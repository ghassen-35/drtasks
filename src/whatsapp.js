'use strict';
// قناة واتساب — مُهيأة للربط المستقبلي عبر WhatsApp Business Platform (Cloud API) الرسمية فقط.
// معطلة افتراضيًا ولم تُختبر مع حساب حقيقي. لا تُستخدم أي وسيلة إرسال غير رسمية.
// المتطلبات: حساب Meta Business موثّق، رقم هاتف مخصص للأعمال، قوالب رسائل معتمدة مسبقًا،
// ورمز وصول دائم. الإرسال خارج نافذة 24 ساعة يتطلب قالبًا معتمدًا ويُحتسب بتكلفة لكل محادثة/رسالة.
const { run } = require('./db');
const cfg = require('./config');

const enabled = () => cfg.flag('WHATSAPP_ENABLED');
// الأنواع المقترحة للإرسال عبر واتساب (حسب المتطلبات)
const WA_TYPES = ['new_assignment', 'overdue', 'deadline_soon', 'digest', 'approval_request'];

const configured = () => enabled() && !!cfg.get('WHATSAPP_TOKEN') && !!cfg.get('WHATSAPP_PHONE_NUMBER_ID');

async function maybeSend(user, notif) {
  if (!enabled()) return; // لا تسجيل عند التعطيل لتجنب الضوضاء
  let prefs = {}; try { prefs = JSON.parse(user.prefs || '{}'); } catch { }
  const phone = prefs.whatsapp_phone;
  if (!prefs.whatsapp_enabled || !phone || !WA_TYPES.includes(notif.type)) return;
  if (!configured()) { run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'whatsapp', 'not_configured', ''); return; }
  const res = await fetch(`https://graph.facebook.com/v20.0/${cfg.get('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.get('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: { name: cfg.get('WHATSAPP_TEMPLATE', 'office_notification'), language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: notif.title.slice(0, 60) }] }] },
    }),
  });
  run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'whatsapp', res.ok ? 'sent' : 'failed', String(res.status));
}

module.exports = { maybeSend, configured, enabled };
