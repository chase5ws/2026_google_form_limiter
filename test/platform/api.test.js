'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { open } = require('../../lib/db');
const { createLimiter } = require('../../lib/limiter');
const { createApp } = require('../../lib/app');
const { createFakeGoogle } = require('./fake-google');

function fakeMailer() {
  const sent = [];
  let failNext = 0;
  return {
    sent, provider: 'fake', from: 'noreply@example.com',
    enabled: () => true,
    failTimes(n) { failNext = n; },
    async send(m) { if (failNext > 0) { failNext--; throw new Error('SMTP 暫時失敗'); } sent.push(m); }
  };
}

function boot() {
  const db = open(':memory:');
  const google = createFakeGoogle();
  const mailer = fakeMailer();
  const limiter = createLimiter({ db, google, mailer, log: { error() {} } });
  const handle = createApp({ db, google, limiter, mailer, config: { appUrl: 'http://localhost' } });
  const server = http.createServer(handle);
  return new Promise(r => server.listen(0, () => r({ db, google, mailer, limiter, server, base: `http://127.0.0.1:${server.address().port}` })));
}

function client(base) {
  let cookie = '';
  const call = async (method, path, body, opts = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, opts.noCsrf ? {} : { 'X-Requested-With': 'limiter' }),
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get: (p) => call('GET', p), post: (p, b, o) => call('POST', p, b || {}, o), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

async function login(base, u, p) {
  const c = client(base);
  const r = await c.post('/api/login', { username: u, password: p });
  return { c, r };
}

test('完整流程', async (t) => {
  const env = await boot();
  const { base, google, db, mailer } = env;
  t.after(() => env.server.close());

  let su;
  await t.test('預設平台管理員 chase5ws/chase5ws，必須先改密碼', async () => {
    assert.strictEqual((await login(base, 'chase5ws', 'wrong')).r.status, 401);
    const { c, r } = await login(base, 'chase5ws', 'chase5ws');
    assert.ok(r.data.me.mustChange);
    assert.ok(r.headers.get('set-cookie').includes('HttpOnly'));
    assert.match((await c.get('/api/orgs')).data.error, /MUSTCHANGE/);
    assert.match((await c.post('/api/password', { oldPassword: 'chase5ws', newPassword: 'chase5ws1' })).data.error, /不能包含帳號/);
    assert.strictEqual((await c.post('/api/password', { oldPassword: 'chase5ws', newPassword: 'Platform2026' })).status, 200);
    su = c;
    assert.strictEqual((await login(base, 'chase5ws', 'chase5ws')).r.status, 401);
  });

  await t.test('沒有 CSRF 標頭的寫入請求會被擋', async () => {
    assert.strictEqual((await su.post('/api/orgs', { name: 'x' }, { noCsrf: true })).status, 403);
  });

  await t.test('連接 Google：state 驗證', async () => {
    await su.post('/api/google/connect');
    const bad = await su.get('/oauth/google/callback?code=good&state=nope');
    assert.match(decodeURIComponent(bad.headers.get('location')), /來源不正確/);
    const r = await su.post('/api/google/connect');
    const cb = await su.get('/oauth/google/callback?code=good&state=' + new URL(r.data.url).searchParams.get('state'));
    assert.strictEqual(cb.headers.get('location'), '/#settings?google=ok');
    const me = (await su.get('/api/me')).data;
    assert.strictEqual(me.google.email, 'chase5ws@gmail.com');
    assert.strictEqual(me.google.folderName, '表單限額平台');
    assert.strictEqual(me.me.owner, true, 'chase5ws 是平台擁有者');
  });

  await t.test('平台管理員可以改共用資料夾名稱', async () => {
    assert.strictEqual((await su.put('/api/settings', { folderName: 'FormLimiter' })).data.folderName, 'FormLimiter');
    await su.put('/api/settings', { folderName: '表單限額平台' });
  });

  let orgA, orgB;
  await t.test('建立兩個組織', async () => {
    await su.post('/api/orgs', { name: '新竹社大', admin: { username: 'hsinchu', password: 'Admin2026a', email: 'boss@hc.test' } });
    const r = await su.post('/api/orgs', { name: '雲科校友會', admin: { username: 'yuntech', password: 'Admin2026b' } });
    [orgA, orgB] = r.data.map(o => o.id);
    assert.match((await su.post('/api/orgs', { name: 'dup', admin: { username: 'hsinchu', password: 'Admin2026c' } })).data.error, /已經有人使用/);
  });

  let a;
  await t.test('組織管理員只看得到自己的組織', async () => {
    a = (await login(base, 'hsinchu', 'Admin2026a')).c;
    await a.post('/api/password', { oldPassword: 'Admin2026a', newPassword: 'MyOrgPw2026' });
    assert.deepStrictEqual((await a.get('/api/orgs')).data.map(o => o.id), [orgA]);
    assert.strictEqual((await a.get('/api/forms?org=' + orgB)).status, 403);
    assert.strictEqual((await a.get('/api/users?org=platform')).status, 403);
  });

  await t.test('連結共用資料夾：沒共用、名稱不對、只有檢視權限都會擋', async () => {
    google._folder('FOLDER_NOT_SHARED_1', '表單限額平台', { shared: false });
    let r = await a.put(`/api/orgs/${orgA}/folder`, { url: 'https://drive.google.com/drive/folders/FOLDER_NOT_SHARED_1' });
    assert.match(r.data.error, /chase5ws@gmail\.com.*編輯者/);
    google._folder('FOLDER_WRONG_NAME_1', '我的資料夾');
    r = await a.put(`/api/orgs/${orgA}/folder`, { url: 'https://drive.google.com/drive/folders/FOLDER_WRONG_NAME_1' });
    assert.match(r.data.error, /要叫「表單限額平台」/);
    google._folder('FOLDER_VIEW_ONLY_1', '表單限額平台', { role: 'reader' });
    r = await a.put(`/api/orgs/${orgA}/folder`, { url: 'https://drive.google.com/drive/u/0/folders/FOLDER_VIEW_ONLY_1?usp=sharing' });
    assert.match(r.data.error, /檢視權限/);
    google._folder('FOLDER_HSINCHU_01', '表單限額平台', { owner: 'boss@hc.test' });
    r = await a.put(`/api/orgs/${orgA}/folder`, { url: 'https://drive.google.com/drive/folders/FOLDER_HSINCHU_01' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.folder.owner, 'boss@hc.test');
    const b = (await login(base, 'yuntech', 'Admin2026b')).c;
    await b.post('/api/password', { oldPassword: 'Admin2026b', newPassword: 'YunOwn2026' });
    assert.match((await b.put(`/api/orgs/${orgB}/folder`, { url: 'FOLDER_HSINCHU_01' })).data.error, /已經連結到/);
  });

  const F1 = '1FormInFolderAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let form;
  await t.test('資料夾裡的表單：列出、加入（不複製）、資料夾外的拒絕、舊版拒絕', async () => {
    google._form(F1, '十二月講座報名', 'FOLDER_HSINCHU_01');
    google._form('1LegacyFormBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', '舊表單', 'FOLDER_HSINCHU_01', { legacy: true });
    google._folder('OTHER_FOLDER_00001', '別的資料夾');
    google._form('1OutsideFormCCCCCCCCCCCCCCCCCCCCCCCCCCCC', '外面的表單', 'OTHER_FOLDER_00001');
    const list = (await a.get(`/api/orgs/${orgA}/folder-forms`)).data;
    assert.deepStrictEqual(list.map(f => f.name).sort(), ['十二月講座報名', '舊表單']);
    assert.match((await a.post('/api/forms', { org: orgA, formId: '1OutsideFormCCCCCCCCCCCCCCCCCCCCCCCCCCCC' })).data.error, /不在共用資料夾/);
    assert.match((await a.post('/api/forms', { org: orgA, formId: '1LegacyFormBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' })).data.error, /舊版.*建立副本/);
    const r = await a.post('/api/forms', { org: orgA, formId: F1 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    form = r.data.form;
    assert.strictEqual(form.googleFormId, F1, '直接控管原始表單');
    assert.strictEqual(form.state, 'open');
    assert.strictEqual(google.files.size, 8, '沒有多出任何複製檔（5 個資料夾 + 3 份表單）');
    assert.match((await a.post('/api/forms', { org: orgA, formId: F1 })).data.error, /已經在管理/);
    assert.ok((await a.get(`/api/orgs/${orgA}/folder-forms`)).data.find(f => f.id === F1).managed);
  });

  await t.test('名額：滿了由排程關閉；調高上限自動重開', async () => {
    await a.patch('/api/forms/' + form.id, { maxResponses: 3 });
    google._submit(F1, 3);
    await env.limiter.checkAll();
    const f = (await a.get('/api/forms?org=' + orgA)).data[0];
    assert.strictEqual(f.reason, 'full');
    assert.strictEqual(google.files.get(F1).accepting, false);
    const r = await a.patch('/api/forms/' + form.id, { maxResponses: 10 });
    assert.strictEqual(r.data.form.state, 'open');
  });

  await t.test('寄信設定需要名額上限', async () => {
    await a.patch('/api/forms/' + form.id, { maxResponses: '' });
    assert.match((await a.patch('/api/forms/' + form.id, { notifyEnabled: true })).data.error, /名額上限/);
  });

  await t.test('排位：超出名額的人收到候補信；有人被刪除後遞補並收到遞補信', async () => {
    const q = (await a.get(`/api/forms/${form.id}/questions`)).data;
    assert.strictEqual(q.collectsEmail, true);
    let r = await a.patch('/api/forms/' + form.id, { maxResponses: 4, notifyEnabled: true, notifySource: 'respondent' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    google._submit(F1, 3); // 共 6 份，名額 4 → 第 5、6 名候補
    await env.limiter.checkAll();
    assert.deepStrictEqual(mailer.sent.map(m => m.to), ['p5@example.com', 'p6@example.com']);
    assert.match(mailer.sent[0].subject, /十二月講座報名.*名額已滿/);
    assert.match(mailer.sent[0].text, /第 5 位（候補第 1 位）/);
    assert.match(mailer.sent[0].text, /新竹社大/);
    await env.limiter.checkAll();
    assert.strictEqual(mailer.sent.length, 2, '不會重複寄');
    google._delete(F1, 0); // 第一名取消 → 原本第 5 名遞補
    await env.limiter.checkAll();
    assert.strictEqual(mailer.sent.length, 3);
    assert.strictEqual(mailer.sent[2].to, 'p5@example.com');
    assert.match(mailer.sent[2].subject, /遞補成功/);
    const f = (await a.get('/api/forms?org=' + orgA)).data[0];
    assert.deepStrictEqual(f.notify.stats, { waitlist: 2, promoted: 1, failed: 0, skipped: 0 });
  });

  await t.test('寄信失敗會重試最多 3 次；用題目當 Email 來源；自訂信件內容', async () => {
    await a.patch('/api/forms/' + form.id, { notifySource: 'q1', waitlistSubject: '[{org}] {title} 候補', waitlistBody: '你是第 {rank} 位，名額 {limit}' });
    mailer.failTimes(2);
    google._submit(F1, 1); // 第 6 名 → 候補
    await env.limiter.checkAll();
    await env.limiter.checkAll();
    assert.strictEqual(mailer.sent.length, 3, '前兩次失敗');
    await env.limiter.checkAll();
    const last = mailer.sent[mailer.sent.length - 1];
    assert.strictEqual(last.to, 'alt-p6@example.com');
    assert.strictEqual(last.subject, '[新竹社大] 十二月講座報名 候補');
    assert.strictEqual(last.text, '你是第 6 位，名額 4');
    const notices = (await a.get(`/api/forms/${form.id}/notices`)).data;
    assert.strictEqual(notices.find(n => n.email === 'alt-p6@example.com').attempts, 3);
  });

  await t.test('沒有 Email 的回覆標記為略過、不寄信', async () => {
    await a.patch('/api/forms/' + form.id, { notifySource: 'respondent' });
    google._submit(F1, 1, () => 'not-an-email');
    const before = mailer.sent.length;
    await env.limiter.checkAll();
    assert.strictEqual(mailer.sent.length, before);
    assert.strictEqual((await a.get('/api/forms?org=' + orgA)).data[0].notify.stats.skipped, 1);
  });

  await t.test('時間：尚未開放、已截止', async () => {
    let r = await a.patch('/api/forms/' + form.id, { maxResponses: '', notifyEnabled: false, openAt: Date.now() + 3600e3, closeAt: '' });
    assert.strictEqual(r.data.form.reason, 'notyet');
    assert.match((await a.patch('/api/forms/' + form.id, { openAt: Date.now() + 3600e3, closeAt: Date.now() + 60e3 })).data.error, /晚於開放/);
    r = await a.patch('/api/forms/' + form.id, { openAt: Date.now() - 7200e3, closeAt: Date.now() - 60e3 });
    assert.strictEqual(r.data.form.reason, 'ended');
    r = await a.patch('/api/forms/' + form.id, { openAt: '', closeAt: '' });
    assert.strictEqual(r.data.form.state, 'open');
  });

  await t.test('手動關閉不被排程打開', async () => {
    await a.post('/api/forms/' + form.id + '/open', { open: false });
    await env.limiter.checkAll();
    assert.strictEqual(google.files.get(F1).accepting, false);
    assert.strictEqual((await a.post('/api/forms/' + form.id + '/open', { open: true })).data.form.state, 'open');
  });

  await t.test('權限被收回時，錯誤寫進表單、不中斷其他表單', async () => {
    google.files.get('FOLDER_HSINCHU_01').role = 'reader';
    await env.limiter.checkAll();
    await a.post('/api/forms/' + form.id + '/open', { open: false });
    const f = (await a.get('/api/forms?org=' + orgA)).data[0];
    assert.match(f.lastError, /permission/);
    google.files.get('FOLDER_HSINCHU_01').role = 'writer';
    await a.post('/api/forms/' + form.id + '/open', { open: true });
  });

  await t.test('其他組織碰不到這份表單', async () => {
    const b = (await login(base, 'yuntech', 'YunOwn2026')).c;
    assert.strictEqual((await b.patch('/api/forms/' + form.id, { maxResponses: 1 })).status, 403);
    assert.strictEqual((await b.get(`/api/forms/${form.id}/notices`)).status, 403);
    assert.strictEqual((await b.get(`/api/orgs/${orgA}/folder-forms`)).status, 403);
  });

  await t.test('組織成員不能設定資料夾、不能管帳號', async () => {
    await a.post('/api/users', { org: orgA, username: 'staff1', password: 'Staff2026x', role: 'org_member' });
    const s = (await login(base, 'staff1', 'Staff2026x')).c;
    await s.post('/api/password', { oldPassword: 'Staff2026x', newPassword: 'StaffOwn99' });
    assert.strictEqual((await s.put(`/api/orgs/${orgA}/folder`, { url: 'FOLDER_HSINCHU_01' })).status, 403);
    assert.strictEqual((await s.get('/api/users?org=' + orgA)).status, 403);
    assert.strictEqual((await s.get('/api/forms?org=' + orgA)).status, 200);
  });

  await t.test('停用組織：該組織的人被登出、排程略過', async () => {
    await su.patch('/api/orgs/' + orgA, { disabled: true });
    assert.strictEqual((await a.get('/api/forms?org=' + orgA)).status, 401);
    assert.strictEqual((await env.limiter.checkAll()).checked, 0);
    await su.patch('/api/orgs/' + orgA, { disabled: false });
  });

  await t.test('暴力破解鎖定', async () => {
    for (let i = 0; i < 5; i++) await login(base, 'yuntech', 'bad' + i);
    assert.strictEqual((await login(base, 'yuntech', 'YunOwn2026')).r.status, 429);
  });

  await t.test('紀錄：組織只看得到自己的', async () => {
    const a2 = (await login(base, 'hsinchu', 'MyOrgPw2026')).c;
    const logs = (await a2.get('/api/logs?org=' + orgA)).data;
    assert.ok(logs.some(l => l.what.includes('連結共用資料夾')));
    assert.ok(logs.some(l => l.what.includes('寄出')));
    assert.strictEqual((await a2.get('/api/logs?org=platform')).status, 403);
  });
});
