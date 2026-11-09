'use strict';
// 執行環境自動偵測：資料夾、加密金鑰，以及各組織在網頁上存的 Google 用戶端／寄信設定
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpError } = require('./security');
const { GAS_URL_RE } = require('./gas-relay');


/** 資料夾：DATA_DIR → Railway Volume 掛載路徑 → ./data */
function resolveDataDir(env) {
  const onRailway = !!(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_SERVICE_ID);
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH || '';
  if (env.DATA_DIR) return { dir: env.DATA_DIR, source: 'env', onRailway, volumeMounted: !!volume, volumePath: volume };
  if (volume) return { dir: volume, source: 'volume', onRailway, volumeMounted: true, volumePath: volume };
  return { dir: './data', source: 'local', onRailway, volumeMounted: false, volumePath: '' };
}

/** 加密金鑰：ENCRYPTION_KEY → 資料夾裡自動產生的 .encryption-key */
function resolveKey(env, dir) {
  if (env.ENCRYPTION_KEY) return { key: env.ENCRYPTION_KEY, source: 'env' };
  if (dir === ':memory:') return { key: crypto.randomBytes(32).toString('base64'), source: 'auto' };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.encryption-key');
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (k) return { key: k, source: 'auto', file };
  } catch (e) { /* 還沒有，下面產生 */ }
  const k = crypto.randomBytes(48).toString('base64');
  fs.writeFileSync(file, k + '\n', { mode: 0o600 });
  return { key: k, source: 'auto', file, created: true };
}

/* ---------- 寄信設定（只有 GAS）：驗證、轉成 mailer 的鍵值、給網頁看的版本 ---------- */
function normalize(input, prev) {
  input = input || {};
  if (input.provider !== 'gas') return null; // 'none' 或舊版的 SMTP／Resend → 不寄
  const url = String(input.gasUrl || '').trim();
  if (!GAS_URL_RE.test(url)) throw httpError(400, '請貼 GAS 的「網頁應用程式網址」，格式是 https://script.google.com/macros/s/…/exec');
  const secret = String(input.gasSecret || '') || (prev.provider === 'gas' ? prev.gasSecret : '');
  if (!secret || secret.length < 24) throw httpError(400, '請先按「產生程式碼」，把程式碼部署到 GAS。');
  const from = String(input.from || '').trim();
  if (!/@/.test(from)) throw httpError(400, '還沒確認 GAS 的寄件帳號。');
  return { provider: 'gas', from, gasUrl: url, gasSecret: secret, gasName: String(input.gasName || '').trim().slice(0, 80) };
}

const cfgToEnv = (c) => (c.provider === 'gas' ? { GAS_URL: c.gasUrl, GAS_SECRET: c.gasSecret, MAIL_FROM: c.from } : {});

function cfgView(c) {
  if (c.provider !== 'gas') c = {}; // 舊版存的 SMTP／Resend 設定視為未設定
  return { provider: c.provider || 'none', from: c.from || '', gasUrl: c.gasUrl || '', gasName: c.gasName || '', hasSecret: !!c.gasSecret };
}

/** 每個組織自己的設定（Google OAuth 用戶端、寄信），加密存在 orgs 資料表 */
function createSettings({ db, cipher }) {
  const dec = (blob) => { try { return blob ? cipher.decrypt(blob) : ''; } catch (e) { return ''; } };
  const orgRow = (orgId) => (orgId ? db.get('SELECT * FROM orgs WHERE id = ?', orgId) : null);

  return {
    /* ---- 組織自己的 Google OAuth 用戶端 ---- */
    orgGoogleClient(orgId) {
      const r = orgRow(orgId);
      if (!r || !r.google_client_id) return { clientId: '', clientSecret: '' };
      return { clientId: r.google_client_id, clientSecret: dec(r.google_client_secret) };
    },
    setOrgGoogleClient(orgId, { clientId, clientSecret }) {
      const r = orgRow(orgId);
      if (!r) throw httpError(404, '找不到這個組織。');
      clientId = String(clientId || '').trim();
      clientSecret = String(clientSecret || '').trim();
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw httpError(400, '用戶端 ID 的格式應該是 …….apps.googleusercontent.com');
      const prev = r.google_client_id;
      if (!clientSecret) {
        if (prev !== clientId || !r.google_client_secret) throw httpError(400, '請輸入用戶端密鑰。');
        db.run('UPDATE orgs SET google_client_id = ? WHERE id = ?', clientId, orgId);
      } else {
        db.run('UPDATE orgs SET google_client_id = ?, google_client_secret = ? WHERE id = ?', clientId, cipher.encrypt(clientSecret), orgId);
      }
      return { changed: !!prev && prev !== clientId };
    },

    /* ---- 組織自己的寄信設定（GAS） ---- */
    orgMailEnv(orgId) {
      const r = orgRow(orgId);
      return r ? cfgToEnv(readCfg(r.mail_cfg)) : {};
    },
    orgMailView(orgId) {
      const r = orgRow(orgId);
      return cfgView(readCfg(r && r.mail_cfg));
    },
    /** 目前存的 GAS 設定（給平台先測試連線用，不會傳到網頁） */
    orgGas(orgId) {
      const c = readCfg((orgRow(orgId) || {}).mail_cfg);
      return c.provider === 'gas' ? { url: c.gasUrl, secret: c.gasSecret } : null;
    },
    setOrgMail(orgId, input) {
      const r = orgRow(orgId);
      if (!r) throw httpError(404, '找不到這個組織。');
      const c = normalize(input, readCfg(r.mail_cfg));
      db.run('UPDATE orgs SET mail_cfg = ? WHERE id = ?', c ? cipher.encrypt(JSON.stringify(c)) : null, orgId);
    }
  };

  function readCfg(blob) {
    try { return JSON.parse(dec(blob) || '{}'); } catch (e) { return {}; }
  }
}

/**
 * 舊版升級：以前 Google 用戶端和帳號是整個平台共用的。
 * 只有一個組織時，直接把它們搬給那個組織（不用重新設定）；有多個組織時無法判斷是誰的，就清掉讓各組織自己連接。
 */
function migratePlatformGoogle(db) {
  const id = db.getSetting('cfg_google_client_id');
  const token = db.getSetting('google_refresh_token');
  if (!id && !token) return null;
  const orgs = db.all('SELECT id, name FROM orgs');
  let movedTo = null;
  if (orgs.length === 1) {
    const o = orgs[0];
    if (id) db.run('UPDATE orgs SET google_client_id = COALESCE(google_client_id, ?), google_client_secret = COALESCE(google_client_secret, ?) WHERE id = ?', id, db.getSetting('cfg_google_client_secret'), o.id);
    if (token && !db.getSetting(`org:${o.id}:google_refresh_token`)) {
      db.setSetting(`org:${o.id}:google_refresh_token`, token);
      db.setSetting(`org:${o.id}:google_email`, db.getSetting('google_email'));
    }
    movedTo = o.name;
  }
  for (const k of ['cfg_google_client_id', 'cfg_google_client_secret', 'google_refresh_token', 'google_email', 'google_connected_at', 'folder_name']) db.setSetting(k, null);
  db.log(null, '系統', movedTo ? `平台共用的 Google 設定已搬到組織「${movedTo}」` : '平台共用的 Google 設定已移除，請各組織在「組織設定」連接自己的 Google 帳號');
  return movedTo;
}

module.exports = { resolveDataDir, resolveKey, createSettings, migratePlatformGoogle };
