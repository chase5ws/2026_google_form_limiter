'use strict';
// 模擬 Google Drive / Forms API，介面跟 lib/google.js 一樣
const { httpError } = require('../../lib/security');
const { FOLDER_MIME, FORM_MIME } = require('../../lib/google');

function createFakeGoogle({ email } = {}) {
  const files = new Map();
  let connected = false;
  let seq = 0;
  const platform = email || 'chase5ws@gmail.com'; // 連接的 Google 帳號
  const calls = [];
  const guard = () => { if (!connected) throw httpError(503, '平台還沒連接 Google 帳號'); };
  const visible = (id) => {
    const f = files.get(id);
    if (!f) return null;
    // 共用給平台：本身或任何上層資料夾有共用
    let cur = f;
    while (cur) { if (cur.sharedWithPlatform) return f; cur = cur.parent && files.get(cur.parent); }
    return null;
  };
  const need = (id) => { const f = visible(id); if (!f) throw httpError(404, 'File not found: ' + id); return f; };
  const canEdit = (f) => { let cur = f; while (cur) { if (cur.sharedWithPlatform) return cur.role === 'writer'; cur = cur.parent && files.get(cur.parent); } return false; };

  return {
    files, calls, platform,
    _connect() { connected = true; },
    _folder(id, name, opts = {}) { files.set(id, { id, name, mimeType: FOLDER_MIME, owner: opts.owner || 'org@example.com', sharedWithPlatform: opts.shared !== false, role: opts.role || 'writer' }); },
    _form(id, name, parent, opts = {}) {
      const items = [{ itemId: 'i1', title: '聯絡 Email', questionItem: { question: { questionId: 'q1', textQuestion: {} } } }].concat(opts.items || []);
      files.set(id, { id, name, mimeType: FORM_MIME, parent, owner: opts.owner || 'org@example.com', legacy: !!opts.legacy, responses: [], published: true, accepting: true,
        collectsEmail: opts.collectsEmail !== false, questions: opts.questions || [{ id: 'q1', title: '聯絡 Email' }], items });
    },
    _submit(id, n = 1, emailFn, choiceFn) {
      const f = files.get(id);
      for (let i = 0; i < n; i++) {
        const k = f.responses.length + 1;
        const email = emailFn ? emailFn(k) : `p${k}@example.com`;
        const answers = { q1: { textAnswers: { answers: [{ value: 'alt-' + email }] } } };
        const ch = choiceFn ? choiceFn(k) : {};
        for (const [qid, v] of Object.entries(ch)) answers[qid] = { textAnswers: { answers: [].concat(v).map(x => ({ value: x })) } };
        f.responses.push({ responseId: 'R' + String(++seq).padStart(6, '0'), createTime: new Date(Date.UTC(2026, 10, 7, 0, 0, k + (f.responses.length * 0))).toISOString().replace('Z', '') + String(seq).padStart(3, '0') + 'Z', respondentEmail: email, answers });
      }
    },
    _options(id, questionId) {
      const it = files.get(id).items.find(i => i.questionItem && i.questionItem.question.questionId === questionId);
      return it.questionItem.question.choiceQuestion.options.map(o => o.isOther ? '(其他)' : o.value);
    },
    _delete(id, responseIndex) { files.get(id).responses.splice(responseIndex, 1); },

    SCOPES: [],
    configured: () => true,
    connected: () => connected,
    email: () => (connected ? platform : null),
    authUrl: (state) => 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state,
    async exchangeCode(code) { if (code !== 'good') throw httpError(502, 'bad code'); connected = true; return platform; },
    disconnect() { connected = false; },

    async fileMeta(id) {
      guard(); calls.push(['fileMeta', id]);
      const f = need(id);
      return { id, name: f.name, mimeType: f.mimeType, trashed: !!f.trashed, parents: f.parent ? [f.parent] : [], owners: [{ emailAddress: f.owner }], capabilities: { canEdit: canEdit(f) } };
    },
    async listFolderForms(folderId) {
      guard(); need(folderId);
      return [...files.values()].filter(f => f.parent === folderId && f.mimeType === FORM_MIME && !f.trashed)
        .map(f => ({ id: f.id, name: f.name, modifiedTime: '2026-11-07T00:00:00Z', capabilities: { canEdit: canEdit(f) } }));
    },
    async getForm(id) {
      guard(); calls.push(['getForm', id]);
      const f = need(id);
      return { formId: id, info: { title: f.name }, responderUri: `https://docs.google.com/forms/d/e/R_${id}/viewform`,
        publishSettings: f.legacy ? undefined : { publishState: { isPublished: f.published, isAcceptingResponses: f.accepting } } };
    },
    async getFormFull(id) {
      guard(); calls.push(['getFormFull', id]);
      const f = need(id);
      return { formId: id, info: { title: f.name }, items: JSON.parse(JSON.stringify(f.items)), publishSettings: f.legacy ? undefined : { publishState: { isPublished: f.published, isAcceptingResponses: f.accepting } } };
    },
    async updateChoiceOptions(id, { itemId, questionId, type, options }) {
      guard(); calls.push(['updateChoiceOptions', id, questionId, options.map(o => o.value)]);
      const f = need(id);
      if (!canEdit(f)) throw httpError(403, 'The caller does not have permission');
      const it = f.items.find(i => i.itemId === itemId);
      if (!it || it.questionItem.question.questionId !== questionId) throw httpError(400, 'item mismatch');
      if (!options.length) throw httpError(400, 'choice question needs at least one option');
      it.questionItem.question.choiceQuestion = { type, options: JSON.parse(JSON.stringify(options)) };
      return {};
    },
    async formQuestions(id) { const f = need(id); return { collectsEmail: f.collectsEmail, questions: f.questions }; },
    async countResponses(id) { guard(); calls.push(['countResponses', id]); return need(id).responses.length; },
    async listResponses(id, withAnswers) {
      guard(); calls.push(['listResponses', id, withAnswers]);
      return need(id).responses.map(r => withAnswers ? r : { responseId: r.responseId, createTime: r.createTime, respondentEmail: need(id).collectsEmail ? r.respondentEmail : undefined });
    },
    async setAccepting(id, accepting) {
      guard(); calls.push(['setAccepting', id, accepting]);
      const f = need(id);
      if (!canEdit(f)) throw httpError(403, 'The caller does not have permission');
      f.published = true; f.accepting = !!accepting; return {};
    }
  };
}

module.exports = { createFakeGoogle };
