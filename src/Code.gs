/**
 * Google Form Limiter — 表單限額管理後台（Google Apps Script 網頁應用程式）
 *
 * 功能
 *   - 名額上限：回覆數達到上限就自動關閉表單
 *   - 開放時間／截止時間：時間到自動開啟、關閉
 *   - 自己的登入系統：最高管理員（owner）可新增、停用其他管理員
 *
 * 安全設計
 *   - 密碼以「隨機鹽 + 多輪 HMAC-SHA256」雜湊後存放，不存明碼
 *   - 同一帳號連續登入失敗 5 次，鎖 15 分鐘
 *   - 登入後發放隨機 token，6 小時沒有動作就失效；改密碼或被停用後舊 token 立即失效
 *   - 結尾是底線 _ 的函式，前端網頁無法呼叫
 *
 * 初始化最高管理員：見 README「第一次設定」。
 */

const CONFIG = {
  TZ: 'Asia/Taipei',
  SESSION_SECONDS: 6 * 60 * 60,  // CacheService 上限就是 6 小時
  HASH_ROUNDS: 1000,
  MAX_FAILS: 5,
  LOCK_SECONDS: 15 * 60,
  CHECK_EVERY_MINUTES: 5,        // 只能是 1, 5, 10, 15, 30
  MIN_PASSWORD: 8,
  LOG_CHUNKS: 5,
  LOG_CHUNK_BYTES: 8000          // 單一屬性值上限約 9KB
};

const P = {
  ADMIN: 'GFL_ADMIN_',
  FORM: 'GFL_FORM_',
  LOG: 'GFL_LOG_',
  LOG_IDX: 'GFL_LOG_IDX',
  INIT_USER: 'INIT_OWNER_USER',
  INIT_PW: 'INIT_OWNER_PASSWORD'
};

const DEFAULT_MSG = {
  msgNotYet: '表單尚未開放填寫，請於開放時間再回來。',
  msgFull: '名額已滿，感謝您的支持！',
  msgEnded: '表單已截止，感謝您的參與！'
};

const REASON_TEXT = {
  manual: '手動關閉',
  notyet: '尚未開放',
  ended: '已截止',
  full: '名額已滿'
};

