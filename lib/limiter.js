'use strict';
// 依規則算出表單應有的狀態，透過 Forms API 開關；並依送出順序排位、寄候補／遞補通知

const REASON_TEXT = { manual: '手動關閉', notyet: '尚未開放', ended: '已截止', full: '名額已滿' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTEMPTS = 3;
const MAX_MAILS_PER_CHECK = 30;

const DEFAULT_TEMPLATES = {
  waitlistSubject: '「{title}」名額已滿通知',
  waitlistBody: '您好：\n\n感謝您報名「{title}」。很抱歉，本次名額 {limit} 位已經額滿，您的報名順位是第 {rank} 位（候補第 {waitlist} 位）。\n如果有名額釋出，我們會再寄信通知您。\n\n{org} 敬上',
  promoteSubject: '「{title}」候補遞補成功',
  promoteBody: '您好：\n\n好消息！「{title}」有名額釋出，您已經從候補遞補為正取（目前順位第 {rank} 位）。\n\n{org} 敬上'
};

function evaluate(f, count, now) {
  if (f.manual_closed) return { open: false, reason: 'manual' };
  if (f.open_at && now < f.open_at) return { open: false, reason: 'notyet' };
  if (f.close_at && now >= f.close_at) return { open: false, reason: 'ended' };
  if (f.max_responses && count != null && count >= f.max_responses) return { open: false, reason: 'full' };
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

/** mailerFor(orgId)：回傳該組織自己設定的寄信器（沒設定時 enabled() 為 false）；也接受舊寫法 mailer */
function createLimiter({ db, google, mailer = null, mailerFor = null, intervalMs = 60_000, log = console }) {
  const getMailer = mailerFor || (() => mailer);
  const running = new Map();   // formId → Promise
  let stopping = false;

  async function processNotices(f, ranked, orgName, mailer) {
    const limit = f.max_responses;
    const existing = new Map(db.all('SELECT * FROM notices WHERE form_id = ?', f.id).map(n => [`${n.response_id}:${n.kind}`, n]));
    const tpl = {
      waitlistSubject: f.notify_waitlist_subject || DEFAULT_TEMPLATES.waitlistSubject,
      waitlistBody: f.notify_waitlist_body || DEFAULT_TEMPLATES.waitlistBody,
      promoteSubject: f.notify_promote_subject || DEFAULT_TEMPLATES.promoteSubject,
      promoteBody: f.notify_promote_body || DEFAULT_TEMPLATES.promoteBody
    };
    const todo = [];
    for (const r of ranked) {
      if (r.rank > limit) todo.push({ r, kind: 'waitlist' });
      else {
        const w = existing.get(`${r.responseId}:waitlist`);
        if (w && w.status === 'sent') todo.push({ r, kind: 'promoted' }); // 曾收到候補信，現在進入名額內
      }
    }
    let sent = 0, failed = 0, budget = MAX_MAILS_PER_CHECK;
    for (const { r, kind } of todo) {
      if (stopping || budget <= 0) break;
      const prev = existing.get(`${r.responseId}:${kind}`);
      if (prev && (prev.status !== 'failed' || prev.attempts >= MAX_ATTEMPTS)) continue;
      const email = emailOf(r, f.notify_source);
      const vars = { title: f.title, org: orgName, rank: r.rank, limit, waitlist: Math.max(0, r.rank - limit) };
      let status = 'sent', error = null;
      if (!email) { status = 'skipped'; error = '這筆回覆沒有可用的 Email'; }
      else {
        budget--;
        try {
          await mailer.send({
            to: email,
            subject: fill(kind === 'waitlist' ? tpl.waitlistSubject : tpl.promoteSubject, vars),
            text: fill(kind === 'waitlist' ? tpl.waitlistBody : tpl.promoteBody, vars)
          });
          sent++;
        } catch (e) { status = 'failed'; error = e.message; failed++; }
      }
      db.run(`INSERT INTO notices(form_id, response_id, kind, email, rank, status, attempts, error, at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
              ON CONFLICT(form_id, response_id, kind) DO UPDATE SET email = excluded.email, rank = excluded.rank, status = excluded.status,
              attempts = notices.attempts + 1, error = excluded.error, at = excluded.at`,
        f.id, r.responseId, kind, email, r.rank, status, error, Date.now());
    }
    if (sent || failed) {
      db.log(f.org_id, '系統', `「${f.title}」寄出 ${sent} 封通知${failed ? `，${failed} 封失敗` : ''}（名額 ${limit}，共 ${ranked.length} 份）`);
    }
  }

  async function doEnforce(formId, source) {
    const f = db.get('SELECT f.*, o.name AS org_name FROM forms f JOIN orgs o ON o.id = f.org_id WHERE f.id = ?', formId);
    if (!f) return null;
    const patch = { last_check: Date.now(), last_error: null };
    try {
      const info = await google.getForm(f.google_form_id);
      if (info.info && info.info.title) { patch.title = info.info.title; f.title = info.info.title; }
      if (info.responderUri) patch.responder_url = info.responderUri;
      if (!info.publishSettings) throw new Error('這是舊版格式的表單，無法用 API 開關。請在 Google 表單「⋮ → 建立副本」後改加入副本。');
      const ps = info.publishSettings.publishState || {};

      const mailer = getMailer(f.org_id);
      const wantNotices = !!(f.notify_enabled && f.max_responses && mailer && mailer.enabled());
      let count, ranked = null;
      if (wantNotices) {
        ranked = rankResponses(await google.listResponses(f.google_form_id, f.notify_source && f.notify_source !== 'respondent'));
        count = ranked.length;
      } else {
        count = await google.countResponses(f.google_form_id);
      }
      patch.last_count = count;

      const want = evaluate(f, count, Date.now());
      const accepting = !!(ps.isPublished && ps.isAcceptingResponses);
      if (accepting !== want.open || !ps.isPublished) {
        await google.setAccepting(f.google_form_id, want.open);
        db.log(f.org_id, '系統', `${want.open ? '開放' : '關閉'}「${f.title}」（${source}${want.reason ? '，' + REASON_TEXT[want.reason] : ''}，目前 ${count} 份）`);
      }
      patch.state = want.open ? 'open' : 'closed';
      patch.reason = want.reason;

      if (ranked) {
        try { await processNotices(f, ranked, f.org_name, mailer); }
        catch (e) { patch.last_error = '寄信流程失敗：' + e.message; }
      }
    } catch (e) {
      patch.last_error = e.message;
    }
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

  async function checkAll(src = '定時檢查') {
    if (!google.connected()) return { skipped: true };
    const rows = db.all('SELECT f.id FROM forms f JOIN orgs o ON o.id = f.org_id WHERE o.disabled = 0 ORDER BY f.id');
    let checked = 0;
    for (const r of rows) {
      if (stopping) break;
      try { await enforce(r.id, src); checked++; } catch (e) { log.error('enforce', r.id, e.message); }
    }
    return { checked };
  }

  let timer = null;
  let cycle = null;
  return {
    enforce,
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

module.exports = { createLimiter, evaluate, rankResponses, emailOf, fill, REASON_TEXT, DEFAULT_TEMPLATES };
