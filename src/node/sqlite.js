'use strict';
// محرك Node: ملف SQLite دائم في DATA_DIR
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

function init(dataDir, file) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const sqlite = new DatabaseSync(file || path.join(dataDir, 'office.db'));
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const plain = (r) => ({ ...r }); // node:sqlite يعيد كائنات بلا prototype
  db.setBackend({
    all: (sql, p) => sqlite.prepare(sql).all(...p).map(plain),
    run: (sql, p) => { const r = sqlite.prepare(sql).run(...p); return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }; },
    transaction: (fn) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const r = fn(); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  });
  db.applySchema();
  // نسخة احتياطية كاملة إلى ملف (آخر 14 نسخة تلقائية)
  function backup(label = 'auto') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(dataDir, 'backups');
    const out = path.join(dir, `office-${label}-${stamp}.db`);
    sqlite.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('office-auto-')).sort();
    while (files.length > 14) fs.unlinkSync(path.join(dir, files.shift()));
    return out;
  }
  return { backup };
}
module.exports = { init };
