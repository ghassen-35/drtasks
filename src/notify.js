'use strict';
// نظام الإشعارات: (1) داخل المنصة  (2) Push للجوال + البريد الإلكتروني  (3) واتساب (مُهيأ للمستقبل، معطل)
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
const { get, all, run, DATA_DIR } = require('./db');
const events = require('./events');
const whatsapp = require('./whatsapp');

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
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (fs.existsSync(VAPID_FILE)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.invalid', vapid.publicKey, vapid.privateKey);

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
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, { TTL: 3600 * 24, urgency: notif.urgent ? 'high' : 'normal' });
      run('INSERT INTO deliveries(notification_id,user_id,channel,status) VALUES(?,?,?,?)', notif.id, user.id, 'push', 'sent');
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subscriptions WHERE id=?', s.id);
      run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'push', 'failed', String(e.statusCode || e.message).slice(0, 300));
    }
  }
}

// ===== البريد الإلكتروني =====
// EMAIL_MODE: off (افتراضي) | smtp (يتطلب إعداد SMTP_*) | file (اختبار: يكتب الرسائل في data/outbox دون إرسال)
const EMAIL_MODE = process.env.EMAIL_MODE || 'off';
let transport = null;
if (EMAIL_MODE === 'smtp' && process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
} else if (EMAIL_MODE === 'file') {
  transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
}
const emailStatus = () => ({ mode: EMAIL_MODE, configured: !!transport });
// في GitHub Codespaces يُستنتج الرابط العام من متغيرات البيئة (النطاق قد يتغير، فلا يُكتب ثابتًا)
const APP_URL = process.env.APP_URL
  || (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `https://${process.env.CODESPACE_NAME}-${process.env.PORT || 3000}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : `http://localhost:${process.env.PORT || 3000}`);

async function sendEmail(user, notif, { force = false } = {}) {
  const prefs = prefsOf(user);
  if (!force && (!prefs.email.enabled || !prefs.email.types.includes(notif.type))) return;
  if (!user.email) { run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'email', 'skipped', 'لا يوجد بريد للمستخدم'); return; }
  if (!transport) { run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'email', 'not_configured', `EMAIL_MODE=${EMAIL_MODE}`); return; }
  const link = APP_URL + '/' + (notif.link || '');
  try {
    const info = await transport.sendMail({
      from: process.env.EMAIL_FROM || 'office-platform@localhost', to: user.email,
      subject: `${notif.urgent ? '[عاجل] ' : ''}${notif.title}`,
      text: `${notif.body || ''}\n\nفتح في المنصة: ${link}`,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial;font-size:15px"><p><b>${esc(notif.title)}</b></p><p style="white-space:pre-wrap">${esc(notif.body || '')}</p><p><a href="${esc(link)}">فتح في المنصة</a></p></div>`,
    });
    if (EMAIL_MODE === 'file') {
      const dir = path.join(DATA_DIR, 'outbox'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}-${notif.id || 'x'}.eml`), info.message);
    }
    run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'email', 'sent', EMAIL_MODE);
  } catch (e) {
    run('INSERT INTO deliveries(notification_id,user_id,channel,status,detail) VALUES(?,?,?,?,?)', notif.id, user.id, 'email', 'failed', String(e.message).slice(0, 300));
  }
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
  setImmediate(() => {
    sendPush(user, notif).catch(() => { });
    sendEmail(user, notif).catch(() => { });
    whatsapp.maybeSend(user, notif).catch(() => { });
  });
  return id;
}

function notifyRole(role, payload) {
  for (const u of all('SELECT id FROM users WHERE role=? AND active=1', role)) notify(u.id, payload);
}

module.exports = { notify, notifyRole, TYPES, prefsOf, DEFAULT_PREFS, vapidPublicKey: () => vapid.publicKey, sendEmail, emailStatus, APP_URL };
