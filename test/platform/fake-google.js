'use strict';
// 模擬 Google Drive / Forms API，介面跟 lib/google.js 一樣
const { httpError } = require('../../lib/security');
const { FOLDER_MIME, FORM_MIME } = require('../../lib/google');

function createFakeGoogle() {
  const files = new Map();
  let connected = false;
  let seq = 0;
  const platform = 'chase5ws@gmail.com';
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
      files.set(id, { id, name, mimeType: FORM_MIME, parent, owner: opts.owner || 'org@example.com', legacy: !!opts.legacy, responses: [], published: true, accepting: true,
        collectsEmail: opts.collectsEmail !== false, questions: opts.questions || [{ id: 'q1', title: '聯絡 Email' }] });
    },
    _submit(id, n = 1, emailFn) {
      const f = files.get(id);
      for (let i = 0; i < n; i++) {
        const k = f.responses.length + 1;
        const email = emailFn ? emailFn(k) : `p${k}@example.com`;
        f.responses.push({ responseId: 'R' + String(++seq).padStart(6, '0'), createTime: new Date(Date.UTC(2026, 10, 7, 0, 0, k)).toISOString(), respondentEmail: email, answers: { q1: { textAnswers: { answers: [{ value: 'alt-' + email }] } } } });
      }
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
