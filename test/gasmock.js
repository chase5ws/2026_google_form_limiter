// 在 Node 裡模擬 Apps Script 服務，載入 src/Code.gs 來測試
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const path = require('path');

function create() {
  const props = {};
  const cache = {};
  const triggers = [];
  const forms = {};
  let clock = { now: null };
  const toBytes = (b) => Array.from(Buffer.from(b)).map(x => (x > 127 ? x - 256 : x));
  const fromBytes = (a) => Buffer.from(a.map(x => (x < 0 ? x + 256 : x)));

  const ctx = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => {
          if (Buffer.byteLength(String(v)) > 9216) throw new Error('Property value too large: ' + k);
          props[k] = String(v);
        },
        deleteProperty: k => { delete props[k]; },
        getProperties: () => Object.assign({}, props)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache[k] && cache[k].exp > Date.now() ? cache[k].v : null),
        put: (k, v, s) => { cache[k] = { v: String(v), exp: Date.now() + s * 1000 }; },
        remove: k => { delete cache[k]; }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Logger: { log: (...a) => ctx.__logs.push(a.join(' ')) },
    __logs: [],
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      newBlob: (s) => ({ getBytes: () => toBytes(String(s)) }),
      computeHmacSha256Signature: (v, k) =>
        toBytes(crypto.createHmac('sha256', fromBytes(k)).update(fromBytes(v)).digest()),
      base64Encode: (b) => fromBytes(b).toString('base64'),
      parseDate: (s, tz, pattern) => new Date(s + ':00+08:00'),
      formatDate: (d, tz, pattern) => {
        const t = new Date(d.getTime() + 8 * 3600e3);
        const p = (n) => String(n).padStart(2, '0');
        return pattern
          .replace(/'T'/, 'T')
          .replace('yyyy', t.getUTCFullYear()).replace('MM', p(t.getUTCMonth() + 1)).replace('dd', p(t.getUTCDate()))
          .replace('HH', p(t.getUTCHours())).replace('mm', p(t.getUTCMinutes())).replace('ss', p(t.getUTCSeconds()));
      }
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => {
        const t = { fn, id: crypto.randomUUID(), getUniqueId() { return this.id; }, getHandlerFunction() { return this.fn; } };
        const chain = {
          forForm: (f) => { t.formId = f.getId(); return chain; },
          onFormSubmit: () => chain,
          timeBased: () => chain,
          everyMinutes: (n) => { t.every = n; return chain; },
          create: () => { if (triggers.length >= 20) throw new Error('This script has too many triggers.'); triggers.push(t); return t; }
        };
        return chain;
      }
    },
    FormApp: {
      openById: (id) => { if (!forms[id]) throw new Error('No item with the given ID could be found.'); return forms[id]; }
    },
    HtmlService: {}
  };

  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
  vm.createContext(ctx);
  vm.runInContext(code + '\n;this.__exports = { CONFIG };', ctx, { filename: 'Code.gs' });

  function addFakeForm(id, title, opts) {
    opts = opts || {};
    const f = {
      _id: id, _title: title, _accepting: true, _responses: opts.responses || 0, _msg: '', _published: opts.published !== false,
      getId() { return this._id; }, getTitle() { return this._title; },
      getEditUrl() { return `https://docs.google.com/forms/d/${this._id}/edit`; },
      getPublishedUrl() { return `https://docs.google.com/forms/d/e/PUB_${this._id}/viewform`; },
      getResponses() { return new Array(this._responses); },
      isAcceptingResponses() { return this._accepting; },
      setAcceptingResponses(v) { this._accepting = v; return this; },
      setCustomClosedFormMessage(m) { this._msg = m; return this; },
      isPublished() { return this._published; }
    };
    forms[id] = f;
    return f;
  }

  return { ctx, props, cache, triggers, forms, addFakeForm };
}

module.exports = { create };
