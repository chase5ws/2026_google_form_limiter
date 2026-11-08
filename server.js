'use strict';
const http = require('node:http');
const { open } = require('./lib/db');
const { cipher } = require('./lib/security');
const { createGoogle } = require('./lib/google');
const { createLimiter } = require('./lib/limiter');
const { createMailer } = require('./lib/mailer');
const { createApp } = require('./lib/app');
const { resolveDataDir, resolveKey, createSettings } = require('./lib/runtime');

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

const db = open(data.dir);
const box = cipher(key.key);
const settings = createSettings({ env, db, cipher: box });
const google = createGoogle({
  getClient: () => settings.googleClient(),
  redirectUri: `${APP_URL}/oauth/google/callback`,
  db,
  cipher: box
});
const mailer = createMailer(() => settings.mailEnv());
const limiter = createLimiter({ db, google, mailer, intervalMs: Number(env.CHECK_INTERVAL_SECONDS || 60) * 1000 });
const handle = createApp({
  db, google, limiter, mailer, settings,
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
    defaultAdminUser: env.DEFAULT_ADMIN_USER,
    defaultAdminPassword: env.DEFAULT_ADMIN_PASSWORD,
    resetAdminPassword: env.RESET_ADMIN_PASSWORD,
    folderName: env.DRIVE_FOLDER_NAME
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
  console.log(`表單限額管理平台已啟動：${APP_URL}（資料：${data.dir}，寄信：${mailer.provider || '未設定'}）`);
  limiter.start();
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
