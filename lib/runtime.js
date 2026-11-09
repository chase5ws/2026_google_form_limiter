'use strict';
// 執行環境自動偵測：資料夾、加密金鑰，以及「平台設定」網頁上存的 Google / 寄信設定
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpError } = require('./security');
const { GAS_URL_RE } = require('./gas-relay');

const MAIL_KEYS = ['RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

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

/* ---------- 寄信設定共用：驗證、轉成 mailer 的鍵值、給網頁看的版本 ---------- */
function normalize(input, prev, label) {
  input = input || {};
  const provider = ['gas', 'resend', 'smtp', 'none'].includes(input.provider) ? input.provider : 'none';
  if (provider === 'none') return null;
  if (provider === 'gas') {
    const url = String(input.gasUrl || '').trim();
    if (!GAS_URL_RE.test(url)) throw httpError(400, '請貼 GAS 的「網頁應用程式網址」，格式是 https://script.google.com/macros/s/…/exec');
    const secret = String(input.gasSecret || '') || (prev.provider === 'gas' ? prev.gasSecret : '');
    if (!secret || secret.length < 24) throw httpError(400, '請先按「產生程式碼」，把程式碼部署到 GAS。');
    const from = String(input.from || '').trim();
    if (!/@/.test(from)) throw httpError(400, '還沒確認 GAS 的寄件帳號。');
    return { provider, from, gasUrl: url, gasSecret: secret, gasName: String(input.gasName || '').trim().slice(0, 80) };
  }
  const from = String(input.from || '').trim();
  if (!from || !/@/.test(from)) throw httpError(400, `請輸入寄件者，例如：${label} <noreply@你的網域>`);
  if (provider === 'resend') {
    const key = String(input.resendKey || '').trim() || (prev.provider === 'resend' ? prev.resendKey : '');
    if (!/^re_\w+/.test(key || '')) throw httpError(400, '請輸入 Resend API Key（re_ 開頭）。');
    return { provider, from, resendKey: key };
  }
  const host = String(input.host || '').trim();
  const port = Number(input.port || 587);
  if (!host) throw httpError(400, '請輸入 SMTP 主機，例如 smtp.gmail.com');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'SMTP 連接埠不正確。');
  const pass = String(input.pass || '') || (prev.provider === 'smtp' ? prev.pass : '');
  if (!pass) throw httpError(400, '請輸入 SMTP 密碼（Gmail 請用應用程式密碼）。');
  return { provider, from, host, port, secure: port === 465, user: String(input.user || '').trim(), pass };
}

function cfgToEnv(c) {
  if (c.provider === 'gas') return { GAS_URL: c.gasUrl, GAS_SECRET: c.gasSecret, MAIL_FROM: c.from };
  if (c.provider === 'resend') return { RESEND_API_KEY: c.resendKey, MAIL_FROM: c.from };
  if (c.provider === 'smtp') return { SMTP_HOST: c.host, SMTP_PORT: String(c.port || ''), SMTP_SECURE: c.secure == null ? '' : String(!!c.secure), SMTP_USER: c.user, SMTP_PASS: c.pass, MAIL_FROM: c.from };
  return {};
}

function cfgView(c, source) {
  return { provider: c.provider || 'none', from: c.from || '', host: c.host || '', port: c.port || '', user: c.user || '', secure: c.secure,
    gasUrl: c.gasUrl || '', gasName: c.gasName || '', hasSecret: !!(c.resendKey || c.pass || c.gasSecret), source: c.provider ? source : null };
}

