'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { open } = require('../../lib/db');
const { createLimiter } = require('../../lib/limiter');
const { createApp } = require('../../lib/app');
const { createDemo } = require('../../lib/demo');
const { createFakeGoogle } = require('./fake-google');

function boot() {
  const db = open(':memory:');
  let limiter = null;
  const demo = createDemo({ db, getLimiter: () => limiter });
  const real = new Map();
  const realFor = (id) => { id = Number(id); if (!real.has(id)) real.set(id, createFakeGoogle({ email: `org${id}@example.com` })); return real.get(id); };
  const googleFor = (id) => (demo.isDemo(id) ? demo.google(id) : realFor(id));
  const noMail = { enabled: () => false, provider: null, from: '' };
  const mailerFor = (id) => (demo.isDemo(id) ? demo.mailer(id) : noMail);
  limiter = createLimiter({ db, googleFor, mailerFor, log: { error() {} } });
  const handle = createApp({ db, googleFor, limiter, mailerFor, demo, config: { appUrl: 'http://localhost' } });
  const server = http.createServer(handle);
  return new Promise(r => server.listen(0, () => r({ db, demo, server, base: `http://127.0.0.1:${server.address().port}` })));
}

function client(base) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Requested-With': 'limiter' }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

test('訪客 Demo：建立沙盒、看得到範例資料、不能改敏感設定、登出就刪除', async () => {
  const { db, demo, server, base } = await boot();
  try {
    const call = client(base);
    assert.deepStrictEqual((await call('GET', '/api/demo')).body, { enabled: true, hours: 2 });

    const login = await call('POST', '/api/demo');
    assert.strictEqual(login.status, 200);
    const me = login.body.me;
    assert.ok(me.demo && me.demo.expiresAt > Date.now(), '標記為 Demo');
    assert.strictEqual(me.role, 'org_admin');

    // Google 已連接（模擬）、資料夾已設定、寄信已設定
    const orgs = (await call('GET', '/api/orgs')).body;
    assert.strictEqual(orgs.length, 1);
    assert.ok(orgs[0].google.connected && orgs[0].folder && orgs[0].mail.enabled);

    // 三份管理中的表單，初始化時已經跑過檢查
    const forms = (await call('GET', '/api/forms?org=' + me.orgId)).body;
    const list = forms.forms || forms;
    assert.strictEqual(list.length, 3);
    const camp = list.find(f => f.title === '寒假社團體驗營');
    assert.strictEqual(camp.state, 'closed', '名額 20、已有 24 份 → 關閉');
    assert.strictEqual(camp.notify.stats.waitlist, 4, '第 21–24 名收到候補信（模擬）');
    const vol = list.find(f => f.title === '春季志工招募');
    assert.strictEqual(vol.state, 'closed', '還沒到開放時間');
    const talk = list.find(f => f.title === '十二月親子講座報名');
    assert.strictEqual(talk.state, 'open');
    assert.ok(talk.optionQuotas[0].options.find(o => o.value.startsWith('上午場')).hidden, '上午場 16 人 > 15 → 從表單移除');

    // 資料夾裡還有一份沒加入管理的表單，可以試「加入管理」
    const ff = (await call('GET', `/api/orgs/${me.orgId}/folder-forms`)).body;
    const party = ff.find(f => !f.managed);
    assert.ok(party);
    const added = await call('POST', '/api/forms', { org: me.orgId, formId: party.id });
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));

    // 可以改表單設定
    const patched = await call('PATCH', '/api/forms/' + camp.id, { maxResponses: 30 });
    assert.strictEqual(patched.body.form.state, 'open');

    // 敏感操作都擋住
    for (const [m, p, b] of [
      ['POST', '/api/password', { oldPassword: 'x', newPassword: 'abc12345' }],
      ['POST', `/api/orgs/${me.orgId}/google/connect`],
      ['POST', `/api/orgs/${me.orgId}/google/disconnect`],
      ['PUT', `/api/orgs/${me.orgId}/folder`, { url: 'https://drive.google.com/drive/folders/abcdefghijk' }],
      ['PUT', `/api/orgs/${me.orgId}/mail`, { provider: 'none' }],
      ['POST', '/api/users', { org: me.orgId, username: 'hacker', password: 'abc12345x' }],
      ['GET', '/api/logs?org=' + me.orgId]
    ]) {
      const r = await call(m, p, b);
      assert.strictEqual(r.status, 403, `${m} ${p} 應該被擋`);
    }

    // 平台管理員看不到沙盒組織
    const admin = client(base);
    await admin('POST', '/api/login', { username: 'chase5ws', password: 'chase5ws' });
    await admin('POST', '/api/password', { oldPassword: 'chase5ws', newPassword: 'Owner12345' });
    assert.strictEqual((await admin('GET', '/api/orgs')).body.length, 0);

    // 另一位訪客有自己的沙盒
    const other = client(base);
    const o2 = (await other('POST', '/api/demo')).body.me;
    assert.notStrictEqual(o2.orgId, me.orgId);
    assert.strictEqual((await other('GET', '/api/forms/' + camp.id + '/notices')).status, 403, '看不到別人的沙盒');

    // 每分鐘的模擬新報名不會出錯
    demo.tick();

    // 結束體驗：沙盒刪除
    await call('POST', '/api/logout');
    assert.strictEqual(db.get('SELECT COUNT(*) n FROM orgs WHERE id = ?', me.orgId).n, 0);
    assert.strictEqual(db.get('SELECT COUNT(*) n FROM forms WHERE org_id = ?', me.orgId).n, 0);
    assert.strictEqual(demo.isDemo(me.orgId), false);

    // 過期的沙盒會被清掉
    db.run('UPDATE orgs SET demo_expires = 1 WHERE id = ?', o2.orgId);
    demo.tick();
    assert.strictEqual((await other('GET', '/api/me')).status, 401);
  } finally {
    server.close();
  }
});

test('沒有傳 demo 時不開放訪客體驗', async () => {
  const db = open(':memory:');
  const handle = createApp({ db, googleFor: () => createFakeGoogle(), limiter: {}, config: { appUrl: 'http://localhost' } });
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  try {
    const call = client(`http://127.0.0.1:${server.address().port}`);
    assert.strictEqual((await call('GET', '/api/demo')).body.enabled, false);
    assert.strictEqual((await call('POST', '/api/demo')).status, 404);
  } finally { server.close(); }
});