/* =========================================================
 * 網頁入口
 * ========================================================= */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('表單限額管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/* =========================================================
 * 在 Apps Script 編輯器手動執行：建立或救回最高管理員
 *   1. 專案設定 → 指令碼屬性，新增 INIT_OWNER_PASSWORD（以及選填的 INIT_OWNER_USER）
 *   2. 選擇 setupOwner 按「執行」
 *   3. 執行完會自動刪掉 INIT_OWNER_PASSWORD，第一次登入會要求改密碼
 * 前端雖然也能呼叫這個函式，但沒有那個指令碼屬性就什麼都不會做。
 * ========================================================= */
function setupOwner() {
  const props = props_();
  const pw = props.getProperty(P.INIT_PW);
  if (!pw) {
    throw new Error('請先在「專案設定 → 指令碼屬性」新增 INIT_OWNER_PASSWORD，再執行 setupOwner。');
  }
  const username = normUser_(props.getProperty(P.INIT_USER) || 'chase5ws');
  checkUsername_(username);
  const result = withLock_(() => {
    let u = getAdmin_(username);
    const isNew = !u;
    if (isNew) {
      u = { username, displayName: username, createdAt: Date.now(), createdBy: 'setupOwner', sessVer: 0 };
    }
    u.role = 'owner';
    u.disabled = false;
    setPassword_(u, pw);
    u.mustChange = true;
    u.sessVer = (u.sessVer || 0) + 1; // 救援時把所有既有登入踢掉
    saveAdmin_(u);
    return isNew ? '建立' : '重設';
  });
  props.deleteProperty(P.INIT_PW);
  CacheService.getScriptCache().remove('fail_' + username);
  ensureTimer_();
  log_('系統', `${result}最高管理員 ${username}`);
  Logger.log(`已${result}最高管理員：${username}。INIT_OWNER_PASSWORD 已刪除，第一次登入會要求修改密碼。`);
  return `已${result}最高管理員：${username}`;
}

/* =========================================================
 * 前端 API：登入／帳號
 * ========================================================= */
function appStatus() {
  return { initialized: listAdmins_().some(a => a.role === 'owner') };
}

function login(username, password) {
  username = normUser_(username);
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + username;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_FAILS) {
    throw new Error('登入失敗次數過多，請 15 分鐘後再試。');
  }
  const u = username ? getAdmin_(username) : null;
  const ok = !!u && !u.disabled && verifyPassword_(u, password);
  if (!ok) {
    cache.put(failKey, String(fails + 1), CONFIG.LOCK_SECONDS);
    log_(username || '(空白)', '登入失敗');
    throw new Error('帳號或密碼錯誤。');
  }
  cache.remove(failKey);
  u.lastLogin = Date.now();
  saveAdmin_(u);
  log_(username, '登入');
  return { token: newSession_(u), me: meOf_(u) };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

function whoAmI(token) {
  return meOf_(auth_(token, { allowMustChange: true }));
}

function changePassword(token, oldPw, newPw) {
  const u = auth_(token, { allowMustChange: true });
  if (!verifyPassword_(u, oldPw)) throw new Error('目前的密碼不正確。');
  checkPassword_(newPw, u.username);
  if (verifyPassword_(u, newPw)) throw new Error('新密碼不能跟舊密碼一樣。');
  withLock_(() => {
    setPassword_(u, newPw);
    u.mustChange = false;
    u.sessVer = (u.sessVer || 0) + 1; // 其他裝置的登入一併失效
    saveAdmin_(u);
  });
  CacheService.getScriptCache().remove('sess_' + token);
  log_(u.username, '修改自己的密碼');
  return { token: newSession_(u), me: meOf_(u) };
}

/* =========================================================
 * 前端 API：管理員（只有 owner 能用）
 * ========================================================= */
function listAdmins(token) {
  auth_(token, { owner: true });
  return listAdmins_()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(a => ({
      username: a.username,
      displayName: a.displayName || a.username,
      role: a.role,
      disabled: !!a.disabled,
      mustChange: !!a.mustChange,
      createdAt: fmt_(a.createdAt),
      createdBy: a.createdBy || '',
      lastLogin: fmt_(a.lastLogin)
    }));
}

function addAdmin(token, data) {
  const me = auth_(token, { owner: true });
  data = data || {};
  const username = normUser_(data.username);
  checkUsername_(username);
  checkPassword_(data.password, username);
  const role = data.role === 'owner' ? 'owner' : 'admin';
  withLock_(() => {
    if (getAdmin_(username)) throw new Error(`帳號 ${username} 已經存在。`);
    const u = {
      username,
      displayName: String(data.displayName || username).trim().slice(0, 40) || username,
      role,
      disabled: false,
      mustChange: true,
      sessVer: 0,
      createdAt: Date.now(),
      createdBy: me.username
    };
    setPassword_(u, data.password);
    saveAdmin_(u);
  });
  log_(me.username, `新增${role === 'owner' ? '最高' : ''}管理員 ${username}`);
  return listAdmins(token);
}

function updateAdmin(token, username, patch) {
  const me = auth_(token, { owner: true });
  username = normUser_(username);
  patch = patch || {};
  const changes = [];
  withLock_(() => {
    const u = getAdmin_(username);
    if (!u) throw new Error('找不到這個帳號。');
    if ('displayName' in patch) {
      u.displayName = String(patch.displayName || '').trim().slice(0, 40) || u.username;
      changes.push('顯示名稱');
    }
    if ('role' in patch) {
      const role = patch.role === 'owner' ? 'owner' : 'admin';
      if (u.username === me.username && role !== 'owner') throw new Error('不能把自己降級。');
      if (u.role === 'owner' && role !== 'owner') ensureAnotherOwner_(u.username);
      if (u.role !== role) changes.push(role === 'owner' ? '升為最高管理員' : '改為一般管理員');
      u.role = role;
    }
    if ('disabled' in patch) {
      const disabled = !!patch.disabled;
      if (u.username === me.username && disabled) throw new Error('不能停用自己。');
      if (disabled && u.role === 'owner') ensureAnotherOwner_(u.username);
      if (u.disabled !== disabled) changes.push(disabled ? '停用' : '啟用');
      u.disabled = disabled;
      if (disabled) u.sessVer = (u.sessVer || 0) + 1;
    }
    saveAdmin_(u);
  });
  if (changes.length) log_(me.username, `${username}：${changes.join('、')}`);
  return listAdmins(token);
}

function resetAdminPassword(token, username, newPw) {
  const me = auth_(token, { owner: true });
  username = normUser_(username);
  checkPassword_(newPw, username);
  withLock_(() => {
    const u = getAdmin_(username);
    if (!u) throw new Error('找不到這個帳號。');
    setPassword_(u, newPw);
    u.mustChange = true;
    u.sessVer = (u.sessVer || 0) + 1;
    saveAdmin_(u);
  });
  CacheService.getScriptCache().remove('fail_' + username);
  log_(me.username, `重設 ${username} 的密碼`);
  return listAdmins(token);
}

function deleteAdmin(token, username) {
  const me = auth_(token, { owner: true });
  username = normUser_(username);
  if (username === me.username) throw new Error('不能刪除自己。');
  withLock_(() => {
    const u = getAdmin_(username);
    if (!u) throw new Error('找不到這個帳號。');
    if (u.role === 'owner') ensureAnotherOwner_(u.username);
    props_().deleteProperty(P.ADMIN + username);
  });
  log_(me.username, `刪除管理員 ${username}`);
  return listAdmins(token);
}

/* =========================================================
 * 前端 API：表單
 * ========================================================= */
function listForms(token) {
  auth_(token);
  return listForms_().map(formView_);
}

/** 立即檢查全部表單（開啟每份表單，數量多時會花幾秒） */
function refreshAllForms(token) {
  auth_(token);
  checkAllForms();
  return listForms_().map(formView_);
}

function refreshForm(token, id) {
  auth_(token);
  return withLock_(() => formView_(enforceById_(id, '手動檢查')));
}

function addForm(token, input) {
  const me = auth_(token);
  const id = parseFormId_(input);
  let form;
  try {
    form = FormApp.openById(id);
  } catch (e) {
    throw new Error('打不開這份表單。請確認網址正確，而且部署這個後台的 Google 帳號有這份表單的編輯權限。');
  }
  const cfg = withLock_(() => {
    if (getForm_(id)) throw new Error('這份表單已經在管理清單裡了。');
    const c = Object.assign({
      id,
      title: form.getTitle() || '(未命名表單)',
      editUrl: form.getEditUrl(),
      publishedUrl: safe_(() => form.getPublishedUrl(), ''),
      maxResponses: null,
      openAt: null,
      closeAt: null,
      manualClosed: false,
      triggerId: null,
      addedBy: me.username,
      addedAt: Date.now()
    }, DEFAULT_MSG);
    c.triggerId = installSubmitTrigger_(form);
    saveForm_(c);
    return enforce_(c, form, '加入管理');
  });
  ensureTimer_();
  log_(me.username, `加入表單「${cfg.title}」`);
  return formView_(cfg);
}

function updateForm(token, id, patch) {
  const me = auth_(token);
  patch = patch || {};
  const cfg = withLock_(() => {
    const c = getForm_(id);
    if (!c) throw new Error('找不到這份表單，可能已被其他管理員移除。');

    if ('maxResponses' in patch) {
      const v = String(patch.maxResponses == null ? '' : patch.maxResponses).trim();
      if (v === '') c.maxResponses = null;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 1000000) throw new Error('名額上限要是 1 以上的整數，留空代表不限。');
        c.maxResponses = n;
      }
    }
    if ('openAt' in patch) c.openAt = parseLocal_(patch.openAt);
    if ('closeAt' in patch) c.closeAt = parseLocal_(patch.closeAt);
    if (c.openAt && c.closeAt && c.closeAt <= c.openAt) throw new Error('截止時間必須晚於開放時間。');
    ['msgNotYet', 'msgFull', 'msgEnded'].forEach(k => {
      if (k in patch) c[k] = String(patch[k] || '').trim().slice(0, 500) || DEFAULT_MSG[k];
    });
    c.updatedBy = me.username;
    c.updatedAt = Date.now();
    saveForm_(c);
    return enforce_(c, null, '更新設定', true);
  });
  log_(me.username, `修改「${cfg.title}」設定：${ruleSummary_(cfg)}`);
  return formView_(cfg);
}

