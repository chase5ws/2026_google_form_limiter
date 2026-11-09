'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sec = require('./security');
const { REASON_TEXT, DEFAULT_TEMPLATES, TEMPLATE_VARS, rankResponses } = require('./limiter');
const { FOLDER_MIME, FORM_MIME } = require('./google');
const { gasScript, callGas, GAS_URL_RE } = require('./gas-relay');
const { parseSections, countOptions, findItem, waitlistOf } = require('./quota');
const crypto = require('node:crypto');

const { httpError } = sec;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createApp({ db, google = null, googleFor = null, limiter, mailer = null, mailerFor = null, settings = null, runtime = {}, config }) {
  // mailerFor(orgId)：組織自己設定的寄信器（GAS）；沒設定就不寄
  const getMailer = mailerFor || (() => mailer);
  // googleFor(orgId)：組織自己連接的 Google 帳號；也接受舊寫法 google（測試用，所有組織共用）
  const gFor = googleFor || (() => google);
  const mailSummary = (m) => ({ enabled: !!(m && m.enabled()), provider: m && m.enabled() ? m.provider : null, from: m && m.enabled() ? m.from : '' });
  const indexHtml = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
  const secureCookie = String(config.appUrl || '').startsWith('https://');

  // 平台管理員帳號：Railway 變數 ADMIN_ACCOUNT（預設 chase5ws）
  const ADMIN_USER = (() => {
    const u = String(config.defaultAdminUser || 'chase5ws').trim().toLowerCase();
    if (/^[a-z0-9._-]{3,32}$/.test(u)) return u;
    console.error(`[設定錯誤] ADMIN_ACCOUNT「${u}」格式不正確（只能用 3–32 個英文小寫、數字、. _ -），改用 chase5ws。`);
    return 'chase5ws';
  })();

  ensureDefaultSuper();
  applyAdminReset();

  /* ============ 啟動：沒有平台管理員就建立預設帳號 ============ */
  function ensureDefaultSuper() {
    const has = db.get("SELECT id FROM users WHERE role = 'super' AND disabled = 0");
    if (has) return;
    const username = ADMIN_USER;
    const existing = db.get('SELECT id FROM users WHERE username = ?', username);
    const hash = sec.hashPassword(config.defaultAdminPassword || 'chase5ws');
    if (existing) {
      db.run("UPDATE users SET role = 'super', org_id = NULL, password_hash = ?, must_change = 1, disabled = 0, sess_ver = sess_ver + 1 WHERE id = ?", hash, existing.id);
    } else {
      db.run("INSERT INTO users(username, display_name, password_hash, role, must_change, created_at, created_by) VALUES (?, ?, ?, 'super', 1, ?, '系統預設')", username, username, hash, Date.now());
    }
    db.log(null, '系統', `建立預設平台管理員 ${username}`);
  }

  /* ============ 平台管理員密碼：Railway 變數 ADMIN_PASSWORD ============ */
  // 設定後套用一次：chase5ws 直接用這組密碼登入，不用第一次改密碼；之後仍可在網頁上自己改。
  // 同一個值只套用一次（記錄雜湊），重啟不會蓋掉你在網頁上改的密碼；換一個值就會再套用一次（可當忘記密碼用）。
  function applyAdminReset() {
    const pw = config.adminPassword || config.resetAdminPassword;
    if (!pw) return;
    const mark = sec.sha256('reset:' + ADMIN_USER + ':' + pw);
    if (db.getSetting('admin_reset_applied') === mark) return;
    const username = ADMIN_USER;
    const hash = sec.hashPassword(pw);
    const existing = db.get('SELECT id FROM users WHERE username = ?', username);
    if (existing) {
      db.run("UPDATE users SET role = 'super', org_id = NULL, password_hash = ?, must_change = 0, disabled = 0, sess_ver = sess_ver + 1 WHERE id = ?", hash, existing.id);
    } else {
      db.run("INSERT INTO users(username, display_name, password_hash, role, must_change, created_at, created_by) VALUES (?, ?, ?, 'super', 0, ?, 'ADMIN_PASSWORD')", username, username, hash, Date.now());
    }
    db.run('DELETE FROM login_fails WHERE username = ?', username);
    db.setSetting('admin_reset_applied', mark);
    db.log(null, '系統', `依 ADMIN_PASSWORD 設定 ${username} 的密碼（所有裝置已登出）`);
    console.log(`[平台管理員] 已依 ADMIN_PASSWORD 設定 ${username} 的密碼，可直接登入。`);
  }

  /* ============ HTTP 小工具 ============ */
  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, Object.assign({
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src https://docs.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    }, headers));
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > 100 * 1024) { reject(httpError(413, '資料太大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(httpError(400, '資料格式錯誤')); }
      });
      req.on('error', reject);
    });
  }

  function cookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }

  const sidCookie = (token, maxAgeSec) =>
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`;

  /* ============ 身分驗證 ============ */
  function currentUser(req, { allowMustChange = false } = {}) {
    const token = cookies(req).sid;
    if (!token) throw httpError(401, '請先登入。');
    const th = sec.sha256(token);
    const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', th);
    const now = Date.now();
    if (!s || s.expires_at < now) {
      if (s) db.run('DELETE FROM sessions WHERE token_hash = ?', th);
      throw httpError(401, '登入已逾時，請重新登入。');
    }
    const u = db.get('SELECT u.*, o.name AS org_name, o.disabled AS org_disabled FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.id = ?', s.user_id);
    if (!u || u.disabled || u.sess_ver !== s.sess_ver || (u.role !== 'super' && u.org_disabled)) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', th);
      throw httpError(401, u && u.org_disabled ? '你的組織已被停用。' : '帳號狀態已變更，請重新登入。');
    }
    if (u.must_change && !allowMustChange) throw httpError(403, 'MUSTCHANGE: 請先修改密碼。');
    if (s.expires_at - now < SESSION_MS - 60_000) db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now + SESSION_MS, th);
    return u;
  }

  function startSession(u) {
    const token = sec.newToken();
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    db.run('INSERT INTO sessions(token_hash, user_id, sess_ver, expires_at) VALUES (?, ?, ?, ?)', sec.sha256(token), u.id, u.sess_ver, Date.now() + SESSION_MS);
    return sidCookie(token, SESSION_MS / 1000);
  }

  const isSuper = (u) => u.role === 'super';
  const requireSuper = (u) => { if (!isSuper(u)) throw httpError(403, '只有平台管理員可以這樣做。'); };
  // 平台擁有者＝ADMIN_ACCOUNT 這個帳號；平台設定（Google 連接、平台管理員、平台紀錄）只有他能用
  const isOwner = (u) => isSuper(u) && u.username === ADMIN_USER;
  const requireOwner = (u) => { if (!isOwner(u)) throw httpError(403, '只有平台擁有者可以使用這個功能。'); };

  /** 解析 org 參數並確認權限；回傳 org 資料列 */
  function orgFor(u, orgParam) {
    const orgId = Number(orgParam || (isSuper(u) ? 0 : u.org_id));
    if (!isSuper(u) && orgId !== u.org_id) throw httpError(403, '你不能存取其他組織。');
    const org = db.get('SELECT * FROM orgs WHERE id = ?', orgId);
    if (!org) throw httpError(404, '找不到這個組織。');
    return org;
  }

  /** 能否管理某個 scope（'platform' 或組織 id）的帳號 */
  function userScope(u, scopeParam) {
    if (scopeParam === 'platform') { requireOwner(u); return { orgId: null, roles: ['super'] }; }
    const org = orgFor(u, scopeParam);
    if (!isSuper(u) && u.role !== 'org_admin') throw httpError(403, '只有組織管理員可以管理帳號。');
    return { orgId: org.id, roles: ['org_admin', 'org_member'] };
  }

  function userInScope(u, targetId) {
    const t = db.get('SELECT * FROM users WHERE id = ?', Number(targetId));
    if (!t) throw httpError(404, '找不到這個帳號。');
    userScope(u, t.org_id == null ? 'platform' : t.org_id);
    return t;
  }

  function ensureAnotherActive(t) {
    const others = t.role === 'super'
      ? db.get("SELECT COUNT(*) n FROM users WHERE role = 'super' AND disabled = 0 AND id != ?", t.id).n
      : db.get("SELECT COUNT(*) n FROM users WHERE role = 'org_admin' AND org_id = ? AND disabled = 0 AND id != ?", t.org_id, t.id).n;
    if (t.role === 'org_admin' || t.role === 'super') {
      if (!others) throw httpError(400, t.role === 'super' ? '至少要保留一位啟用中的平台管理員。' : '每個組織至少要保留一位啟用中的組織管理員。');
    }
  }

  const userView = (t) => ({
    id: t.id, username: t.username, displayName: t.display_name || t.username, email: t.email || '',
    role: t.role, orgId: t.org_id, disabled: !!t.disabled, mustChange: !!t.must_change,
    createdAt: t.created_at, createdBy: t.created_by || '', lastLogin: t.last_login || null
  });

  const meView = (u) => ({
    id: u.id, username: u.username, displayName: u.display_name || u.username, email: u.email || '',
    role: u.role, orgId: u.org_id, orgName: u.org_name || null, mustChange: !!u.must_change, owner: isOwner(u)
  });

  const formView = (f) => ({
    id: f.id, orgId: f.org_id, title: f.title, googleFormId: f.google_form_id, sourceFormId: f.source_form_id,
    responderUrl: f.responder_url, editUrl: f.edit_url,
    maxResponses: f.max_responses, openAt: f.open_at, closeAt: f.close_at, manualClosed: !!f.manual_closed,
    state: f.state || 'unknown', reason: f.reason, reasonText: f.reason ? REASON_TEXT[f.reason] : '',
    notify: {
      enabled: !!f.notify_enabled, source: f.notify_source || 'respondent',
      waitlistSubject: f.notify_waitlist_subject || '', waitlistBody: f.notify_waitlist_body || '',
      promoteSubject: f.notify_promote_subject || '', promoteBody: f.notify_promote_body || '',
      stats: noticeStats(f.id)
    },
    optionQuotas: quotaView(f),
    sheetUrl: f.sheet_url || '',
    count: f.last_count, lastCheck: f.last_check, lastError: f.last_error || '',
    createdBy: f.created_by, createdAt: f.created_at, updatedBy: f.updated_by
  });

  function quotaView(f) {
    let qs = [];
    try { qs = JSON.parse(f.option_quotas || '[]'); } catch (e) { qs = []; }
    return qs.filter(q => !q.remove).map(q => ({
      questionId: q.questionId, title: q.title, section: q.section || null,
      options: Object.entries(q.limits || {}).map(([value, limit]) => ({
        value, limit, count: (q.counts && q.counts[value]) || 0, hidden: (q.hidden || []).some(h => h.value === value)
      }))
    }));
  }

  function noticeStats(formId) {
    const r = db.get(`SELECT
      SUM(kind = 'waitlist' AND status = 'sent') AS waitlist,
      SUM(kind = 'promoted' AND status = 'sent') AS promoted,
      SUM(status = 'failed') AS failed,
      SUM(status = 'skipped') AS skipped FROM notices WHERE form_id = ?`, formId) || {};
    return { waitlist: r.waitlist || 0, promoted: r.promoted || 0, failed: r.failed || 0, skipped: r.skipped || 0 };
  }

  function formFor(u, id) {
    const f = db.get('SELECT * FROM forms WHERE id = ?', Number(id));
    if (!f) throw httpError(404, '找不到這份表單。');
    orgFor(u, f.org_id);
    return f;
  }

  function cleanEmails(list) {
    const arr = (Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/))
      .map(s => String(s).trim().toLowerCase()).filter(Boolean);
    const bad = arr.filter(e => !EMAIL_RE.test(e));
    if (bad.length) throw httpError(400, `Email 格式不正確：${bad.join(', ')}`);
    if (arr.length > 20) throw httpError(400, '共用 Email 最多 20 個。');
    return [...new Set(arr)];
  }

  function parseTime(v) {
    if (v === '' || v == null) return null;
    const n = typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(n)) throw httpError(400, '時間格式不正確。');
    return n;
  }

  function parseFormId(input) {
    const s = String(input || '').trim();
    if (/\/forms\/d\/e\//.test(s) || /forms\.gle\//.test(s)) {
      throw httpError(400, '這是「填寫」連結。請貼表單的「編輯」連結，格式是 https://docs.google.com/forms/d/…/edit');
    }
    const m = s.match(/\/forms\/d\/([a-zA-Z0-9_-]{20,})/) || s.match(/^([a-zA-Z0-9_-]{20,})$/);
    if (!m) throw httpError(400, '看不懂這個連結。請貼表單的「編輯」連結，格式是 https://docs.google.com/forms/d/…/edit');
    return m[1];
  }

  /* ============ 組織的資料夾（組織自己的雲端硬碟） ============ */
  const folderUrl = (id) => (id ? `https://drive.google.com/drive/folders/${id}` : null);

  function parseFolderId(input) {
    const s = String(input || '').trim();
    const m = s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || s.match(/^([a-zA-Z0-9_-]{10,})$/);
    if (!m) throw httpError(400, '看不懂這個連結。請貼雲端硬碟資料夾的連結，格式是 https://drive.google.com/drive/folders/…');
    return m[1];
  }

  function needFolder(org) {
    if (!org.shared_folder_id) throw httpError(400, '這個組織還沒設定資料夾，請先到「組織設定 → 資料夾」貼上資料夾連結。');
    return org.shared_folder_id;
  }

  /** 組織的 Google 連線；沒連接就丟錯 */
  function orgGoogle(org) {
    const g = gFor(org.id);
    if (!g.connected()) throw httpError(503, '這個組織還沒連接 Google 帳號，請組織管理員到「組織設定 → Google 帳號」連接。');
    return g;
  }

  const noAccess = (g) => httpError(400, `連接的 Google 帳號 ${g.email() || ''} 打不開這個資料夾。請確認資料夾在這個帳號的雲端硬碟裡（或有共用給這個帳號編輯）。`);

  /* ============ 路由 ============ */
  const routes = [];
  const on = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  /* ---- 帳號 ---- */
  on('POST', '/api/login', async (req, res, { body }) => {
    const username = String(body.username || '').trim().toLowerCase();
    const now = Date.now();
    const fail = db.get('SELECT * FROM login_fails WHERE username = ?', username);
    if (fail && fail.count >= MAX_FAILS && fail.until > now) throw httpError(429, '登入失敗次數過多，請 15 分鐘後再試。');
    const u = username ? db.get('SELECT u.*, o.disabled AS org_disabled FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.username = ?', username) : null;
    let ok = false;
    if (u) ok = sec.verifyPassword(String(body.password || ''), u.password_hash); else sec.fakeVerify();
    if (!ok || u.disabled || (u.role !== 'super' && u.org_disabled)) {
      const count = fail && fail.until > now ? fail.count + 1 : 1;
      db.run('INSERT INTO login_fails(username, count, until) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET count = excluded.count, until = excluded.until', username, count, now + LOCK_MS);
      db.log(u ? u.org_id : null, username || '(空白)', '登入失敗');
      throw httpError(401, ok && u && u.org_disabled ? '你的組織已被停用。' : '帳號或密碼錯誤。');
    }
    db.run('DELETE FROM login_fails WHERE username = ?', username);
    db.run('UPDATE users SET last_login = ? WHERE id = ?', now, u.id);
    db.log(u.org_id, u.username, '登入');
    const cookie = startSession(u);
    send(res, 200, { me: meView(currentUserById(u.id)) }, { 'Set-Cookie': cookie });
    return null;
  });

  function currentUserById(id) {
    return db.get('SELECT u.*, o.name AS org_name FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.id = ?', id);
  }

  on('POST', '/api/logout', async (req, res) => {
    const token = cookies(req).sid;
    if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sec.sha256(token));
    send(res, 200, { ok: true }, { 'Set-Cookie': sidCookie('', 0) });
    return null;
  });

  on('GET', '/api/me', async (req) => {
    const u = currentUser(req, { allowMustChange: true });
    return {
      me: meView(u),
      mail: u.org_id ? mailSummary(getMailer(u.org_id)) : null,
      commit: config.commit || '',
      templates: DEFAULT_TEMPLATES,
      templateVars: TEMPLATE_VARS.map(([key, label]) => ({ key, label }))
    };
  });

  on('POST', '/api/password', async (req, res, { body }) => {
    const u = currentUser(req, { allowMustChange: true });
    if (!sec.verifyPassword(String(body.oldPassword || ''), u.password_hash)) throw httpError(400, '目前的密碼不正確。');
    sec.checkPassword(body.newPassword, u.username);
    if (sec.verifyPassword(String(body.newPassword), u.password_hash)) throw httpError(400, '新密碼不能跟舊密碼一樣。');
    db.run('UPDATE users SET password_hash = ?, must_change = 0, sess_ver = sess_ver + 1 WHERE id = ?', sec.hashPassword(body.newPassword), u.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    db.log(u.org_id, u.username, '修改自己的密碼');
    const fresh = currentUserById(u.id);
    send(res, 200, { me: meView(fresh) }, { 'Set-Cookie': startSession(fresh) });
    return null;
  });

  /* ---- Google 連接：每個組織用自己的 OAuth 用戶端和帳號 ---- */
  function orgAdminOnly(u, what = '設定') {
    if (!isSuper(u) && u.role !== 'org_admin') throw httpError(403, `只有組織管理員可以${what}。`);
  }
  const redirectUri = () => runtime.redirectUri || `${String(config.appUrl || '').replace(/\/$/, '')}/oauth/google/callback`;
  function googleView(org) {
    const g = gFor(org.id);
    const c = settings ? settings.orgGoogleClient(org.id) : { clientId: '', clientSecret: '' };
    return { clientId: c.clientId || '', hasSecret: !!c.clientSecret, configured: g.configured(), connected: g.connected(), email: g.email() || null, redirectUri: redirectUri() };
  }

  on('GET', '/api/orgs/:id/google', async (req, res, { params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u);
    return googleView(org);
  });

  on('PUT', '/api/orgs/:id/google/client', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u);
    if (!settings) throw httpError(503, '設定功能未啟用。');
    const r = settings.setOrgGoogleClient(org.id, body);
    const g = gFor(org.id);
    if (r.changed && g.connected()) g.disconnect();
    db.log(org.id, u.username, `設定 Google OAuth 用戶端${r.changed ? '（已變更，需要重新連接 Google）' : ''}`);
    return googleView(org);
  });

  on('POST', '/api/orgs/:id/google/connect', async (req, res, { params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u, '連接 Google');
    const state = sec.newToken();
    const url = gFor(org.id).authUrl(state);
    db.setSetting('oauth_state:' + sec.sha256(state), JSON.stringify({ uid: u.id, org: org.id, exp: Date.now() + 10 * 60 * 1000 }));
    return { url };
  });

  on('GET', '/oauth/google/callback', async (req, res, { query }) => {
    const key = 'oauth_state:' + sec.sha256(query.get('state') || '');
    let st = null;
    try { st = JSON.parse(db.getSetting(key) || 'null'); } catch (e) { st = null; }
    db.setSetting(key, null);
    const back = (msg) => {
      res.writeHead(302, { Location: (st ? `/#org/${st.org}/orgsettings` : '/#') + '?google=' + encodeURIComponent(msg) });
      res.end(); return null;
    };
    if (query.get('error')) return back('Google 回傳：' + query.get('error'));
    if (!st || st.exp < Date.now()) { st = null; return back('連接逾時或來源不正確，請重新按「連接 Google」。'); }
    let u;
    try { u = currentUser(req); } catch (e) { return back('請先登入再連接。'); }
    if (u.id !== st.uid) return back('登入的帳號跟按下連接的人不一樣，請重新連接。');
    let org;
    try { org = orgFor(u, st.org); orgAdminOnly(u, '連接 Google'); } catch (e) { return back(e.message); }
    try {
      const email = await gFor(org.id).exchangeCode(query.get('code'));
      db.log(org.id, u.username, `連接 Google 帳號 ${email}`);
      return back('ok');
    } catch (e) {
      return back(e.message);
    }
  });

  on('POST', '/api/orgs/:id/google/disconnect', async (req, res, { params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u, '中斷 Google');
    const g = gFor(org.id);
    const email = g.email();
    g.disconnect();
    db.log(org.id, u.username, `中斷 Google 帳號 ${email || ''}`);
    return googleView(org);
  });

  /* ---- 組織 ---- */
  function orgList(u) {
    const sql = `SELECT o.*, (SELECT COUNT(*) FROM forms f WHERE f.org_id = o.id) AS form_count,
                 (SELECT COUNT(*) FROM users x WHERE x.org_id = o.id) AS user_count FROM orgs o`;
    const rows = isSuper(u) ? db.all(sql + ' ORDER BY o.id') : db.all(sql + ' WHERE o.id = ?', u.org_id);
    return rows.map(o => ({ id: o.id, name: o.name, disabled: !!o.disabled, forms: o.form_count, users: o.user_count, createdAt: o.created_at,
      mail: mailSummary(getMailer(o.id)),
      google: { connected: gFor(o.id).connected(), email: gFor(o.id).email() || null },
      folder: o.shared_folder_id ? { id: o.shared_folder_id, name: o.shared_folder_name, owner: o.shared_folder_owner, url: folderUrl(o.shared_folder_id) } : null }));
  }

  on('GET', '/api/orgs', async (req) => orgList(currentUser(req)));

  on('POST', '/api/orgs', async (req, res, { body }) => {
    const u = currentUser(req); requireSuper(u);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, '請輸入組織名稱。');
    const admin = body.admin || {};
    const username = String(admin.username || '').trim().toLowerCase();
    sec.checkUsername(username);
    sec.checkPassword(admin.password, username);
    const email = admin.email ? cleanEmails([admin.email])[0] : null;
    if (db.get('SELECT id FROM users WHERE username = ?', username)) throw httpError(400, `帳號 ${username} 已經有人使用。`);
    db.tx(() => {
      const r = db.run('INSERT INTO orgs(name, created_at, created_by) VALUES (?, ?, ?)', name, Date.now(), u.username);
      db.run("INSERT INTO users(username, display_name, email, password_hash, role, org_id, must_change, created_at, created_by) VALUES (?, ?, ?, ?, 'org_admin', ?, 1, ?, ?)",
        username, String(admin.displayName || username).trim().slice(0, 40), email, sec.hashPassword(admin.password), Number(r.lastInsertRowid), Date.now(), u.username);
      db.log(Number(r.lastInsertRowid), u.username, `建立組織「${name}」與組織管理員 ${username}`);
    });
    return orgList(u);
  });

  on('PATCH', '/api/orgs/:id', async (req, res, { body, params }) => {
    const u = currentUser(req); requireSuper(u);
    const org = orgFor(u, params.id);
    if ('name' in body) {
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) throw httpError(400, '請輸入組織名稱。');
      db.run('UPDATE orgs SET name = ? WHERE id = ?', name, org.id);
    }
    if ('disabled' in body) db.run('UPDATE orgs SET disabled = ? WHERE id = ?', body.disabled ? 1 : 0, org.id);
    db.log(org.id, u.username, `修改組織「${org.name}」${'disabled' in body ? (body.disabled ? '：停用' : '：啟用') : ''}`);
    return orgList(u);
  });

  on('DELETE', '/api/orgs/:id', async (req, res, { params }) => {
    const u = currentUser(req); requireSuper(u);
    const org = orgFor(u, params.id);
    db.run('DELETE FROM orgs WHERE id = ?', org.id);
    if (googleFor && googleFor.forget) googleFor.forget(org.id);
    db.log(null, u.username, `刪除組織「${org.name}」（Google 表單本身保留在雲端硬碟）`);
    return orgList(u);
  });

  /* ---- 組織的資料夾：組織自己雲端硬碟裡的資料夾，平台只控管裡面的表單 ---- */
  on('PUT', '/api/orgs/:id/folder', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u, '設定資料夾');
    const g = orgGoogle(org);
    const id = parseFolderId(body.url);
    let meta;
    try { meta = await g.fileMeta(id); } catch (e) { if (e.status === 404 || e.status === 403) throw noAccess(g); throw e; }
    if (meta.trashed) throw httpError(400, '這個資料夾在垃圾桶裡。');
    if (meta.mimeType !== FOLDER_MIME) throw httpError(400, '這個連結不是資料夾。');
    if (!meta.capabilities || !meta.capabilities.canEdit) throw httpError(400, `${g.email() || '連接的帳號'} 對這個資料夾只有檢視權限，請改用有編輯權限的帳號或資料夾。`);
    const used = db.get('SELECT name FROM orgs WHERE shared_folder_id = ? AND id != ?', id, org.id);
    if (used) throw httpError(400, `這個資料夾已經被「${used.name}」使用。`);
    const owner = (meta.owners && meta.owners[0] && meta.owners[0].emailAddress) || '';
    db.run('UPDATE orgs SET shared_folder_id = ?, shared_folder_name = ?, shared_folder_owner = ? WHERE id = ?', id, meta.name, owner, org.id);
    db.log(org.id, u.username, `設定資料夾「${meta.name}」（擁有者 ${owner || '未知'}）`);
    return orgList(u).find(o => o.id === org.id);
  });

  /** 資料夾裡的表單，標出哪些已經在管理 */
  on('GET', '/api/orgs/:id/folder-forms', async (req, res, { params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    const g = orgGoogle(org);
    const folderId = needFolder(org);
    let files;
    try { files = await g.listFolderForms(folderId); } catch (e) { if (e.status === 404 || e.status === 403) throw noAccess(g); throw e; }
    const managed = new Map(db.all('SELECT google_form_id, org_id FROM forms').map(r => [r.google_form_id, r.org_id]));
    return files.map(f => ({
      id: f.id, name: f.name, modifiedTime: f.modifiedTime, canEdit: !!(f.capabilities && f.capabilities.canEdit),
      managed: managed.has(f.id), managedElsewhere: managed.has(f.id) && managed.get(f.id) !== org.id
    }));
  });

  /* ---- 平台狀態（平台擁有者）：平台只提供網站本身，Google 與寄信都由各組織自己設定 ---- */
  function setupView() {
    const checks = [
      { key: 'domain', ok: !!String(runtime.appUrl || '').startsWith('https://'), title: '產生網域', hint: 'Railway → Settings → Networking → Generate Domain' },
      { key: 'volume', ok: !runtime.onRailway || !!runtime.volumeMounted, title: '掛載 Volume', hint: '在 Railway 對服務按右鍵 → Attach Volume，掛載路徑填 /data。沒掛的話每次部署資料都會消失。' }
    ];
    return {
      runtime: {
        appUrl: runtime.appUrl, redirectUri: redirectUri(), onRailway: !!runtime.onRailway,
        volumeMounted: !!runtime.volumeMounted, dataDir: runtime.dataDir, dataSource: runtime.dataSource,
        keySource: runtime.keySource, domainFromRailway: !!runtime.domainFromRailway
      },
      checks,
      done: checks.every(c => c.ok)
    };
  }

  on('GET', '/api/setup', async (req) => { requireOwner(currentUser(req)); return setupView(); });

  /* ---- 組織自己的寄信設定（只有 GAS） ---- */
  function orgMailView(org) {
    const m = getMailer(org.id);
    return { settings: settings ? settings.orgMailView(org.id) : { provider: 'none' }, effective: mailSummary(m) };
  }

  on('GET', '/api/orgs/:id/mail', async (req, res, { params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u);
    return orgMailView(org);
  });

  /** 產生組織要貼到自己 GAS 的寄信中繼程式碼（含隨機密鑰） */
  on('POST', '/api/mail/gas-script', async (req) => {
    const u = currentUser(req);
    orgAdminOnly(u);
    const secret = crypto.randomBytes(24).toString('base64url');
    return { secret, code: gasScript(secret) };
  });

  on('PUT', '/api/orgs/:id/mail', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u);
    if (!settings) throw httpError(503, '設定功能未啟用。');
    body = Object.assign({}, body || {});
    if (body.provider !== 'gas') body = { provider: 'none' };
    let gasCheck = null;
    if (body.provider === 'gas') {
      const url = String(body.gasUrl || '').trim();
      if (!GAS_URL_RE.test(url)) throw httpError(400, '請貼 GAS 的「網頁應用程式網址」，格式是 https://script.google.com/macros/s/…/exec');
      const prev = settings.orgGas(org.id);
      const secret = body.gasSecret || (prev && prev.secret);
      if (!secret) throw httpError(400, '請先按「產生程式碼」，把程式碼部署到 GAS。');
      try { gasCheck = await callGas(url, { secret, action: 'ping' }, config.fetchImpl); }
      catch (e) { throw httpError(400, e.message); }
      const name = String(body.gasName || '').trim();
      body.gasSecret = secret;
      body.from = name ? `${name} <${gasCheck.email}>` : gasCheck.email;
    }
    settings.setOrgMail(org.id, body);
    db.log(org.id, u.username, `設定組織寄信：${body.provider || 'none'}${gasCheck ? `（GAS，寄件帳號 ${gasCheck.email}）` : ''}`);
    return Object.assign(orgMailView(org), gasCheck ? { gasCheck: { email: gasCheck.email, quota: gasCheck.quota } } : {});
  });

  on('POST', '/api/orgs/:id/mail/test', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    orgAdminOnly(u, '寄測試信');
    const m = getMailer(org.id);
    if (!m || !m.enabled()) throw httpError(400, '這個組織還沒設定寄信帳號。');
    if (!body.to) throw httpError(400, '請輸入收件 Email。');
    const to = cleanEmails([body.to])[0];
    try {
      await m.send({ to, subject: `${org.name}：寄信測試`, text: `這是「${org.name}」在「Chase's Google Form Limiter平台」的寄信測試。\n\n寄件者：${m.from}\n寄送方式：Google Apps Script\n時間：${new Date().toISOString()}` });
    } catch (e) { throw httpError(502, e.message); }
    db.log(org.id, u.username, `寄測試信到 ${to}`);
    return { ok: true };
  });

  /* ---- 帳號管理 ---- */
  on('GET', '/api/users', async (req, res, { query }) => {
    const u = currentUser(req);
    const scope = userScope(u, query.get('org'));
    const rows = scope.orgId == null
      ? db.all("SELECT * FROM users WHERE role = 'super' ORDER BY id")
      : db.all('SELECT * FROM users WHERE org_id = ? ORDER BY id', scope.orgId);
    return rows.map(userView);
  });

  on('POST', '/api/users', async (req, res, { body }) => {
    const u = currentUser(req);
    const scope = userScope(u, body.org);
    const username = String(body.username || '').trim().toLowerCase();
    sec.checkUsername(username);
    sec.checkPassword(body.password, username);
    const role = scope.roles.includes(body.role) ? body.role : scope.roles[scope.roles.length - 1];
    const email = body.email ? cleanEmails([body.email])[0] : null;
    if (db.get('SELECT id FROM users WHERE username = ?', username)) throw httpError(400, `帳號 ${username} 已經有人使用。`);
    db.run('INSERT INTO users(username, display_name, email, password_hash, role, org_id, must_change, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      username, String(body.displayName || username).trim().slice(0, 40) || username, email, sec.hashPassword(body.password), role, scope.orgId, Date.now(), u.username);
    db.log(scope.orgId, u.username, `新增帳號 ${username}（${roleText(role)}）`);
    return { ok: true };
  });

  on('PATCH', '/api/users/:id', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const t = userInScope(u, params.id);
    const scope = userScope(u, t.org_id == null ? 'platform' : t.org_id);
    const self = t.id === u.id;
    const changes = [];
    db.tx(() => {
      if ('displayName' in body) { db.run('UPDATE users SET display_name = ? WHERE id = ?', String(body.displayName || '').trim().slice(0, 40) || t.username, t.id); changes.push('顯示名稱'); }
      if ('email' in body) { db.run('UPDATE users SET email = ? WHERE id = ?', body.email ? cleanEmails([body.email])[0] : null, t.id); changes.push('Email'); }
      if ('role' in body && body.role !== t.role) {
        if (!scope.roles.includes(body.role)) throw httpError(400, '權限設定不正確。');
        if (self) throw httpError(400, '不能修改自己的權限。');
        if (t.role === 'org_admin') ensureAnotherActive(t);
        db.run('UPDATE users SET role = ? WHERE id = ?', body.role, t.id);
        changes.push(`改為${roleText(body.role)}`);
      }
      if ('disabled' in body && !!body.disabled !== !!t.disabled) {
        if (self) throw httpError(400, '不能停用自己。');
        if (body.disabled) ensureAnotherActive(t);
        db.run('UPDATE users SET disabled = ?, sess_ver = sess_ver + 1 WHERE id = ?', body.disabled ? 1 : 0, t.id);
        changes.push(body.disabled ? '停用' : '啟用');
      }
    });
    if (changes.length) db.log(t.org_id, u.username, `${t.username}：${changes.join('、')}`);
    return { ok: true };
  });

  on('POST', '/api/users/:id/reset', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const t = userInScope(u, params.id);
    if (t.id === u.id) throw httpError(400, '要改自己的密碼請用右上角「改密碼」。');
    sec.checkPassword(body.password, t.username);
    db.run('UPDATE users SET password_hash = ?, must_change = 1, sess_ver = sess_ver + 1 WHERE id = ?', sec.hashPassword(body.password), t.id);
    db.run('DELETE FROM login_fails WHERE username = ?', t.username);
    db.log(t.org_id, u.username, `重設 ${t.username} 的密碼`);
    return { ok: true };
  });

  on('DELETE', '/api/users/:id', async (req, res, { params }) => {
    const u = currentUser(req);
    const t = userInScope(u, params.id);
    if (t.id === u.id) throw httpError(400, '不能刪除自己。');
    ensureAnotherActive(t);
    db.run('DELETE FROM users WHERE id = ?', t.id);
    db.log(t.org_id, u.username, `刪除帳號 ${t.username}`);
    return { ok: true };
  });

  /* ---- 表單 ---- */
  on('GET', '/api/forms', async (req, res, { query }) => {
    const u = currentUser(req);
    const org = orgFor(u, query.get('org'));
    return db.all('SELECT * FROM forms WHERE org_id = ? ORDER BY id DESC', org.id).map(formView);
  });

  on('POST', '/api/forms', async (req, res, { body }) => {
    const u = currentUser(req);
    const org = orgFor(u, body.org);
    const google = orgGoogle(org);
    const folderId = needFolder(org);
    const formId = parseFormId(body.formId || body.url);
    if (db.get('SELECT id FROM forms WHERE google_form_id = ?', formId)) throw httpError(400, '這份表單已經在管理清單裡了。');

    let meta;
    try { meta = await google.fileMeta(formId); } catch (e) {
      if (e.status === 404 || e.status === 403) throw httpError(400, `找不到這份表單，或 ${google.email() || '連接的帳號'} 沒有權限。請確認表單放在資料夾「${org.shared_folder_name}」裡。`);
      throw e;
    }
    if (meta.mimeType !== FORM_MIME) throw httpError(400, '這個連結不是 Google 表單。');
    if (meta.trashed) throw httpError(400, '這份表單在垃圾桶裡。');
    if (!(meta.parents || []).includes(folderId)) throw httpError(400, `這份表單不在資料夾「${org.shared_folder_name}」裡。請先把表單移進資料夾再加入。`);
    if (!meta.capabilities || !meta.capabilities.canEdit) throw httpError(400, `${google.email() || '連接的帳號'} 對這份表單沒有編輯權限。`);

    const info = await google.getForm(formId);
    if (!info.publishSettings) {
      throw httpError(400, '這是舊版格式的表單，Google 不允許用 API 開關。請在 Google 表單按「⋮ → 建立副本」，把副本放在同一個資料夾，再加入副本。');
    }

    const r = db.run(`INSERT INTO forms(org_id, title, source_form_id, google_form_id, responder_url, edit_url, created_by, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      org.id, (info.info && info.info.title) || meta.name, formId, formId, info.responderUri || null,
      `https://docs.google.com/forms/d/${formId}/edit`, u.username, Date.now());
    db.log(org.id, u.username, `加入表單「${meta.name}」`);
    const row = await limiter.enforce(Number(r.lastInsertRowid), '加入管理');
    return { form: formView(row) };
  });

  on('PATCH', '/api/forms/:id', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    const set = {};
    if ('maxResponses' in body) {
      const v = String(body.maxResponses == null ? '' : body.maxResponses).trim();
      if (v === '') set.max_responses = null;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw httpError(400, '名額上限要是 1 以上的整數，留空代表不限。');
        set.max_responses = n;
      }
    }
    if ('openAt' in body) set.open_at = parseTime(body.openAt);
    if ('closeAt' in body) set.close_at = parseTime(body.closeAt);
    const openAt = 'open_at' in set ? set.open_at : f.open_at;
    const closeAt = 'close_at' in set ? set.close_at : f.close_at;
    if (openAt && closeAt && closeAt <= openAt) throw httpError(400, '截止時間必須晚於開放時間。');

    if ('notifyEnabled' in body) set.notify_enabled = body.notifyEnabled ? 1 : 0;
    if ('notifySource' in body) {
      const src = String(body.notifySource || 'respondent').trim();
      if (src !== 'respondent' && !/^[a-zA-Z0-9_-]{1,64}$/.test(src)) throw httpError(400, 'Email 來源設定不正確。');
      set.notify_source = src;
    }
    if ('sheetUrl' in body) set.sheet_url = parseSheetUrl(body.sheetUrl);
    for (const [k, col, max] of [['waitlistSubject', 'notify_waitlist_subject', 200], ['waitlistBody', 'notify_waitlist_body', 5000],
                                 ['promoteSubject', 'notify_promote_subject', 200], ['promoteBody', 'notify_promote_body', 5000]]) {
      if (k in body) set[col] = String(body[k] || '').trim().slice(0, max) || null;
    }
    let quotasAfter;
    try { quotasAfter = JSON.parse(f.option_quotas || '[]').filter(q => !q.remove); } catch (e) { quotasAfter = []; }
    if ('optionQuotas' in body) {
      const next = await buildQuotas(f, body.optionQuotas);
      set.option_quotas = JSON.stringify(next);
      quotasAfter = next.filter(q => !q.remove);
    }
    const willNotify = 'notify_enabled' in set ? set.notify_enabled : f.notify_enabled;
    const maxAfter = 'max_responses' in set ? set.max_responses : f.max_responses;
    if (willNotify && !maxAfter && !quotasAfter.length) throw httpError(400, '要先設定名額上限或選項名額，才能寄候補通知。');
    set.updated_by = u.username;
    set.updated_at = Date.now();
    const cols = Object.keys(set);
    db.run(`UPDATE forms SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, ...cols.map(c => set[c]), f.id);
    const row = await limiter.enforce(f.id, '更新設定');
    db.log(f.org_id, u.username, `修改「${row.title}」設定：${summary(row)}`);
    return { form: formView(row) };
  });

  on('POST', '/api/forms/:id/open', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    db.run('UPDATE forms SET manual_closed = ?, updated_by = ?, updated_at = ? WHERE id = ?', body.open ? 0 : 1, u.username, Date.now(), f.id);
    const row = await limiter.enforce(f.id, body.open ? '手動開放' : '手動關閉');
    db.log(f.org_id, u.username, `${body.open ? '手動開放' : '手動關閉'}「${row.title}」`);
    return { form: formView(row) };
  });

  on('POST', '/api/forms/:id/check', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    return { form: formView(await limiter.enforce(f.id, '手動檢查')) };
  });

  on('POST', '/api/forms/check-all', async (req, res, { body }) => {
    const u = currentUser(req);
    const org = orgFor(u, body.org);
    for (const r of db.all('SELECT id FROM forms WHERE org_id = ?', org.id)) await limiter.enforce(r.id, '手動檢查');
    return db.all('SELECT * FROM forms WHERE org_id = ? ORDER BY id DESC', org.id).map(formView);
  });

  /** 表單是否收集 Email、可以當 Email 欄位的簡答題 */
  on('GET', '/api/forms/:id/questions', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    return gFor(f.org_id).formQuestions(f.google_form_id);
  });

  /**
   * 選項名額設定 → 存進資料庫的格式。
   * input：[{ questionId, limits: { 選項: 名額 或 '' } }]
   * 被拿掉的題目如果有被系統隱藏的選項，先留著（標記 remove），等下次檢查加回去再刪除。
   */
  async function buildQuotas(f, input) {
    if (!Array.isArray(input)) throw httpError(400, '選項名額格式不正確。');
    const form = await gFor(f.org_id).getFormFull(f.google_form_id);
    const sections = parseSections(form);
    const byId = new Map();
    sections.forEach(sec => sec.questions.forEach(q => byId.set(q.questionId, Object.assign({ section: { index: sec.index, title: sec.title } }, q))));
    let prev = [];
    try { prev = JSON.parse(f.option_quotas || '[]'); } catch (e) { prev = []; }
    const prevById = new Map(prev.map(q => [q.questionId, q]));
    const out = [];
    for (const item of input) {
      const q = byId.get(item && item.questionId);
      if (!q) throw httpError(400, '找不到這個題目，請重新整理後再試。');
      const old = prevById.get(q.questionId) || { hidden: [], order: [] };
      const known = new Set(q.options.concat((old.hidden || []).map(h => h.value)));
      const limits = {};
      for (const [value, raw] of Object.entries(item.limits || {})) {
        const v = String(raw == null ? '' : raw).trim();
        if (v === '') continue;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 100000) throw httpError(400, `「${value}」的名額要是 0 以上的整數，留空代表不限。`);
        if (!known.has(value)) throw httpError(400, `「${q.title}」沒有「${value}」這個選項。`);
        limits[value] = n;
      }
      if (!Object.keys(limits).length && !(old.hidden || []).length) continue;
      out.push({
        questionId: q.questionId, title: q.title, section: q.section, type: q.type, limits,
        hidden: old.hidden || [], order: old.order && old.order.length ? old.order : q.options.slice(),
        counts: old.counts || {}, remove: !Object.keys(limits).length
      });
      prevById.delete(q.questionId);
    }
    // 整題被拿掉、但還有被隱藏的選項 → 保留到加回去為止
    for (const old of prevById.values()) if ((old.hidden || []).length) out.push(Object.assign({}, old, { limits: {}, remove: true }));
    return out;
  }

  /** 表單結構：段落、選擇題、選項，以及目前每個選項的回覆數與名額設定 */
  on('GET', '/api/forms/:id/structure', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    const google = gFor(f.org_id);
    const form = await google.getFormFull(f.google_form_id);
    const sections = parseSections(form);
    const responses = await google.listResponses(f.google_form_id, true);
    let quotas = [];
    try { quotas = JSON.parse(f.option_quotas || '[]'); } catch (e) { quotas = []; }
    const aliases = jsonOf(f.option_aliases, {});
    const qmap = new Map(quotas.map(q => [q.questionId, q]));
    for (const sec of sections) {
      for (const q of sec.questions) {
        const counts = countOptions(responses, q.questionId, aliases);
        const cfg = qmap.get(q.questionId) || { limits: {}, hidden: [] };
        // 被系統隱藏的選項也列出來，才能調整名額
        const all = q.options.slice();
        (cfg.hidden || []).forEach(h => { if (!all.includes(h.value)) all.push(h.value); });
        q.options = all.map(v => ({ value: v, count: counts[v] || 0, limit: cfg.limits && cfg.limits[v] != null && !cfg.remove ? cfg.limits[v] : null, hidden: (cfg.hidden || []).some(h => h.value === v) }));
      }
    }
    return { sections, total: responses.length };
  });

  const jsonOf = (txt, dflt) => { try { return JSON.parse(txt || '') || dflt; } catch (e) { return dflt; } };

  /**
   * 修改一題選擇題：題目名稱、選項（新增、改名、刪除、排序）和每個選項的名額，一次存好。
   * body：{ title, options: [{ value: 新名稱, from: 原本的名稱（新選項不填）, limit: 名額（空白＝不限） }] }
   * 已經額滿、被系統從表單移除的選項也可以改；存檔後立即重新檢查，額滿的照樣會被移除。
   */
  on('PUT', '/api/forms/:id/questions/:qid', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    const google = orgGoogle({ id: f.org_id });
    const form = await google.getFormFull(f.google_form_id);
    const found = findItem(form, params.qid);
    if (!found) throw httpError(404, '找不到這一題，可能已經在 Google 表單被刪除，請重新整理。');
    const cq = found.item.questionItem.question.choiceQuestion;
    if (!['RADIO', 'CHECKBOX', 'DROP_DOWN'].includes(cq.type)) throw httpError(400, '只有單選、多選、下拉題可以在這裡修改。');

    const title = String(body.title == null ? found.item.title || '' : body.title).trim().slice(0, 500);
    if (!title) throw httpError(400, '題目名稱不能空白。');
    const input = Array.isArray(body.options) ? body.options : [];
    if (!input.length) throw httpError(400, '至少要有一個選項。');
    if (input.length > 200) throw httpError(400, '選項最多 200 個。');

    let quotas = jsonOf(f.option_quotas, []);
    const old = quotas.find(q => q.questionId === params.qid) || { hidden: [], order: [], limits: {} };
    // 目前所有選項：表單上的 + 額滿被移除的，名稱 → 原本的選項物件（保留跳到某段落等設定）
    const known = new Map();
    for (const o of cq.options || []) if (!o.isOther) known.set(o.value, o);
    for (const h of old.hidden || []) if (!known.has(h.value)) known.set(h.value, h.option || { value: h.value });
    const other = (cq.options || []).filter(o => o.isOther);

    const seen = new Set();
    const next = input.map(raw => {
      const value = String((raw && raw.value) || '').trim().slice(0, 300);
      if (!value) throw httpError(400, '選項名稱不能空白。');
      if (seen.has(value)) throw httpError(400, `選項「${value}」重複了。`);
      seen.add(value);
      const from = raw.from != null && known.has(String(raw.from)) ? String(raw.from) : null;
      const v = String(raw.limit == null ? '' : raw.limit).trim();
      let limit = null;
      if (v !== '') {
        limit = Number(v);
        if (!Number.isInteger(limit) || limit < 0 || limit > 100000) throw httpError(400, `「${value}」的名額要是 0 以上的整數，留白代表不限。`);
      }
      return { value, from, limit, option: from ? Object.assign({}, known.get(from), { value }) : { value } };
    });

    // 改名：記下舊名稱，之前的回覆才會算在新名稱上
    const aliases = jsonOf(f.option_aliases, {});
    const qa = Object.assign({}, aliases[params.qid] || {});
    const renamed = [];
    for (const n of next) {
      if (n.from && n.from !== n.value) {
        qa[n.value] = [...new Set([...(qa[n.value] || []), ...(qa[n.from] || []), n.from])];
        delete qa[n.from];
        renamed.push(`${n.from} → ${n.value}`);
      }
    }
    const kept = new Set(next.filter(n => n.from).map(n => n.from));
    const removed = [...known.keys()].filter(v => !kept.has(v));
    for (const v of removed) delete qa[v];
    if (Object.keys(qa).length) aliases[params.qid] = qa; else delete aliases[params.qid];

    // 額滿被移除的選項：跟著改名，刪掉的就不再記
    const hiddenByFrom = new Map((old.hidden || []).map(h => [h.value, h]));
    const hidden = next.filter(n => n.from && hiddenByFrom.has(n.from)).map(n => ({ value: n.value, option: n.option }));
    const anyLimit = next.some(n => n.limit != null);
    const hiddenSet = new Set(anyLimit ? hidden.map(h => h.value) : []); // 不限名額了 → 全部放回表單
    let visible = next.filter(n => !hiddenSet.has(n.value)).map(n => n.option);
    if (!visible.length) visible = next.map(n => n.option); // 全部額滿：選擇題至少要有一個選項，表單會因為「選項皆已額滿」關閉

    await google.updateChoiceQuestion(f.google_form_id, {
      itemId: found.item.itemId, itemIndex: found.index, questionId: params.qid, type: cq.type, title,
      options: visible.concat(other)
    });

    const limits = {};
    next.forEach(n => { if (n.limit != null) limits[n.value] = n.limit; });
    const sections = parseSections(form);
    const sec = sections.find(x => x.questions.some(q => q.questionId === params.qid));
    const entry = {
      questionId: params.qid, title, section: sec ? { index: sec.index, title: sec.title } : old.section || null, type: cq.type,
      limits, hidden: visible.length === next.length ? [] : hidden, order: next.map(n => n.value), counts: {},
      remove: !Object.keys(limits).length
    };
    quotas = quotas.filter(q => q.questionId !== params.qid);
    if (Object.keys(limits).length || entry.hidden.length) quotas.push(entry);
    db.run('UPDATE forms SET option_quotas = ?, option_aliases = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(quotas), JSON.stringify(aliases), u.username, Date.now(), f.id);

    const changes = [];
    if (title !== (found.item.title || '')) changes.push(`題目改名為「${title}」`);
    if (renamed.length) changes.push(`選項改名：${renamed.join('、')}`);
    const added = next.filter(n => !n.from).map(n => n.value);
    if (added.length) changes.push(`新增選項：${added.join('、')}`);
    if (removed.length) changes.push(`刪除選項：${removed.join('、')}`);
    changes.push(Object.keys(limits).length ? `名額：${Object.entries(limits).map(([k, v]) => `${k} ${v}`).join('、')}` : '不限名額');
    db.log(f.org_id, u.username, `修改「${f.title}」的「${title}」：${changes.join('；')}`);
    const row = await limiter.enforce(f.id, '修改選項');
    return { form: formView(row) };
  });

  /**
   * 回覆試算表「發佈到網路」的連結 → 可以嵌入後台的網址。
   * 只接受已發佈的連結（/spreadsheets/d/e/…），一般的編輯連結 Google 不允許嵌入。
   */
  function parseSheetUrl(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    const m = s.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/([\w-]{20,})\//);
    if (!m) {
      if (/docs\.google\.com\/spreadsheets\/d\/[\w-]{20,}/.test(s)) throw httpError(400, '這是試算表的編輯連結。請在試算表按「檔案 → 共用 → 發布到網路」，選「整份文件」和「網頁」，按「發布」，再貼上那個連結。');
      throw httpError(400, '請貼 Google 試算表「發布到網路」的連結，格式是 https://docs.google.com/spreadsheets/d/e/…/pubhtml');
    }
    return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pubhtml?widget=true&headers=false`;
  }

  /**
   * 即時動態：最新的回覆（順位、時間、Email、答案、正取／候補）、最近 48 小時的送出時間。
   * 同一份表單 10 秒內重複查詢用暫存，避免多人同時開著頁面時用光 Google 配額。
   */
  const activityCache = new Map();
  function answerText(a) {
    if (!a) return '';
    if (a.textAnswers) return (a.textAnswers.answers || []).map(x => x.value).join('、');
    if (a.fileUploadAnswers) return `（上傳檔案 ${(a.fileUploadAnswers.answers || []).length} 個）`;
    return '';
  }
  on('GET', '/api/forms/:id/activity', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    const hit = activityCache.get(f.id);
    if (hit && Date.now() - hit.at < 10_000) return hit.data;
    const google = orgGoogle({ id: f.org_id });
    const [full, raw] = await Promise.all([google.getFormFull(f.google_form_id), google.listResponses(f.google_form_id, true)]);
    const questions = [];
    for (const it of full.items || []) {
      const q = it.questionItem && it.questionItem.question;
      if (q && q.questionId) questions.push({ id: q.questionId, title: it.title || '(未命名題目)' });
    }
    const ranked = rankResponses(raw);
    const wl = waitlistOf(ranked, f.max_responses, jsonOf(f.option_quotas, []).filter(q => !q.remove), jsonOf(f.option_aliases, {}));
    const since = Date.now() - 48 * 3600e3;
    const data = {
      at: Date.now(),
      total: ranked.length,
      maxResponses: f.max_responses || null,
      questions,
      recentTimes: ranked.map(r => Date.parse(r.createTime)).filter(t => t >= since),
      items: ranked.slice(-100).reverse().map(r => ({
        rank: r.rank, at: Date.parse(r.createTime), email: r.respondentEmail || '',
        waitlist: wl.has(r.responseId) ? (wl.get(r.responseId).option || '總名額') : null,
        answers: questions.map(q => answerText(r.answers && r.answers[q.id]))
      }))
    };
    activityCache.set(f.id, { at: Date.now(), data });
    return data;
  });

  /** 測試：模擬幾筆送出，看會發生什麼事（不改表單，只寄一封 [測試] 信給自己） */
  on('POST', '/api/forms/:id/simulate', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    const count = Math.max(1, Math.min(50, Number(body.count) || 1));
    const email = String(body.email || u.email || '').trim();
    if (body.sendMail !== false && email && !EMAIL_RE.test(email)) throw httpError(400, '測試 Email 格式不正確。');
    const r = await limiter.simulate(f.id, { choices: body.choices || {}, count, email, sendMail: body.sendMail !== false });
    db.log(f.org_id, u.username, `測試「${f.title}」：模擬 ${count} 筆送出${r.mail.sent ? `，寄測試信到 ${r.mail.to}` : ''}`);
    return r;
  });

  on('GET', '/api/forms/:id/notices', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    return db.all('SELECT * FROM notices WHERE form_id = ? ORDER BY at DESC LIMIT 500', f.id)
      .map(n => ({ kind: n.kind, email: n.email, rank: n.rank, status: n.status, error: n.error, attempts: n.attempts, at: n.at }));
  });

  on('DELETE', '/api/forms/:id', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    db.run('DELETE FROM forms WHERE id = ?', f.id);
    db.log(f.org_id, u.username, `移出管理「${f.title}」（表單維持目前的開關狀態）`);
    return { ok: true };
  });

  /* ---- 紀錄 ---- */
  /** 操作紀錄：只有平台擁有者看得到（平台紀錄與各組織紀錄） */
  on('GET', '/api/logs', async (req, res, { query }) => {
    const u = currentUser(req);
    requireOwner(u);
    const q = query.get('org');
    const rows = q === 'platform'
      ? (requireOwner(u), db.all('SELECT * FROM logs WHERE org_id IS NULL ORDER BY at DESC, id DESC LIMIT 300'))
      : db.all('SELECT * FROM logs WHERE org_id = ? ORDER BY at DESC, id DESC LIMIT 300', orgFor(u, q).id);
    return rows.map(l => ({ at: l.at, who: l.who, what: l.what }));
  });

  on('GET', '/healthz', async () => ({ ok: true }));

  function roleText(r) { return { super: '平台管理員', org_admin: '組織管理員', org_member: '組織成員' }[r] || r; }
  function summary(f) {
    const p = [f.max_responses ? `上限 ${f.max_responses} 份` : '不限名額'];
    if (f.open_at) p.push(`${new Date(f.open_at).toISOString()} 開放`);
    if (f.close_at) p.push(`${new Date(f.close_at).toISOString()} 截止`);
    return p.join('、');
  }

  /* ============ 請求處理 ============ */
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, indexHtml());
      }
      const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!route) return send(res, 404, { error: '找不到這個頁面' });
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'limiter') {
        throw httpError(403, '請求來源不正確。');
      }
      const m = url.pathname.match(route.re);
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const body = req.method === 'GET' ? {} : await readJson(req);
      const out = await route.handler(req, res, { body, params, query: url.searchParams });
      if (out !== null && !res.headersSent) send(res, 200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && status !== 502 && status !== 503) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? '伺服器錯誤，請稍後再試。' : e.message });
    }
  };
}

module.exports = { createApp };
