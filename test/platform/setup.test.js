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

test('網頁設定：Google 用戶端與寄信加密存放；環境變數優先且不可在網頁改', () => {
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

  assert.throws(() => s.setMail({ provider: 'resend', from: 'a@b.c', resendKey: 'bad' }), /re_/);
  s.setMail({ provider: 'resend', from: '平台 <noreply@ex.com>', resendKey: 're_abc123' });
  assert.deepStrictEqual(s.mailEnv(), { RESEND_API_KEY: 're_abc123', MAIL_FROM: '平台 <noreply@ex.com>' });
  assert.ok(!db.getSetting('cfg_mail').includes('re_abc123'), '寄信金鑰有加密');
  assert.strictEqual(s.mailView().hasSecret, true);
  assert.ok(!JSON.stringify(s.mailView()).includes('re_abc123'), '網頁看不到金鑰');
  s.setMail({ provider: 'resend', from: 'x@ex.com' }); // 不重填金鑰 → 沿用
  assert.strictEqual(s.mailEnv().RESEND_API_KEY, 're_abc123');
  s.setMail({ provider: 'smtp', from: 'bot@gmail.com', host: 'smtp.gmail.com', port: 465, user: 'bot@gmail.com', pass: 'app-pass' });
  assert.deepStrictEqual(s.mailEnv(), { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'bot@gmail.com', SMTP_PASS: 'app-pass', MAIL_FROM: 'bot@gmail.com' });

  const e = createSettings({ env: { GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 's', RESEND_API_KEY: 're_env', MAIL_FROM: 'e@x.com' }, db, cipher: box });
  assert.strictEqual(e.googleClient().source, 'env');
  assert.throws(() => e.setGoogleClient({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'x' }), /環境變數/);
  assert.strictEqual(e.mailEnv().RESEND_API_KEY, 're_env');
  assert.throws(() => e.setMail({ provider: 'none' }), /環境變數/);
});