function setFormOpen(token, id, open) {
  const me = auth_(token);
  const cfg = withLock_(() => {
    const c = getForm_(id);
    if (!c) throw new Error('找不到這份表單。');
    c.manualClosed = !open;
    c.updatedBy = me.username;
    c.updatedAt = Date.now();
    saveForm_(c);
    return enforce_(c, null, open ? '手動開放' : '手動關閉', true);
  });
  log_(me.username, `${open ? '手動開放' : '手動關閉'}「${cfg.title}」`);
  return formView_(cfg);
}

function removeForm(token, id) {
  const me = auth_(token);
  const title = withLock_(() => {
    const c = getForm_(id);
    if (!c) throw new Error('找不到這份表單。');
    removeTrigger_(c.triggerId);
    props_().deleteProperty(P.FORM + id);
    return c.title;
  });
  log_(me.username, `移除表單「${title}」（表單本身不會被刪除，維持目前的開關狀態）`);
  return listForms_().map(formView_);
}

function getLogs(token) {
  auth_(token);
  return readLogs_().slice(0, 300).map(l => ({ time: fmt_(l.t), who: l.w, what: l.m }));
}

/* =========================================================
 * 觸發器（由 Google 呼叫）
 * ========================================================= */
/** 每份受管表單「提交表單時」觸發 */
function onLimitedFormSubmit(e) {
  let form, id;
  try {
    form = e.source;
    id = form.getId();
  } catch (err) {
    return; // 不是真的表單事件
  }
  withLock_(() => {
    const c = getForm_(id);
    if (c) enforce_(c, form, '有人送出');
  });
}