/** 網頁上存的設定（加密），環境變數有設定時以環境變數為準 */
function createSettings({ env, db, cipher }) {
  const dec = (blob) => { try { return blob ? cipher.decrypt(blob) : ''; } catch (e) { return ''; } };
  const mailFromEnv = () => MAIL_KEYS.some(k => k !== 'MAIL_FROM' && env[k]);

  return {
    googleClient() {
      if (env.GOOGLE_CLIENT_ID) return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET || '', source: 'env' };
      const id = db.getSetting('cfg_google_client_id');
      if (!id) return { clientId: '', clientSecret: '', source: null };
      return { clientId: id, clientSecret: dec(db.getSetting('cfg_google_client_secret')), source: 'web' };
    },
    setGoogleClient({ clientId, clientSecret }) {
      if (env.GOOGLE_CLIENT_ID) throw httpError(400, 'Google 用戶端目前由 Railway 環境變數設定，要改請到 Railway 修改或刪除那兩個變數。');
      clientId = String(clientId || '').trim();
      clientSecret = String(clientSecret || '').trim();
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw httpError(400, '用戶端 ID 的格式應該是 …….apps.googleusercontent.com');
      const prev = db.getSetting('cfg_google_client_id');
      if (!clientSecret) {
        if (prev !== clientId || !db.getSetting('cfg_google_client_secret')) throw httpError(400, '請輸入用戶端密鑰。');
      } else {
        db.setSetting('cfg_google_client_secret', cipher.encrypt(clientSecret));
      }
      db.setSetting('cfg_google_client_id', clientId);
      return { changed: !!prev && prev !== clientId };
    },

    /** 回傳 mailer 需要的鍵值 */
    mailEnv() {
      if (mailFromEnv()) {
        const o = {}; MAIL_KEYS.forEach(k => { if (env[k]) o[k] = env[k]; }); return o;
      }
      return cfgToEnv(readCfg(db.getSetting('cfg_mail')));
    },
    mailSource() { return mailFromEnv() ? 'env' : (db.getSetting('cfg_mail') ? 'web' : null); },
    /** 給網頁顯示用，不含密碼 */
    mailView() {
      if (mailFromEnv()) return { provider: env.RESEND_API_KEY ? 'resend' : 'smtp', from: env.MAIL_FROM || env.SMTP_USER || '', host: env.SMTP_HOST || '', port: env.SMTP_PORT || '', user: env.SMTP_USER || '', hasSecret: true, source: 'env' };
      return cfgView(readCfg(db.getSetting('cfg_mail')), 'web');
    },
    setMail(input) {
      if (mailFromEnv()) throw httpError(400, '寄信目前由 Railway 環境變數設定，要改請到 Railway 修改或刪除那些變數。');
      const c = normalize(input, readCfg(db.getSetting('cfg_mail')), '表單平台');
      db.setSetting('cfg_mail', c ? cipher.encrypt(JSON.stringify(c)) : null);
    },

    /* ---- 每個組織自己的寄信設定（存在 orgs.mail_cfg，加密） ---- */
    orgMailEnv(orgId) {
      const r = orgId ? db.get('SELECT mail_cfg FROM orgs WHERE id = ?', orgId) : null;
      return r ? cfgToEnv(readCfg(r.mail_cfg)) : {};
    },
    orgMailView(orgId) {
      const r = db.get('SELECT mail_cfg FROM orgs WHERE id = ?', orgId);
      return cfgView(readCfg(r && r.mail_cfg), 'org');
    },
    /** 目前存的 GAS 設定（給平台先測試連線用，不會傳到網頁） */
    orgGas(orgId) {
      const r = db.get('SELECT mail_cfg FROM orgs WHERE id = ?', orgId);
      const c = readCfg(r && r.mail_cfg);
      return c.provider === 'gas' ? { url: c.gasUrl, secret: c.gasSecret } : null;
    },
    setOrgMail(orgId, input) {
      const r = db.get('SELECT name, mail_cfg FROM orgs WHERE id = ?', orgId);
      if (!r) throw httpError(404, '找不到這個組織。');
      const c = normalize(input, readCfg(r.mail_cfg), r.name);
      db.run('UPDATE orgs SET mail_cfg = ? WHERE id = ?', c ? cipher.encrypt(JSON.stringify(c)) : null, orgId);
    }
  };

  function readCfg(blob) {
    try { return JSON.parse(dec(blob) || '{}'); } catch (e) { return {}; }
  }
}

module.exports = { resolveDataDir, resolveKey, createSettings, MAIL_KEYS };
