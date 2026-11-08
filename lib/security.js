'use strict';
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || !stored) return false;
  const [algo, s, h] = String(stored).split('$');
  if (algo !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(s, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

// 給「帳號不存在」時跑一次假驗證，讓回應時間一致
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));
function fakeVerify() { verifyPassword('x', DUMMY_HASH); }

const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// 加密存放 Google refresh token（AES-256-GCM，金鑰來自環境變數 ENCRYPTION_KEY）
function cipher(secret) {
  const key = crypto.createHash('sha256').update(String(secret || '')).digest();
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
    },
    decrypt(blob) {
      const [v, iv, tag, enc] = String(blob || '').split('.');
      if (v !== 'v1') throw new Error('bad ciphertext');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
    }
  };
}

function checkUsername(u) {
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw httpError(400, '帳號只能用 3–32 個英文小寫、數字、點、底線或減號。');
}

function checkPassword(pw, username) {
  pw = String(pw || '');
  if (pw.length < 8) throw httpError(400, '密碼至少要 8 個字元。');
  if (pw.length > 128) throw httpError(400, '密碼太長了（最多 128 個字元）。');
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) throw httpError(400, '密碼不能包含帳號名稱。');
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) throw httpError(400, '密碼要同時包含英文字母和數字。');
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { hashPassword, verifyPassword, fakeVerify, newToken, sha256, cipher, checkUsername, checkPassword, httpError };
