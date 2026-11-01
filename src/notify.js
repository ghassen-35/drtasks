'use strict';
// نظام الإشعارات: (1) داخل المنصة  (2) Push للجوال + البريد الإلكتروني  (3) واتساب (مُهيأ للمستقبل، معطل)
const { get, all, run } = require('./db');
const cfg = require('./config');
const events = require('./events');
const whatsapp = require('./whatsapp');
const push = require('./push');

const TYPES = {
  new_assignment: 'تكليف جديد',
  new_message: 'رسالة جديدة',
  new_note: 'ملاحظة أو طلب جديد',
  acknowledged: 'تأكيد استلام',
  status_change: 'تحديث حالة مهمة',
  approval_request: 'طلب اعتماد',
  decision: 'قرار جديد',
  deadline_soon: 'اقتراب موعد نهائي',
  overdue: 'تأخر مهمة',
  digest: 'ملخص دوري',
};

const DEFAULT_PREFS = {
  inapp: Object.fromEntries(Object.keys(TYPES).map(t => [t, true])),
  push: { enabled: true, urgent_only: false, types: Object.keys(TYPES).filter(t => t !== 'digest') },
  email: { enabled: false, types: ['new_assignment', 'approval_request', 'overdue', 'digest'] },
  private_lock_screen: true, // لا تظهر تفاصيل حساسة في إشعارات شاشة القفل
};
function prefsOf(user) {
  let p = {}; try { p = JSON.parse(user.prefs || '{}'); } catch { }
  return {
    inapp: { ...DEFAULT_PREFS.inapp, ...(p.inapp || {}) },
    push: { ...DEFAULT_PREFS.push, ...(p.push || {}) },
    email: { ...DEFAULT_PREFS.email, ...(p.email || {}) },
    private_lock_screen: p.private_lock_screen !== undefined ? !!p.private_lock_screen : true,
  };
}

// ===== Web Push (VAPID) =====
async function sendPush(user, notif) {
  const prefs = prefsOf(user);
  if (!prefs.push.enabled) return;
  if (prefs.push.urgent_only && !notif.urgent) return;
  if (!prefs.push.types.includes(notif.type)) return;
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id=?', user.id);
  if (!subs.length) return;
  const payload = JSON.stringify(prefs.private_lock_screen
    ? { title: notif.urgent ? 'تنبيه عاجل — مكتب رجل الأعمال' : 'مكتب رجل الأعمال', body: 'لديك إشعار جديد في المنصة', link: notif.link, tag: `n${notif.id}` }
    : { title: notif.title, body: notif.body || '', link: notif.link, tag: `n${notif.id}` });
  for (const s of subs) {
    try {
      await push.sendWebPush({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, { urgent: notif.urgent });
      run('INSERT INTO deliveries(notification_id,user_id,channel,status) VALUES(?,?,?,?)', notif.id, user.id, 'push', 'sent');
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subscriptions WHERE id=?', s.id);
      run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'push', 'failed', String(e.statusCode || e.message).slice(0, 300));
    }
  }
}

