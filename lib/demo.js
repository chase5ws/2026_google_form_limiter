'use strict';
// 訪客 Demo：按「訪客體驗」會建立一個只屬於這位訪客的沙盒組織
// - Google 帳號、雲端硬碟、表單、回覆都是記憶體裡的模擬資料，不會連到真的 Google
// - 寄信也是模擬的，只記錄在「寄信紀錄」，不會真的寄出
// - 沙盒在 DEMO_TTL 後自動刪除；重新啟動時也會清掉（模擬資料只存在記憶體）
const crypto = require('node:crypto');
const sec = require('./security');
const { FOLDER_MIME, FORM_MIME } = require('./google');

const { httpError } = sec;
const DEMO_TTL = 2 * 60 * 60 * 1000; // 沙盒保留 2 小時
const MAX_SANDBOXES = 50;            // 同時最多幾個沙盒
const PER_IP = 5;                    // 每個 IP 每 10 分鐘最多建立幾個
const IP_WINDOW = 10 * 60 * 1000;

const NAMES = ['王小明', '林怡君', '陳冠宇', '張雅婷', '李承恩', '黃詩涵', '吳柏翰', '劉佳穎', '蔡宗翰', '鄭欣妤', '許家豪', '謝宜蓁', '楊子軒', '洪郁婷', '郭俊傑', '曾品妍'];

/* ============ 模擬 Google（介面跟 lib/google.js 一樣） ============ */
function createDemoGoogle(account) {
  const files = new Map();
  let seq = 0;
  const need = (id) => { const f = files.get(id); if (!f || f.trashed) throw httpError(404, 'File not found: ' + id); return f; };
  const publish = (f) => ({ publishState: { isPublished: true, isAcceptingResponses: f.accepting } });
  const g = {
    demo: true,
    files,
    SCOPES: [],
    configured: () => true,
    connected: () => true,
    email: () => account,
    authUrl() { throw httpError(403, 'Demo 模式已經連接模擬的 Google 帳號，不能連接真的帳號。'); },
    async exchangeCode() { throw httpError(403, 'Demo 模式不能連接真的 Google 帳號。'); },
    disconnect() {},

    folder(id, name) { files.set(id, { id, name, mimeType: FOLDER_MIME }); },
    form(id, name, parent, items) { files.set(id, { id, name, mimeType: FORM_MIME, parent, items, responses: [], accepting: true }); },
    /** 加一筆模擬回覆；choice：{ questionId: 值 } */
    submit(id, { at = Date.now(), name, choices = {} } = {}) {
      const f = files.get(id);
      if (!f) return null;
      const k = ++seq;
      const email = `guest${String(k).padStart(3, '0')}@example.com`;
      const answers = { name: { textAnswers: { answers: [{ value: name || NAMES[k % NAMES.length] }] } } };
      for (const [q, v] of Object.entries(choices)) answers[q] = { textAnswers: { answers: [].concat(v).map(x => ({ value: x })) } };
      const r = { responseId: 'DEMO' + String(k).padStart(6, '0'), createTime: new Date(at).toISOString(), respondentEmail: email, answers };
      f.responses.push(r);
      f.responses.sort((a, b) => Date.parse(a.createTime) - Date.parse(b.createTime));
      return r;
    },
    /** 目前表單上看得到的選項（額滿的會被平台移除） */
    visibleOptions(id, questionId) {
      const f = files.get(id);
      const it = f && f.items.find(i => i.questionItem && i.questionItem.question.questionId === questionId);
      return it ? (it.questionItem.question.choiceQuestion.options || []).filter(o => !o.isOther).map(o => o.value) : [];
    },

    async fileMeta(id) {
      const f = need(id);
      return { id, name: f.name, mimeType: f.mimeType, trashed: false, parents: f.parent ? [f.parent] : [], owners: [{ emailAddress: account }], capabilities: { canEdit: true } };
    },
    async listFolderForms(folderId) {
      need(folderId);
      return [...files.values()].filter(f => f.parent === folderId && f.mimeType === FORM_MIME)
        .map(f => ({ id: f.id, name: f.name, modifiedTime: new Date().toISOString(), capabilities: { canEdit: true } }));
    },
    async getForm(id) {
      const f = need(id);
      return { formId: id, info: { title: f.name }, responderUri: `https://docs.google.com/forms/d/e/${id}/viewform`, publishSettings: publish(f) };
    },
    async getFormFull(id) {
      const f = need(id);
      return { formId: id, info: { title: f.name }, items: JSON.parse(JSON.stringify(f.items)), publishSettings: publish(f) };
    },
    async updateChoiceOptions(id, { itemId, questionId, type, options }) {
      const it = need(id).items.find(i => i.itemId === itemId);
      if (!it || it.questionItem.question.questionId !== questionId) throw httpError(400, 'item mismatch');
      if (!options.length) throw httpError(400, 'choice question needs at least one option');
      it.questionItem.question.choiceQuestion = { type, options: JSON.parse(JSON.stringify(options)) };
      return {};
    },
    async updateChoiceQuestion(id, { itemId, questionId, type, title, options }) {
      const it = need(id).items.find(i => i.itemId === itemId);
      if (!it || it.questionItem.question.questionId !== questionId) throw httpError(400, 'item mismatch');
      if (!options.length) throw httpError(400, 'choice question needs at least one option');
      it.title = title;
      it.questionItem.question.choiceQuestion = { type, options: JSON.parse(JSON.stringify(options)) };
      return {};
    },
    async formQuestions(id) {
      const f = need(id);
      return { collectsEmail: true, questions: f.items.filter(i => i.questionItem).map(i => ({ id: i.questionItem.question.questionId, title: i.title })) };
    },
    async countResponses(id) { return need(id).responses.length; },
    async listResponses(id, withAnswers) {
      return need(id).responses.map(r => (withAnswers ? JSON.parse(JSON.stringify(r)) : { responseId: r.responseId, createTime: r.createTime, respondentEmail: r.respondentEmail }));
    },
    async setAccepting(id, accepting) { need(id).accepting = !!accepting; return {}; }
  };
  return g;
}

