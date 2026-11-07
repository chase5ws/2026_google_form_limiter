const assert = require('assert');
const { create } = require('./gasmock');

const g = create();
const C = g.ctx;
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('✓', name); };
const throws = (fn, re) => assert.throws(fn, e => re.test(e.message), 'expected ' + re);

t('未初始化前 appStatus = false，setupOwner 沒有屬性會拒絕', () => {
  assert.strictEqual(C.appStatus().initialized, false);
  throws(() => C.setupOwner(), /INIT_OWNER_PASSWORD/);
});

t('setupOwner 建立 chase5ws，刪掉明碼屬性，安裝定時觸發', () => {
  g.props.INIT_OWNER_PASSWORD = 'Init2026pw';
  C.setupOwner();
  assert.ok(!('INIT_OWNER_PASSWORD' in g.props));
  const rec = JSON.parse(g.props.GFL_ADMIN_chase5ws);
  assert.strictEqual(rec.role, 'owner');
  assert.ok(!JSON.stringify(rec).includes('Init2026pw'), '不能存明碼');
  assert.ok(g.triggers.some(x => x.fn === 'checkAllForms' && x.every === 5));
  assert.strictEqual(C.appStatus().initialized, true);
});

let tok;
t('登入：錯密碼拒絕；對的密碼成功但要求改密碼', () => {
  throws(() => C.login('chase5ws', 'wrong'), /帳號或密碼錯誤/);
  const r = C.login('  CHASE5WS ', 'Init2026pw');
  assert.ok(r.me.mustChange);
  tok = r.token;
  throws(() => C.listForms(tok), /MUSTCHANGE/);
});

t('改密碼：規則檢查、舊 token 失效、新 token 可用', () => {
  throws(() => C.changePassword(tok, 'Init2026pw', 'short1'), /至少要 8/);
  throws(() => C.changePassword(tok, 'Init2026pw', 'chase5ws123'), /不能包含帳號/);
  throws(() => C.changePassword(tok, 'Init2026pw', 'abcdefghij'), /英文字母和數字/);
  const r = C.changePassword(tok, 'Init2026pw', 'NewPass2026');
  throws(() => C.listForms(tok), /AUTH/);
  tok = r.token;
  assert.strictEqual(C.listForms(tok).length, 0);
});

t('暴力破解：連錯 5 次鎖定', () => {
  for (let i = 0; i < 5; i++) { try { C.login('chase5ws', 'x' + i); } catch (e) {} }
  throws(() => C.login('chase5ws', 'NewPass2026'), /次數過多/);
  delete g.cache['fail_chase5ws'];
});

let adminTok;
t('owner 新增一般管理員；一般管理員不能管帳號但能管表單', () => {
  C.addAdmin(tok, { username: 'Amy', displayName: '艾咪', password: 'TempPass88', role: 'admin' });
  throws(() => C.addAdmin(tok, { username: 'amy', password: 'TempPass88' }), /已經存在/);
  throws(() => C.addAdmin(tok, { username: 'a', password: 'TempPass88' }), /3–32/);
  const r = C.login('amy', 'TempPass88');
  adminTok = C.changePassword(r.token, 'TempPass88', 'Kiwi7788pp').token;
  throws(() => C.listAdmins(adminTok), /權限不足/);
  assert.strictEqual(C.listForms(adminTok).length, 0);
});

t('不能停用／降級／刪除自己，至少保留一位 owner', () => {
  throws(() => C.updateAdmin(tok, 'chase5ws', { disabled: true }), /不能停用自己/);
  throws(() => C.updateAdmin(tok, 'chase5ws', { role: 'admin' }), /不能把自己降級/);
  throws(() => C.deleteAdmin(tok, 'chase5ws'), /不能刪除自己/);
});

t('停用 amy 後她的 token 立即失效；重設密碼後要改密碼', () => {
  C.updateAdmin(tok, 'amy', { disabled: true });
  throws(() => C.listForms(adminTok), /AUTH/);
  throws(() => C.login('amy', 'Kiwi7788pp'), /帳號或密碼錯誤/);
  C.updateAdmin(tok, 'amy', { disabled: false });
  C.resetAdminPassword(tok, 'amy', 'Reset12345');
  const r = C.login('amy', 'Reset12345');
  assert.ok(r.me.mustChange);
});

const ID = '1Jv2alkQNxR1_-lYWjOxhih9aWouvFghOhpPaA3iKYmA';
let form;
t('加入表單：拒絕填寫網址、接受編輯網址、安裝送出觸發器', () => {
  form = g.addFakeForm(ID, '十二月講座報名', { responses: 3 });
  throws(() => C.addForm(tok, 'https://docs.google.com/forms/d/e/1FAIpQLSf_xxxxxxxxxxxxxxxxxxxxxxx/viewform'), /填寫/);
  throws(() => C.addForm(tok, 'https://forms.gle/abc'), /填寫/);
  const f = C.addForm(tok, `https://docs.google.com/forms/d/${ID}/edit?usp=sharing`);
  assert.strictEqual(f.title, '十二月講座報名');
  assert.strictEqual(f.state, 'open');
  assert.strictEqual(f.count, 3);
  assert.ok(f.hasSubmitTrigger);
  throws(() => C.addForm(tok, ID), /已經在管理清單/);
});