// ===== البريد الإلكتروني =====
// EMAIL_MODE: off (افتراضي) | resend (HTTP، يعمل على Cloudflare) | smtp وfile (Node فقط). المزودون يسجّلهم نظام التشغيل
const mailProviders = {
  async resend(msg) {
    const key = cfg.get('RESEND_API_KEY');
    if (!key) throw new Error('RESEND_API_KEY غير مضبوط');
    const res = await fetch(cfg.get('RESEND_API_URL', 'https://api.resend.com/emails'), {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.get('EMAIL_FROM', 'office@localhost'), to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}`);
  },
};
const registerMailProvider = (name, fn) => { mailProviders[name] = fn; };
const emailMode = () => cfg.get('EMAIL_MODE', 'off');
const emailStatus = () => ({ mode: emailMode(), configured: emailMode() !== 'off' && !!mailProviders[emailMode()] && (emailMode() !== 'resend' || !!cfg.get('RESEND_API_KEY')) });
const appUrl = () => cfg.get('APP_URL') || cfg.get('RENDER_EXTERNAL_URL')
  || (cfg.get('CODESPACE_NAME') && cfg.get('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN') ? `https://${cfg.get('CODESPACE_NAME')}-${cfg.get('PORT', '3000')}.${cfg.get('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN')}` : null)
  || cfg.runtime.origin || `http://localhost:${cfg.get('PORT', '3000')}`;

async function sendEmail(user, notif, { force = false } = {}) {
  const prefs = prefsOf(user);
  if (!force && (!prefs.email.enabled || !prefs.email.types.includes(notif.type))) return;
  const rec = (status, detail) => run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'email', status, detail);
  if (!user.email) return rec('skipped', 'لا يوجد بريد للمستخدم');
  if (!emailStatus().configured) return rec('not_configured', `EMAIL_MODE=${emailMode()}`);
  const link = appUrl() + '/' + (notif.link || '');
  try {
    await mailProviders[emailMode()]({
      to: user.email, subject: `${notif.urgent ? '[عاجل] ' : ''}${notif.title}`,
      text: `${notif.body || ''}\n\nفتح في المنصة: ${link}`,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial;font-size:15px"><p><b>${esc(notif.title)}</b></p><p style="white-space:pre-wrap">${esc(notif.body || '')}</p><p><a href="${esc(link)}">فتح في المنصة</a></p></div>`,
    });
    rec('sent', emailMode());
  } catch (e) { rec('failed', String(e.message).slice(0, 300)); }
}
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * إنشاء إشعار لمستخدم وإيصاله عبر القنوات المفعلة.
 * dedupe: مفتاح يمنع تكرار نفس التنبيه (مثل التأخر اليومي).
 * collapse: يدمج الرسائل المتتالية غير المقروءة لنفس المهمة في إشعار واحد.
 */
function notify(userId, { type, title, body, link, urgent = false, dedupe = null, collapse = null }) {
  const user = get('SELECT * FROM users WHERE id=? AND active=1', userId);
  if (!user) return null;
  const prefs = prefsOf(user);
  if (prefs.inapp[type] === false && !urgent) return null;
  if (collapse) {
    const ex = get('SELECT * FROM notifications WHERE user_id=? AND dedupe_key=? AND read_at IS NULL', userId, collapse);
    if (ex) {
      const n = (ex.body.match(/^\((\d+)\)/) || [0, 1])[1] * 1 + 1;
      run("UPDATE notifications SET body=?, title=?, created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), urgent=MAX(urgent,?) WHERE id=?",
        `(${n}) ${body || ''}`.slice(0, 500), title, urgent ? 1 : 0, ex.id);
      events.sendTo(userId, 'notification', { id: ex.id, type, title, urgent });
      return ex.id;
    }
    dedupe = collapse;
  }
  if (dedupe && get('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?', userId, dedupe)) return null;
  const { id } = run('INSERT INTO notifications(user_id,type,title,body,link,urgent,dedupe_key) VALUES(?,?,?,?,?,?,?)',
    userId, type, title, (body || '').slice(0, 500), link || null, urgent ? 1 : 0, dedupe);
  const notif = { id, type, title, body, link, urgent };
  events.sendTo(userId, 'notification', notif);
  // القنوات الخارجية تعمل في الخلفية دون تعطيل الطلب
  queueMicrotask(() => {
    sendPush(user, notif).catch(() => { });
    sendEmail(user, notif).catch(() => { });
    whatsapp.maybeSend(user, notif).catch(() => { });
  });
  return id;
}

function notifyRole(role, payload) {
  for (const u of all('SELECT id FROM users WHERE role=? AND active=1', role)) notify(u.id, payload);
}

module.exports = { notify, notifyRole, TYPES, prefsOf, DEFAULT_PREFS, sendEmail, emailStatus, registerMailProvider, appUrl };
