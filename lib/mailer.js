'use strict';
// 寄信：組織自己的 Google Apps Script 中繼站（HTTPS）或 SMTP（零依賴實作，支援 465 SSL / 587 STARTTLS）
// Railway 的 Free / Trial / Hobby 方案封鎖對外 SMTP，這些方案請用 GAS。
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');
const { callGas } = require('./gas-relay');

/**
 * source：環境變數物件，或回傳它的函式（讓網頁上改的設定立即生效）
 * 會用到的鍵：GAS_URL、GAS_SECRET、SMTP_HOST、SMTP_PORT、SMTP_SECURE、SMTP_USER、SMTP_PASS、MAIL_FROM
 */
function createMailer(source = process.env, { fetchImpl } = {}) {
  const cfg = () => (typeof source === 'function' ? source() : source) || {};
  const fetchFn = fetchImpl || fetch;
  const fromOf = (env) => env.MAIL_FROM || env.SMTP_USER || '';
  const providerOf = (env) => (env.GAS_URL ? 'gas' : env.SMTP_HOST ? 'smtp' : null);
  const nameOf = (from) => { const m = String(from).match(/^\s*"?([^"<]*?)"?\s*</); return m ? m[1].trim() : ''; };

  async function sendGas(env, { to, subject, text }) {
    await callGas(env.GAS_URL, { secret: env.GAS_SECRET, to, subject, text, name: nameOf(fromOf(env)) }, fetchFn);
  }

  return {
    get provider() { return providerOf(cfg()); },
    get from() { return fromOf(cfg()); },
    enabled() { const env = cfg(); return !!providerOf(env) && !!fromOf(env); },
    async send(msg) {
      const env = cfg();
      const provider = providerOf(env);
      if (!provider) throw new Error('這個組織還沒設定寄信帳號，請組織管理員到「組織設定 → 寄信帳號」設定。');
      if (!fromOf(env)) throw new Error('還沒設定寄件者。');
      if (provider === 'gas') return sendGas(env, msg);
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
    const blocked = `連不到 ${opt.host}:${opt.port}。最常見的原因是 Railway 封鎖了對外 SMTP：Free／Trial／Hobby 方案一律封鎖；剛升級 Pro 的話，要到 Railway 對服務按「Redeploy」重新部署一次才會解鎖。`;
    const timer = setTimeout(() => finish(new Error(`SMTP 逾時：${blocked}`)), timeoutMs);

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
    const explain = (e) => {
      const c = e.code || '';
      if (['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(c)) return `SMTP 連線失敗（${c}）：${blocked}`;
      if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return `SMTP 連線失敗：找不到主機「${opt.host}」，請確認 SMTP 主機有沒有打錯。`;
      if (/certificate|SSL|TLS|wrong version/i.test(e.message)) return `SMTP 加密連線失敗（${e.message}）。連接埠 465 要用 SSL、587 要用 STARTTLS，請確認連接埠和主機搭配正確。`;
      return 'SMTP 連線失敗：' + e.message + (c ? `（${c}）` : '');
    };
    const attach = (s) => { s.on('data', onData); s.on('error', (e) => finish(new Error(explain(e)))); };
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