/** 每 5 分鐘：處理開放／截止時間，也補檢查名額 */
function checkAllForms() {
  listForms_().forEach(c => {
    try {
      withLock_(() => enforceById_(c.id, '定時檢查'));
    } catch (err) {
      // 單一表單出錯不影響其他表單，錯誤已記錄在 lastError
    }
  });
}

/* =========================================================
 * 核心邏輯：判斷表單該開還是該關
 * ========================================================= */
/** 純函式：依規則算出應有狀態 */
function evaluate_(c, count, now) {
  if (c.manualClosed) return { open: false, reason: 'manual' };
  if (c.openAt && now < c.openAt) return { open: false, reason: 'notyet' };
  if (c.closeAt && now >= c.closeAt) return { open: false, reason: 'ended' };
  if (c.maxResponses && count >= c.maxResponses) return { open: false, reason: 'full' };
  return { open: true, reason: null };
}

function closedMessage_(c, reason) {
  if (reason === 'notyet') return c.msgNotYet || DEFAULT_MSG.msgNotYet;
  if (reason === 'full') return c.msgFull || DEFAULT_MSG.msgFull;
  return c.msgEnded || DEFAULT_MSG.msgEnded;
}

function enforceById_(id, source) {
  const c = getForm_(id);
  if (!c) throw new Error('找不到這份表單。');
  return enforce_(c, null, source);
}

/**
 * 讀取回覆數、套用規則、必要時開關表單，並把結果存回設定。
 * 呼叫端要先拿 withLock_。
 */
function enforce_(c, form, source, rethrow) {
  c.lastCheck = Date.now();
  try {
    form = form || FormApp.openById(c.id);
    c.title = form.getTitle() || c.title;
    const count = form.getResponses().length;
    const want = evaluate_(c, count, Date.now());
    const published = typeof form.isPublished === 'function' ? form.isPublished() : true;
    const accepting = form.isAcceptingResponses();

    c.lastCount = count;
    c.lastError = '';

    if (!published) {
      c.lastState = 'unpublished';
      c.lastReason = want.reason;
      c.lastError = '表單尚未「發布」，Google 不會收回覆。請到表單編輯頁按右上角「發布」。';
    } else {
      if (!want.open) {
        const msg = closedMessage_(c, want.reason);
        if (accepting || c.lastReason !== want.reason || c.lastMsg !== msg) {
          form.setCustomClosedFormMessage(msg);
          c.lastMsg = msg;
        }
      }
      if (accepting !== want.open) {
        form.setAcceptingResponses(want.open);
        log_('系統', `${want.open ? '開放' : '關閉'}「${c.title}」（${source}${want.reason ? '，' + REASON_TEXT[want.reason] : ''}，目前 ${count} 份）`);
      }
      c.lastState = want.open ? 'open' : 'closed';
      c.lastReason = want.reason;
    }
  } catch (err) {
    c.lastError = String(err && err.message || err);
    saveForm_(c);
    if (rethrow) throw new Error('設定已儲存，但套用到表單時失敗：' + c.lastError);
    return c;
  }
  saveForm_(c);
  return c;
}

/* =========================================================
 * 觸發器管理
 * ========================================================= */
