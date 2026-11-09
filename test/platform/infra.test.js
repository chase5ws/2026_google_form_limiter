'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createMailer } = require('../../lib/mailer');
const { open } = require('../../lib/db');
const { createLimiter } = require('../../lib/limiter');
const { createFakeGoogle } = require('./fake-google');

/** 極簡 SMTP 伺服器：記錄收到的指令與信件內容 */
function fakeSmtp() {
  const log = { cmds: [], data: '' };
  const server = net.createServer((sock) => {
    let inData = false, buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else log.data += line + '\n';
          continue;
        }
        log.cmds.push(line);
        if (/^EHLO/.test(line)) sock.write('250-fake\r\n250-SIZE 1000000\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) sock.write(Buffer.from(line.slice(11), 'base64').toString() === '\0bot@example.com\0secret' ? '235 ok\r\n' : '535 bad\r\n');
        else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT TO/.test(line)) sock.write(line.includes('reject') ? '550 no such user\r\n' : '250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 ?\r\n');
      }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, log, port: server.address().port })));
}

test('SMTP：認證、中文主旨與內容、錯誤回報', async () => {
  const s = await fakeSmtp();
  try {
    const mailer = createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_SECURE: 'false', SMTP_USER: 'bot@example.com', SMTP_PASS: 'secret', MAIL_FROM: '表單平台 <bot@example.com>' });
    assert.strictEqual(mailer.provider, 'smtp');
    await mailer.send({ to: 'p5@example.com', subject: '「講座」名額已滿通知', text: '您好：\n第 5 位' });
    assert.ok(s.log.cmds.includes('MAIL FROM:<bot@example.com>'));
    assert.ok(s.log.cmds.includes('RCPT TO:<p5@example.com>'));
    const subj = s.log.data.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)[1];
    assert.strictEqual(Buffer.from(subj, 'base64').toString(), '「講座」名額已滿通知');
    const body = s.log.data.split('\n\n')[1].replace(/\n/g, '');
    assert.strictEqual(Buffer.from(body, 'base64').toString(), '您好：\r\n第 5 位');
    await assert.rejects(mailer.send({ to: 'reject@example.com', subject: 'x', text: 'y' }), /550/);
    const bad = createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_SECURE: 'false', SMTP_USER: 'bot@example.com', SMTP_PASS: 'wrong', MAIL_FROM: 'bot@example.com' });
    await assert.rejects(bad.send({ to: 'a@example.com', subject: 'x', text: 'y' }), /535/);
  } finally { s.server.close(); }
});

test('SMTP 連不上時，錯誤訊息會說明是 Railway 封鎖或主機打錯', async () => {
  const net2 = require('node:net');
  const srv = net2.createServer(); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; srv.close(); await new Promise(r => setTimeout(r, 50));
  const m = createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_USER: 'a', SMTP_PASS: 'b', MAIL_FROM: 'a@b.c' });
  await assert.rejects(m.send({ to: 'x@y.z', subject: 's', text: 't' }), /ECONNREFUSED.*Railway.*Redeploy/);
  const m2 = createMailer({ SMTP_HOST: 'no-such-host.invalid', SMTP_PORT: '465', SMTP_USER: 'a', SMTP_PASS: 'b', MAIL_FROM: 'a@b.c' });
  await assert.rejects(m2.send({ to: 'x@y.z', subject: 's', text: 't' }), /找不到主機|Railway/);
});

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