test('平台設定 API：檢查清單、網頁設定立即生效、換用戶端會中斷 Google', async () => {
  const db = open(':memory:');
  const box = cipher('k');
  const settings = createSettings({ env: {}, db, cipher: box });
  const google = createGoogle({ getClient: () => settings.googleClient(), redirectUri: 'https://app.example.com/oauth/google/callback', db, cipher: box });
  const mailer = createMailer(() => settings.mailEnv());
  const limiter = createLimiter({ db, google, mailer, log: { error() {} } });
  const handle = createApp({ db, google, limiter, mailer, settings,
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
    assert.deepStrictEqual(ok, { domain: true, volume: false, client: false, connect: false, mail: false });
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

    r = await call('PUT', '/api/setup/mail', { provider: 'resend', from: 'noreply@ex.com', resendKey: 're_live' });
    assert.strictEqual(r.data.checks.find(c => c.key === 'mail').ok, true);
    assert.strictEqual(mailer.provider, 'resend');
    assert.ok(!JSON.stringify(r.data).includes('re_live'));
    const me = (await call('GET', '/api/me')).data;
    assert.strictEqual(me.mail.enabled, true);
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

test('每個組織用自己的寄信帳號；沒設定時用平台預設；成員不能看設定', async () => {
  const db = open(':memory:');
  const box = cipher('k');
  const settings = createSettings({ env: {}, db, cipher: box });
  const { createFakeGoogle } = require('./fake-google');
  const google = createFakeGoogle(); google._connect();
  const sent = [];
  const fakeFetch = async (url, opt) => { const b = JSON.parse(opt.body); sent.push({ key: opt.headers.Authorization, from: b.from, to: b.to[0], subject: b.subject }); return { ok: true, json: async () => ({}) }; };
  const platformMailer = Object.assign(createMailer(() => settings.mailEnv(), { fetchImpl: fakeFetch }), { source: 'platform' });
  const mailerFor = (orgId) => {
    const e = orgId ? settings.orgMailEnv(orgId) : {};
    return e.MAIL_FROM ? Object.assign(createMailer(e, { fetchImpl: fakeFetch }), { source: 'org' }) : platformMailer;
  };
  const limiter = createLimiter({ db, google, mailerFor, log: { error() {} } });
  const handle = createApp({ db, google, limiter, mailerFor, settings, config: { appUrl: 'http://x', adminPassword: 'Super2026x' } });
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => { let cookie = ''; return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  }; };
  try {
    const su = client();
    await su('POST', '/api/login', { username: 'chase5ws', password: 'Super2026x' });
    await su('POST', '/api/orgs', { name: '社大', admin: { username: 'org-a', password: 'OrgA2026xx' } });
    const orgs = (await su('POST', '/api/orgs', { name: '校友會', admin: { username: 'org-b', password: 'OrgB2026xx' } })).data;
    const [A, B] = orgs.map(o => o.id);
    assert.strictEqual(orgs[0].mail.enabled, false, '平台和組織都沒設定');

    // 平台預設
    await su('PUT', '/api/setup/mail', { provider: 'resend', from: '平台 <noreply@platform.com>', resendKey: 're_platform' });
    // 組織 A 自己的
    const a = client();
    await a('POST', '/api/login', { username: 'org-a', password: 'OrgA2026xx' });
    await a('POST', '/api/password', { oldPassword: 'OrgA2026xx', newPassword: 'OrgAown2026' });
    let r = await a('PUT', `/api/orgs/${A}/mail`, { provider: 'resend', from: '社大 <hi@school.org>', resendKey: 're_school' });
    assert.strictEqual(r.data.effective.source, 'org');
    assert.strictEqual(r.data.effective.from, '社大 <hi@school.org>');
    assert.ok(!JSON.stringify(r.data).includes('re_school'), '看不到金鑰');
    assert.strictEqual((await a('GET', `/api/orgs/${B}/mail`)).status, 403, '不能看別的組織');
    assert.strictEqual((await a('GET', '/api/me')).data.mail.source, 'org');

    // 組織成員不能看寄信設定
    await a('POST', '/api/users', { org: A, username: 'staff-a', password: 'StaffA2026', role: 'org_member' });
    db.run("UPDATE users SET must_change = 0 WHERE username = 'staff-a'");
    const m = client();
    await m('POST', '/api/login', { username: 'staff-a', password: 'StaffA2026' });
    assert.strictEqual((await m('GET', `/api/orgs/${A}/mail`)).status, 403);

    // 兩個組織各有一份滿額表單 → A 用自己的帳號寄，B 用平台預設
    for (const [org, folder, form] of [[A, 'FA', 'FORM_A_xxxxxxxxxxxxxxxx'], [B, 'FB', 'FORM_B_xxxxxxxxxxxxxxxx']]) {
      google._folder(folder, '表單限額平台'); google._form(form, '講座 ' + org, folder);
      db.run('UPDATE orgs SET shared_folder_id = ?, shared_folder_name = ? WHERE id = ?', folder, '表單限額平台', org);
      const add = await su('POST', '/api/forms', { org, formId: form });
      await su('PATCH', '/api/forms/' + add.data.form.id, { maxResponses: 1, notifyEnabled: true });
      google._submit(form, 2);
    }
    await limiter.checkAll();
    const byKey = Object.fromEntries(sent.map(x => [x.key, x.from]));
    assert.strictEqual(byKey['Bearer re_school'], '社大 <hi@school.org>', '組織 A 用自己的帳號');
    assert.strictEqual(byKey['Bearer re_platform'], '平台 <noreply@platform.com>', '組織 B 沒設定 → 平台預設');

    // A 改回不寄信設定 → 退回平台預設
    r = await a('PUT', `/api/orgs/${A}/mail`, { provider: 'none' });
    assert.strictEqual(r.data.effective.source, 'platform');
    // 測試信
    await a('PUT', `/api/orgs/${A}/mail`, { provider: 'resend', from: 'hi@school.org', resendKey: 're_school' });
    r = await a('POST', `/api/orgs/${A}/mail/test`, { to: 'me@school.org' });
    assert.strictEqual(r.data.source, 'org');
    assert.strictEqual(sent[sent.length - 1].key, 'Bearer re_school');
  } finally { server.close(); }
});

test('ADMIN_ACCOUNT + ADMIN_PASSWORD：自訂帳號直接登入；換帳號會建立新的平台管理員', () => {
  const db = open(':memory:');
  const google = { configured: () => false, connected: () => false, email: () => null };
  const sec = require('../../lib/security');
  const mk = (user, pw) => createApp({ db, google, limiter: {}, config: { appUrl: 'http://x', defaultAdminUser: user, adminPassword: pw } });
  mk('Boss.Admin', 'Strong#2026');
  const u = db.get("SELECT * FROM users WHERE username = 'boss.admin'");
  assert.ok(u, '帳號轉小寫建立');
  assert.strictEqual(u.role, 'super');
  assert.strictEqual(u.must_change, 0);
  assert.ok(sec.verifyPassword('Strong#2026', u.password_hash));
  assert.strictEqual(db.get("SELECT COUNT(*) n FROM users WHERE username = 'chase5ws'").n, 0, '有設 ADMIN_ACCOUNT 就不會另外建 chase5ws');
  mk('second', 'Strong#2026');
  const v = db.get("SELECT * FROM users WHERE username = 'second'");
  assert.ok(v && v.role === 'super' && sec.verifyPassword('Strong#2026', v.password_hash), '換帳號（密碼相同）也會套用');
  mk('bad name!', 'x');
  assert.ok(db.get("SELECT id FROM users WHERE username = 'chase5ws'"), '格式錯誤時退回 chase5ws');
});
