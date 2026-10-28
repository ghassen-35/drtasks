'use strict';
// قناة واتساب — مُهيأة للربط المستقبلي عبر WhatsApp Business Platform (Cloud API) الرسمية فقط.
// معطلة افتراضيًا ولم تُختبر مع حساب حقيقي. لا تُستخدم أي وسيلة إرسال غير رسمية.
// المتطلبات: حساب Meta Business موثّق، رقم هاتف مخصص للأعمال، قوالب رسائل معتمدة مسبقًا،
// ورمز وصول دائم. الإرسال خارج نافذة 24 ساعة يتطلب قالبًا معتمدًا ويُحتسب بتكلفة لكل محادثة/رسالة.
const { run } = require('./db');

const ENABLED = process.env.WHATSAPP_ENABLED === '1';
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TEMPLATE = process.env.WHATSAPP_TEMPLATE || 'office_notification';
// الأنواع المقترحة للإرسال عبر واتساب (حسب المتطلبات)
const WA_TYPES = ['new_assignment', 'overdue', 'deadline_soon', 'digest', 'approval_request'];

const configured = () => ENABLED && !!TOKEN && !!PHONE_ID;

async function maybeSend(user, notif) {
  if (!ENABLED) return; // لا تسجيل عند التعطيل لتجنب الضوضاء
  let prefs = {}; try { prefs = JSON.parse(user.prefs || '{}'); } catch { }
  const phone = prefs.whatsapp_phone;
  if (!prefs.whatsapp_enabled || !phone || !WA_TYPES.includes(notif.type)) return;
  if (!configured()) { run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'whatsapp', 'not_configured', ''); return; }
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: { name: TEMPLATE, language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: notif.title.slice(0, 60) }] }] },
    }),
  });
  run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'whatsapp', res.ok ? 'sent' : 'failed', String(res.status));
}

module.exports = { maybeSend, configured, ENABLED };
