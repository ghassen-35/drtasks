'use strict';
// المزامنة الفورية بين الحسابين. النقل (SSE على Node، WebSocket على Cloudflare) يضبطه نظام التشغيل عبر setTransport
let T = { sendTo() { }, broadcast() { } };
const setTransport = (t) => { T = t; };
const sendTo = (userId, event, data) => T.sendTo(userId, event, data);
// إعلام كل المتصلين بأن البيانات تغيّرت ليعيدوا تحميل ما يعرضونه
const broadcastChange = (scope = {}) => T.broadcast('change', scope);
module.exports = { setTransport, sendTo, broadcastChange };
