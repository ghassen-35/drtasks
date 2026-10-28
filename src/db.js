'use strict';
// طبقة قاعدة البيانات: SQLite مدمجة في Node (node:sqlite) — ملف دائم في data/office.db
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'office.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager')),
  email TEXT,
  password_hash TEXT NOT NULL,
  prefs TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- سجل واحد لكل تكليف/ملاحظة/مهمة. التحويل إلى مهمة يتم في نفس السجل (لا نسخ مكررة)
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assignment','note','task')),
  msg_type TEXT,                       -- للملاحظات: info|action|modify|inquiry|directive
  source TEXT NOT NULL DEFAULT 'owner',-- owner|manager|meeting
  title TEXT NOT NULL,
  description TEXT,
  original_text TEXT,                  -- نص التكليف الأصلي كما أُرسل (لا يتغير)
  section TEXT,
  category TEXT NOT NULL DEFAULT 'general', -- general|commitment|opportunity|appointment|academic
  project_id INTEGER REFERENCES projects(id),
  parent_id INTEGER REFERENCES items(id),   -- ملاحظة مرتبطة بمهمة قائمة
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important','urgent')),
  due_date TEXT,
  due_time TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assignee TEXT,
  next_step TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  acknowledged_by INTEGER REFERENCES users(id),
  started_at TEXT,
  completed_at TEXT,
  closed_at TEXT,
  converted_at TEXT,
  meeting_id INTEGER,
  decision_id INTEGER,
  sop_id INTEGER,
  partner_id INTEGER,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_items_section ON items(section);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_due ON items(due_date);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);

-- المحادثة المرتبطة بالمهمة: رسائل، تحديثات، أحداث نظام
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  author_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'message', -- message|update|system|decision|result
  body TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_item ON messages(item_id);

-- طلبات الاعتماد/القرار
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL, -- report|proposal|commercial|approval|guidance|inquiry|final
  title TEXT NOT NULL,
  body TEXT,
  options TEXT,       -- JSON: بدائل مقترحة
  blocking INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|changes_requested|chosen|answered|withdrawn
  decision_note TEXT,
  chosen_option TEXT,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_approvals_item ON approvals(item_id);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id),
  message_id INTEGER REFERENCES messages(id),
  approval_id INTEGER REFERENCES approvals(id),
  sop_id INTEGER,
  meeting_id INTEGER,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  is_voice INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

-- سجل محاولات الإرسال خارج المنصة (Push / بريد / واتساب)
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  notification_id INTEGER REFERENCES notifications(id),
  user_id INTEGER,
  channel TEXT NOT NULL,
  status TEXT NOT NULL, -- sent|failed|skipped|not_configured
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT UNIQUE NOT NULL,
  keys TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  section TEXT,
  starts_at TEXT NOT NULL,
  location TEXT,
  participants TEXT,
  topics TEXT,
  minutes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|held|cancelled
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  text TEXT NOT NULL,
  responsible TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|done|cancelled
  task_id INTEGER UNIQUE REFERENCES items(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sops (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT,
  steps TEXT,
  responsible TEXT,
  section TEXT,
  approved_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'org', -- org|person
  relation_type TEXT,
  phone TEXT,
  email TEXT,
  contact_notes TEXT,
  last_contact_at TEXT,
  commitments TEXT,
  next_followup TEXT,
  opportunities TEXT,
  awaiting_reply INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

function nowIso() { return new Date().toISOString(); }

// يعيد كائنات عادية (node:sqlite يعيد كائنات بلا prototype)
const plain = (r) => (r ? { ...r } : r);
function get(sql, ...p) { return plain(db.prepare(sql).get(...p)); }
function all(sql, ...p) { return db.prepare(sql).all(...p).map(plain); }
function run(sql, ...p) { const r = db.prepare(sql).run(...p); return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }; }

let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { txDepth--; }
}

function nextRef(prefix) {
  const year = new Date().getFullYear();
  const name = `${prefix}-${year}`;
  run('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1', name);
  const v = get('SELECT value FROM counters WHERE name=?', name).value;
  return `${prefix}-${year}-${String(v).padStart(4, '0')}`;
}

// ===== كلمات المرور (scrypt) =====
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}

// إنشاء الحسابين عند أول تشغيل، وتدوين كلمات المرور الأولية في ملف محلي
function ensureUsers() {
  const count = get('SELECT COUNT(*) c FROM users').c;
  if (count > 0) return null;
  const gen = () => crypto.randomBytes(6).toString('base64url');
  const ownerPw = process.env.OWNER_PASSWORD || gen();
  const managerPw = process.env.MANAGER_PASSWORD || gen();
  run('INSERT INTO users(username,name,role,email,password_hash) VALUES(?,?,?,?,?)',
    process.env.OWNER_USERNAME || 'owner', process.env.OWNER_NAME || 'رجل الأعمال', 'owner', process.env.OWNER_EMAIL || null, hashPassword(ownerPw));
  run('INSERT INTO users(username,name,role,email,password_hash) VALUES(?,?,?,?,?)',
    process.env.MANAGER_USERNAME || 'manager', process.env.MANAGER_NAME || 'مدير المكتب', 'manager', process.env.MANAGER_EMAIL || null, hashPassword(managerPw));
  const creds = `بيانات الدخول الأولية (غيّرها بعد أول دخول من صفحة الإعدادات)\n\nرجل الأعمال: ${process.env.OWNER_USERNAME || 'owner'} / ${ownerPw}\nمدير المكتب: ${process.env.MANAGER_USERNAME || 'manager'} / ${managerPw}\n`;
  fs.writeFileSync(path.join(DATA_DIR, 'initial-credentials.txt'), creds, { mode: 0o600 });
  return creds;
}

function backup(label = 'auto') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DATA_DIR, 'backups', `office-${label}-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // الاحتفاظ بآخر 14 نسخة تلقائية
  const files = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter(f => f.startsWith('office-auto-')).sort();
  while (files.length > 14) fs.unlinkSync(path.join(DATA_DIR, 'backups', files.shift()));
  return file;
}

module.exports = { db, get, all, run, tx, nowIso, nextRef, hashPassword, verifyPassword, ensureUsers, backup, DATA_DIR };
