'use strict';
// 寄信：SMTP（零依賴實作，支援 465 SSL / 587 STARTTLS）或 Resend HTTPS API
// Railway 的 Free / Trial / Hobby 方案封鎖對外 SMTP，這些方案請用 RESEND_API_KEY。
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

/**
 * source：環境變數物件，或回傳它的函式（讓網頁上改的設定立即生效）
 * 會用到的鍵：RESEND_API_KEY、SMTP_HOST、SMTP_PORT、SMTP_SECURE、SMTP_USER、SMTP_PASS、MAIL_FROM
 */
function createMailer(source = process.env, { fetchImpl } = {}) {
  const cfg = () => (typeof source === 'function' ? source() : source) || {};
  const fetchFn = fetchImpl || fetch;
  const fromOf = (env) => env.MAIL_FROM || env.SMTP_USER || '';
  const providerOf = (env) => (env.RESEND_API_KEY ? 'resend' : env.SMTP_HOST ? 'smtp' : null);

  async function sendResend(env, { to, subject, text }) {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromOf(env), to: [to], subject, text })
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(`Resend ${res.status}：${d.message || d.name || res.statusText}`);
    }
  }

  return {
    get provider() { return providerOf(cfg()); },
    get from() { return fromOf(cfg()); },
    enabled() { const env = cfg(); return !!providerOf(env) && !!fromOf(env); },
    async send(msg) {
      const env = cfg();
      const provider = providerOf(env);
      if (!provider) throw new Error('還沒設定寄信方式，請到「平台設定 → 寄信」設定 Resend 或 SMTP。');
      if (!fromOf(env)) throw new Error('還沒設定寄件者。');
      if (provider === 'resend') return sendResend(env, msg);
      return smtpSend({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: env.SMTP_SECURE ? String(env.SMTP_SECURE) === 'true' : Number(env.SMTP_PORT) === 465,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        rejectUnauthorized: env.SMTP_TLS_INSECURE !== 'true'
      }, fromOf(env), msg);
    }
  };
}

/* ---------------- SMTP ---------------- */
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addrOnly = (a) => { const m = String(a).match(/<([^>]+)>/); return (m ? m[1] : String(a)).trim(); };
function encAddress(a) {
  const m = String(a).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m && m[1] ? `${encWord(m[1])} <${m[2]}>` : addrOnly(a);
}

function buildMessage(from, { to, subject, text }) {
  const body = b64(String(text).replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${encAddress(from)}`,
    `To: ${addrOnly(to)}`,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${addrOnly(from).split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].join('\r\n');
}

function smtpSend(opt, from, msg, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket = opt.secure
      ? tls.connect({ host: opt.host, port: opt.port, servername: opt.host, rejectUnauthorized: opt.rejectUnauthorized })
      : net.connect({ host: opt.host, port: opt.port });
    let buf = '';
    let waiter = null;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.end(); } catch (e) { /* ignore */ }
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`SMTP 逾時（${opt.host}:${opt.port}）。如果在 Railway Hobby 方案，SMTP 會被封鎖，請改用 RESEND_API_KEY。`)), timeoutMs);

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // 完整回應：最後一行是「三位數字 + 空白」
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const resp = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiter; waiter = null;
          if (w) w(resp);
          return;
        }
      }
    };
    const attach = (s) => { s.on('data', onData); s.on('error', (e) => finish(new Error('SMTP 連線失敗：' + e.message))); };
    attach(socket);

    const read = () => new Promise((r) => { waiter = r; });
    const cmd = async (line, expect) => {
      if (line != null) socket.write(line + '\r\n');
      const resp = await read();
      const code = Number(resp.split('\n').pop().slice(0, 3));
      if (!expect.includes(code)) throw new Error(`SMTP 錯誤：${line ? line.split(' ')[0] : '連線'} → ${resp.replace(/\n/g, ' ')}`);
      return resp;
    };

    (async () => {
      const name = os.hostname() || 'localhost';
      await cmd(null, [220]);
      let ehlo = await cmd(`EHLO ${name}`, [250]);
      if (!opt.secure && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', [220]);
        socket.removeListener('data', onData);
        socket = tls.connect({ socket, servername: opt.host, rejectUnauthorized: opt.rejectUnauthorized });
        attach(socket);
        await new Promise((r, j) => { socket.once('secureConnect', r); socket.once('error', j); });
        ehlo = await cmd(`EHLO ${name}`, [250]);
      }
      if (opt.user) {
        if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo)) {
          await cmd('AUTH PLAIN ' + Buffer.from(`\0${opt.user}\0${opt.pass || ''}`, 'utf8').toString('base64'), [235]);
        } else {
          await cmd('AUTH LOGIN', [334]);
          await cmd(b64(opt.user), [334]);
          await cmd(b64(opt.pass || ''), [235]);
        }
      }
      await cmd(`MAIL FROM:<${addrOnly(from)}>`, [250]);
      await cmd(`RCPT TO:<${addrOnly(msg.to)}>`, [250, 251]);
      await cmd('DATA', [354]);
      await cmd(buildMessage(from, msg) + '\r\n.', [250]);
      socket.write('QUIT\r\n');
      finish();
    })().catch(finish);
  });
}

module.exports = { createMailer, smtpSend, buildMessage };
