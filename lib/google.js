'use strict';
// Google OAuth（平台擁有者的帳號）＋ Drive / Forms API，只用內建 fetch
const { httpError } = require('./security');

// 權限刻意縮小：雲端硬碟「只讀檔案清單」，完全不寫入；表單直接控管組織自己的原始表單
const SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly', // 讀共用資料夾裡有哪些表單
  'https://www.googleapis.com/auth/forms.body',              // 讀表單、開關「接受回覆」
  'https://www.googleapis.com/auth/forms.responses.readonly' // 計算回覆數
];
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FORM_MIME = 'application/vnd.google-apps.form';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const FORMS = 'https://forms.googleapis.com/v1';

/**
 * getClient：回傳 { clientId, clientSecret } 的函式（網頁上改了會立即生效）；
 * 也接受舊寫法直接傳 clientId / clientSecret。
 */
function createGoogle({ clientId, clientSecret, getClient, redirectUri, db, cipher, fetchImpl }) {
  const fetchFn = fetchImpl || fetch;
  let cached = { token: null, exp: 0 };
  const client = () => (getClient ? getClient() : { clientId, clientSecret }) || {};

  const configured = () => { const c = client(); return !!(c.clientId && c.clientSecret && redirectUri); };
  const refreshToken = () => {
    const blob = db.getSetting('google_refresh_token');
    if (!blob) return null;
    try { return cipher.decrypt(blob); } catch (e) { return null; }
  };

  function authUrl(state) {
    if (!configured()) throw httpError(503, '還沒設定 Google OAuth 用戶端，請先在「平台設定 → 設定 Google 用戶端」填入用戶端 ID 和密鑰。');
    const q = new URLSearchParams({
      client_id: client().clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
  }

  async function tokenRequest(params) {
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ client_id: client().clientId, client_secret: client().clientSecret }, params))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error === 'invalid_grant'
        ? 'Google 授權已失效（可能被撤銷，或 OAuth 同意畫面還在「測試」狀態，7 天就會過期）。請平台管理員重新連接 Google。'
        : `Google 登入失敗：${data.error_description || data.error || res.status}`;
      throw httpError(502, msg);
    }
    return data;
  }

  async function exchangeCode(code) {
    const data = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
    if (!data.refresh_token) throw httpError(502, 'Google 沒有回傳 refresh token，請到 Google 帳號移除這個 App 的存取權後再連接一次。');
    db.setSetting('google_refresh_token', cipher.encrypt(data.refresh_token));
    cached = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
    const me = await api('GET', `${DRIVE}/about?fields=user(emailAddress,displayName)`);
    db.setSetting('google_email', me.user.emailAddress);
    db.setSetting('google_connected_at', Date.now());
    return me.user.emailAddress;
  }

  async function accessToken() {
    if (cached.token && Date.now() < cached.exp) return cached.token;
    const rt = refreshToken();
    if (!rt) throw httpError(503, '平台還沒連接 Google 帳號，請平台管理員到「平台設定」連接。');
    const data = await tokenRequest({ refresh_token: rt, grant_type: 'refresh_token' });
    cached = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
    return cached.token;
  }

  async function api(method, url, body) {
    const token = await accessToken();
    const res = await fetchFn(url, {
      method,
      headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) cached = { token: null, exp: 0 };
      const msg = (data.error && data.error.message) || res.statusText;
      const e = httpError(res.status === 404 || res.status === 403 ? res.status : 502, msg);
      e.google = { status: res.status, message: msg };
      throw e;
    }
    return data;
  }

  return {
    SCOPES,
    configured,
    redirectUri,
    connected: () => !!refreshToken(),
    email: () => db.getSetting('google_email'),
    authUrl,
    exchangeCode,
    disconnect() {
      db.setSetting('google_refresh_token', null);
      db.setSetting('google_email', null);
      cached = { token: null, exp: 0 };
    },

    /** 檔案或資料夾的基本資料；不存在或沒權限丟 404/403 */
    async fileMeta(id) {
      return api('GET', `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,parents,owners(emailAddress,displayName),capabilities(canEdit)&supportsAllDrives=true`);
    },
    /** 資料夾裡（第一層）的 Google 表單 */
    async listFolderForms(folderId) {
      const out = [];
      let pageToken = '';
      do {
        const q = new URLSearchParams({
          q: `'${String(folderId).replace(/'/g, '')}' in parents and mimeType = '${FORM_MIME}' and trashed = false`,
          fields: 'nextPageToken,files(id,name,modifiedTime,capabilities(canEdit))',
          pageSize: '200', orderBy: 'modifiedTime desc',
          supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
        });
        if (pageToken) q.set('pageToken', pageToken);
        const r = await api('GET', `${DRIVE}/files?${q}`);
        out.push(...(r.files || []));
        pageToken = r.nextPageToken || '';
      } while (pageToken && out.length < 1000);
      return out;
    },
    async getForm(id) {
      return api('GET', `${FORMS}/forms/${encodeURIComponent(id)}?fields=formId,info(title,documentTitle),responderUri,publishSettings`);
    },
    async countResponses(id) {
      let n = 0, pageToken = '';
      do {
        const q = new URLSearchParams({ pageSize: '5000', fields: 'responses(responseId),nextPageToken' });
        if (pageToken) q.set('pageToken', pageToken);
        const r = await api('GET', `${FORMS}/forms/${encodeURIComponent(id)}/responses?${q}`);
        n += (r.responses || []).length;
        pageToken = r.nextPageToken || '';
      } while (pageToken);
      return n;
    },
    /** 所有回覆（排位用）：回覆 ID、建立時間、Email，必要時含答案 */
    async listResponses(id, withAnswers) {
      const out = [];
      let pageToken = '';
      do {
        const q = new URLSearchParams({ pageSize: '5000', fields: `responses(responseId,createTime,respondentEmail${withAnswers ? ',answers' : ''}),nextPageToken` });
        if (pageToken) q.set('pageToken', pageToken);
        const r = await api('GET', `${FORMS}/forms/${encodeURIComponent(id)}/responses?${q}`);
        out.push(...(r.responses || []));
        pageToken = r.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    /** 表單有沒有收集 Email，以及可以當成 Email 欄位的簡答題 */
    async formQuestions(id) {
      const f = await api('GET', `${FORMS}/forms/${encodeURIComponent(id)}?fields=settings,items(title,questionItem(question(questionId,textQuestion)))`);
      const ect = f.settings && f.settings.emailCollectionType;
      return {
        collectsEmail: !!ect && ect !== 'DO_NOT_COLLECT',
        questions: (f.items || [])
          .filter(i => i.questionItem && i.questionItem.question && i.questionItem.question.textQuestion)
          .map(i => ({ id: i.questionItem.question.questionId, title: i.title || '(未命名題目)' }))
      };
    },
    async setAccepting(id, accepting) {
      return api('POST', `${FORMS}/forms/${encodeURIComponent(id)}:setPublishSettings`, {
        publishSettings: { publishState: { isPublished: true, isAcceptingResponses: !!accepting } },
        updateMask: 'publishState'
      });
    }
  };
}

module.exports = { createGoogle, SCOPES, FOLDER_MIME, FORM_MIME };
