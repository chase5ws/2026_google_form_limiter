'use strict';
// 組織自己的 Google Apps Script 寄信中繼站：平台用 HTTPS 呼叫，由組織的 Google 帳號以 MailApp 寄出
// 好處：Railway Hobby 也能用（不走 SMTP）、寄件者就是組織信箱、不用設定 DNS

const GAS_URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[\w.-]+|macros)\/s\/[\w-]{20,}\/exec$/;

function gasScript(secret) {
  return `/**
 * 表單限額管理平台：寄信中繼站
 * 用你們組織自己的 Google 帳號寄出候補／遞補通知，不需要 SMTP 或 DNS。
 *
 * 部署方式：
 *   1. 右上「部署」→「新增部署作業」→ 齒輪選「網頁應用程式」
 *   2. 執行身分：我　／　誰可以存取：所有人
 *   3. 按「部署」並授權（看到未驗證的警告，點「進階 → 前往」→ 允許）
 *   4. 複製「網頁應用程式網址」（/exec 結尾），貼回平台
 *
 * 下面的 SECRET 是平台產生的密鑰，用來確認呼叫的是平台本身，請不要外流或修改。
 */
const SECRET = '${secret}';

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.secret !== SECRET) return out_({ ok: false, error: '密鑰不正確' });
    if (req.action === 'ping') {
      return out_({ ok: true, email: Session.getEffectiveUser().getEmail(), quota: MailApp.getRemainingDailyQuota() });
    }
    var to = String(req.to || '').trim();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(to)) return out_({ ok: false, error: '收件 Email 不正確' });
    if (MailApp.getRemainingDailyQuota() < 1) return out_({ ok: false, error: '今天的寄信額度用完了，明天會自動恢復' });
    var opt = { to: to, subject: String(req.subject || '').slice(0, 250), body: String(req.text || '') };
    if (req.name) opt.name = String(req.name).slice(0, 80);
    MailApp.sendEmail(opt);
    return out_({ ok: true, quota: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return out_({ ok: true, service: 'form-limiter-mail-relay' });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 可選：部署前先在編輯器選這個函式按「執行」，提前完成授權 */
function authorize() {
  Logger.log(Session.getEffectiveUser().getEmail() + ' 今天還能寄 ' + MailApp.getRemainingDailyQuota() + ' 封');
}
`;
}

/** 呼叫 GAS；回傳解析後的 JSON，失敗丟出中文說明 */
async function callGas(url, payload, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  let res;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
  } catch (e) {
    throw new Error(`連不到 GAS 網址：${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data) {
    if (res.status === 404) throw new Error('GAS 網址不存在，請確認貼的是「網頁應用程式網址」（/exec 結尾），而且部署還在。');
    throw new Error('GAS 沒有回傳正確的資料。請確認部署時「誰可以存取」選的是「所有人」，而且程式碼有完整貼上並儲存後重新部署。');
  }
  if (!data.ok) throw new Error(`GAS 回報錯誤：${data.error || '未知錯誤'}`);
  return data;
}

module.exports = { gasScript, callGas, GAS_URL_RE };
