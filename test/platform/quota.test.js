'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { open } = require('../../lib/db');
const { cipher } = require('../../lib/security');
const { createSettings } = require('../../lib/runtime');
const { createMailer } = require('../../lib/mailer');
const { createLimiter } = require('../../lib/limiter');
const { createApp } = require('../../lib/app');
const { parseSections, planQuotas, waitlistOf } = require('../../lib/quota');
const { createFakeGoogle } = require('./fake-google');

const opt = (v) => ({ value: v });
const choice = (questionId, title, values, extra = {}) => ({ itemId: 'item-' + questionId, title, questionItem: { question: { questionId, choiceQuestion: Object.assign({ type: 'RADIO', options: values.map(opt) }, extra) } } });
const resp = (id, sec, answers) => ({ responseId: id, createTime: `2026-11-09T00:00:${String(sec).padStart(2, '0')}Z`, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { textAnswers: { answers: [].concat(v).map(x => ({ value: x })) } }])) });

test('段落解析：依分頁切段，只列出單選／多選／下拉題', () => {
  const form = { info: { title: '研習報名' }, items: [
    { itemId: 'a', title: '姓名', questionItem: { question: { questionId: 'name', textQuestion: {} } } },
    choice('s1', '身分', ['教師', '學生']),
    { itemId: 'pb', title: '場次選擇', pageBreakItem: {} },
    choice('slot', '場次', ['A 場', 'B 場'], { type: 'RADIO', options: [opt('A 場'), opt('B 場'), { isOther: true }] }),
    choice('meal', '餐點', ['葷', '素'], { type: 'CHECKBOX' })
  ] };
  const s = parseSections(form);
  assert.deepStrictEqual(s.map(x => [x.index, x.title, x.questions.map(q => q.title)]), [[1, '研習報名', ['身分']], [2, '場次選擇', ['場次', '餐點']]]);
  assert.deepStrictEqual(s[1].questions[0].options, ['A 場', 'B 場']);
  assert.strictEqual(s[1].questions[0].hasOther, true);
  assert.strictEqual(s[1].questions[1].typeText, '多選');
});

test('planQuotas：額滿移除、保留「其他」、有空位依原順序加回、全部額滿改關表單', () => {
  const form = { items: [choice('slot', '場次', [], { options: [opt('A'), opt('B'), opt('C'), { isOther: true }] })] };
  const q = [{ questionId: 'slot', title: '場次', limits: { A: 2, B: 1 }, hidden: [], order: [] }];
  let p = planQuotas(q, form, [resp('1', 1, { slot: 'A' }), resp('2', 2, { slot: 'A' }), resp('3', 3, { slot: 'C' })]);
  assert.deepStrictEqual(p.actions[0].options.map(o => o.value || '(其他)'), ['B', 'C', '(其他)']);
  assert.deepStrictEqual(p.quotas[0].hidden.map(h => h.value), ['A']);
  assert.deepStrictEqual(p.quotas[0].counts, { A: 2, C: 1 });
  // 套用後，A 被刪掉一筆 → 加回，而且排回原本的位置
  form.items[0].questionItem.question.choiceQuestion.options = p.actions[0].options;
  p = planQuotas(p.quotas, form, [resp('1', 1, { slot: 'A' }), resp('3', 3, { slot: 'C' })]);
  assert.deepStrictEqual(p.actions[0].options.map(o => o.value || '(其他)'), ['A', 'B', 'C', '(其他)']);
  assert.deepStrictEqual(p.quotas[0].hidden, []);
  // 全部有名額的選項都滿了（C 也設名額）→ 不移除最後的選項，改成關表單
  const q2 = [{ questionId: 'slot', title: '場次', limits: { A: 1, B: 1, C: 1 }, hidden: [], order: [] }];
  const form2 = { items: [choice('slot', '場次', ['A', 'B', 'C'])] };
  p = planQuotas(q2, form2, [resp('1', 1, { slot: 'A' }), resp('2', 2, { slot: 'B' }), resp('3', 3, { slot: 'C' })]);
  assert.strictEqual(p.allFull, true);
  assert.strictEqual(p.actions.length, 0);
  // 題目被刪掉 → 回報錯誤、不當機
  p = planQuotas(q2, { items: [] }, []);
  assert.match(p.errors[0], /找不到題目/);
});

