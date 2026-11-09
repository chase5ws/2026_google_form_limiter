'use strict';
// SQLite（Node 內建 node:sqlite），資料檔放在 DATA_DIR（Railway 請掛 Volume）
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orgs (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  shared_folder_id    TEXT,
  shared_folder_name  TEXT,
  shared_folder_owner TEXT,
  mail_cfg            TEXT,
  google_client_id    TEXT,
  google_client_secret TEXT,
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  email         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super','org_admin','org_member')),
  org_id        INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  must_change   INTEGER NOT NULL DEFAULT 1,
  disabled      INTEGER NOT NULL DEFAULT 0,
  sess_ver      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  last_login    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sess_ver    INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_fails (
  username  TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  until     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forms (
  id              INTEGER PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  source_form_id  TEXT,
  google_form_id  TEXT NOT NULL UNIQUE,
  responder_url   TEXT,
  edit_url        TEXT,
  share_emails    TEXT NOT NULL DEFAULT '[]',
  max_responses   INTEGER,
  open_at         INTEGER,
  close_at        INTEGER,
  manual_closed   INTEGER NOT NULL DEFAULT 0,
  state           TEXT,
  reason          TEXT,
  last_count      INTEGER,
  last_check      INTEGER,
  last_error      TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_by      TEXT,
  updated_at      INTEGER
);

-- 候補／遞補通知：每筆回覆每種通知最多寄一次
CREATE TABLE IF NOT EXISTS notices (
  id           INTEGER PRIMARY KEY,
  form_id      INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  response_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('waitlist','promoted')),
  email        TEXT,
  rank         INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  at           INTEGER NOT NULL,
  UNIQUE (form_id, response_id, kind)
);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY,
  org_id  INTEGER,
  who     TEXT,
  what    TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_org_at ON logs(org_id, at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
`;

function open(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'limiter.db');
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // 舊資料庫升級
  for (const col of ['shared_folder_id', 'shared_folder_name', 'shared_folder_owner', 'mail_cfg', 'google_client_id', 'google_client_secret']) {
    try { db.exec(`ALTER TABLE orgs ADD COLUMN ${col} TEXT`); } catch (e) { /* 已存在 */ }
  }
  const formCols = {
    notify_enabled: 'INTEGER NOT NULL DEFAULT 0',
    notify_source: 'TEXT', // 'respondent'（表單收集的 Email）或題目 questionId
    notify_waitlist_subject: 'TEXT', notify_waitlist_body: 'TEXT',
    notify_promote_subject: 'TEXT', notify_promote_body: 'TEXT',
    option_quotas: 'TEXT', // 選項名額設定（JSON）
    option_aliases: 'TEXT' // 改過名稱的選項：{ questionId: { 目前名稱: [舊名稱] } }
  };
  for (const [col, type] of Object.entries(formCols)) {
    try { db.exec(`ALTER TABLE forms ADD COLUMN ${col} ${type}`); } catch (e) { /* 已存在 */ }
  }

  const stmts = new Map();
  const prep = (sql) => {
    if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql));
    return stmts.get(sql);
  };
  const plain = (row) => (row ? Object.assign({}, row) : null);

  return {
    raw: db,
    get: (sql, ...p) => plain(prep(sql).get(...p)),
    all: (sql, ...p) => prep(sql).all(...p).map(plain),
    run: (sql, ...p) => prep(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    getSetting(key) {
      const r = plain(prep('SELECT value FROM settings WHERE key = ?').get(key));
      return r ? r.value : null;
    },
    setSetting(key, value) {
      if (value == null) prep('DELETE FROM settings WHERE key = ?').run(key);
      else prep('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
    },
    log(orgId, who, what) {
      prep('INSERT INTO logs(org_id, who, what, at) VALUES (?, ?, ?, ?)').run(orgId ?? null, String(who || '').slice(0, 60), String(what).slice(0, 500), Date.now());
    },
    /** 把 WAL 寫回主檔再關閉，部署切換時不會遺失資料 */
    close() {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
      db.close();
    }
  };
}

module.exports = { open };