function installSubmitTrigger_(form) {
  try {
    return ScriptApp.newTrigger('onLimitedFormSubmit').forForm(form).onFormSubmit().create().getUniqueId();
  } catch (err) {
    // 每個指令碼最多 20 個觸發器；超過時只靠每 5 分鐘的定時檢查
    log_('系統', `「${form.getTitle()}」無法安裝送出觸發器，改為只靠定時檢查：${err.message || err}`);
    return null;
  }
}

function removeTrigger_(uid) {
  if (!uid) return;
  ScriptApp.getProjectTriggers()
    .filter(t => t.getUniqueId() === uid)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function ensureTimer_() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'checkAllForms');
  if (!has) {
    ScriptApp.newTrigger('checkAllForms').timeBased().everyMinutes(CONFIG.CHECK_EVERY_MINUTES).create();
  }
}

/* =========================================================
 * 身分驗證
 * ========================================================= */
function newSession_(u) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('sess_' + token, `${u.username}|${u.sessVer || 0}`, CONFIG.SESSION_SECONDS);
  return token;
}

function auth_(token, opt) {
  opt = opt || {};
  if (!token || typeof token !== 'string') throw new Error('AUTH: 請先登入。');
  const cache = CacheService.getScriptCache();
  const val = cache.get('sess_' + token);
  if (!val) throw new Error('AUTH: 登入已逾時，請重新登入。');
  const parts = val.split('|');
  const u = getAdmin_(parts[0]);
  if (!u || u.disabled || String(u.sessVer || 0) !== parts[1]) {
    cache.remove('sess_' + token);
    throw new Error('AUTH: 帳號狀態已變更，請重新登入。');
  }
  if (u.mustChange && !opt.allowMustChange) throw new Error('MUSTCHANGE: 請先修改密碼。');
  if (opt.owner && u.role !== 'owner') throw new Error('權限不足：只有最高管理員可以管理帳號。');
  cache.put('sess_' + token, val, CONFIG.SESSION_SECONDS); // 有動作就延長
  return u;
}

function meOf_(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role,
    mustChange: !!u.mustChange
  };
}

function setPassword_(u, pw) {
  u.salt = Utilities.getUuid();
  u.rounds = CONFIG.HASH_ROUNDS;
  u.hash = hashPassword_(String(pw), u.salt, u.rounds);
}

function verifyPassword_(u, pw) {
  if (!u || !u.hash || typeof pw !== 'string') return false;
  const h = hashPassword_(pw, u.salt, u.rounds || CONFIG.HASH_ROUNDS);
  if (h.length !== u.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ u.hash.charCodeAt(i);
  return diff === 0;
}

function hashPassword_(pw, salt, rounds) {
  const key = Utilities.newBlob(salt).getBytes();
  let b = Utilities.computeHmacSha256Signature(Utilities.newBlob(pw).getBytes(), key);
  for (let i = 1; i < rounds; i++) b = Utilities.computeHmacSha256Signature(b, key);
  return Utilities.base64Encode(b);
}

function normUser_(s) {
  return String(s || '').trim().toLowerCase();
}

function checkUsername_(username) {
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('帳號只能用 3–32 個英文小寫、數字、點、底線或減號。');
  }
}

function checkPassword_(pw, username) {
  pw = String(pw || '');
  if (pw.length < CONFIG.MIN_PASSWORD) throw new Error(`密碼至少要 ${CONFIG.MIN_PASSWORD} 個字元。`);
  if (pw.length > 128) throw new Error('密碼太長了（最多 128 個字元）。');
  const lower = pw.toLowerCase();
  if (username && lower.indexOf(username) >= 0) throw new Error('密碼不能包含帳號名稱。');
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('密碼要同時包含英文字母和數字。');
}

function ensureAnotherOwner_(exceptUsername) {
  const others = listAdmins_().filter(a => a.role === 'owner' && !a.disabled && a.username !== exceptUsername);
  if (!others.length) throw new Error('至少要保留一位啟用中的最高管理員。');
}

/* =========================================================
 * 資料存取（指令碼屬性）
 * ========================================================= */
