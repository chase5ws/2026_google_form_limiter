'use strict';
// 依規則算出表單應有的狀態，透過 Forms API 開關；處理選項名額（移除／加回選項）；
// 並依送出順序排位、寄候補／遞補通知。另外提供「模擬」：不動真的表單，算出會發生什麼事。
const { planQuotas, waitlistOf } = require('./quota');

const REASON_TEXT = { manual: '手動關閉', notyet: '尚未開放', ended: '已截止', full: '名額已滿', optfull: '選項皆已額滿' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTEMPTS = 3;
const MAX_MAILS_PER_CHECK = 30;

const DEFAULT_TEMPLATES = {
  waitlistSubject: '「{title}」名額已滿通知',
  waitlistBody: '您好：\n\n感謝您報名「{title}」。很抱歉，{full}已經額滿，您的順位是第 {rank} 位（候補第 {waitlist} 位）。\n如果有名額釋出，我們會再寄信通知您。\n\n{org} 敬上',
  promoteSubject: '「{title}」候補遞補成功',
  promoteBody: '您好：\n\n好消息！「{title}」有名額釋出，您已經從候補遞補為正取。\n\n{org} 敬上'
};

function evaluate(f, count, now, opts = {}) {
  if (f.manual_closed) return { open: false, reason: 'manual' };
  if (f.open_at && now < f.open_at) return { open: false, reason: 'notyet' };
  if (f.close_at && now >= f.close_at) return { open: false, reason: 'ended' };
  if (f.max_responses && count != null && count >= f.max_responses) return { open: false, reason: 'full' };
  if (opts.optFull) return { open: false, reason: 'optfull' };
  return { open: true, reason: null };
}

/** 依建立時間排序（同時間用 responseId），回傳加上 rank 的陣列 */
function rankResponses(responses) {
  return responses.slice()
    .sort((a, b) => (a.createTime < b.createTime ? -1 : a.createTime > b.createTime ? 1 : a.responseId < b.responseId ? -1 : 1))
    .map((r, i) => Object.assign({}, r, { rank: i + 1 }));
}

function emailOf(resp, source) {
  let v = '';
  if (!source || source === 'respondent') v = resp.respondentEmail || '';
  else {
    const a = resp.answers && resp.answers[source];
    v = (a && a.textAnswers && a.textAnswers.answers && a.textAnswers.answers[0] && a.textAnswers.answers[0].value) || '';
  }
  v = String(v).trim();
  return EMAIL_RE.test(v) ? v : null;
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

const parseQuotas = (f) => { try { return JSON.parse(f.option_quotas || '[]'); } catch (e) { return []; } };

function templatesOf(f) {
  return {
    waitlistSubject: f.notify_waitlist_subject || DEFAULT_TEMPLATES.waitlistSubject,
    waitlistBody: f.notify_waitlist_body || DEFAULT_TEMPLATES.waitlistBody,
    promoteSubject: f.notify_promote_subject || DEFAULT_TEMPLATES.promoteSubject,
    promoteBody: f.notify_promote_body || DEFAULT_TEMPLATES.promoteBody
  };
}

/** 算出每筆回覆該收哪種信（不寄、不寫資料庫） */
function planNotices(f, ranked, quotas, existing, orgName) {
  const wl = waitlistOf(ranked, f.max_responses, quotas);
  const tpl = templatesOf(f);
  const out = [];
  for (const r of ranked) {
    let kind = null, info = null;
    if (wl.has(r.responseId)) { kind = 'waitlist'; info = wl.get(r.responseId); }
    else {
      const w = existing.get(`${r.responseId}:waitlist`);
      if (w && w.status === 'sent') { kind = 'promoted'; info = { rank: r.rank, limit: f.max_responses || '', option: '' }; }
    }
    if (!kind) continue;
    const vars = {
      title: f.title, org: orgName, rank: info.rank, limit: info.limit, waitlist: Math.max(0, info.rank - (Number(info.limit) || 0)),
      option: info.option, full: info.option ? `「${info.option}」的名額 ${info.limit} 位` : `本次名額 ${info.limit} 位`
    };
    out.push({
      r, kind, info, email: emailOf(r, f.notify_source),
      subject: fill(kind === 'waitlist' ? tpl.waitlistSubject : tpl.promoteSubject, vars),
      text: fill(kind === 'waitlist' ? tpl.waitlistBody : tpl.promoteBody, vars)
    });
  }
  return out;
}

/** mailerFor(orgId)：回傳該組織自己設定的寄信器（沒設定時 enabled() 為 false）；也接受舊寫法 mailer */
function createLimiter({ db, google = null, googleFor = null, mailer = null, mailerFor = null, intervalMs = 60_000, log = console }) {
  const getMailer = mailerFor || (() => mailer);
  // googleFor(orgId)：每個組織用自己連接的 Google 帳號；也接受舊寫法 google（所有組織共用）
  const gFor = googleFor || (() => google);
  const running = new Map();   // formId → Promise
  let stopping = false;
  const existingNotices = (formId) => new Map(db.all('SELECT * FROM notices WHERE form_id = ?', formId).map(n => [`${n.response_id}:${n.kind}`, n]));

  async function processNotices(f, ranked, quotas, orgName, mailer) {
    const existing = existingNotices(f.id);
    let sent = 0, failed = 0, budget = MAX_MAILS_PER_CHECK;
    for (const n of planNotices(f, ranked, quotas, existing, orgName)) {
      if (stopping || budget <= 0) break;
      const prev = existing.get(`${n.r.responseId}:${n.kind}`);
      if (prev && (prev.status !== 'failed' || prev.attempts >= MAX_ATTEMPTS)) continue;
      let status = 'sent', error = null;
      if (!n.email) { status = 'skipped'; error = '這筆回覆沒有可用的 Email'; }
      else {
        budget--;
        try { await mailer.send({ to: n.email, subject: n.subject, text: n.text }); sent++; }
        catch (e) { status = 'failed'; error = e.message; failed++; }
      }
      db.run(`INSERT INTO notices(form_id, response_id, kind, email, rank, status, attempts, error, at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
              ON CONFLICT(form_id, response_id, kind) DO UPDATE SET email = excluded.email, rank = excluded.rank, status = excluded.status,
              attempts = notices.attempts + 1, error = excluded.error, at = excluded.at`,
        f.id, n.r.responseId, n.kind, n.email, n.info.rank, status, error, Date.now());
    }
    if (sent || failed) {
      db.log(f.org_id, '系統', `「${f.title}」寄出 ${sent} 封通知${failed ? `，${failed} 封失敗` : ''}（共 ${ranked.length} 份）`);
    }
  }

  async function doEnforce(formId, source) {
    const f = db.get('SELECT f.*, o.name AS org_name FROM forms f JOIN orgs o ON o.id = f.org_id WHERE f.id = ?', formId);
    if (!f) return null;
    const patch = { last_check: Date.now(), last_error: null };
    const notes = [];
    const google = gFor(f.org_id);
    try {
      if (!google.connected()) throw new Error('組織還沒連接 Google 帳號（組織設定 → Google 帳號）。');
      const info = await google.getForm(f.google_form_id);
      if (info.info && info.info.title) { patch.title = info.info.title; f.title = info.info.title; }
      if (info.responderUri) patch.responder_url = info.responderUri;
      if (!info.publishSettings) throw new Error('這是舊版格式的表單，無法用 API 開關。請在 Google 表單「⋮ → 建立副本」後改加入副本。');
      const ps = info.publishSettings.publishState || {};

      const quotas = parseQuotas(f);
      const mailer = getMailer(f.org_id);
      const wantNotices = !!(f.notify_enabled && (f.max_responses || quotas.length) && mailer && mailer.enabled());
      const needAnswers = quotas.length > 0 || (wantNotices && f.notify_source && f.notify_source !== 'respondent');
      let count, ranked = null;
      if (wantNotices || quotas.length) {
        ranked = rankResponses(await google.listResponses(f.google_form_id, needAnswers));
        count = ranked.length;
      } else {
        count = await google.countResponses(f.google_form_id);
      }
      patch.last_count = count;

      // 選項名額：移除額滿選項、加回有空位的選項
      let plan = null;
      if (quotas.length) {
        plan = planQuotas(quotas, await google.getFormFull(f.google_form_id), ranked);
        for (const a of plan.actions) await google.updateChoiceOptions(f.google_form_id, a);
        plan.changes.forEach(c => db.log(f.org_id, '系統', `${c}（${source}）`));
        notes.push(...plan.errors);
        patch.option_quotas = JSON.stringify(plan.quotas.filter(q => !(q.remove && !q.hidden.length)));
      }

      const want = evaluate(f, count, Date.now(), { optFull: plan && plan.allFull });
      const accepting = !!(ps.isPublished && ps.isAcceptingResponses);
      if (accepting !== want.open || !ps.isPublished) {
        await google.setAccepting(f.google_form_id, want.open);
        db.log(f.org_id, '系統', `${want.open ? '開放' : '關閉'}「${f.title}」（${source}${want.reason ? '，' + REASON_TEXT[want.reason] : ''}，目前 ${count} 份）`);
      }
      patch.state = want.open ? 'open' : 'closed';
      patch.reason = want.reason;

      if (wantNotices) {
        try { await processNotices(f, ranked, plan ? plan.quotas : quotas, f.org_name, mailer); }
        catch (e) { notes.push('寄信流程失敗：' + e.message); }
      }
    } catch (e) {
      notes.push(e.message);
    }
    patch.last_error = notes.length ? notes.join(' ') : null;
    const cols = Object.keys(patch);
    db.run(`UPDATE forms SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, ...cols.map(c => patch[c]), formId);
    return db.get('SELECT * FROM forms WHERE id = ?', formId);
  }

  /** 檢查一份表單並套用規則；同一份表單同時只跑一個 */
  function enforce(formId, source) {
    if (running.has(formId)) return running.get(formId);
    const p = doEnforce(formId, source).finally(() => running.delete(formId));
    running.set(formId, p);
    return p;
  }

  /**
   * 模擬：加入 count 筆假的回覆（選 choices、Email 為 email），算出會發生什麼事。
   * 不改表單、不寫資料庫；只會把「假回覆會收到的第一封信」加上 [測試] 寄給 email。
   */
  async function simulate(formId, { choices = {}, count = 1, email = '', sendMail = true } = {}) {
    const f = db.get('SELECT f.*, o.name AS org_name FROM forms f JOIN orgs o ON o.id = f.org_id WHERE f.id = ?', formId);
    const quotas = parseQuotas(f);
    const google = gFor(f.org_id);
    const full = await google.getFormFull(f.google_form_id);
    const real = rankResponses(await google.listResponses(f.google_form_id, true));
    const now = Date.now();
    const fakes = [];
    for (let i = 0; i < count; i++) {
      const answers = {};
      for (const [qid, v] of Object.entries(choices)) if (v) answers[qid] = { textAnswers: { answers: [{ value: String(v) }] } };
      if (f.notify_source && f.notify_source !== 'respondent' && email) answers[f.notify_source] = { textAnswers: { answers: [{ value: email }] } };
      fakes.push({ responseId: `TEST-${i + 1}`, createTime: new Date(now + i).toISOString(), respondentEmail: email, answers, test: true });
    }
    const all = rankResponses(real.concat(fakes));
    const before = planQuotas(quotas, full, real);
    const after = planQuotas(quotas, full, all);
    const stateBefore = evaluate(f, real.length, now, { optFull: before.allFull });
    const stateAfter = evaluate(f, all.length, now, { optFull: after.allFull });

    const options = [];
    for (const q of after.quotas) {
      const qb = before.quotas.find(x => x.questionId === q.questionId) || {};
      for (const [value, limit] of Object.entries(q.limits || {})) {
        const nb = (qb.counts && qb.counts[value]) || 0, na = (q.counts && q.counts[value]) || 0;
        options.push({ question: q.title, option: value, limit, before: nb, after: na,
          status: na >= limit ? (nb >= limit ? '已額滿' : '這次額滿 → 從表單移除') : '還有名額' });
      }
    }
    const plan = planNotices(f, all, after.quotas, existingNotices(f.id), f.org_name);
    const notices = plan.filter(n => n.r.test).map(n => ({ response: n.r.responseId, kind: n.kind, email: n.email, option: n.info.option, rank: n.info.rank, limit: n.info.limit, subject: n.subject, text: n.text }));

    let mail = { sent: false, reason: '' };
    const mailer = getMailer(f.org_id);
    const first = notices[0];
    if (!sendMail) mail.reason = '沒有要求寄信';
    else if (!first) mail.reason = '這次模擬的回覆都在名額內，不會收到候補信';
    else if (!f.notify_enabled) mail.reason = '這份表單沒有開啟「名額已滿時寄信通知」';
    else if (!mailer || !mailer.enabled()) mail.reason = '組織還沒設定寄信帳號（組織設定 → 寄信帳號）';
    else if (!first.email) mail.reason = '測試 Email 不正確';
    else {
      try { await mailer.send({ to: first.email, subject: '[測試] ' + first.subject, text: first.text + '\n\n——\n這是「Chase\'s Google Form Limiter平台」的測試信，實際報名者收到時不會有 [測試] 字樣。' }); mail = { sent: true, to: first.email }; }
      catch (e) { mail.reason = '寄信失敗：' + e.message; }
    }
    return {
      before: { count: real.length, open: stateBefore.open, reason: REASON_TEXT[stateBefore.reason] || '' },
      after: { count: all.length, open: stateAfter.open, reason: REASON_TEXT[stateAfter.reason] || '' },
      options, changes: after.changes.filter(c => !before.changes.includes(c)), notices, mail, errors: after.errors
    };
  }

  async function checkAll(src = '定時檢查') {
    const rows = db.all('SELECT f.id, f.org_id FROM forms f JOIN orgs o ON o.id = f.org_id WHERE o.disabled = 0 ORDER BY f.id');
    let checked = 0;
    for (const r of rows) {
      if (stopping) break;
      if (!gFor(r.org_id).connected()) continue; // 這個組織還沒連接 Google
      try { await enforce(r.id, src); checked++; } catch (e) { log.error('enforce', r.id, e.message); }
    }
    return { checked };
  }

  let timer = null;
  let cycle = null;
  return {
    enforce,
    simulate,
    checkAll,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (cycle || stopping) return;
        cycle = checkAll().catch(e => log.error('checkAll', e.message)).finally(() => { cycle = null; });
      }, intervalMs);
      if (timer.unref) timer.unref();
    },
    /** 停止排程，等目前的檢查與寄信做完（最多 timeoutMs） */
    async stop(timeoutMs = 20_000) {
      stopping = true;
      clearInterval(timer); timer = null;
      const pending = [cycle, ...running.values()].filter(Boolean);
      if (!pending.length) return true;
      let t;
      const finished = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise(r => { t = setTimeout(() => r(false), timeoutMs); })
      ]);
      clearTimeout(t);
      return finished;
    }
  };
}

module.exports = { createLimiter, evaluate, rankResponses, emailOf, fill, planNotices, REASON_TEXT, DEFAULT_TEMPLATES };
