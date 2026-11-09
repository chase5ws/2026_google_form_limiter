'use strict';
// 寄信：組織自己的 Google Apps Script 中繼站（HTTPS），不需要 SMTP 或 DNS，Railway Hobby 也能用
const { callGas } = require('./gas-relay');

/**
 * source：設定物件，或回傳它的函式（讓網頁上改的設定立即生效）
 * 會用到的鍵：GAS_URL、GAS_SECRET、MAIL_FROM
 */
function createMailer(source = {}, { fetchImpl } = {}) {
  const cfg = () => (typeof source === 'function' ? source() : source) || {};
  const fetchFn = fetchImpl || fetch;
  const fromOf = (env) => env.MAIL_FROM || '';
  const nameOf = (from) => { const m = String(from).match(/^\s*"?([^"<]*?)"?\s*</); return m ? m[1].trim() : ''; };

  return {
    get provider() { return cfg().GAS_URL ? 'gas' : null; },
    get from() { return fromOf(cfg()); },
    enabled() { const env = cfg(); return !!env.GAS_URL && !!fromOf(env); },
    async send({ to, subject, text }) {
      const env = cfg();
      if (!env.GAS_URL) throw new Error('這個組織還沒設定寄信帳號，請組織管理員到「組織設定 → 寄信帳號」設定。');
      if (!fromOf(env)) throw new Error('還沒設定寄件者。');
      await callGas(env.GAS_URL, { secret: env.GAS_SECRET, to, subject, text, name: nameOf(fromOf(env)) }, fetchFn);
    }
  };
}

module.exports = { createMailer };