test('waitlistOf：超過總名額或選項名額的回覆，記錄是哪個選項', () => {
  const ranked = [1, 2, 3, 4].map(i => Object.assign(resp(String(i), i, { slot: i <= 3 ? 'A' : 'B' }), { rank: i }));
  const wl = waitlistOf(ranked, null, [{ questionId: 'slot', title: '場次', limits: { A: 2 } }]);
  assert.deepStrictEqual([...wl.entries()], [['3', { rank: 3, limit: 2, option: '場次：A' }]]);
  const wl2 = waitlistOf(ranked, 3, [{ questionId: 'slot', title: '場次', limits: { A: 2 } }]);
  assert.deepStrictEqual([...wl2.keys()].sort(), ['3', '4']);
});

test('選項名額完整流程：讀表單結構、設定、額滿移除、候補信寫明選項、遞補加回、全滿關表單、測試按鈕', async (t) => {
  const db = open(':memory:');
  const box = cipher('k');
  const settings = createSettings({ env: {}, db, cipher: box });
  const google = createFakeGoogle(); google._connect();
  const sent = [];
  const fakeMailer = { provider: 'gas', from: '社大 <hi@school.org>', enabled: () => true, async send(m) { sent.push(m); } };
  const limiter = createLimiter({ db, google, mailerFor: () => fakeMailer, log: { error() {} } });
  const handle = createApp({ db, google, limiter, mailerFor: () => fakeMailer, settings, config: { appUrl: 'http://x', adminPassword: 'Owner2026x' } });
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  await call('POST', '/api/login', { username: 'chase5ws', password: 'Owner2026x' });
  const orgId = (await call('POST', '/api/orgs', { name: '新竹社大', admin: { username: 'hcadmin', password: 'Bamboo2026x' } })).data[0].id;
  google._folder('F', '表單限額平台');
  const FORM = 'FORM_QUOTA_xxxxxxxxxxxxxxxx';
  google._form(FORM, '十二月研習', 'F', { items: [
    { itemId: 'pb2', title: '場次選擇', pageBreakItem: {} },
    choice('slot', '場次', [], { options: [opt('上午場'), opt('下午場'), opt('晚上場'), { isOther: true }] })
  ] });
  db.run('UPDATE orgs SET shared_folder_id = ?, shared_folder_name = ? WHERE id = ?', 'F', '表單限額平台', orgId);
  const form = (await call('POST', '/api/forms', { org: orgId, formId: FORM })).data.form;

  // 讀結構
  let st = (await call('GET', `/api/forms/${form.id}/structure`)).data;
  assert.deepStrictEqual(st.sections.map(s => s.title), ['十二月研習', '場次選擇']);
  assert.deepStrictEqual(st.sections[1].questions[0].options.map(o => o.value), ['上午場', '下午場', '晚上場']);

  // 設定：上午 2、下午 1，晚上不限；開啟通知
  let r = await call('PATCH', '/api/forms/' + form.id, { optionQuotas: [{ questionId: 'slot', limits: { 上午場: 2, 下午場: 1, 晚上場: '' } }], notifyEnabled: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.form.optionQuotas[0].options.map(o => [o.value, o.limit]), [['上午場', 2], ['下午場', 1]]);
  assert.match((await call('PATCH', '/api/forms/' + form.id, { optionQuotas: [{ questionId: 'slot', limits: { 不存在: 3 } }] })).data.error, /沒有「不存在」/);

  // 測試按鈕（還沒有人報名）：模擬 3 筆選上午場 → 第 3 筆超額，寄 [測試] 信，表單不受影響
  r = await call('POST', `/api/forms/${form.id}/simulate`, { choices: { slot: '上午場' }, count: 3, email: 'me@school.org' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.options.find(o => o.option === '上午場'), { question: '場次', option: '上午場', limit: 2, before: 0, after: 3, status: '這次額滿 → 從表單移除' });
  assert.strictEqual(r.data.notices.length, 1);
  assert.strictEqual(r.data.notices[0].option, '場次：上午場');
  assert.strictEqual(r.data.mail.sent, true);
  assert.match(sent[0].subject, /^\[測試\] 「十二月研習」名額已滿通知/);
  assert.match(sent[0].text, /「場次：上午場」的名額 2 位已經額滿，您的順位是第 3 位（候補第 1 位）/);
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['上午場', '下午場', '晚上場', '(其他)'], '模擬不會改表單');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM notices').n, 0, '模擬不寫寄信紀錄');
  sent.length = 0;

  // 真的報名：上午 2 → 滿 → 移除
  google._submit(FORM, 2, null, () => ({ slot: '上午場' }));
  await limiter.checkAll();
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['下午場', '晚上場', '(其他)']);
  const fl = await call('GET', '/api/forms?org=' + orgId); assert.ok(Array.isArray(fl.data), JSON.stringify(fl)); let f = fl.data[0];
  assert.deepStrictEqual(f.optionQuotas[0].options.map(o => [o.value, o.count, o.hidden]), [['上午場', 2, true], ['下午場', 0, false]]);
  assert.strictEqual(f.state, 'open');

  // 系統移除前，有人搶先送出上午場 → 候補信寫明選項
  google._submit(FORM, 1, () => 'late@x.org', () => ({ slot: '上午場' }));
  await limiter.checkAll();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'late@x.org');
  assert.match(sent[0].text, /「場次：上午場」的名額 2 位已經額滿/);

  // 第一位上午場取消 → 上午場剩 1+1(候補)=2，候補遞補成功；上午場仍滿（2/2）不加回
  google._delete(FORM, 0);
  await limiter.checkAll();
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].to, 'late@x.org');
  assert.match(sent[1].subject, /遞補成功/);
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['下午場', '晚上場', '(其他)']);

  // 調高上午場名額 → 依原本順序加回
  await call('PATCH', '/api/forms/' + form.id, { optionQuotas: [{ questionId: 'slot', limits: { 上午場: 5, 下午場: 1 } }] });
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['上午場', '下午場', '晚上場', '(其他)']);

  // 所有設名額的選項都滿（晚上場也設 0）→ 不刪光，改關表單
  await call('PATCH', '/api/forms/' + form.id, { optionQuotas: [{ questionId: 'slot', limits: { 上午場: 2, 下午場: 0, 晚上場: 0 } }] });
  f = (await call('GET', '/api/forms?org=' + orgId)).data[0];
  assert.strictEqual(f.state, 'closed');
  assert.strictEqual(f.reasonText, '選項皆已額滿');
  assert.ok(google._options(FORM, 'slot').length >= 1);

  // 拿掉選項名額 → 被隱藏的選項全部加回、表單重新開放
  assert.match((await call('PATCH', '/api/forms/' + form.id, { optionQuotas: [] })).data.error, /名額上限或選項名額/, '開著通知時不能把名額全拿掉');
  r = await call('PATCH', '/api/forms/' + form.id, { optionQuotas: [], notifyEnabled: false });
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['上午場', '下午場', '晚上場', '(其他)']);
  assert.strictEqual(r.data.form.state, 'open');
  assert.deepStrictEqual(r.data.form.optionQuotas, []);
  assert.strictEqual(JSON.parse(db.get('SELECT option_quotas FROM forms WHERE id = ?', form.id).option_quotas).length, 0, '加回後刪掉暫存設定');

  // 紀錄
  const logs = (await call('GET', '/api/logs?org=' + orgId)).data.map(l => l.what).join('\n');
  assert.match(logs, /移除額滿選項：上午場/);
  assert.match(logs, /加回選項：上午場/);
  assert.match(logs, /測試「十二月研習」/);
});

