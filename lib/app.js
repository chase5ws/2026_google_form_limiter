'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sec = require('./security');
const { REASON_TEXT, DEFAULT_TEMPLATES } = require('./limiter');
const { FOLDER_MIME, FORM_MIME } = require('./google');

const { httpError } = sec;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createApp({ db, google, limiter, mailer = null, settings = null, runtime = {}, config }) {
  const indexHtml = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
  const secureCookie = String(config.appUrl || '').startsWith('https://');

  ensureDefaultSuper();

  /* ============ 啟動：沒有平台管理員就建立預設帳號 ============ */
  function ensureDefaultSuper() {
    const has = db.get("SELECT id FROM users WHERE role = 'super' AND disabled = 0");
    if (has) return;
    const username = String(config.defaultAdminUser || 'chase5ws').toLowerCase();
    const existing = db.get('SELECT id FROM users WHERE username = ?', username);
    const hash = sec.hashPassword(config.defaultAdminPassword || 'chase5ws');
    if (existing) {
      db.run("UPDATE users SET role = 'super', org_id = NULL, password_hash = ?, must_change = 1, disabled = 0, sess_ver = sess_ver + 1 WHERE id = ?", hash, existing.id);
    } else {
      db.run("INSERT INTO users(username, display_name, password_hash, role, must_change, created_at, created_by) VALUES (?, ?, ?, 'super', 1, ?, '系統預設')", username, username, hash, Date.now());
    }
    db.log(null, '系統', `建立預設平台管理員 ${username}`);
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
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
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
    if (scopeParam === 'platform') { requireSuper(u); return { orgId: null, roles: ['super'] }; }
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
    role: u.role, orgId: u.org_id, orgName: u.org_name || null, mustChange: !!u.must_change
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
    count: f.last_count, lastCheck: f.last_check, lastError: f.last_error || '',
    createdBy: f.created_by, createdAt: f.created_at, updatedBy: f.updated_by
  });

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

  /* ============ 組織共用資料夾 ============ */
  const folderUrl = (id) => (id ? `https://drive.google.com/drive/folders/${id}` : null);
  const requiredFolderName = () => db.getSetting('folder_name') || config.folderName || '表單限額平台';
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  function parseFolderId(input) {
    const s = String(input || '').trim();
    const m = s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || s.match(/^([a-zA-Z0-9_-]{10,})$/);
    if (!m) throw httpError(400, '看不懂這個連結。請貼雲端硬碟資料夾的連結，格式是 https://drive.google.com/drive/folders/…');
    return m[1];
  }

  function needFolder(org) {
    if (!org.shared_folder_id) throw httpError(400, '這個組織還沒連結共用資料夾，請先在「表單」分頁完成第一步。');
    return org.shared_folder_id;
  }

  const notShared = () => httpError(400, `平台帳號 ${google.email()} 還沒有這個資料夾的權限。請在雲端硬碟對資料夾按右鍵 →「共用」，把 ${google.email()} 加為「編輯者」。`);

  /* ============ 路由 ============ */  /* ============ 路由 ============ */
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
      google: {
        email: google.email(),
        connected: google.connected(),
        configured: isSuper(u) ? google.configured() : undefined,
        folderName: requiredFolderName()
      },
      mail: { enabled: !!(mailer && mailer.enabled()), provider: mailer ? mailer.provider : null, from: isSuper(u) && mailer ? mailer.from : undefined },
      templates: DEFAULT_TEMPLATES
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

  /* ---- Google 連接（平台管理員） ---- */
  on('POST', '/api/google/connect', async (req) => {
    const u = currentUser(req); requireSuper(u);
    const state = sec.newToken();
    db.setSetting('oauth_state', JSON.stringify({ h: sec.sha256(state), uid: u.id, exp: Date.now() + 10 * 60 * 1000 }));
    return { url: google.authUrl(state) };
  });

  on('GET', '/oauth/google/callback', async (req, res, { query }) => {
    const back = (msg) => { res.writeHead(302, { Location: '/#settings?google=' + encodeURIComponent(msg) }); res.end(); return null; };
    let st = null;
    try { st = JSON.parse(db.getSetting('oauth_state') || 'null'); } catch (e) { st = null; }
    db.setSetting('oauth_state', null);
    if (query.get('error')) return back('Google 回傳：' + query.get('error'));
    if (!st || st.exp < Date.now() || st.h !== sec.sha256(query.get('state') || '')) return back('連接逾時或來源不正確，請重新按「連接 Google」。');
    let u;
    try { u = currentUser(req); } catch (e) { return back('請先登入平台管理員帳號再連接。'); }
    if (!isSuper(u) || u.id !== st.uid) return back('只有平台管理員可以連接 Google。');
    try {
      const email = await google.exchangeCode(query.get('code'));
      db.log(null, u.username, `連接 Google 帳號 ${email}`);
      return back('ok');
    } catch (e) {
      return back(e.message);
    }
  });

  on('POST', '/api/google/disconnect', async (req) => {
    const u = currentUser(req); requireSuper(u);
    const email = google.email();
    google.disconnect();
    db.log(null, u.username, `中斷 Google 帳號 ${email || ''}`);
    return { ok: true };
  });

  /* ---- 組織 ---- */
  function orgList(u) {
    const sql = `SELECT o.*, (SELECT COUNT(*) FROM forms f WHERE f.org_id = o.id) AS form_count,
                 (SELECT COUNT(*) FROM users x WHERE x.org_id = o.id) AS user_count FROM orgs o`;
    const rows = isSuper(u) ? db.all(sql + ' ORDER BY o.id') : db.all(sql + ' WHERE o.id = ?', u.org_id);
    return rows.map(o => ({ id: o.id, name: o.name, disabled: !!o.disabled, forms: o.form_count, users: o.user_count, createdAt: o.created_at,
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
    db.log(null, u.username, `刪除組織「${org.name}」（Google 表單本身保留在雲端硬碟）`);
    return orgList(u);
  });

  /* ---- 組織共用資料夾 ---- */
  on('PUT', '/api/orgs/:id/folder', async (req, res, { body, params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    if (!isSuper(u) && u.role !== 'org_admin') throw httpError(403, '只有組織管理員可以設定共用資料夾。');
    if (!google.connected()) throw httpError(503, '平台還沒連接 Google 帳號，請聯絡平台管理員。');
    const id = parseFolderId(body.url);
    let meta;
    try { meta = await google.fileMeta(id); } catch (e) { if (e.status === 404 || e.status === 403) throw notShared(); throw e; }
    if (meta.trashed) throw httpError(400, '這個資料夾在垃圾桶裡。');
    if (meta.mimeType !== FOLDER_MIME) throw httpError(400, '這個連結不是資料夾。');
    if (!sameName(meta.name, requiredFolderName())) throw httpError(400, `資料夾名稱要叫「${requiredFolderName()}」，目前是「${meta.name}」。請先在雲端硬碟改名再貼一次。`);
    if (!meta.capabilities || !meta.capabilities.canEdit) throw httpError(400, `平台帳號對這個資料夾只有檢視權限，請改成「編輯者」，系統才能開關裡面的表單。`);
    const used = db.get('SELECT name FROM orgs WHERE shared_folder_id = ? AND id != ?', id, org.id);
    if (used) throw httpError(400, `這個資料夾已經連結到「${used.name}」。`);
    const owner = (meta.owners && meta.owners[0] && meta.owners[0].emailAddress) || '';
    db.run('UPDATE orgs SET shared_folder_id = ?, shared_folder_name = ?, shared_folder_owner = ? WHERE id = ?', id, meta.name, owner, org.id);
    db.log(org.id, u.username, `連結共用資料夾「${meta.name}」（擁有者 ${owner || '未知'}）`);
    return orgList(u).find(o => o.id === org.id);
  });

  /** 共用資料夾裡的表單，標出哪些已經在管理 */
  on('GET', '/api/orgs/:id/folder-forms', async (req, res, { params }) => {
    const u = currentUser(req);
    const org = orgFor(u, params.id);
    const folderId = needFolder(org);
    let files;
    try { files = await google.listFolderForms(folderId); } catch (e) { if (e.status === 404 || e.status === 403) throw notShared(); throw e; }
    const managed = new Map(db.all('SELECT google_form_id, org_id FROM forms').map(r => [r.google_form_id, r.org_id]));
    return files.map(f => ({
      id: f.id, name: f.name, modifiedTime: f.modifiedTime, canEdit: !!(f.capabilities && f.capabilities.canEdit),
      managed: managed.has(f.id), managedElsewhere: managed.has(f.id) && managed.get(f.id) !== org.id
    }));
  });

  on('PUT', '/api/settings', async (req, res, { body }) => {
    const u = currentUser(req); requireSuper(u);
    if ('folderName' in body) {
      const n = String(body.folderName || '').trim().slice(0, 100);
      if (!n) throw httpError(400, '請輸入資料夾名稱。');
      db.setSetting('folder_name', n);
      db.log(null, u.username, `把組織共用資料夾名稱設為「${n}」`);
    }
    return { folderName: requiredFolderName() };
  });

  /* ---- 平台設定精靈（平台管理員） ---- */
  function setupView() {
    const gc = settings ? settings.googleClient() : { clientId: '', source: null };
    const mail = settings ? settings.mailView() : { provider: 'none', source: null };
    const checks = [
      { key: 'domain', ok: !!String(runtime.appUrl || '').startsWith('https://'), title: '產生網域', hint: 'Railway → Settings → Networking → Generate Domain' },
      { key: 'volume', ok: !runtime.onRailway || !!runtime.volumeMounted, title: '掛載 Volume', hint: '在 Railway 對服務按右鍵 → Attach Volume，掛載路徑填 /data。沒掛的話每次部署資料都會消失。' },
      { key: 'client', ok: google.configured(), title: '設定 Google 用戶端', hint: '在下方填入 Google Cloud 的 OAuth 用戶端 ID 和密鑰。' },
      { key: 'connect', ok: google.connected(), title: '連接 Google 帳號', hint: '按「連接 Google」，用平台的 Google 帳號登入並允許。' },
      { key: 'mail', ok: !!(mailer && mailer.enabled()), title: '設定寄信（選填）', hint: '要寄候補通知才需要。Railway Hobby 方案請用 Resend。', optional: true }
    ];
    return {
      runtime: {
        appUrl: runtime.appUrl, redirectUri: runtime.redirectUri || google.redirectUri, onRailway: !!runtime.onRailway,
        volumeMounted: !!runtime.volumeMounted, dataDir: runtime.dataDir, dataSource: runtime.dataSource,
        keySource: runtime.keySource, domainFromRailway: !!runtime.domainFromRailway
      },
      google: { clientId: gc.clientId || '', source: gc.source, hasSecret: !!gc.clientSecret, connected: google.connected(), email: google.email() },
      mail,
      checks,
      done: checks.filter(c => !c.optional).every(c => c.ok)
    };
  }

  on('GET', '/api/setup', async (req) => { requireSuper(currentUser(req)); return setupView(); });

  on('PUT', '/api/setup/google', async (req, res, { body }) => {
    const u = currentUser(req); requireSuper(u);
    if (!settings) throw httpError(503, '設定功能未啟用。');
    const r = settings.setGoogleClient(body);
    if (r.changed && google.connected()) google.disconnect();
    db.log(null, u.username, `設定 Google OAuth 用戶端${r.changed ? '（已變更，需要重新連接 Google）' : ''}`);
    return setupView();
  });

  on('PUT', '/api/setup/mail', async (req, res, { body }) => {
    const u = currentUser(req); requireSuper(u);
    if (!settings) throw httpError(503, '設定功能未啟用。');
    settings.setMail(body || {});
    db.log(null, u.username, `設定寄信：${(body && body.provider) || 'none'}`);
    return setupView();
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
    if (!google.connected()) throw httpError(503, '平台還沒連接 Google 帳號，請聯絡平台管理員。');
    const folderId = needFolder(org);
    const formId = parseFormId(body.formId || body.url);
    if (db.get('SELECT id FROM forms WHERE google_form_id = ?', formId)) throw httpError(400, '這份表單已經在管理清單裡了。');

    let meta;
    try { meta = await google.fileMeta(formId); } catch (e) {
      if (e.status === 404 || e.status === 403) throw httpError(400, `找不到這份表單，或平台帳號沒有權限。請確認表單放在共用資料夾「${org.shared_folder_name}」裡。`);
      throw e;
    }
    if (meta.mimeType !== FORM_MIME) throw httpError(400, '這個連結不是 Google 表單。');
    if (meta.trashed) throw httpError(400, '這份表單在垃圾桶裡。');
    if (!(meta.parents || []).includes(folderId)) throw httpError(400, `這份表單不在共用資料夾「${org.shared_folder_name}」裡。請先把表單移進資料夾再加入。`);
    if (!meta.capabilities || !meta.capabilities.canEdit) throw httpError(400, '平台帳號對這份表單沒有編輯權限。請確認資料夾是用「編輯者」權限共用的。');

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
    for (const [k, col, max] of [['waitlistSubject', 'notify_waitlist_subject', 200], ['waitlistBody', 'notify_waitlist_body', 5000],
                                 ['promoteSubject', 'notify_promote_subject', 200], ['promoteBody', 'notify_promote_body', 5000]]) {
      if (k in body) set[col] = String(body[k] || '').trim().slice(0, max) || null;
    }
    const willNotify = 'notify_enabled' in set ? set.notify_enabled : f.notify_enabled;
    const maxAfter = 'max_responses' in set ? set.max_responses : f.max_responses;
    if (willNotify && !maxAfter) throw httpError(400, '要先設定名額上限，才能寄候補通知。');
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
    return google.formQuestions(f.google_form_id);
  });

  on('GET', '/api/forms/:id/notices', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    return db.all('SELECT * FROM notices WHERE form_id = ? ORDER BY at DESC LIMIT 500', f.id)
      .map(n => ({ kind: n.kind, email: n.email, rank: n.rank, status: n.status, error: n.error, attempts: n.attempts, at: n.at }));
  });

  /** 平台管理員寄測試信 */
  on('POST', '/api/mail/test', async (req, res, { body }) => {
    const u = currentUser(req); requireSuper(u);
    if (!mailer || !mailer.enabled()) throw httpError(400, '伺服器還沒設定寄信（SMTP_HOST 或 RESEND_API_KEY，以及 MAIL_FROM）。');
    if (!body.to) throw httpError(400, '請輸入收件 Email。');
    const to = cleanEmails([body.to])[0];
    try {
      await mailer.send({ to, subject: '表單限額管理平台：測試信', text: `這是一封測試信。\n\n寄送方式：${mailer.provider}\n時間：${new Date().toISOString()}` });
    } catch (e) { throw httpError(502, e.message); }
    db.log(null, u.username, `寄測試信到 ${to}`);
    return { ok: true };
  });

  on('DELETE', '/api/forms/:id', async (req, res, { params }) => {
    const u = currentUser(req);
    const f = formFor(u, params.id);
    db.run('DELETE FROM forms WHERE id = ?', f.id);
    db.log(f.org_id, u.username, `移出管理「${f.title}」（表單維持目前的開關狀態）`);
    return { ok: true };
  });

  /* ---- 紀錄 ---- */
  on('GET', '/api/logs', async (req, res, { query }) => {
    const u = currentUser(req);
    const q = query.get('org');
    const rows = q === 'platform'
      ? (requireSuper(u), db.all('SELECT * FROM logs WHERE org_id IS NULL ORDER BY at DESC, id DESC LIMIT 300'))
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
