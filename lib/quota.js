'use strict';
// 選項名額：讀取表單的段落與選擇題，依每個選項的名額決定要移除／加回哪些選項，並找出超額（候補）的回覆
// 這裡都是純函式，排程（真的套用）和「測試」按鈕（模擬）共用

const CHOICE_TYPES = ['RADIO', 'CHECKBOX', 'DROP_DOWN'];
const TYPE_TEXT = { RADIO: '單選', CHECKBOX: '多選', DROP_DOWN: '下拉' };

/** 表單 → 段落清單，每段列出可以設名額的選擇題 */
function parseSections(form) {
  const sections = [{ index: 1, title: (form.info && form.info.title) || '第 1 段', questions: [] }];
  (form.items || []).forEach((item, itemIndex) => {
    if (item.pageBreakItem) {
      sections.push({ index: sections.length + 1, title: item.title || `第 ${sections.length + 1} 段`, questions: [] });
      return;
    }
    const q = item.questionItem && item.questionItem.question;
    const cq = q && q.choiceQuestion;
    if (!cq || !CHOICE_TYPES.includes(cq.type)) return;
    sections[sections.length - 1].questions.push({
      questionId: q.questionId, itemId: item.itemId, itemIndex, title: item.title || '(未命名題目)', type: cq.type, typeText: TYPE_TEXT[cq.type],
      options: (cq.options || []).filter(o => !o.isOther).map(o => o.value),
      hasOther: (cq.options || []).some(o => o.isOther)
    });
  });
  return sections;
}

function findItem(form, questionId) {
  const items = form.items || [];
  for (let i = 0; i < items.length; i++) {
    const q = items[i].questionItem && items[i].questionItem.question;
    if (q && q.questionId === questionId && q.choiceQuestion) return { item: items[i], index: i };
  }
  return null;
}

/**
 * 改過名稱的選項：舊回覆裡存的還是舊名稱。
 * aliases：{ questionId: { 目前名稱: [舊名稱…] } } → 回傳「舊名稱 → 目前名稱」的對照（目前還存在的名稱不轉換）
 */
function renameMap(aliases, questionId) {
  const m = new Map();
  const a = (aliases && aliases[questionId]) || {};
  const current = new Set(Object.keys(a));
  for (const [cur, olds] of Object.entries(a)) for (const o of olds || []) if (!current.has(o)) m.set(o, cur);
  return m;
}

/** 一筆回覆在某題選了哪些值（舊名稱會換成目前的名稱） */
function answerValues(resp, questionId, rename) {
  const a = resp.answers && resp.answers[questionId];
  return ((a && a.textAnswers && a.textAnswers.answers) || []).map(x => {
    const v = String(x.value);
    return rename && rename.has(v) ? rename.get(v) : v;
  });
}

function countOptions(responses, questionId, aliases) {
  const rename = renameMap(aliases, questionId);
  const counts = {};
  for (const r of responses) for (const v of answerValues(r, questionId, rename)) counts[v] = (counts[v] || 0) + 1;
  return counts;
}

/**
 * 依目前回覆算出每題要怎麼調整選項
 * quotas：[{ questionId, title, limits: {選項: 名額}, hidden: [{ value, option }], order: [選項...] }]
 * 回傳 { quotas: 更新後的設定, actions: 要送給 Forms API 的變更, allFull, errors, changes: 給紀錄用的文字 }
 */
function planQuotas(quotas, form, responses, aliases) {
  const out = { quotas: [], actions: [], allFull: false, allFullTitles: [], errors: [], changes: [] };
  for (const q0 of quotas || []) {
    const q = Object.assign({ limits: {}, hidden: [], order: [] }, q0);
    const found = findItem(form, q.questionId);
    if (!found) {
      out.errors.push(`找不到題目「${q.title}」，可能已被刪除或改成非選擇題。`);
      out.quotas.push(q);
      continue;
    }
    const cq = found.item.questionItem.question.choiceQuestion;
    const cur = cq.options || [];
    const counts = countOptions(responses, q.questionId, aliases);
    const full = (v) => q.limits[v] != null && (counts[v] || 0) >= q.limits[v];

    // 記錄選項順序（組織之後在表單新增的選項接在後面）
    const order = q.order.slice();
    for (const o of cur) if (!o.isOther && !order.includes(o.value)) order.push(o.value);

    const toHide = cur.filter(o => !o.isOther && full(o.value));
    const toRestore = q.hidden.filter(h => !full(h.value) && !cur.some(o => o.value === h.value));
    const stillHidden = q.hidden.filter(h => full(h.value) && !cur.some(o => o.value === h.value));

    const keep = cur.filter(o => o.isOther || !full(o.value));
    const visibleLeft = keep.filter(o => !o.isOther).length + toRestore.length;
    const pos = (v) => { const i = order.indexOf(v); return i < 0 ? 1e9 : i; };

    let hidden = stillHidden;
    let newOptions = null;
    if (visibleLeft === 0) {
      // 全部額滿：不移除最後的選項（選擇題至少要有一個選項），改成關閉整份表單
      out.allFull = true;
      out.allFullTitles.push(q.title);
    } else if (toHide.length || toRestore.length) {
      const normal = keep.filter(o => !o.isOther).concat(toRestore.map(h => h.option))
        .sort((a, b) => pos(a.value) - pos(b.value));
      newOptions = normal.concat(keep.filter(o => o.isOther));
      hidden = stillHidden.concat(toHide.map(o => ({ value: o.value, option: o })));
      out.actions.push({ questionId: q.questionId, itemId: found.item.itemId, itemIndex: found.index, type: cq.type, options: newOptions });
      if (toHide.length) out.changes.push(`「${q.title}」移除額滿選項：${toHide.map(o => o.value).join('、')}`);
      if (toRestore.length) out.changes.push(`「${q.title}」加回選項：${toRestore.map(h => h.value).join('、')}`);
    }
    out.quotas.push(Object.assign({}, q, { hidden, order, counts, title: found.item.title || q.title }));
  }
  return out;
}

/** 依建立時間排序後，找出超過總名額或選項名額的回覆 → Map(responseId → { rank, limit, option }) */
function waitlistOf(ranked, maxResponses, quotas, aliases) {
  const wl = new Map();
  if (maxResponses) for (const r of ranked) if (r.rank > maxResponses) wl.set(r.responseId, { rank: r.rank, limit: maxResponses, option: '' });
  for (const q of quotas || []) {
    for (const [value, limit] of Object.entries(q.limits || {})) {
      if (limit == null) continue;
      const rename = renameMap(aliases, q.questionId);
      let i = 0;
      for (const r of ranked) {
        if (!answerValues(r, q.questionId, rename).includes(value)) continue;
        i++;
        if (i > limit && !wl.has(r.responseId)) wl.set(r.responseId, { rank: i, limit, option: `${q.title}：${value}` });
      }
    }
  }
  return wl;
}

module.exports = { parseSections, planQuotas, waitlistOf, answerValues, countOptions, findItem, renameMap, CHOICE_TYPES };
