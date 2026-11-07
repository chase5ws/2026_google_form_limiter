// 介面測試：真的伺服器 + 模擬 Google，Playwright 走完整流程並截圖
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { open } = require('../lib/db');
const { createLimiter } = require('../lib/limiter');
const { createApp } = require('../lib/app');
const { createFakeGoogle } = require('./fake-google');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const db = open(':memory:');
  const google = createFakeGoogle();
  const sent = [];
  const mailer = { provider: 'smtp', from: '表單平台 <noreply@example.com>', enabled: () => true, async send(m) { sent.push(m); } };
  const limiter = createLimiter({ db, google, mailer, log: { error() {} } });
  const server = http.createServer(createApp({ db, google, limiter, mailer, config: { appUrl: 'http://localhost' } }));
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const F1 = '1FormAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', F2 = '1FormBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  google._folder('HSINCHU_FOLDER_ID_01', '表單限額平台', { owner: 'boss@hc.example.com' });
  google._form(F1, '十二月講座報名', 'HSINCHU_FOLDER_ID_01');
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
  await page.waitForSelector('#pOrgs:not(.hidden)');

  step('平台設定：連接 Google');
  await page.click('[data-tab=settings]');
  await page.waitForSelector('#btnGConnect:not([disabled])');
  await page.click('#btnGConnect');
  await page.waitForFunction(() => document.getElementById('gStatus').textContent.includes('已連接'));
  await page.waitForTimeout(3000);
  await shot('r01-settings');

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
  await page.click(`.ff[data-id="${F1}"] [data-act=manage]`);
  await page.waitForSelector('#dlgForm[open]');
  await page.fill('#feMax', '30');
  await page.fill('#feClose', '2026-12-20T18:00');
  await page.check('#feNotify');
  await page.waitForFunction(() => document.querySelectorAll('#feSource option').length > 1);
  await page.click('details summary');
  await page.waitForTimeout(200);
  await shot('r03-form-settings');
  await page.click('#feSave');
  await page.waitForSelector('#dlgForm', { state: 'hidden' });
  await page.click(`.ff[data-id="${F2}"] [data-act=manage]`);
  await page.waitForSelector('#dlgForm[open]');
  await page.fill('#feMax', '5');
  await page.check('#feNotify');
  await page.click('#feSave');
  await page.waitForSelector('#dlgForm', { state: 'hidden' });
  google._submit(F1, 12); google._submit(F2, 8);
  await page.click('#btnCheckAll');
  await page.waitForFunction(() => document.querySelectorAll('.pill.closed').length === 1);
  await page.waitForTimeout(3000);
  await shot('r04-forms');
  await page.click('[data-act=notices]');
  await page.waitForFunction(() => document.querySelectorAll('#ntRows tr').length === 3);
  await shot('r05-notices');
  await page.click('#dlgNotices [data-close]');

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
  await page.click('#orgRows tr:nth-child(2) [data-act=delete]');
  await page.waitForFunction(() => document.querySelectorAll('#orgRows tr').length === 1);
  await shot('r09-orgs');
  await page.click('[data-tab=settings]');
  await page.waitForFunction(() => document.getElementById('mStatus').textContent.length > 0);
  await page.fill('#mailTo', 'me@example.com'); await page.click('#mailTestBtn');
  await page.waitForTimeout(500);
  await shot('r10-settings');

  await browser.close(); server.close();
  console.log('組織管理員看到的分頁：', tabs.join('、'));
  console.log('寄出的信：', sent.map(m => m.to + '｜' + m.subject).join(' / '));
  console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : '沒有前端錯誤');
  console.log('手機橫向捲動：', overflow ? '有' : '沒有');
})().catch(e => { console.error(e); process.exit(1); });
