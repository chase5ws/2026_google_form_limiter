'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { resolveDataDir, resolveKey, createSettings } = require('../../lib/runtime');
const { open } = require('../../lib/db');
const { cipher } = require('../../lib/security');
const { createGoogle } = require('../../lib/google');
const { createMailer } = require('../../lib/mailer');
const { createLimiter } = require('../../lib/limiter');
const { createApp } = require('../../lib/app');

test('資料夾：DATA_DIR > Railway Volume > ./data', () => {
  assert.deepStrictEqual(resolveDataDir({}).dir, './data');
  const v = resolveDataDir({ RAILWAY_PROJECT_ID: 'p', RAILWAY_VOLUME_MOUNT_PATH: '/data' });
  assert.strictEqual(v.dir, '/data'); assert.strictEqual(v.source, 'volume'); assert.ok(v.volumeMounted);
  const nv = resolveDataDir({ RAILWAY_PROJECT_ID: 'p' });
  assert.ok(nv.onRailway && !nv.volumeMounted);
  assert.strictEqual(resolveDataDir({ DATA_DIR: '/x', RAILWAY_VOLUME_MOUNT_PATH: '/data' }).dir, '/x');
});

test('加密金鑰：自動產生、權限 600、重啟後沿用；環境變數優先', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfl-key-'));
  const a = resolveKey({}, dir);
  assert.ok(a.created && a.key.length > 40);
  assert.strictEqual(fs.statSync(a.file).mode & 0o777, 0o600);
  const b = resolveKey({}, dir);
  assert.strictEqual(b.key, a.key);
  assert.ok(!b.created);
  assert.strictEqual(resolveKey({ ENCRYPTION_KEY: 'zzz' }, dir).key, 'zzz');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('網頁設定：Google 用戶端與組織寄信加密存放；只接受 GAS／SMTP；環境變數優先', () => {
  const db = open(':memory:');
  const box = cipher('k');
  const s = createSettings({ env: {}, db, cipher: box });
  assert.strictEqual(s.googleClient().source, null);
  assert.throws(() => s.setGoogleClient({ clientId: 'abc', clientSecret: 'x' }), /apps\.googleusercontent\.com/);
  s.setGoogleClient({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  assert.deepStrictEqual(s.googleClient(), { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', source: 'web' });
  assert.ok(!db.getSetting('cfg_google_client_secret').includes('GOCSPX'), '密鑰有加密');
  // 只改 ID 不給密鑰 → 必須重新輸入密鑰
  assert.throws(() => s.setGoogleClient({ clientId: '999-x.apps.googleusercontent.com' }), /用戶端密鑰/);
  // 同一個 ID 不給密鑰 → 保留原密鑰
  s.setGoogleClient({ clientId: '123-abc.apps.googleusercontent.com' });
  assert.strictEqual(s.googleClient().clientSecret, 'GOCSPX-secret');

  // 組織寄信：只接受 GAS 或 SMTP，加密存放
  db.run("INSERT INTO orgs(name, created_at) VALUES ('o', 0)");
  assert.throws(() => s.setOrgMail(1, { provider: 'resend', from: 'a@b.c', resendKey: 're_x' }) || assert.fail(), /./, 'Resend 已移除');
  s.setOrgMail(1, { provider: 'smtp', from: 'bot@gmail.com', host: 'smtp.gmail.com', port: 465, user: 'bot@gmail.com', pass: 'app-pass' });
  assert.deepStrictEqual(s.orgMailEnv(1), { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'bot@gmail.com', SMTP_PASS: 'app-pass', MAIL_FROM: 'bot@gmail.com' });
  assert.ok(!db.get('SELECT mail_cfg FROM orgs WHERE id = 1').mail_cfg.includes('app-pass'), '密碼有加密');
  assert.ok(!JSON.stringify(s.orgMailView(1)).includes('app-pass'), '網頁看不到密碼');
  s.setOrgMail(1, { provider: 'smtp', from: 'bot@gmail.com', host: 'smtp.gmail.com', port: 465, user: 'bot@gmail.com' });
  assert.strictEqual(s.orgMailEnv(1).SMTP_PASS, 'app-pass', '不重填密碼 → 沿用');
  // 舊版存的 Resend 設定視為未設定
  db.run('UPDATE orgs SET mail_cfg = ? WHERE id = 1', box.encrypt(JSON.stringify({ provider: 'resend', from: 'a@b.c', resendKey: 're_old' })));
  assert.deepStrictEqual(s.orgMailEnv(1), {});
  assert.strictEqual(s.orgMailView(1).provider, 'none');

  const e = createSettings({ env: { GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 's' }, db, cipher: box });
  assert.strictEqual(e.googleClient().source, 'env');
  assert.throws(() => e.setGoogleClient({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'x' }), /環境變數/);
});

test('平台設定 API：檢查清單、網頁設定立即生效、換用戶端會中斷 Google', async () => {
  const db = open(':memory:');
  const box = cipher('k');
  const settings = createSettings({ env: {}, db, cipher: box });
  const google = createGoogle({ getClient: () => settings.googleClient(), redirectUri: 'https://app.example.com/oauth/google/callback', db, cipher: box });
  const limiter = createLimiter({ db, google, log: { error() {} } });
  const handle = createApp({ db, google, limiter, settings,
    runtime: { appUrl: 'https://app.example.com', redirectUri: 'https://app.example.com/oauth/google/callback', onRailway: true, volumeMounted: false, keySource: 'auto' },
    config: { appUrl: 'https://app.example.com' } });
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  try {
    await call('POST', '/api/login', { username: 'chase5ws', password: 'chase5ws' });
    await call('POST', '/api/password', { oldPassword: 'chase5ws', newPassword: 'Setup2026x' });
    let r = await call('GET', '/api/setup');
    assert.strictEqual(r.data.runtime.redirectUri, 'https://app.example.com/oauth/google/callback');
    const ok = Object.fromEntries(r.data.checks.map(c => [c.key, c.ok]));
    assert.deepStrictEqual(ok, { domain: true, volume: false, client: false, connect: false });
    assert.strictEqual(r.data.done, false);
    assert.strictEqual((await call('POST', '/api/google/connect')).status, 503);

    r = await call('PUT', '/api/setup/google', { clientId: '42-x.apps.googleusercontent.com', clientSecret: 'GOCSPX-1' });
    assert.strictEqual(r.data.checks.find(c => c.key === 'client').ok, true);
    const url = new URL((await call('POST', '/api/google/connect')).data.url);
    assert.strictEqual(url.searchParams.get('client_id'), '42-x.apps.googleusercontent.com', '不用重新部署就生效');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://app.example.com/oauth/google/callback');

    db.setSetting('google_refresh_token', box.encrypt('rt'));
    r = await call('PUT', '/api/setup/google', { clientId: '43-y.apps.googleusercontent.com', clientSecret: 'GOCSPX-2' });
    assert.strictEqual(r.data.google.connected, false, '換用戶端後要重新連接');

  } finally { server.close(); }
});

test('ADMIN_PASSWORD：直接登入不用改密碼、可以自己在網頁改、重啟不會蓋掉；換值會再套用（忘記密碼用）', () => {
  const db = open(':memory:');
  const google = { configured: () => false, connected: () => false, email: () => null };
  const sec = require('../../lib/security');
  const mk = (pw) => createApp({ db, google, limiter: {}, config: { appUrl: 'http://x', adminPassword: pw } });
  const user = () => db.get("SELECT * FROM users WHERE username = 'chase5ws'");
  mk('@Start5ws');
  assert.ok(sec.verifyPassword('@Start5ws', user().password_hash));
  assert.strictEqual(user().must_change, 0, '第一次登入不用改密碼');
  assert.ok(!sec.verifyPassword('chase5ws', user().password_hash), '預設密碼不能用');
  // 在網頁上自己改密碼
  db.run("UPDATE users SET password_hash = ? WHERE username = 'chase5ws'", sec.hashPassword('MyOwn2026x'));
  db.run("INSERT INTO login_fails(username, count, until) VALUES ('chase5ws', 5, ?)", Date.now() + 9e5);
  const ver = user().sess_ver;
  mk('@Start5ws');
  assert.ok(sec.verifyPassword('MyOwn2026x', user().password_hash), '同一個值重啟不會蓋掉網頁上改的密碼');
  assert.strictEqual(user().sess_ver, ver);
  // 忘記密碼 → 換一個值
  mk('Rescue2026x');
  assert.ok(sec.verifyPassword('Rescue2026x', user().password_hash));
  assert.strictEqual(user().must_change, 0);
  assert.strictEqual(user().sess_ver, ver + 1, '舊登入失效');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM login_fails').n, 0, '鎖定解除');
});

test('寄信只用組織自己的設定；沒設定就不寄；平台設定只有擁有者能用', async () => {
  const db = open(':memory:');
  const box = cipher('k');
  const settings = createSettings({ env: {}, db, cipher: box });
  const { createFakeGoogle } = require('./fake-google');
  const { gasScript } = require('../../lib/gas-relay');
  const google = createFakeGoogle(); google._connect();
  const deployments = {};
  const routedFetch = async (url, opt) => deployments[url].fetchImpl(url, opt);
  const noMailer = createMailer({});
  const mailerFor = (orgId) => { const e = orgId ? settings.orgMailEnv(orgId) : {}; return e.MAIL_FROM ? createMailer(e, { fetchImpl: routedFetch }) : noMailer; };
  const limiter = createLimiter({ db, google, mailerFor, log: { error() {} } });
  const handle = createApp({ db, google, limiter, mailerFor, settings, config: { appUrl: 'http://x', adminPassword: 'Super2026x', fetchImpl: routedFetch } });
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => { let cookie = ''; return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  }; };
  try {
    const owner = client();
    await owner('POST', '/api/login', { username: 'chase5ws', password: 'Super2026x' });
    const meR = await owner('GET', '/api/me'); assert.ok(meR.data.me, JSON.stringify(meR)); assert.strictEqual(meR.data.me.owner, true);
    await owner('POST', '/api/orgs', { name: '社大', admin: { username: 'org-a', password: 'Alpha2026xx' } });
    const orgs = (await owner('POST', '/api/orgs', { name: '校友會', admin: { username: 'org-b', password: 'Bravo2026xx' } })).data;
    const [A, B] = orgs.map(o => o.id);
    assert.strictEqual(orgs[0].mail.enabled, false);
    assert.strictEqual((await owner('PUT', '/api/setup/mail', { provider: 'smtp' })).status, 404, '平台預設寄信已移除');

    // 平台擁有者可以替組織新增組織管理員，對方可以設定組織寄信
    assert.strictEqual((await owner('POST', '/api/users', { org: A, username: 'org-a2', password: 'Second2026x', role: 'org_admin' })).status, 200);
    const a = client();
    await a('POST', '/api/login', { username: 'org-a2', password: 'Second2026x' });
    await a('POST', '/api/password', { oldPassword: 'Second2026x', newPassword: 'Charlie2026x' });
    const gen = (await a('POST', '/api/mail/gas-script')).data;
    const URLA = 'https://script.google.com/macros/s/AKfycbx_orgA_deployment_000000001/exec';
    deployments[URLA] = fakeGasDeployment(gen.code, { email: 'notice@school.org' });
    let r = await a('PUT', `/api/orgs/${A}/mail`, { provider: 'gas', gasUrl: URLA, gasSecret: gen.secret, gasName: '社大通知' });
    assert.strictEqual(r.data.effective.from, '社大通知 <notice@school.org>');
    assert.strictEqual((await a('GET', `/api/orgs/${B}/mail`)).status, 403, '不能看別的組織');
    assert.strictEqual((await a('PUT', `/api/orgs/${A}/mail`, { provider: 'resend', from: 'x@y.z', resendKey: 're_1' })).data.effective.enabled, false, 'Resend 不再支援 → 視為不寄信');
    await a('PUT', `/api/orgs/${A}/mail`, { provider: 'gas', gasUrl: URLA, gasSecret: gen.secret, gasName: '社大通知' });

    // 兩個組織各有一份滿額表單 → A 用自己的 GAS 寄；B 沒設定 → 不寄
    for (const [org, folder, form] of [[A, 'FA', 'FORM_A_xxxxxxxxxxxxxxxx'], [B, 'FB', 'FORM_B_xxxxxxxxxxxxxxxx']]) {
      google._folder(folder, '表單限額平台'); google._form(form, '講座 ' + org, folder);
      db.run('UPDATE orgs SET shared_folder_id = ?, shared_folder_name = ? WHERE id = ?', folder, '表單限額平台', org);
      const add = await owner('POST', '/api/forms', { org, formId: form });
      await owner('PATCH', '/api/forms/' + add.data.form.id, { maxResponses: 1, notifyEnabled: true });
      google._submit(form, 2);
    }
    await limiter.checkAll();
    assert.deepStrictEqual(deployments[URLA].sent.map(m => [m.to, m.name]), [['p2@example.com', '社大通知']]);
    assert.strictEqual(db.get('SELECT COUNT(*) n FROM notices n JOIN forms f ON f.id = n.form_id WHERE f.org_id = ?', B).n, 0, 'B 沒設定寄信 → 不寄、不記錄');

    // 另一位平台管理員：可以管組織，但不能用平台設定
    await owner('POST', '/api/users', { org: 'platform', username: 'helper', password: 'Assist2026x', role: 'super' });
    db.run("UPDATE users SET must_change = 0 WHERE username = 'helper'");
    const h = client();
    await h('POST', '/api/login', { username: 'helper', password: 'Assist2026x' });
    assert.strictEqual((await h('GET', '/api/me')).data.me.owner, false);
    assert.strictEqual((await h('GET', '/api/orgs')).status, 200);
    assert.strictEqual((await h('POST', '/api/users', { org: B, username: 'org-b2', password: 'Delta2026xx', role: 'org_admin' })).status, 200, '可以替組織建立管理員');
    for (const [m, p, b] of [['GET', '/api/setup'], ['PUT', '/api/setup/google', { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'x' }], ['POST', '/api/google/connect'], ['POST', '/api/google/disconnect'],
      ['PUT', '/api/settings', { folderName: 'x' }], ['GET', '/api/users?org=platform'], ['GET', '/api/logs?org=platform'], ['POST', '/api/users', { org: 'platform', username: 'evil', password: 'Evil2026xxx', role: 'super' }]]) {
      assert.strictEqual((await h(m, p, b)).status, 403, `${m} ${p} 應該只有擁有者能用`);
    }
  } finally { server.close(); }
});

/* 在 Node 裡執行產生出來的 GAS 程式碼（模擬 MailApp / Session / ContentService） */
function fakeGasDeployment(code, { email = 'hia.eca@hia.hcc.edu.tw', quota = 1500 } = {}) {
  const vm = require('node:vm');
  const sent = [];
  const ctx = {
    Session: { getEffectiveUser: () => ({ getEmail: () => email }) },
    MailApp: { getRemainingDailyQuota: () => quota - sent.length, sendEmail: (o) => sent.push(o) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }) },
    Logger: { log() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const fetchImpl = async (url, opt) => {
    const out = vm.runInContext('doPost', ctx)({ postData: { contents: opt.body } });
    return { status: 200, text: async () => out.text };
  };
  return { sent, fetchImpl };
}

test('GAS 寄信中繼：產生程式碼、測試連線抓寄件帳號、用組織帳號寄出、密鑰錯誤會擋', async () => {
  const { gasScript, callGas } = require('../../lib/gas-relay');
  const code = gasScript('S'.repeat(32));
  const dep = fakeGasDeployment(code);
  const URL1 = 'https://script.google.com/macros/s/AKfycbx_abcdefghijklmnopqrstuvwxyz/exec';
  assert.deepStrictEqual(await callGas(URL1, { secret: 'S'.repeat(32), action: 'ping' }, dep.fetchImpl), { ok: true, email: 'hia.eca@hia.hcc.edu.tw', quota: 1500 });
  await assert.rejects(callGas(URL1, { secret: 'wrong', action: 'ping' }, dep.fetchImpl), /密鑰不正確/);
  await assert.rejects(callGas(URL1, { secret: 'x' }, async () => ({ status: 200, text: async () => '<html>Sign in</html>' })), /所有人/);

  // 透過 API 走完整流程
  const db = open(':memory:');
  const box = cipher('k');
  const settings = createSettings({ env: {}, db, cipher: box });
  const { createFakeGoogle } = require('./fake-google');
  const google = createFakeGoogle(); google._connect();
  let deployment = null;
  const routedFetch = async (url, opt) => deployment.fetchImpl(url, opt);
  const mailerFor = (orgId) => { const e = orgId ? settings.orgMailEnv(orgId) : {}; return e.MAIL_FROM ? Object.assign(createMailer(e, { fetchImpl: routedFetch }), { source: 'org' }) : createMailer({}); };
  const limiter = createLimiter({ db, google, mailerFor, log: { error() {} } });
  const handle = createApp({ db, google, limiter, mailerFor, settings, config: { appUrl: 'http://x', adminPassword: 'Super2026x', fetchImpl: routedFetch } });
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  try {
    await call('POST', '/api/login', { username: 'chase5ws', password: 'Super2026x' });
    const orgId = (await call('POST', '/api/orgs', { name: 'HIA', admin: { username: 'hia', password: 'Nice2026xx' } })).data[0].id;
    const gen = (await call('POST', '/api/mail/gas-script')).data;
    assert.ok(gen.secret.length >= 24 && gen.code.includes(gen.secret) && gen.code.includes('function doPost'));
    deployment = fakeGasDeployment(gen.code);

    let r = await call('PUT', `/api/orgs/${orgId}/mail`, { provider: 'gas', gasUrl: 'https://example.com/x', gasSecret: gen.secret });
    assert.match(r.data.error, /網頁應用程式網址/);
    r = await call('PUT', `/api/orgs/${orgId}/mail`, { provider: 'gas', gasUrl: URL1, gasSecret: gen.secret, gasName: 'HIA 報名通知' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.gasCheck.email, 'hia.eca@hia.hcc.edu.tw');
    assert.strictEqual(r.data.effective.from, 'HIA 報名通知 <hia.eca@hia.hcc.edu.tw>');
    assert.strictEqual(r.data.effective.provider, 'gas');
    assert.ok(!JSON.stringify(r.data).includes(gen.secret), '密鑰不會傳回網頁');

    // 不重填密鑰也能再儲存（沿用舊的）
    r = await call('PUT', `/api/orgs/${orgId}/mail`, { provider: 'gas', gasUrl: URL1, gasName: 'HIA' });
    assert.strictEqual(r.status, 200);

    r = await call('POST', `/api/orgs/${orgId}/mail/test`, { to: 'chase.tseng@hia.hcc.edu.tw' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(deployment.sent.map(m => [m.to, m.name]), [['chase.tseng@hia.hcc.edu.tw', 'HIA']]);

    // 候補通知也走 GAS
    google._folder('F', '表單限額平台'); google._form('FORM_HIA_xxxxxxxxxxxxxxxxx', '研習報名', 'F');
    db.run('UPDATE orgs SET shared_folder_id = ?, shared_folder_name = ? WHERE id = ?', 'F', '表單限額平台', orgId);
    const f = (await call('POST', '/api/forms', { org: orgId, formId: 'FORM_HIA_xxxxxxxxxxxxxxxxx' })).data.form;
    await call('PATCH', '/api/forms/' + f.id, { maxResponses: 2, notifyEnabled: true });
    google._submit('FORM_HIA_xxxxxxxxxxxxxxxxx', 3);
    await limiter.checkAll();
    assert.strictEqual(deployment.sent.length, 2);
    assert.strictEqual(deployment.sent[1].to, 'p3@example.com');
    assert.match(deployment.sent[1].subject, /研習報名.*名額已滿/);

    // 部署被換掉（密鑰不同）→ 寄信失敗會記錄、不會當機
    deployment = fakeGasDeployment(gasScript('Z'.repeat(32)));
    r = await call('POST', `/api/orgs/${orgId}/mail/test`, { to: 'a@b.cd' });
    assert.match(r.data.error, /密鑰不正確/);
  } finally { server.close(); }
});