function props_() {
  return PropertiesService.getScriptProperties();
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('系統忙碌中，請稍後再試。');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function readJson_(key) {
  const s = props_().getProperty(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function byPrefix_(prefix) {
  const all = props_().getProperties();
  return Object.keys(all)
    .filter(k => k.indexOf(prefix) === 0)
    .map(k => { try { return JSON.parse(all[k]); } catch (e) { return null; } })
    .filter(Boolean);
}

function getAdmin_(username) { return username ? readJson_(P.ADMIN + username) : null; }
function saveAdmin_(u) { props_().setProperty(P.ADMIN + u.username, JSON.stringify(u)); }
function listAdmins_() { return byPrefix_(P.ADMIN); }

function getForm_(id) { return id ? readJson_(P.FORM + id) : null; }
function saveForm_(c) { props_().setProperty(P.FORM + c.id, JSON.stringify(c)); }
function listForms_() {
  return byPrefix_(P.FORM).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/* ---------- 操作紀錄：輪替存在 5 個屬性裡 ---------- */
function log_(who, msg) {
  try {
    const props = props_();
    let idx = Number(props.getProperty(P.LOG_IDX) || 0);
    let arr = readJson_(P.LOG + idx) || [];
    arr.push({ t: Date.now(), w: String(who).slice(0, 40), m: String(msg).slice(0, 300) });
    let s = JSON.stringify(arr);
    if (byteLen_(s) > CONFIG.LOG_CHUNK_BYTES) {
      idx = (idx + 1) % CONFIG.LOG_CHUNKS;
      arr = arr.slice(-1);
      s = JSON.stringify(arr);
      props.setProperty(P.LOG_IDX, String(idx));
    }
    props.setProperty(P.LOG + idx, s);
  } catch (e) {
    // 紀錄失敗不影響主要功能
  }
}

function readLogs_() {
  // 從最舊的區塊讀到目前區塊，再整個反轉成「新的在前」
  const cur = Number(props_().getProperty(P.LOG_IDX) || 0);
  let all = [];
  for (let k = 1; k <= CONFIG.LOG_CHUNKS; k++) {
    all = all.concat(readJson_(P.LOG + ((cur + k) % CONFIG.LOG_CHUNKS)) || []);
  }
  return all.reverse();
}

/* =========================================================
 * 小工具
 * ========================================================= */
function parseFormId_(input) {
  const s = String(input || '').trim();
  if (/\/forms\/d\/e\//.test(s) || /forms\.gle\//.test(s)) {
    throw new Error('這是「填寫」網址。請貼表單的「編輯」網址，格式是 https://docs.google.com/forms/d/…/edit');
  }
  const m = s.match(/\/forms\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  throw new Error('看不懂這個網址。請貼表單的「編輯」網址，格式是 https://docs.google.com/forms/d/…/edit');
}

/** 'yyyy-MM-ddTHH:mm'（台北時間）→ 毫秒；空字串 → null */
function parseLocal_(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) throw new Error('時間格式不正確。');
  return Utilities.parseDate(s, CONFIG.TZ, "yyyy-MM-dd'T'HH:mm").getTime();
}

function fmt_(ms, pattern) {
  if (!ms) return '';
  return Utilities.formatDate(new Date(ms), CONFIG.TZ, pattern || 'yyyy/MM/dd HH:mm');
}

function byteLen_(s) {
  return Utilities.newBlob(s).getBytes().length;
}

function safe_(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

function ruleSummary_(c) {
  const parts = [];
  parts.push(c.maxResponses ? `上限 ${c.maxResponses} 份` : '不限名額');
  if (c.openAt) parts.push(`${fmt_(c.openAt)} 開放`);
  if (c.closeAt) parts.push(`${fmt_(c.closeAt)} 截止`);
  return parts.join('、');
}

/** 傳給前端的表單資料（不含內部欄位） */
function formView_(c) {
  return {
    id: c.id,
    title: c.title,
    editUrl: c.editUrl,
    publishedUrl: c.publishedUrl,
    maxResponses: c.maxResponses,
    openAt: fmt_(c.openAt, "yyyy-MM-dd'T'HH:mm"),
    closeAt: fmt_(c.closeAt, "yyyy-MM-dd'T'HH:mm"),
    openAtText: fmt_(c.openAt),
    closeAtText: fmt_(c.closeAt),
    msgNotYet: c.msgNotYet,
    msgFull: c.msgFull,
    msgEnded: c.msgEnded,
    manualClosed: !!c.manualClosed,
    count: c.lastCount == null ? null : c.lastCount,
    state: c.lastState || 'unknown',
    reason: c.lastReason || null,
    reasonText: c.lastReason ? REASON_TEXT[c.lastReason] : '',
    lastCheck: fmt_(c.lastCheck, 'MM/dd HH:mm:ss'),
    lastError: c.lastError || '',
    hasSubmitTrigger: !!c.triggerId,
    addedBy: c.addedBy,
    updatedBy: c.updatedBy || ''
  };
}