t('名額：設上限 5，第 5 份送出後自動關閉並顯示名額已滿訊息', () => {
  let f = C.updateForm(tok, ID, { maxResponses: '5' });
  assert.strictEqual(f.state, 'open');
  form._responses = 4; C.onLimitedFormSubmit({ source: form });
  assert.strictEqual(form._accepting, true);
  form._responses = 5; C.onLimitedFormSubmit({ source: form });
  assert.strictEqual(form._accepting, false);
  assert.strictEqual(form._msg, '名額已滿，感謝您的支持！');
  f = C.listForms(tok)[0];
  assert.strictEqual(f.reason, 'full');
});

t('把上限調高到 10 會自動重新開放', () => {
  const f = C.updateForm(tok, ID, { maxResponses: 10 });
  assert.strictEqual(f.state, 'open');
  assert.strictEqual(form._accepting, true);
});

t('時間：開放時間在未來 → 關閉並顯示尚未開放；截止時間已過 → 已截止', () => {
  const fmt = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16);
  let f = C.updateForm(tok, ID, { openAt: fmt(Date.now() + 86400e3), closeAt: '' });
  assert.strictEqual(f.reason, 'notyet');
  assert.strictEqual(form._msg, '表單尚未開放填寫，請於開放時間再回來。');
  throws(() => C.updateForm(tok, ID, { openAt: fmt(Date.now() + 86400e3), closeAt: fmt(Date.now() + 3600e3) }), /晚於開放/);
  f = C.updateForm(tok, ID, { openAt: fmt(Date.now() - 86400e3), closeAt: fmt(Date.now() - 60e3) });
  assert.strictEqual(f.reason, 'ended');
  assert.strictEqual(f.openAt, fmt(Date.now() - 86400e3).slice(0, 16));
  f = C.updateForm(tok, ID, { openAt: '', closeAt: '' });
  assert.strictEqual(f.state, 'open');
});

t('手動關閉不會被定時檢查打開；手動開放後恢復規則', () => {
  C.setFormOpen(tok, ID, false);
  C.checkAllForms();
  assert.strictEqual(form._accepting, false);
  const f = C.setFormOpen(tok, ID, true);
  assert.strictEqual(f.state, 'open');
});

t('表單未發布：不硬開，回報錯誤訊息', () => {
  form._published = false;
  const f = C.refreshForm(tok, ID);
  assert.strictEqual(f.state, 'unpublished');
  assert.ok(/發布/.test(f.lastError));
  form._published = true;
});

t('打不開的表單：定時檢查不會中斷，錯誤寫進 lastError', () => {
  const ID2 = 'B'.repeat(30);
  g.addFakeForm(ID2, '第二份');
  C.addForm(tok, ID2);
  delete g.forms[ID2];
  C.checkAllForms();
  const f = C.listForms(tok).find(x => x.id === ID2);
  assert.ok(f.lastError);
  C.removeForm(tok, ID2);
});

t('移出管理會刪掉送出觸發器', () => {
  const before = g.triggers.filter(x => x.fn === 'onLimitedFormSubmit').length;
  C.removeForm(tok, ID);
  assert.strictEqual(g.triggers.filter(x => x.fn === 'onLimitedFormSubmit').length, before - 1);
  assert.strictEqual(C.listForms(tok).length, 0);
});

t('超過觸發器上限時改為只靠定時檢查', () => {
  for (let i = 0; i < 25; i++) { g.addFakeForm('F' + String(i).padStart(29, '0'), 'f' + i); C.addForm(tok, 'F' + String(i).padStart(29, '0')); }
  const list = C.listForms(tok);
  assert.ok(list.some(f => !f.hasSubmitTrigger));
  assert.ok(g.triggers.length <= 20);
});

t('操作紀錄會輪替，不超過屬性大小上限', () => {
  for (let i = 0; i < 400; i++) C.refreshForm(tok, 'F' + '0'.repeat(29));
  for (let i = 0; i < 300; i++) C.log_('測試', '這是一筆很長的中文紀錄，用來測試輪替是否正常運作 #' + i);
  const logs = C.getLogs(tok);
  assert.ok(logs.length > 100 && logs.length <= 300);
  assert.ok(logs[0].what.includes('#299'));
});

t('前端呼叫觸發器函式時傳假物件不會出事', () => {
  C.onLimitedFormSubmit({ source: { foo: 1 } });
  C.onLimitedFormSubmit(null);
});

t('setupOwner 可用來救回忘記的密碼', () => {
  g.props.INIT_OWNER_PASSWORD = 'Rescue2026x';
  C.setupOwner();
  throws(() => C.listForms(tok), /AUTH/);
  assert.ok(C.login('chase5ws', 'Rescue2026x').me.mustChange);
});

t('預設帳號：沒有最高管理員時 chase5ws/chase5ws 可登入，改密碼後失效', () => {
  const g2 = create(); const C2 = g2.ctx;
  assert.strictEqual(C2.appStatus().initialized, false);
  throws(() => C2.login('chase5ws', 'wrong'), /帳號或密碼錯誤/);
  const r = C2.login('chase5ws', 'chase5ws');
  assert.ok(r.me.mustChange && r.me.role === 'owner');
  assert.ok(g2.triggers.some(x => x.fn === 'checkAllForms'));
  C2.changePassword(r.token, 'chase5ws', 'MyOwnPw2026');
  throws(() => C2.login('chase5ws', 'chase5ws'), /帳號或密碼錯誤/);
  assert.ok(C2.login('chase5ws', 'MyOwnPw2026').token);
  assert.strictEqual(Object.keys(g2.props).filter(k => k.startsWith('GFL_ADMIN_')).length, 1);
});

t('已有最高管理員時，預設密碼不會被重新啟用', () => {
  throws(() => C.login('chase5ws', 'chase5ws'), /帳號或密碼錯誤/);
});

console.log(`\n${pass} 項全部通過`);