test('修改選項：題目改名、選項改名（舊回覆照算）、新增、刪除、名額一起存；跳段設定保留', async (t) => {
  const db = open(':memory:');
  const settings = createSettings({ db, cipher: cipher('k') });
  const google = createFakeGoogle(); google._connect();
  const limiter = createLimiter({ db, google, mailerFor: () => null, log: { error() {} } });
  const server = http.createServer(createApp({ db, google, limiter, settings, config: { appUrl: 'http://x', adminPassword: 'Owner2026x' } }));
  await new Promise(r => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  await call('POST', '/api/login', { username: 'chase5ws', password: 'Owner2026x' });
  const orgId = (await call('POST', '/api/orgs', { name: '社大', admin: { username: 'hcadmin', password: 'Bamboo2026x' } })).data[0].id;
  google._folder('F', 'x');
  const FORM = 'FORM_EDIT_xxxxxxxxxxxxxxxxx';
  google._form(FORM, '研習', 'F', { items: [
    choice('slot', '場次', [], { options: [opt('A 場'), Object.assign(opt('B 場'), { goToSectionId: 'sec2' }), opt('C 場'), { isOther: true }] })
  ] });
  db.run('UPDATE orgs SET shared_folder_id = ? WHERE id = ?', 'F', orgId);
  const form = (await call('POST', '/api/forms', { org: orgId, formId: FORM })).data.form;

  // A 場名額 1，已有 1 人 → 被移除
  google._submit(FORM, 1, null, () => ({ slot: 'A 場' }));
  let r = await call('PUT', `/api/forms/${form.id}/questions/slot`, { title: '場次', options: [{ value: 'A 場', from: 'A 場', limit: 1 }, { value: 'B 場', from: 'B 場' }, { value: 'C 場', from: 'C 場' }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['B 場', 'C 場', '(其他)']);

  // 一次改：題目改名、A 場（已額滿被移除）改名、B 場改名並設名額、刪掉 C 場、新增 D 場
  r = await call('PUT', `/api/forms/${form.id}/questions/slot`, { title: '想參加的場次', options: [
    { value: '上午 A 場', from: 'A 場', limit: 1 }, { value: '下午 B 場', from: 'B 場', limit: 3 }, { value: 'D 場', limit: '' }
  ] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['下午 B 場', 'D 場', '(其他)'], '改名後的 A 場仍然額滿、不放回；C 場刪除；新增 D 場；「其他」保留');
  const item = google.files.get(FORM).items.find(i => i.itemId === 'item-slot');
  assert.strictEqual(item.title, '想參加的場次');
  assert.strictEqual(item.questionItem.question.choiceQuestion.options[0].goToSectionId, 'sec2', '跳到某段落的設定保留');
  assert.deepStrictEqual(r.data.form.optionQuotas[0].options.map(o => [o.value, o.limit, o.count, o.hidden]), [['上午 A 場', 1, 1, true], ['下午 B 場', 3, 0, false]], '舊回覆算在新名稱上');

  // 舊名稱「B 場」的回覆也算在「下午 B 場」：名額 3，再來 3 人（舊名稱 1 + 新名稱 2）→ 額滿
  google._submit(FORM, 1, null, () => ({ slot: 'B 場' }));
  google._submit(FORM, 2, null, () => ({ slot: '下午 B 場' }));
  await limiter.checkAll();
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['D 場', '(其他)']);
  const st = (await call('GET', `/api/forms/${form.id}/structure`)).data;
  const counts = Object.fromEntries(st.sections[0].questions[0].options.map(o => [o.value, o.count]));
  assert.deepStrictEqual(counts, { 'D 場': 0, '上午 A 場': 1, '下午 B 場': 3 });

  // 拿掉所有名額 → 全部放回表單
  r = await call('PUT', `/api/forms/${form.id}/questions/slot`, { title: '想參加的場次', options: [
    { value: '上午 A 場', from: '上午 A 場' }, { value: '下午 B 場', from: '下午 B 場' }, { value: 'D 場', from: 'D 場' }
  ] });
  assert.deepStrictEqual(google._options(FORM, 'slot'), ['上午 A 場', '下午 B 場', 'D 場', '(其他)']);

  // 檢查
  assert.match((await call('PUT', `/api/forms/${form.id}/questions/slot`, { title: 'x', options: [{ value: 'a' }, { value: 'a' }] })).data.error, /重複/);
  assert.match((await call('PUT', `/api/forms/${form.id}/questions/slot`, { title: 'x', options: [] })).data.error, /至少要有一個選項/);
  assert.match((await call('PUT', `/api/forms/${form.id}/questions/slot`, { title: '', options: [{ value: 'a' }] })).data.error, /題目名稱/);
  const logs = (await call('GET', '/api/logs?org=' + orgId)).data.map(l => l.what).join('\n');
  assert.match(logs, /選項改名：A 場 → 上午 A 場、B 場 → 下午 B 場/);
  assert.match(logs, /刪除選項：C 場/);
});

test('信件內容可以用中文欄位名稱', () => {
  const { fill, DEFAULT_TEMPLATES } = require('../../lib/limiter');
  const vars = { title: '研習', org: '社大', rank: 5, limit: 4, waitlist: 1, option: '場次：A', full: '「場次：A」的名額 4 位' };
  assert.strictEqual(fill('{表單名稱}｜{組織}｜{順位}｜{名額}｜{候補第幾位}｜{額滿的選項}｜{額滿說明}｜{title}｜{不存在}', vars), '研習｜社大｜5｜4｜1｜場次：A｜「場次：A」的名額 4 位｜研習｜{不存在}');
  assert.ok(!/\{[a-z]+\}/.test(Object.values(DEFAULT_TEMPLATES).join('')), '預設內容只用中文欄位');
});
