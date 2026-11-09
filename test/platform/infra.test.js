'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { open } = require('../../lib/db');
const { createLimiter } = require('../../lib/limiter');
const { createFakeGoogle } = require('./fake-google');

test('limiter.stop 會等正在進行的檢查做完再回來', async () => {
  const db = open(':memory:');
  const google = createFakeGoogle(); google._connect();
  google._folder('F', '表單限額平台'); google._form('FORM1', '慢表單', 'F');
  db.run("INSERT INTO orgs(name, created_at) VALUES ('o', 0)");
  db.run("INSERT INTO forms(org_id, title, google_form_id, created_at) VALUES (1, 'x', 'FORM1', 0)");
  const orig = google.getForm;
  google.getForm = async (id) => { await new Promise(r => setTimeout(r, 800)); return orig(id); };
  const limiter = createLimiter({ db, google, log: { error() {} } });
  const p = limiter.enforce(1, 'test');
  const t0 = Date.now();
  const finished = await limiter.stop(5000);
  assert.ok(finished);
  assert.ok(Date.now() - t0 >= 500, '有等待');
  await p;
  assert.strictEqual(db.get('SELECT state FROM forms WHERE id = 1').state, 'open', '資料已寫入');
});

test('SIGTERM：伺服器收尾、寫回磁碟、資料在重啟後還在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfl-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const start = () => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, ENCRYPTION_KEY: 'k', RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '10' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = (proc) => new Promise((r, j) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('已啟動')) r(); });
    proc.on('exit', c => j(new Error('exited ' + c + out)));
  });
  let proc = start();
  await ready(proc);
  const base = `http://127.0.0.1:${port}`;
  const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter' };
  let res = await fetch(base + '/api/login', { method: 'POST', headers: h, body: JSON.stringify({ username: 'chase5ws', password: 'chase5ws' }) });
  let cookie = res.headers.get('set-cookie').split(';')[0];
  res = await fetch(base + '/api/password', { method: 'POST', headers: Object.assign({ Cookie: cookie }, h), body: JSON.stringify({ oldPassword: 'chase5ws', newPassword: 'Persist2026' }) });
  assert.strictEqual(res.status, 200);

  let out = '';
  proc.stdout.on('data', d => { out += d; });
  const exited = new Promise(r => proc.on('exit', (code) => r(code)));
  proc.kill('SIGTERM');
  assert.strictEqual(await exited, 0);
  assert.match(out, /收尾完成/);
  assert.ok(!fs.existsSync(path.join(dir, 'limiter.db-wal')) || fs.statSync(path.join(dir, 'limiter.db-wal')).size === 0, 'WAL 已寫回主檔');

  proc = start();
  await ready(proc);
  res = await fetch(base + '/api/login', { method: 'POST', headers: h, body: JSON.stringify({ username: 'chase5ws', password: 'Persist2026' }) });
  assert.strictEqual(res.status, 200, '重啟後新密碼仍有效');
  assert.strictEqual((await res.json()).me.mustChange, false);
  const ex2 = new Promise(r => proc.on('exit', r));
  proc.kill('SIGTERM');
  await ex2;
  fs.rmSync(dir, { recursive: true, force: true });
});