/* ============ 模擬寄信：只記錄，不寄出 ============ */
function createDemoMailer(account) {
  const sent = [];
  return {
    demo: true, sent,
    provider: 'gas',
    from: `Demo 組織 <${account}>`,
    enabled: () => true,
    async send(m) { sent.push(Object.assign({ at: Date.now() }, m)); if (sent.length > 200) sent.shift(); }
  };
}

/* ============ 範例表單 ============ */
const text = (id, title) => ({ itemId: 'item-' + id, title, questionItem: { question: { questionId: id, textQuestion: {} } } });
const choice = (id, title, values, type = 'RADIO') => ({ itemId: 'item-' + id, title, questionItem: { question: { questionId: id, choiceQuestion: { type, options: values.map(value => ({ value })) } } } });
const page = (id, title) => ({ itemId: 'pb-' + id, title, pageBreakItem: {} });

/**
 * db、limiter：平台本身的；建立沙盒時把範例表單加入管理，再跑一次檢查，
 * 讓「選項額滿被移除」「名額已滿關閉」「候補信」一開始就看得到。
 */
function createDemo({ db, getLimiter, log = console }) {
  const sandboxes = new Map(); // orgId → { google, mailer, expiresAt, forms: { key: googleFormId } }
  const ipHits = new Map();

  try { db.raw.exec('ALTER TABLE orgs ADD COLUMN demo_expires INTEGER'); } catch (e) { /* 已存在 */ }
  // 模擬資料只在記憶體裡：啟動時把上次留下的沙盒清掉
  purge(() => true);

  function purge(pred) {
    const rows = db.all('SELECT id, demo_expires FROM orgs WHERE demo_expires IS NOT NULL');
    let n = 0;
    for (const o of rows) {
      if (!pred(o)) continue;
      db.run('DELETE FROM orgs WHERE id = ?', o.id); // 帳號、表單、寄信紀錄、登入都會一起刪除（ON DELETE CASCADE）
      db.run('DELETE FROM logs WHERE org_id = ?', o.id);
      sandboxes.delete(o.id);
      n++;
    }
    return n;
  }

  function rateLimit(ip) {
    const now = Date.now();
    const hits = (ipHits.get(ip) || []).filter(t => now - t < IP_WINDOW);
    if (hits.length >= PER_IP) throw httpError(429, '建立 Demo 的次數太多了，請 10 分鐘後再試。');
    hits.push(now);
    ipHits.set(ip, hits);
    if (ipHits.size > 5000) ipHits.clear();
  }

  async function createSandbox(ip) {
    purge(o => o.demo_expires < Date.now());
    rateLimit(String(ip || ''));
    if (db.get('SELECT COUNT(*) n FROM orgs WHERE demo_expires IS NOT NULL').n >= MAX_SANDBOXES) {
      throw httpError(503, '目前體驗的人太多了，請稍後再試。');
    }
    const tag = crypto.randomBytes(3).toString('hex');
    const account = `demo-${tag}@example.com`;
    const now = Date.now();
    const expiresAt = now + DEMO_TTL;
    const google = createDemoGoogle(account);
    const mailer = createDemoMailer(account);

    // 雲端硬碟：一個資料夾、四份表單
    const folderId = 'DEMO_FOLDER_' + tag;
    const ids = { talk: `1DemoTalk${tag}xxxxxxxxxxxxxxxxxxxxxxxx`, camp: `1DemoCamp${tag}xxxxxxxxxxxxxxxxxxxxxxxx`, vol: `1DemoVolunteer${tag}xxxxxxxxxxxxxxxxxxx`, party: `1DemoParty${tag}xxxxxxxxxxxxxxxxxxxxxxx` };
    google.folder(folderId, '活動報名表單');
    google.form(ids.talk, '十二月親子講座報名', folderId, [
      text('name', '姓名'), choice('age', '孩子年齡', ['3–6 歲', '7–9 歲', '10–12 歲']),
      page('2', '場次選擇'), choice('slot', '場次', ['上午場（10:00）', '下午場（14:00）', '晚上場（19:00）'])
    ]);
    google.form(ids.camp, '寒假社團體驗營', folderId, [text('name', '姓名'), choice('club', '想體驗的社團', ['籃球', '熱舞', '吉他', '桌遊'], 'CHECKBOX')]);
    google.form(ids.vol, '春季志工招募', folderId, [text('name', '姓名'), choice('shift', '可以的時段', ['平日白天', '平日晚上', '週末'], 'DROP_DOWN')]);
    google.form(ids.party, '年終聚餐調查', folderId, [text('name', '姓名'), choice('food', '想吃什麼', ['火鍋', '燒肉', '義式'])]);

    // 模擬回覆：分散在過去 20 小時，數據頁的每小時圖表才有東西看
    const spread = (i, n) => now - 20 * 3600_000 + Math.round((i + Math.random() * 0.8) * (20 * 3600_000 / n));
    const slots = ['上午場（10:00）', '下午場（14:00）', '晚上場（19:00）'];
    const ages = ['3–6 歲', '7–9 歲', '10–12 歲'];
    const talkSlots = [].concat(Array(16).fill(slots[0]), Array(9).fill(slots[1]), Array(6).fill(slots[2]));
    talkSlots.forEach((s, i) => google.submit(ids.talk, { at: spread(i, talkSlots.length), choices: { age: ages[i % 3], slot: s } }));
    for (let i = 0; i < 24; i++) google.submit(ids.camp, { at: spread(i, 24), choices: { club: [['籃球'], ['熱舞', '吉他'], ['桌遊'], ['吉他']][i % 4] } });
    for (let i = 0; i < 7; i++) google.submit(ids.party, { at: spread(i, 7), choices: { food: ['火鍋', '燒肉', '義式'][i % 3] } });

    let orgId;
    db.tx(() => {
      const r = db.run('INSERT INTO orgs(name, shared_folder_id, shared_folder_name, shared_folder_owner, created_at, created_by, demo_expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
        `Demo 組織 ${tag}`, folderId, '活動報名表單', account, now, '訪客 Demo', expiresAt);
      orgId = Number(r.lastInsertRowid);
      // 訪客帳號：隨機密碼，只能透過「訪客體驗」按鈕登入
      db.run("INSERT INTO users(username, display_name, email, password_hash, role, org_id, must_change, created_at, created_by) VALUES (?, ?, ?, ?, 'org_admin', ?, 0, ?, '訪客 Demo')",
        `guest-${tag}`, '訪客', account, sec.hashPassword(crypto.randomBytes(24).toString('hex')), orgId, now);
      db.run("INSERT INTO users(username, display_name, email, password_hash, role, org_id, must_change, created_at, created_by) VALUES (?, ?, ?, ?, 'org_member', ?, 0, ?, '訪客 Demo')",
        `staff-${tag}`, '範例同事', `staff-${tag}@example.com`, sec.hashPassword(crypto.randomBytes(24).toString('hex')), orgId, now);
      const add = (key, title, extra) => {
        const id = ids[key];
        const cols = Object.assign({ org_id: orgId, title, source_form_id: id, google_form_id: id, responder_url: `https://docs.google.com/forms/d/e/${id}/viewform`,
          edit_url: `https://docs.google.com/forms/d/${id}/edit`, created_by: `guest-${tag}`, created_at: now }, extra);
        const k = Object.keys(cols);
        db.run(`INSERT INTO forms(${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`, ...k.map(c => cols[c]));
      };
      // 清單依 id 由新到舊排：最熱鬧的講座最後加，打開「數據」第一個看到它
      // 志工：3 天後才開放
      add('vol', '春季志工招募', { max_responses: 30, open_at: now + 3 * 86400_000, close_at: now + 17 * 86400_000 });
      // 體驗營：名額 20 已滿 → 關閉，第 21 名之後收到候補信
      add('camp', '寒假社團體驗營', { max_responses: 20, notify_enabled: 1, notify_source: 'respondent' });
      // 講座：總名額 40，上午場 15 人（會額滿被移除）、下午場 15、晚上場 10，候補寄信
      add('talk', '十二月親子講座報名', {
        max_responses: 40, notify_enabled: 1, notify_source: 'respondent', close_at: now + 10 * 86400_000,
        option_quotas: JSON.stringify([{ questionId: 'slot', title: '場次', section: 2, limits: { [slots[0]]: 15, [slots[1]]: 15, [slots[2]]: 10 }, hidden: [], order: slots }])
      });
      // 年終聚餐調查：放在資料夾裡但還沒加入管理，讓訪客試「加入管理」
      db.log(orgId, '系統', '建立訪客 Demo 沙盒（模擬的 Google 帳號與表單，2 小時後自動刪除）');
    });

    sandboxes.set(orgId, { google, mailer, expiresAt, ids, slots });
    const limiter = getLimiter();
    if (limiter) {
      for (const f of db.all('SELECT id FROM forms WHERE org_id = ?', orgId)) {
        try { await limiter.enforce(f.id, 'Demo 初始化'); } catch (e) { log.error && log.error('demo enforce', e); }
      }
    }
    return { orgId, username: `guest-${tag}`, expiresAt };
  }

  /** 每分鐘：清掉過期沙盒，並替每個沙盒的講座「新進」一筆報名，讓即時動態有變化 */
  function tick() {
    purge(o => o.demo_expires < Date.now());
    for (const [, sb] of sandboxes) {
      if (Math.random() < 0.5) continue;
      const open = sb.google.visibleOptions(sb.ids.talk, 'slot');
      const f = sb.google.files.get(sb.ids.talk);
      if (!f || !f.accepting || !open.length) continue;
      sb.google.submit(sb.ids.talk, { choices: { age: ['3–6 歲', '7–9 歲', '10–12 歲'][Math.floor(Math.random() * 3)], slot: open[Math.floor(Math.random() * open.length)] } });
    }
  }

  return {
    TTL: DEMO_TTL,
    isDemo: (orgId) => sandboxes.has(Number(orgId)),
    expiresAt: (orgId) => (sandboxes.get(Number(orgId)) || {}).expiresAt || null,
    google: (orgId) => (sandboxes.get(Number(orgId)) || {}).google,
    mailer: (orgId) => (sandboxes.get(Number(orgId)) || {}).mailer,
    forget: (orgId) => { sandboxes.delete(Number(orgId)); },
    createSandbox,
    tick,
    purge
  };
}

module.exports = { createDemo, createDemoGoogle, createDemoMailer, DEMO_TTL };
