// 介面測試：真的伺服器 + 模擬 Google，Playwright 走完整流程並截圖
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { open } = require('../../lib/db');
const { createLimiter } = require('../../lib/limiter');
const { createApp } = require('../../lib/app');
const { createFakeGoogle } = require('./fake-google');
const { createSettings } = require('../../lib/runtime');
const { createMailer } = require('../../lib/mailer');
const { cipher } = require('../../lib/security');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const db = open(':memory:');
  const google = createFakeGoogle();
  const sent = [];
  const settings = createSettings({ env: {}, db, cipher: cipher('ui') });
  // 模擬組織部署了平台產生的 GAS：照請求裡的密鑰建立對應的中繼站
  const { gasScript } = require('../../lib/gas-relay');
  const vm = require('node:vm');
  const gasSent = [];
  const gasFetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    const ctx = { Session: { getEffectiveUser: () => ({ getEmail: () => 'hia.eca@hia.hcc.edu.tw' }) },
      MailApp: { getRemainingDailyQuota: () => 1500 - gasSent.length, sendEmail: (o) => gasSent.push(o) },
      ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }) }, Logger: { log() {} } };
    vm.createContext(ctx); vm.runInContext(gasScript(body.secret), ctx);
    const out = vm.runInContext('doPost', ctx)({ postData: { contents: opt.body } });
    return { status: 200, text: async () => out.text };
  };
  const fakeFetch = async (url, opt) => {
    if (String(url).startsWith('https://script.google.com/')) return gasFetch(url, opt); const b = JSON.parse(opt.body); sent.push({ to: b.to[0], subject: b.subject, from: b.from }); return { ok: true, json: async () => ({}) }; };
  const noMailer = createMailer({});
  const mailerFor = (orgId) => { const e = orgId ? settings.orgMailEnv(orgId) : {}; return e.MAIL_FROM ? createMailer(e, { fetchImpl: fakeFetch }) : noMailer; };
  const limiter = createLimiter({ db, google, mailerFor, log: { error() {} } });
  let gcSet = false;
  google.configured = () => gcSet;
  const origSet = settings.setGoogleClient.bind(settings);
  settings.setGoogleClient = (b) => { const r = origSet(b); gcSet = true; return r; };
  const server = http.createServer(createApp({ db, google, limiter, mailerFor, settings,
    runtime: { appUrl: 'https://forms.up.railway.app', redirectUri: 'https://forms.up.railway.app/oauth/google/callback', onRailway: true, volumeMounted: true, dataDir: '/data', dataSource: 'volume', keySource: 'auto', domainFromRailway: true },
    config: { appUrl: 'http://localhost', fetchImpl: fakeFetch } }));
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const F1 = '1FormAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', F2 = '1FormBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  google._folder('HSINCHU_FOLDER_ID_01', '表單限額平台', { owner: 'boss@hc.example.com' });
  google._form(F1, '十二月講座報名', 'HSINCHU_FOLDER_ID_01', { items: [
    { itemId: 'pb', title: '場次選擇', pageBreakItem: {} },
    { itemId: 'slotItem', title: '場次', questionItem: { question: { questionId: 'slot', choiceQuestion: { type: 'RADIO', options: [{ value: '上午場' }, { value: '下午場' }, { value: '晚上場' }] } } } }
  ] });
  google._form(F2, '志工招募', 'HSINCHU_FOLDER_ID_01');
  google._form('1FormCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', '2024 年度問卷（舊版）', 'HSINCHU_FOLDER_ID_01', { legacy: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1120, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept(d.message().includes('確認') ? '雲科校友會' : '') : d.accept());
  await page.route('https://accounts.google.com/**', r => {
    const st = new URL(r.request().url()).searchParams.get('state');
    r.fulfill({ status: 302, headers: { location: `${base}/oauth/google/callback?code=good&state=${st}` } });
  });
  const shot = n => page.screenshot({ path: path.join(OUT, n + '.png') });
  const step = s => console.log('•', s);

  step('預設帳號登入 → 改密碼');
  await page.goto(base);
  await page.fill('#lgUser', 'chase5ws'); await page.fill('#lgPw', 'chase5ws'); await page.click('#lgBtn');
  await page.waitForSelector('#vChange:not(.hidden)');
  await page.fill('#cpOld', 'chase5ws'); await page.fill('#cpNew', 'Platform2026'); await page.fill('#cpNew2', 'Platform2026');
  await page.click('#cpBtn');
  await page.waitForSelector('#vApp:not(.hidden)');

  step('平台設定：設定 Google 用戶端 → 連接 Google → 設定寄信');
  await page.waitForSelector('#pSettings:not(.hidden)');
  await page.waitForSelector('#checkList li');
  await page.waitForTimeout(300);
  await shot('r00-setup-start');
  await page.fill('#gcId', '123456-abc.apps.googleusercontent.com');
  await page.fill('#gcSecret', 'GOCSPX-test');
  await page.click('#gcSave');
  await page.waitForSelector('#btnGConnect:not([disabled])');
  await page.click('#btnGConnect');
  await page.waitForFunction(() => document.getElementById('gStatus').textContent.includes('已連接'));
  await page.waitForTimeout(3000);
  await shot('r01-settings');
  const banner = await page.isVisible('#setupBanner');

  step('建立兩個組織');
  await page.click('[data-tab=orgs]');
  for (const [n, u] of [['新竹社區大學', 'hsinchu'], ['雲科校友會', 'yuntech']]) {
    await page.click('#btnAddOrg');
    await page.fill('#oeName', n); await page.fill('#oeUser', u); await page.fill('#oeEmail', u + '@example.com');
    await page.click('#oeSave');
    await page.waitForSelector('#dlgOrg', { state: 'hidden' });
  }
  await page.waitForFunction(() => document.querySelectorAll('#orgRows tr').length === 2);

  step('管理第一個組織 → 連結資料夾 → 加入表單');
  await page.click('#orgRows tr:first-child [data-act=manage]');
  await page.waitForSelector('#folderSetup:not(.hidden)');
  await page.waitForTimeout(300);
  await shot('r02-folder-setup');
  await page.fill('#folderUrl', 'https://drive.google.com/drive/folders/HSINCHU_FOLDER_ID_01');
  await page.click('#folderBtn');
  await page.waitForSelector('.ff [data-act=manage]');
  await page.click('[data-tab=orgsettings]');
  await page.waitForFunction(() => document.getElementById('omStatus').textContent.length > 0);
  await page.selectOption('#omProvider', 'gas');
  await page.click('#omGasGen');
  await page.waitForSelector('#omGasCode:not(.hidden)');
  await page.fill('#omGasUrl', 'https://script.google.com/macros/s/AKfycbx_uiTestDeploymentId_1234567/exec');
  await page.fill('#omGasName', '新竹社大報名通知');
  await page.click('#omSave');
  await page.waitForFunction(() => document.getElementById('omStatus').textContent.includes('Apps Script'));
  await page.click('[data-tab=forms]');
  await page.waitForSelector('.ff [data-act=manage]');
  await page.click(`.ff[data-id="${F1}"] [data-act=manage]`);
  await page.waitForSelector('#dlgForm[open]');
  await page.fill('#feMax', '30');
  await page.fill('#feClose', '2026-12-20T18:00');
  await page.waitForSelector('#feQBox:not(.hidden)');
  await page.fill('input[data-q="slot"][data-v="上午場"]', '5');
  await page.fill('input[data-q="slot"][data-v="下午場"]', '3');
  await page.check('#feNotify');
  await page.waitForFunction(() => document.querySelectorAll('#feSource option').length > 1);
  await page.click('details summary');
  await page.waitForTimeout(200);
  await page.$eval('#feQBox', el => el.scrollIntoView());
  await shot('r03-form-settings');
  await page.click('#feSave');
  await page.waitForSelector('#dlgForm', { state: 'hidden' });
  await page.click(`.ff[data-id="${F2}"] [data-act=manage]`);
  await page.waitForSelector('#dlgForm[open]');
  await page.fill('#feMax', '5');
  await page.check('#feNotify');
  await page.click('#feSave');
  await page.waitForSelector('#dlgForm', { state: 'hidden' });
  google._submit(F1, 12, null, (k) => ({ slot: k <= 3 ? '下午場' : '上午場' })); google._submit(F2, 8);
  await page.click('#btnCheckAll');
  await page.waitForFunction(() => document.querySelectorAll('.pill.closed').length === 1);
  await page.waitForTimeout(3000);
  await shot('r04-forms');
  await page.click('[data-act=notices]');
  await page.waitForFunction(() => document.querySelectorAll('#ntRows tr').length === 3);
  await shot('r05-notices');
  await page.click('#dlgNotices [data-close]');

  step('測試按鈕');
  const simBtn = page.locator('.fcard', { hasText: '十二月講座報名' }).locator('[data-act=sim]');
  await simBtn.click();
  await page.waitForSelector('#simChoices select');
  await page.selectOption('#simChoices select', '上午場');
  await page.fill('#simCount', '2');
  await page.fill('#simEmail', 'chase@example.com');
  await page.click('#simBtn');
  await page.waitForSelector('#simResult .sim-res');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'r05b-simulate.png'), fullPage: false });
  await page.click('#dlgSim [data-close]');

  step('組織管理員視角');
  const p2 = await (await browser.newContext({ viewport: { width: 1120, height: 900 } })).newPage();
  p2.on('pageerror', e => errors.push('p2 ' + e.message));
  await p2.goto(base);
  // 用 API 重設 hsinchu 密碼，讓測試知道密碼
  const users = await page.evaluate(async () => (await (await fetch('/api/users?org=' + document.getElementById('orgSelect').value)).json()));
  await page.evaluate(async (id) => fetch('/api/users/' + id + '/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter' }, body: JSON.stringify({ password: 'OrgTemp2026' }) }), users[0].id);
  await p2.fill('#lgUser', 'hsinchu'); await p2.fill('#lgPw', 'OrgTemp2026'); await p2.click('#lgBtn');
  await p2.waitForSelector('#vChange:not(.hidden)');
  await p2.fill('#cpOld', 'OrgTemp2026'); await p2.fill('#cpNew', 'Bamboo2026x'); await p2.fill('#cpNew2', 'Bamboo2026x'); await p2.click('#cpBtn');
  await p2.waitForSelector('.fcard');
  await p2.click('[data-tab=users]');
  await p2.click('#btnAddUser');
  await p2.fill('#ueUser', 'staff1'); await p2.fill('#ueName', '小美'); await p2.fill('#ueEmail', 'mei@example.com');
  await p2.click('#ueSave');
  await p2.waitForFunction(() => document.querySelectorAll('#userRows tr').length === 2);
  await p2.waitForTimeout(3000);
  await p2.screenshot({ path: path.join(OUT, 'r06-org-users.png') });
  await p2.click('[data-tab=orgsettings]');
  await p2.waitForFunction(() => document.getElementById('omStatus').textContent.length > 0);
  await p2.waitForFunction(() => document.getElementById('omStatus').textContent.includes('Apps Script'));
  await p2.fill('#omTo', 'boss@hc.example.com'); await p2.click('#omTestBtn');
  await p2.waitForTimeout(2800);
  await p2.screenshot({ path: path.join(OUT, 'r06b-org-mail.png') });
  const tabs = await p2.$$eval('.tab', ts => ts.map(t => t.textContent));
  await p2.click('[data-tab=logs]');
  await p2.waitForSelector('#logRows > div:nth-child(9)');
  await p2.screenshot({ path: path.join(OUT, 'r07-org-logs.png') });

  step('手機');
  await p2.setViewportSize({ width: 390, height: 844 });
  await p2.click('[data-tab=forms]');
  await p2.waitForSelector('.fcard');
  await p2.waitForTimeout(300);
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await p2.screenshot({ path: path.join(OUT, 'r08-mobile.png'), fullPage: true });

  step('平台：刪除組織');
  await page.click('[data-tab=orgs]');
  await page.waitForFunction(() => document.querySelectorAll('#orgRows tr').length === 2);
  await page.click('#orgRows tr:first-child [data-act=addadmin]');
  await page.waitForSelector('#dlgUser[open]');
  const role = await page.$eval('#ueRole', e => e.value);
  await page.fill('#ueUser', 'hsinchu2');
  await page.screenshot({ path: path.join(OUT, 'r09a-add-org-admin.png') });
  await page.click('#ueSave');
  await page.waitForSelector('#dlgUser', { state: 'hidden' });
  await page.click('#orgRows tr:nth-child(2) [data-act=delete]');
  await page.waitForFunction(() => document.querySelectorAll('#orgRows tr').length === 1);
  await shot('r09-orgs');
  await page.click('#btnPlatform');
  await page.waitForSelector('#pSettings:not(.hidden)');
  await page.waitForTimeout(500);
  await shot('r10-settings');

  await browser.close(); server.close();
  console.log('組織管理員看到的分頁：', tabs.join('、'));
  console.log('從所有組織新增管理員，預設權限：', role);
  console.log('設定完成後提示列還在嗎：', banner ? '是（錯誤）' : '否');
  console.log('GAS 寄出：', gasSent.map(m => m.to + '｜' + m.name + '｜' + m.subject).join(' / '));
  console.log('寄出的信：', sent.map(m => m.to + '｜' + m.from + '｜' + m.subject).join(' / '));
  console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : '沒有前端錯誤');
  console.log('手機橫向捲動：', overflow ? '有' : '沒有');
})().catch(e => { console.error(e); process.exit(1); });
