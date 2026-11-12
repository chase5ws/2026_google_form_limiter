'use strict';
const http = require('node:http');
const { open } = require('./lib/db');
const { cipher } = require('./lib/security');
const { createGoogleHub } = require('./lib/google');
const { createLimiter } = require('./lib/limiter');
const { createMailer } = require('./lib/mailer');
const { createApp } = require('./lib/app');
const { createDemo } = require('./lib/demo');
const { resolveDataDir, resolveKey, createSettings, migratePlatformGoogle } = require('./lib/runtime');

const env = process.env;
const APP_URL = String(env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/$/, '');
// railway.json 設定 drainingSeconds: 30：收到 SIGTERM 後最多 30 秒會被強制關閉，預留 3 秒給收尾
const DRAIN_MS = Math.max(5, Number(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS || 30) - 3) * 1000;

// 自動偵測：資料夾（Railway Volume）與加密金鑰
const data = resolveDataDir(env);
const key = resolveKey(env, data.dir);
if (data.onRailway && !data.volumeMounted) {
  console.warn('[警告] 沒有偵測到 Railway Volume，資料會在每次部署時消失。請在 Railway 對服務按右鍵 → Attach Volume，掛載路徑填 /data。');
}
if (key.created) console.log(`已自動產生加密金鑰：${key.file}`);

// 這次部署的 commit：Railway 會提供 RAILWAY_GIT_COMMIT_SHA；本機開發時讀 .git
function currentCommit() {
  if (env.RAILWAY_GIT_COMMIT_SHA) return env.RAILWAY_GIT_COMMIT_SHA;
  try {
    const fs = require('node:fs'), path = require('node:path');
    const git = path.join(__dirname, '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    try { return fs.readFileSync(path.join(git, ref), 'utf8').trim(); } catch (e) { /* 可能在 packed-refs */ }
    const line = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split('\n').find(l => l.endsWith(' ' + ref));
    return line ? line.split(' ')[0] : '';
  } catch (e) { return ''; }
}
const COMMIT = currentCommit().slice(0, 7);

const db = open(data.dir);
const box = cipher(key.key);
const settings = createSettings({ db, cipher: box });
const moved = migratePlatformGoogle(db);
if (moved) console.log(`舊版平台共用的 Google 設定已搬到組織「${moved}」。`);
// 每個組織用自己的 Google OAuth 用戶端和帳號；平台只提供這個網站
const realGoogleFor = createGoogleHub({ settings, redirectUri: `${APP_URL}/oauth/google/callback`, db, cipher: box });
// 訪客 Demo（預設開啟，設 DEMO=off 關閉）：沙盒組織用模擬的 Google 和寄信
const DEMO_ON = !/^(off|0|false|no)$/i.test(String(env.DEMO || 'on'));
let limiter = null;
const demo = DEMO_ON ? createDemo({ db, getLimiter: () => limiter }) : null;
const googleFor = (orgId) => (demo && demo.isDemo(orgId) ? demo.google(orgId) : realGoogleFor(orgId));
googleFor.forget = (orgId) => { if (demo && demo.isDemo(orgId)) return demo.forget(orgId); return realGoogleFor.forget(orgId); };
// 寄信：每個組織用自己的 GAS；沒設定就不寄
const noMailer = createMailer({});
function mailerFor(orgId) {
  if (demo && demo.isDemo(orgId)) return demo.mailer(orgId);
  const orgEnv = orgId ? settings.orgMailEnv(orgId) : {};
  return orgEnv.MAIL_FROM ? createMailer(orgEnv) : noMailer;
}
limiter = createLimiter({ db, googleFor, mailerFor, intervalMs: Number(env.CHECK_INTERVAL_SECONDS || 60) * 1000 });
const handle = createApp({
  db, googleFor, limiter, mailerFor, settings, demo,
  runtime: {
    appUrl: APP_URL,
    redirectUri: `${APP_URL}/oauth/google/callback`,
    onRailway: data.onRailway,
    volumeMounted: data.volumeMounted,
    dataDir: data.dir,
    dataSource: data.source,
    keySource: key.source,
    domainFromRailway: !env.APP_URL && !!env.RAILWAY_PUBLIC_DOMAIN
  },
  config: {
    appUrl: APP_URL,
    defaultAdminUser: env.ADMIN_ACCOUNT || env.ADMIN__ACCOUNT || env.DEFAULT_ADMIN_USER,
    defaultAdminPassword: env.DEFAULT_ADMIN_PASSWORD,
    adminPassword: env.ADMIN_PASSWORD,
    resetAdminPassword: env.RESET_ADMIN_PASSWORD,
    commit: COMMIT
  }
});

let draining = false;
const server = http.createServer((req, res) => {
  if (draining) {
    // 部署切換中：不接新的請求，避免做到一半被關掉
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '30', Connection: 'close' });
    return res.end(JSON.stringify({ error: '系統正在更新，請 30 秒後再試。' }));
  }
  handle(req, res);
});
server.listen(Number(env.PORT || 3000), () => {
  console.log(`表單限額管理平台已啟動：${APP_URL}（資料：${data.dir}）`);
  limiter.start();
  if (demo) setInterval(() => { try { demo.tick(); } catch (e) { console.error('demo tick', e); } }, 60_000).unref();
});

/* 優雅關閉：Railway 部署新版時先送 SIGTERM，等 drainingSeconds 後才 SIGKILL */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  draining = true;
  const t0 = Date.now();
  console.log(`[${signal}] 開始收尾，最多 ${DRAIN_MS / 1000} 秒…`);
  const httpDone = new Promise(r => server.close(r));
  if (server.closeIdleConnections) server.closeIdleConnections();
  const finished = await limiter.stop(DRAIN_MS - 2000);
  await Promise.race([httpDone, new Promise(r => setTimeout(r, Math.max(0, DRAIN_MS - (Date.now() - t0)))).then(() => server.closeAllConnections && server.closeAllConnections())]);
  db.close();
  console.log(`收尾完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒${finished ? '' : '，部分檢查被中斷，下次啟動會重新處理'}），資料已寫入磁碟。`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
