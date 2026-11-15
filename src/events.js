'use strict';
// المزامنة الفورية بين الحسابين. النقل (SSE على Node، WebSocket على Cloudflare) يضبطه نظام التشغيل عبر setTransport
let T = { sendTo() { }, broadcast() { }, disconnect() { } };
const setTransport = (t) => { T = t; };
const sendTo = (userId, event, data) => T.sendTo(userId, event, data);
// إعلام كل المتصلين بأن البيانات تغيّرت ليعيدوا تحميل ما يعرضونه
const broadcastChange = (scope = {}) => T.broadcast('change', scope);
// قطع الاتصال الفوري لمستخدم (عند إيقاف حسابه أو تغيير كلمة مروره)
const disconnect = (userId) => { try { (T.disconnect || (() => { }))(userId); } catch { /* تجاهل */ } };
module.exports = { setTransport, sendTo, broadcastChange, disconnect };
