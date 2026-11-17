'use strict';
// طبقة قاعدة البيانات المشتركة: دوال متزامنة (get/all/run/tx) تُفوَّض إلى «محرك» يضبطه كل نظام تشغيل:
// Node → SQLite المدمجة (src/node/sqlite.js)، Cloudflare → SQLite داخل Durable Object (src/cloudflare/worker.mjs)
let B = null;
function setBackend(b) { B = b; }

function nowIso() { return new Date().toISOString(); }
// قيمة غير مُرسلة (undefined) تُخزَّن فارغة (NULL) بدل أن يرفضها محرك SQLite
const clean = (p) => p.map(v => (v === undefined ? null : v));
const get = (sql, ...p) => B.all(sql, clean(p))[0];
const all = (sql, ...p) => B.all(sql, clean(p));
const run = (sql, ...p) => B.run(sql, clean(p));

let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  try { return B.transaction(fn); } finally { txDepth--; }
}

function nextRef(prefix) {
  const year = new Date().getFullYear();
  const name = `${prefix}-${year}`;
  run('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1', name);
  const v = get('SELECT value FROM counters WHERE name=?', name).value;
  return `${prefix}-${year}-${String(v).padStart(4, '0')}`;
}

function applySchema() {
  const schema = require('./schema');
  for (const s of schema) B.run(s, []);
  const done = Number(kvGet('schema_version') || 0);
  schema.migrations.forEach((stmts, i) => {
    if (i + 1 <= done) return;
    tx(() => { for (const s of stmts) B.run(s, []); kvSet('schema_version', String(i + 1)); });
  });
}

const kvGet = (k) => (get('SELECT value FROM kv WHERE key=?', k) || {}).value;
const kvSet = (k, v) => run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);

module.exports = { setBackend, get, all, run, tx, nowIso, nextRef, applySchema, kvGet, kvSet };
