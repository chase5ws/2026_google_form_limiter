// 用 Playwright 開 Index.html，google.script.run 接到 Node 端的 Code.gs 模擬
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { create } = require('./gasmock');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const g = create();
  const C = g.ctx;
  g.props.INIT_OWNER_PASSWORD = 'Init2026pw';
  C.setupOwner();
  const f1 = g.addFakeForm('1Jv2alkQNxR1_-lYWjOxhih9aWouvFghOhpPaA3iKYmA', '十二月講座報名', { responses: 38 });
  g.addFakeForm('2Kx3bmlROyS2_-mZXkPyijh0bXpvwGhiqQbB4jLZnB', '社團招新問卷', { responses: 12 });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());

  await page.exposeFunction('__gas', (fn, args) => {
    try {
      if (fn.endsWith('_') || typeof C[fn] !== 'function') throw new Error('Script function not found: ' + fn);
      return { ok: JSON.parse(JSON.stringify(C[fn](...args) ?? null)) };
    } catch (e) { return { err: e.message } }
  });
  await page.addInitScript(() => {
    const mk = (ok, fail) => new Proxy({}, {
      get(_, k) {
        if (k === 'withSuccessHandler') return (f) => mk(f, fail);
        if (k === 'withFailureHandler') return (f) => mk(ok, f);
        return (...args) => window.__gas(k, args).then(r => setTimeout(() => r.err ? fail && fail(new Error(r.err)) : ok && ok(r.ok), 30));
      }
    });
    window.google = { script: { get run() { return mk(null, null); } } };
  });
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'Index.html'), 'utf8');
  await page.route('http://gas.test/', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://gas.test/');

  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
  const step = (s) => console.log('•', s);

  step('登入頁');
  await page.waitForSelector('#vLogin:not(.hidden)');
  await page.fill('#lgUser', 'chase5ws'); await page.fill('#lgPw', 'bad');
  await page.click('#lgBtn');
  await page.waitForSelector('#loginErr:not(.hidden)');
  await shot('01-login-error');

  await page.fill('#lgPw', 'Init2026pw'); await page.click('#lgBtn');
  step('強制改密碼');
  await page.waitForSelector('#vChange:not(.hidden)');
  if (await page.isVisible('#cpCancel')) throw new Error('強制改密碼時不該有取消鈕');
  await page.fill('#cpOld', 'Init2026pw'); await page.fill('#cpNew', 'NewPass2026'); await page.fill('#cpNew2', 'NewPass2026');
  await shot('02-change-password');
  await page.click('#cpBtn');
  await page.waitForSelector('#vApp:not(.hidden)');

  step('加入兩份表單');
  await page.fill('#addFormUrl', 'https://docs.google.com/forms/d/e/1FAIpQLSf_abcdefghijklmnopqrstuv/viewform');
  await page.click('#addFormBtn');
  await page.waitForSelector('#toast.bad');
  await page.fill('#addFormUrl', 'https://docs.google.com/forms/d/1Jv2alkQNxR1_-lYWjOxhih9aWouvFghOhpPaA3iKYmA/edit');
  await page.click('#addFormBtn');
  await page.waitForSelector('#dlgForm[open]');
  await page.fill('#feMax', '40');
  const fmt = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16);
  await page.fill('#feClose', fmt(Date.now() + 5 * 86400e3));
  await shot('03-edit-dialog');
  await page.click('#feSave');
  await page.waitForSelector('#dlgForm', { state: 'hidden' });

  await page.fill('#addFormUrl', '2Kx3bmlROyS2_-mZXkPyijh0bXpvwGhiqQbB4jLZnB');
  await page.click('#addFormBtn');
  await page.waitForSelector('#dlgForm[open]');
  await page.fill('#feMax', '12');
  await page.click('#feSave');
  await page.waitForSelector('#dlgForm', { state: 'hidden' });

  step('模擬有人送出 → 講座第 40 份');
  f1._responses = 40; C.onLimitedFormSubmit({ source: f1 });
  await page.click('#btnRefreshAll');
  await page.waitForFunction(() => document.querySelectorAll('.pill.closed').length === 2);
  await page.waitForTimeout(3000);
  await shot('04-forms');

  step('新增管理員');
  await page.click('[data-tab=admins]');
  await page.waitForSelector('#adminRows tr');
  await page.click('#btnAddAdmin');
  await page.fill('#aeUser', 'amy'); await page.fill('#aeName', '艾咪');
  await shot('05-add-admin');
  await page.click('#aeSave');
  await page.waitForFunction(() => document.querySelectorAll('#adminRows tr').length === 2);
  await page.waitForTimeout(2800);
  await shot('06-admins');

  step('紀錄');
  await page.click('[data-tab=logs]');
  await page.waitForSelector('#logRows > div:nth-child(6)');
  await shot('07-logs');

  step('手機寬度');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-tab=forms]');
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await shot('08-mobile');

  step('登出後 token 失效');
  await page.click('#btnLogout');
  await page.waitForSelector('#vLogin:not(.hidden)');

  await browser.close();
  console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : '沒有前端錯誤');
  console.log('手機橫向捲動：', overflow ? '有（需修正）' : '沒有');
})().catch(e => { console.error(e); process.exit(1); });
