'use strict';
// مزامنة فورية بين الحسابين عبر Server-Sent Events
const clients = new Map(); // userId -> Set<res>

function subscribe(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  return () => { const s = clients.get(userId); if (s) { s.delete(res); if (!s.size) clients.delete(userId); } };
}
function write(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* اتصال مغلق */ }
}
function sendTo(userId, event, data) {
  for (const res of clients.get(userId) || []) write(res, event, data);
}
// إعلام كل المتصلين بأن البيانات تغيّرت ليعيدوا تحميل ما يعرضونه
function broadcastChange(scope = {}) {
  for (const set of clients.values()) for (const res of set) write(res, 'change', scope);
}
setInterval(() => { for (const set of clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch { } } }, 25000).unref();

module.exports = { subscribe, sendTo, broadcastChange };
