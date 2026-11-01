'use strict';
// طبقة قاعدة البيانات المشتركة: دوال متزامنة (get/all/run/tx) تُفوَّض إلى «محرك» يضبطه كل نظام تشغيل:
// Node → SQLite المدمجة (src/node/sqlite.js)، Cloudflare → SQLite داخل Durable Object (src/cloudflare/worker.mjs)
let B = null;
function setBackend(b) { B = b; }

function nowIso() { return new Date().toISOString(); }
const get = (sql, ...p) => B.all(sql, p)[0];
const all = (sql, ...p) => B.all(sql, p);
const run = (sql, ...p) => B.run(sql, p);

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

function applySchema() { for (const s of require('./schema')) B.run(s, []); }

const kvGet = (k) => (get('SELECT value FROM kv WHERE key=?', k) || {}).value;
const kvSet = (k, v) => run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);

module.exports = { setBackend, get, all, run, tx, nowIso, nextRef, applySchema, kvGet, kvSet };
