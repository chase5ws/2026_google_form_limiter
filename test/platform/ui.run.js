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
  const sent = [];
  const settings = createSettings({ db, cipher: cipher('ui') });
  // 每個組織自己的 Google 帳號：只有填了用戶端才算 configured
  const gs = new Map();
  const googleFor = (id) => {
    id = Number(id);
    if (!gs.has(id)) {
      const g = createFakeGoogle({ email: id === 1 ? 'hia.eca@hia.hcc.edu.tw' : `org${id}@example.com` });
      g.configured = () => !!settings.orgGoogleClient(id).clientId;
      gs.set(id, g);
    }
    return gs.get(id);
  };
  const google = googleFor(1);
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
  const fakeFetch = async (url, opt) => gasFetch(url, opt);
  const noMailer = createMailer({});
  const mailerFor = (orgId) => { const e = orgId ? settings.orgMailEnv(orgId) : {}; return e.MAIL_FROM ? createMailer(e, { fetchImpl: fakeFetch }) : noMailer; };
  const limiter = createLimiter({ db, googleFor, mailerFor, log: { error() {} } });
  const server = http.createServer(createApp({ db, googleFor, limiter, mailerFor, settings,
    runtime: { appUrl: 'https://forms.up.railway.app', redirectUri: 'https://forms.up.railway.app/oauth/google/callback', onRailway: true, volumeMounted: true, dataDir: '/data', dataSource: 'volume', keySource: 'auto', domainFromRailway: true },
    config: { appUrl: 'http://localhost', fetchImpl: fakeFetch } }));
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const F1 = '1FormAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', F2 = '1FormBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  google._folder('HSINCHU_FOLDER_ID_01', '社大報名表', { owner: 'hia.eca@hia.hcc.edu.tw' });
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

  const tab = (pg, name) => pg.click(`.tab[data-page=${name}]`);
  step('預設帳號登入 → 改密碼 → 全組織');
  await page.goto(base);
  await page.fill('#lgUser', 'chase5ws'); await page.fill('#lgPw', 'chase5ws'); await page.click('#lgBtn');
  await page.waitForSelector('#vChange:not(.hidden)');
  await page.fill('#cpOld', 'chase5ws'); await page.fill('#cpNew', 'Platform2026'); await page.fill('#cpNew2', 'Platform2026');
  await page.click('#cpBtn');
  await page.waitForSelector('#pOrgs:not(.hidden)');
  const ownerTabsAll = await page.$$eval('.tab', ts => ts.map(t => t.textContent));

  step('建立兩個組織');
  for (const [n, u] of [['新竹社區大學', 'hsinchu'], ['雲科校友會', 'yuntech']]) {
    await page.click('#btnAddOrg');
    await page.fill('#oeName', n); await page.fill('#oeUser', u); await page.fill('#oeEmail', u + '@example.com');
    await page.click('#oeSave');
    await page.waitForSelector('#dlgOrg', { state: 'hidden' });
  }
  await page.waitForFunction(() => document.querySelectorAll('#orgRows tr').length === 2);
  await page.waitForTimeout(3000);
  await shot('r00-all-orgs');
  await tab(page, 'settings');
  await page.waitForSelector('#checkList li');
  await page.waitForTimeout(300);
  await shot('r01-platform-settings');
  const scopeOptions = await page.$$eval('#scopeSelect option', os => os.map(o => o.textContent));

  step('選組織 → 首頁（還沒設定）→ 組織設定：Google 用戶端、連接、資料夾、GAS');
  await page.selectOption('#scopeSelect', '1');
  await page.waitForSelector('#pHome:not(.hidden)');
  await page.waitForSelector('#homeChecks .tag');
  await shot('r02a-home-empty');
  const orgTabs = await page.$$eval('.tab', ts => ts.map(t => t.textContent));
  await tab(page, 'orgsettings');
  await page.waitForSelector('#pOrgSettings:not(.hidden)');
  await page.waitForFunction(() => document.getElementById('gcState').textContent.length > 0);
  await page.waitForTimeout(300);
  await shot('r02-org-settings-start');
  await page.fill('#gcId', '123456-abc.apps.googleusercontent.com');
  await page.fill('#gcSecret', 'GOCSPX-test');
  await page.click('#gcSave');
  await page.waitForSelector('#btnGConnect:not([disabled])');
  await page.click('#btnGConnect');
  await page.waitForFunction(() => document.getElementById('gStatus').textContent.includes('已連接'));
  if (!page.url().includes('#org/1/orgsettings')) throw new Error('連接後沒有回到組織設定：' + page.url());
  await page.fill('#folderUrl', 'https://drive.google.com/drive/folders/HSINCHU_FOLDER_ID_01');
  await page.click('#folderBtn');
  await page.waitForSelector('#folderLinkedInfo:not(.hidden)');
  await page.click('#omGasGen');
  await page.waitForSelector('#omGasCode:not(.hidden)');
  await page.fill('#omGasUrl', 'https://script.google.com/macros/s/AKfycbx_uiTestDeploymentId_1234567/exec');
  await page.fill('#omGasName', '新竹社大報名通知');
  await page.click('#omSave');
  await page.waitForFunction(() => document.getElementById('omStatus').textContent.includes('Apps Script'));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, 'r03-org-settings-done.png'), fullPage: true });

  step('首頁 → 加入表單 → 整頁的表單設定');
  await tab(page, 'home');
  await page.waitForSelector('.ff [data-act=manage]');
  await shot('r04-home');
  await page.click(`.ff[data-id="${F1}"] [data-act=manage]`);
  await page.waitForSelector('#pFormEdit:not(.hidden)');
  if (await page.$('dialog[open]')) throw new Error('不應該跳窗');
  await page.fill('#feMax', '30');
  await page.fill('#feClose', '2026-12-20T18:00');
  await page.click('#feBasicSave');
  await page.waitForSelector('[data-dirty=basic].hidden', { state: 'attached' });
  await page.waitForSelector('#feQBox:not(.hidden)');
  const blk = '.qblock[data-q="slot"]';
  await page.fill(`${blk} .optrow[data-i="0"] input[data-f=limit]`, '5');
  await page.fill(`${blk} .optrow[data-i="1"] input[data-f=limit]`, '3');
  await page.fill(`${blk} .optrow[data-i="2"] input[data-f=value]`, '晚上場（線上）');
  await page.click(`${blk} [data-qa=add]`);
  await page.fill(`${blk} .optrow[data-i="3"] input[data-f=value]`, '週末加開場');
  await page.fill(`${blk} .optrow[data-i="3"] input[data-f=limit]`, '10');
  await page.waitForTimeout(200);
  await page.$eval(blk, el => el.scrollIntoView());
  await page.waitForTimeout(2600);
  await shot('r05a-options-edit');
  await page.click(`${blk} [data-qa=save]`);
  await page.waitForFunction(() => document.querySelectorAll('.qblock[data-q="slot"] .optrow:not(.head)').length === 4 && !document.querySelector('.qblock[data-q="slot"] .dirty-dot:not(.hidden)'));
  const opts = google._options(F1, 'slot');
  if (opts.join() !== '上午場,下午場,晚上場（線上）,週末加開場') throw new Error('選項沒寫回表單：' + opts.join());
  await page.check('#feNotify');
  await page.waitForFunction(() => document.querySelectorAll('#feSource option').length > 1);
  await page.click('#feWS');
  await page.keyboard.press('End');
  await page.click('#feVars [data-var="組織"]');
  const ws = await page.$eval('#feWS', e => e.value);
  if (!ws.endsWith('{組織}')) throw new Error('插入欄位失敗：' + ws);
  await page.$eval('#feNotifyForm', el => el.scrollIntoView());
  await page.waitForTimeout(200);
  await shot('r05b-notify');
  await page.click('#feNotifySave');
  await page.waitForSelector('[data-dirty=notify].hidden', { state: 'attached' });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: path.join(OUT, 'r05-form-page.png'), fullPage: true });
  await page.click('.tab[data-page=forms]');
  await page.waitForSelector('#pForms:not(.hidden)');
  await tab(page, 'home');
  await page.waitForSelector(`.ff[data-id="${F2}"] [data-act=manage]`);
  await page.click(`.ff[data-id="${F2}"] [data-act=manage]`);
  await page.waitForSelector('#pFormEdit:not(.hidden)');
  await page.fill('#feMax', '5');
  await page.click('#feBasicSave');
  await page.waitForSelector('[data-dirty=basic].hidden', { state: 'attached' });
  await page.check('#feNotify');
  await page.click('#feNotifySave');
  await page.waitForSelector('[data-dirty=notify].hidden', { state: 'attached' });
  await page.click('.tab[data-page=forms]');
  await page.waitForSelector('#pForms:not(.hidden)');
  google._submit(F1, 12, null, (k) => ({ slot: k <= 3 ? '下午場' : '上午場' })); google._submit(F2, 8);
  await page.click('#btnCheckAll');
  await page.waitForFunction(() => document.querySelectorAll('.pill.closed').length === 1);
  await page.waitForTimeout(3000);
  await shot('r06-forms');
  await page.click('[data-act=notices]');
  await page.waitForSelector('#pNotices:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#ntRows tr').length === 3);
  await shot('r07-notices');
  await page.goBack();
  await page.waitForSelector('#pForms:not(.hidden)');

  step('測試（整頁）');
  await page.locator('.fcard', { hasText: '十二月講座報名' }).locator('[data-act=sim]').click();
  await page.waitForSelector('#pSim:not(.hidden)');
  await page.waitForSelector('#simChoices select');
  await page.selectOption('#simChoices select', '上午場');
  await page.fill('#simCount', '2');
  await page.fill('#simEmail', 'chase@example.com');
  await page.click('#simBtn');
  await page.waitForSelector('#simResult .sim-res');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'r08-simulate.png'), fullPage: true });

  step('組織管理員視角');
  const p2 = await (await browser.newContext({ viewport: { width: 1120, height: 900 } })).newPage();
  p2.on('pageerror', e => errors.push('p2 ' + e.message));
  await p2.goto(base);
  const users = await page.evaluate(async () => (await (await fetch('/api/users?org=1')).json()));
  await page.evaluate(async (id) => fetch('/api/users/' + id + '/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'limiter' }, body: JSON.stringify({ password: 'OrgTemp2026' }) }), users[0].id);
  await p2.fill('#lgUser', 'hsinchu'); await p2.fill('#lgPw', 'OrgTemp2026'); await p2.click('#lgBtn');
  await p2.waitForSelector('#vChange:not(.hidden)');
  await p2.fill('#cpOld', 'OrgTemp2026'); await p2.fill('#cpNew', 'Bamboo2026x'); await p2.fill('#cpNew2', 'Bamboo2026x'); await p2.click('#cpBtn');
  await p2.waitForSelector('#pHome:not(.hidden)');
  await p2.waitForSelector('#homeChecks .tag');
  await p2.waitForTimeout(300);
  await p2.screenshot({ path: path.join(OUT, 'r09-org-home.png') });
  const tabs = await p2.$$eval('.tab', ts => ts.map(t => t.textContent));
  if (await p2.$('.tab[data-page=logs]')) throw new Error('組織管理員不該看到紀錄');
  if (await p2.isVisible('#scopeSelect')) throw new Error('組織管理員不該看到組織選單');
  await tab(p2, 'users');
  await p2.click('#btnAddUser');
  await p2.fill('#ueUser', 'staff1'); await p2.fill('#ueName', '小美'); await p2.fill('#ueEmail', 'mei@example.com');
  await p2.click('#ueSave');
  await p2.waitForFunction(() => document.querySelectorAll('#userRows tr').length === 2);
  await tab(p2, 'orgsettings');
  await p2.waitForFunction(() => document.getElementById('omStatus').textContent.includes('Apps Script'));
  await p2.fill('#omTo', 'boss@hc.example.com'); await p2.click('#omTestBtn');
  await p2.waitForTimeout(1500);
  await p2.click('#acctBtn');
  await p2.waitForSelector('#acctMenu:not(.hidden)');
  await p2.screenshot({ path: path.join(OUT, 'r10-account-menu.png') });
  await p2.click('body', { position: { x: 5, y: 600 } });

  step('手機');
  await p2.setViewportSize({ width: 390, height: 844 });
  await tab(p2, 'forms');
  await p2.waitForSelector('.fcard');
  await p2.waitForTimeout(300);
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await p2.screenshot({ path: path.join(OUT, 'r11-mobile.png'), fullPage: true });

  step('平台：紀錄、新增組織管理員、刪除組織');
  await tab(page, 'logs');
  await page.waitForSelector('#logRows > div:nth-child(9)');
  await shot('r12-owner-logs');
  await page.selectOption('#scopeSelect', 'all');
  await page.waitForSelector('#pOrgs:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#orgRows tr').length === 2);
  await page.click('#orgRows tr:first-child [data-act=addadmin]');
  await page.waitForSelector('#dlgUser[open]');
  const role = await page.$eval('#ueRole', e => e.value);
  await page.fill('#ueUser', 'hsinchu2');
  await page.click('#ueSave');
  await page.waitForSelector('#dlgUser', { state: 'hidden' });
  await page.click('#orgRows tr:nth-child(2) [data-act=delete]');
  await page.waitForFunction(() => document.querySelectorAll('#orgRows tr').length === 1);
  await shot('r13-orgs');

  await browser.close(); server.close();
  console.log('組織選單：', scopeOptions.join('、'));
  console.log('擁有者在全組織看到的分頁：', ownerTabsAll.join('、'));
  console.log('擁有者在組織裡看到的分頁：', orgTabs.join('、'));
  console.log('組織管理員看到的分頁：', tabs.join('、'));
  console.log('從所有組織新增管理員，預設權限：', role);
  console.log('GAS 寄出：', gasSent.map(m => m.to + '｜' + m.name + '｜' + m.subject).join(' / '));
  console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : '沒有前端錯誤');
  console.log('手機橫向捲動：', overflow ? '有' : '沒有');
})().catch(e => { console.error(e); process.exit(1); });
