'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, get, all, run, tx, nowIso, verifyPassword, hashPassword, ensureUsers, backup, DATA_DIR } = require('./db');
const D = require('./domain');
const S = require('./services');
const N = require('./notify');
const events = require('./events');
const whatsapp = require('./whatsapp');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '1mb' }));

// ===== ترويسات الأمان =====
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});

// ===== الجلسات =====
const COOKIE = 'sid';
const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function parseCookies(h = '') { return Object.fromEntries(h.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
function currentUser(req) {
  const tok = parseCookies(req.headers.cookie)[COOKIE];
  if (!tok) return null;
  const s = get('SELECT * FROM sessions WHERE token_hash=?', sha(tok));
  if (!s || s.expires_at < nowIso()) return null;
  const u = get('SELECT id,username,name,role,email,prefs FROM users WHERE id=? AND active=1', s.user_id);
  return u || null;
}
app.use('/api', (req, res, next) => {
  // حماية CSRF: كل طلب معدِّل يجب أن يحمل ترويسة مخصصة لا يمكن لموقع آخر إرسالها
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'طلب غير مسموح' });
  req.user = currentUser(req);
  if (!req.user && !['/login', '/health'].includes(req.path)) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  next();
});
const wrap = (fn) => (req, res) => {
  try {
    const r = fn(req, res);
    if (r && typeof r.then === 'function') r.then(v => { if (!res.headersSent) res.json(v ?? { ok: true }); }).catch(e => fail(res, e));
    else if (!res.headersSent) res.json(r ?? { ok: true });
  } catch (e) { fail(res, e); }
};
function fail(res, e) {
  if (!(e instanceof S.AppError)) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'حدث خطأ غير متوقع' });
}

// محدد بسيط لمحاولات الدخول
const attempts = new Map();
app.post('/api/login', wrap((req, res) => {
  const key = `${req.ip}|${String(req.body.username || '').toLowerCase()}`;
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw new S.AppError(429, 'محاولات كثيرة، حاول بعد ربع ساعة');
  const u = get('SELECT * FROM users WHERE username=? AND active=1', String(req.body.username || '').trim().toLowerCase());
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) { a.n++; attempts.set(key, a); throw new S.AppError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة'); }
  attempts.delete(key);
  const tok = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(tok), u.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
  const secure = req.secure || process.env.COOKIE_SECURE === '1';
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
  return { ok: true };
}));
app.post('/api/logout', wrap((req, res) => {
  const tok = parseCookies(req.headers.cookie)[COOKIE];
  if (tok) run('DELETE FROM sessions WHERE token_hash=?', sha(tok));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  return { ok: true };
}));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/me', wrap(req => {
  const u = { ...req.user }; delete u.prefs;
  u.perms = [...D.PERMS[u.role]];
  u.unread = get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL', u.id).c;
  u.pending_decisions = get("SELECT COUNT(*) c FROM approvals WHERE status='pending'").c;
  u.inbox_pending = get("SELECT COUNT(*) c FROM items WHERE kind IN ('assignment','note') AND status!='cancelled' AND (acknowledged_at IS NULL OR kind='assignment' OR status NOT IN ('done','cancelled'))").c;
  return u;
}));
app.post('/api/password', wrap(req => {
  const u = get('SELECT * FROM users WHERE id=?', req.user.id);
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) throw S.bad('كلمة المرور الحالية غير صحيحة');
  const pw = String(req.body.next || '');
  if (pw.length < 8) throw S.bad('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(pw), u.id);
  return { ok: true };
}));

app.get('/api/meta', wrap(req => ({
  sections: D.SECTIONS, statuses: D.STATUSES, priorities: D.PRIORITIES, msg_types: D.MSG_TYPES, categories: D.CATEGORIES,
  approval_kinds: D.APPROVAL_KINDS, notif_types: N.TYPES, vapid: N.vapidPublicKey(), today: D.todayStr(), tz: D.TZ,
  email: N.emailStatus(), whatsapp: { enabled: whatsapp.ENABLED, configured: whatsapp.configured() },
  users: all('SELECT id,name,role FROM users WHERE active=1'),
})));

// ===== الصفحة الرئيسية: الأشرطة والمربعات والملخصات =====
app.get('/api/home', wrap(req => {
  const t = D.todayStr();
  const out = { today: t, today_ribbon: D.todayRibbon(), urgent_ribbon: D.urgentRibbon(), tiles: D.SECTION_KEYS.map(D.sectionStats) };
  const c = (sql, ...p) => get(sql, ...p).c;
  out.summary = {
    open: c(`SELECT COUNT(*) c FROM items WHERE kind IN ${D.TASK_KINDS} AND ${D.OPEN}`),
    open_assignments: c(`SELECT COUNT(*) c FROM items WHERE source='owner' AND kind IN ${D.TASK_KINDS} AND ${D.OPEN}`),
    urgent: out.urgent_ribbon.length,
    overdue: c(`SELECT COUNT(*) c FROM items WHERE kind IN ${D.TASK_KINDS} AND ${D.OPEN} AND due_date<?`, t),
    pending_decisions: c(`SELECT COUNT(*) c FROM approvals WHERE status='pending'`),
    inbox_pending: c(`SELECT COUNT(*) c FROM items WHERE kind IN ('assignment','note') AND status NOT IN ('done','cancelled') AND (acknowledged_at IS NULL OR kind='assignment')`),
  };
  out.updates = all(`SELECT m.id,m.item_id,m.kind,m.body,m.created_at,u.name AS author_name,i.title AS item_title,i.ref FROM messages m JOIN items i ON i.id=m.item_id LEFT JOIN users u ON u.id=m.author_id
    WHERE u.role='manager' AND (m.kind IN ('update','result','message') OR (m.kind IN ('system','decision') AND m.meta IS NOT NULL)) ORDER BY m.id DESC LIMIT 8`);
  out.achievements = all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE kind IN ${D.TASK_KINDS} AND status='done' ORDER BY completed_at DESC LIMIT 5`).map(i => D.decorate(i, t));
  out.meetings = all(`SELECT * FROM meetings WHERE status='scheduled' AND starts_at>=? ORDER BY starts_at LIMIT 5`, t);
  return out;
}));

// ===== المهام والتكليفات =====
function listItems(q, user) {
  const t = D.todayStr();
  const where = ['1=1']; const p = [];
  if (q.kind === 'tasks' || !q.kind) where.push(`i.kind IN ${D.TASK_KINDS}`);
  else if (q.kind === 'inbox') where.push("i.kind IN ('assignment','note')");
  else if (q.kind === 'mine') { where.push("i.source='owner' AND i.created_by=?"); p.push(user.id); }
  else if (q.kind !== 'all') { where.push('i.kind=?'); p.push(q.kind); }
  if (q.section) { where.push('i.section=?'); p.push(q.section); }
  if (q.status) { where.push('i.status=?'); p.push(q.status); }
  if (q.priority) { where.push('i.priority=?'); p.push(q.priority); }
  if (q.project_id) { where.push('i.project_id=?'); p.push(Number(q.project_id)); }
  if (q.category) { where.push('i.category=?'); p.push(q.category); }
  if (q.scope === 'open') where.push(`i.${D.OPEN}`);
  if (q.scope === 'overdue') { where.push(`i.${D.OPEN} AND i.due_date<?`); p.push(t); }
  if (q.scope === 'today') { where.push(`i.${D.OPEN} AND i.due_date=?`); p.push(t); }
  if (q.scope === 'closed') where.push("i.status IN ('done','cancelled')");
  if (q.q) { where.push('(i.title LIKE ? OR i.description LIKE ? OR i.ref LIKE ? OR i.assignee LIKE ?)'); const s = `%${String(q.q).slice(0, 100)}%`; p.push(s, s, s, s); }
  return all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN i.status IN ('done','cancelled') THEN 1 ELSE 0 END, CASE i.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, COALESCE(i.due_date,'9999'), i.id DESC LIMIT 500`, ...p)
    .map(i => D.decorate(i, t));
}
app.get('/api/items', wrap(req => { S.require_(req.user, 'item.view'); return listItems(req.query, req.user); }));

function attachFiles(user, itemId, ids) {
  for (const f of (ids || []).map(Number).filter(Boolean)) run('UPDATE files SET item_id=? WHERE id=? AND uploader_id=? AND item_id IS NULL AND message_id IS NULL AND approval_id IS NULL', itemId, f, user.id);
}
app.post('/api/assignments', wrap(req => { const it = S.createAssignment(req.user, req.body); attachFiles(req.user, it.id, req.body.file_ids); return it; }));
app.post('/api/notes', wrap(req => { const it = S.createNote(req.user, req.body); attachFiles(req.user, it.id, req.body.file_ids); return it; }));
app.post('/api/tasks', wrap(req => { const it = S.createTask(req.user, req.body); attachFiles(req.user, it.id, req.body.file_ids); return it; }));

app.get('/api/items/:id', wrap(req => {
  S.require_(req.user, 'item.view');
  const it = S.getItem(Number(req.params.id));
  // فتح المهمة يعني الاطلاع على إشعاراتها
  run('UPDATE notifications SET read_at=? WHERE user_id=? AND link=? AND read_at IS NULL', nowIso(), req.user.id, `#/item/${it.id}`);
  const th = S.thread(it.id);
  const extra = {};
  if (it.parent_id) extra.parent = get('SELECT id,ref,title FROM items WHERE id=?', it.parent_id);
  if (it.meeting_id) extra.meeting = get('SELECT id,title,starts_at FROM meetings WHERE id=?', it.meeting_id);
  if (it.sop_id) extra.sop = get('SELECT id,name FROM sops WHERE id=?', it.sop_id);
  if (it.partner_id) extra.partner = get('SELECT id,name FROM partners WHERE id=?', it.partner_id);
  return { item: it, ...th, ...extra };
}));
app.post('/api/items/:id/ack', wrap(req => S.acknowledge(req.user, Number(req.params.id))));
app.post('/api/items/:id/convert', wrap(req => S.convertToTask(req.user, Number(req.params.id), req.body)));
app.patch('/api/items/:id', wrap(req => S.updateItem(req.user, Number(req.params.id), req.body)));
app.post('/api/items/:id/close', wrap(req => S.closeItem(req.user, Number(req.params.id))));
app.post('/api/items/:id/messages', wrap(req => ({ id: S.addMessage(req.user, Number(req.params.id), req.body, req.body.file_ids || []) })));
app.post('/api/items/:id/approvals', wrap(req => ({ id: S.requestApproval(req.user, Number(req.params.id), req.body, req.body.file_ids || []) })));
app.post('/api/approvals/:id/decide', wrap(req => S.decide(req.user, Number(req.params.id), req.body)));
app.post('/api/approvals/:id/withdraw', wrap(req => S.withdrawApproval(req.user, Number(req.params.id))));
app.get('/api/approvals', wrap(req => {
  S.require_(req.user, 'item.view');
  const status = req.query.status || 'pending';
  return all(`SELECT a.*, i.ref, i.title AS item_title, i.section, i.priority, i.due_date, ru.name AS requested_by_name, du.name AS decided_by_name
    FROM approvals a JOIN items i ON i.id=a.item_id LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users du ON du.id=a.decided_by
    WHERE ${status === 'all' ? '1=1' : status === 'decided' ? "a.status NOT IN ('pending','withdrawn')" : 'a.status=?'} ORDER BY ${status === 'pending' ? 'a.blocking DESC, a.id' : 'a.decided_at DESC'} LIMIT 200`,
  ...(status === 'all' || status === 'decided' ? [] : [status]))
    .map(a => ({ ...a, options: a.options ? JSON.parse(a.options) : [], kind_label: D.APPROVAL_KINDS[a.kind], section_name: D.sectionName(a.section),
      files: all('SELECT id,original_name,mime,size,is_voice FROM files WHERE approval_id=?', a.id) }));
}));

// لوحة المتابعة التنفيذية لمدير المكتب
app.get('/api/dashboard', wrap(req => {
  S.require_(req.user, 'item.manage');
  const t = D.todayStr();
  const q = (cond, ...p) => all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE ${cond} ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, COALESCE(i.due_date,'9999') LIMIT 100`, ...p).map(i => D.decorate(i, t));
  const TK = `i.kind IN ${D.TASK_KINDS} AND i.${D.OPEN}`;
  return {
    groups: [
      { key: 'today', title: 'مهام اليوم', tone: 'orange', items: D.todayRibbon() },
      { key: 'urgent', title: 'المهام العاجلة', tone: 'red', items: D.urgentRibbon() },
      { key: 'overdue', title: 'المهام المتأخرة', tone: 'red', items: q(`${TK} AND i.due_date<?`, t) },
      { key: 'unack', title: 'تكليفات جديدة غير مؤكدة الاستلام', tone: 'orange', items: q("i.kind IN ('assignment','note') AND i.acknowledged_at IS NULL AND i.status!='cancelled'") },
      { key: 'not_started', title: 'مهام لم يبدأ تنفيذها', tone: 'gray', items: q(`${TK} AND i.status IN ('new','acknowledged')`) },
      { key: 'waiting_info', title: 'تنتظر معلومات من رجل الأعمال', tone: 'gray', items: q(`${TK} AND i.status='waiting_info'`) },
      { key: 'waiting_approval', title: 'تنتظر اعتماد رجل الأعمال', tone: 'gray', items: q(`${TK} AND i.status='waiting_approval'`) },
      { key: 'waiting_reply', title: 'تنتظر أطرافًا خارجية', tone: 'gray', items: q(`${TK} AND i.status='waiting_reply'`) },
      { key: 'stalled', title: 'تحتاج تدخلًا أو تصعيدًا', tone: 'red', items: q(`${TK} AND i.status='stalled'`) },
      { key: 'to_close', title: 'مكتملة تنتظر الإغلاق النهائي', tone: 'green', items: q("i.kind IN ('assignment','task') AND i.status='done' AND i.closed_at IS NULL") },
    ],
  };
}));

// ===== الإشعارات =====
app.get('/api/notifications', wrap(req => all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', req.user.id)));
app.post('/api/notifications/:id/read', wrap(req => { run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL', nowIso(), Number(req.params.id), req.user.id); }));
app.post('/api/notifications/read-all', wrap(req => { run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', nowIso(), req.user.id); }));
app.get('/api/deliveries', wrap(req => all('SELECT channel,status,detail,created_at FROM deliveries WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id)));
app.get('/api/prefs', wrap(req => { const u = get('SELECT * FROM users WHERE id=?', req.user.id); let raw = {}; try { raw = JSON.parse(u.prefs); } catch { } return { ...N.prefsOf(u), email_address: u.email, whatsapp_phone: raw.whatsapp_phone || '', whatsapp_enabled: !!raw.whatsapp_enabled, push_devices: get('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=?', u.id).c }; }));
app.put('/api/prefs', wrap(req => {
  const b = req.body; const types = Object.keys(N.TYPES);
  const clean = {
    inapp: Object.fromEntries(types.map(t => [t, b.inapp ? b.inapp[t] !== false : true])),
    push: { enabled: !!(b.push && b.push.enabled), urgent_only: !!(b.push && b.push.urgent_only), types: ((b.push && b.push.types) || []).filter(t => types.includes(t)) },
    email: { enabled: !!(b.email && b.email.enabled), types: ((b.email && b.email.types) || []).filter(t => types.includes(t)) },
    private_lock_screen: b.private_lock_screen !== false,
    whatsapp_enabled: !!b.whatsapp_enabled, whatsapp_phone: S.str(b.whatsapp_phone, 20) || '',
  };
  const email = S.str(b.email_address, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw S.bad('بريد إلكتروني غير صالح');
  run('UPDATE users SET prefs=?, email=? WHERE id=?', JSON.stringify(clean), email, req.user.id);
  return { ok: true };
}));
app.post('/api/push/subscribe', wrap(req => {
  const s = req.body; if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) throw S.bad('اشتراك غير صالح');
  run('INSERT INTO push_subscriptions(user_id,endpoint,keys,user_agent) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, keys=excluded.keys',
    req.user.id, String(s.endpoint), JSON.stringify({ p256dh: s.keys.p256dh, auth: s.keys.auth }), String(req.get('user-agent') || '').slice(0, 200));
}));
app.post('/api/push/unsubscribe', wrap(req => { run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?', String(req.body.endpoint || ''), req.user.id); }));
app.post('/api/notify/test', wrap(req => {
  N.notify(req.user.id, { type: 'status_change', title: 'إشعار تجريبي', body: 'هذا إشعار اختبار من صفحة الإعدادات', link: '#/settings' });
}));

// SSE
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const off = events.subscribe(req.user.id, res);
  req.on('close', off);
});

// ===== الملفات =====
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, f, cb) => cb(null, crypto.randomBytes(16).toString('hex')) }),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});
app.post('/api/files', upload.array('files', 10), wrap(req => {
  return (req.files || []).map(f => {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200);
    const { id } = run('INSERT INTO files(uploader_id,original_name,stored_name,mime,size,is_voice) VALUES(?,?,?,?,?,?)',
      req.user.id, name, f.filename, f.mimetype, f.size, req.body.voice === '1' ? 1 : 0);
    return { id, original_name: name, mime: f.mimetype, size: f.size, is_voice: req.body.voice === '1' };
  });
}));
const INLINE = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/(mp4|webm)|application\/pdf)/;
app.get('/api/files/:id', (req, res) => {
  const f = get('SELECT * FROM files WHERE id=?', Number(req.params.id));
  // الملفات متاحة للمستخدمين المصرح لهم فقط (مرفوعة بواسطتهم أو مرتبطة بعنصر يمكنهم الاطلاع عليه)
  if (!f || !(f.uploader_id === req.user.id || (f.item_id && D.can(req.user, 'item.view')) || (f.sop_id && D.can(req.user, 'sops.view')) || (f.meeting_id && D.can(req.user, 'meetings.view')))) return res.status(404).json({ error: 'غير موجود' });
  const inline = INLINE.test(f.mime || '');
  res.set({
    'Content-Type': inline ? f.mime : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    'Cache-Control': 'private, max-age=3600',
  });
  res.sendFile(path.join(UPLOAD_DIR, f.stored_name));
});

// ===== المشاريع =====
app.get('/api/projects', wrap(req => {
  const rows = req.query.section ? all('SELECT * FROM projects WHERE section=? ORDER BY status, name', req.query.section) : all('SELECT * FROM projects ORDER BY section, name');
  return rows.map(p => ({ ...p, open_tasks: get(`SELECT COUNT(*) c FROM items WHERE project_id=? AND kind IN ${D.TASK_KINDS} AND ${D.OPEN}`, p.id).c }));
}));
app.post('/api/projects', wrap(req => {
  S.require_(req.user, 'projects.manage');
  const name = S.str(req.body.name, 200); if (!name) throw S.bad('اسم المشروع مطلوب');
  const section = S.validSection(req.body.section); if (!section) throw S.bad('اختر القسم');
  const { id } = run('INSERT INTO projects(section,name,description) VALUES(?,?,?)', section, name, S.str(req.body.description));
  S.audit('project', id, req.user.id, 'created'); events.broadcastChange({ project: id });
  return get('SELECT * FROM projects WHERE id=?', id);
}));
app.patch('/api/projects/:id', wrap(req => {
  S.require_(req.user, 'projects.manage');
  const p = get('SELECT * FROM projects WHERE id=?', Number(req.params.id)); if (!p) throw S.notFound();
  const b = req.body;
  run('UPDATE projects SET name=?, description=?, status=? WHERE id=?', S.str(b.name, 200) || p.name, b.description !== undefined ? S.str(b.description) : p.description, ['active', 'paused', 'done'].includes(b.status) ? b.status : p.status, p.id);
  S.audit('project', p.id, req.user.id, 'updated'); events.broadcastChange({ project: p.id });
  return get('SELECT * FROM projects WHERE id=?', p.id);
}));

// ===== الاجتماعات والقرارات =====
function decisionRow(d, t = D.todayStr()) {
  const st = d.task_status || d.status;
  return { ...d, effective_status: st, status_label: D.STATUSES[st] || ({ pending: 'لم يبدأ' })[st] || st, is_overdue: !['done', 'cancelled'].includes(st) && d.due_date && d.due_date < t };
}
app.get('/api/meetings', wrap(req => {
  S.require_(req.user, 'meetings.view');
  return all(`SELECT m.*, (SELECT COUNT(*) FROM decisions d WHERE d.meeting_id=m.id) AS decisions_count FROM meetings m ORDER BY m.starts_at DESC LIMIT 200`)
    .map(m => ({ ...m, section_name: m.section ? D.sectionName(m.section) : null }));
}));
app.get('/api/decisions', wrap(req => {
  S.require_(req.user, 'meetings.view');
  return all(`SELECT d.*, m.title AS meeting_title, m.section AS meeting_section, m.starts_at, i.status AS task_status, i.ref AS task_ref FROM decisions d JOIN meetings m ON m.id=d.meeting_id LEFT JOIN items i ON i.id=d.task_id ORDER BY COALESCE(d.due_date,'9999')`).map(d => decisionRow(d));
}));
app.get('/api/meetings/:id', wrap(req => {
  S.require_(req.user, 'meetings.view');
  const m = get('SELECT * FROM meetings WHERE id=?', Number(req.params.id)); if (!m) throw S.notFound();
  m.decisions = all('SELECT d.*, m.section AS meeting_section, i.status AS task_status, i.ref AS task_ref FROM decisions d JOIN meetings m ON m.id=d.meeting_id LEFT JOIN items i ON i.id=d.task_id WHERE d.meeting_id=? ORDER BY d.id', m.id).map(d => decisionRow(d));
  m.files = all('SELECT id,original_name,mime,size FROM files WHERE meeting_id=?', m.id);
  m.section_name = m.section ? D.sectionName(m.section) : null;
  return m;
}));
function meetingFields(b, m = {}) {
  const title = S.str(b.title, 300) ?? m.title; if (!title) throw S.bad('عنوان الاجتماع مطلوب');
  const starts = b.starts_at !== undefined ? String(b.starts_at) : m.starts_at; if (!starts || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(starts)) throw S.bad('موعد الاجتماع مطلوب');
  return [title, b.section !== undefined ? S.validSection(b.section) : m.section, starts, b.location !== undefined ? S.str(b.location, 300) : m.location,
    b.participants !== undefined ? S.str(b.participants, 2000) : m.participants, b.topics !== undefined ? S.str(b.topics) : m.topics,
    b.minutes !== undefined ? S.str(b.minutes, 20000) : m.minutes, ['scheduled', 'held', 'cancelled'].includes(b.status) ? b.status : (m.status || 'scheduled')];
}
app.post('/api/meetings', wrap(req => {
  S.require_(req.user, 'meetings.manage');
  const { id } = run('INSERT INTO meetings(title,section,starts_at,location,participants,topics,minutes,status,created_by) VALUES(?,?,?,?,?,?,?,?,?)', ...meetingFields(req.body), req.user.id);
  for (const f of (req.body.file_ids || []).map(Number)) run('UPDATE files SET meeting_id=? WHERE id=? AND uploader_id=? AND meeting_id IS NULL', id, f, req.user.id);
  S.audit('meeting', id, req.user.id, 'created'); events.broadcastChange({ meeting: id });
  return { id };
}));
app.patch('/api/meetings/:id', wrap(req => {
  S.require_(req.user, 'meetings.manage');
  const m = get('SELECT * FROM meetings WHERE id=?', Number(req.params.id)); if (!m) throw S.notFound();
  run('UPDATE meetings SET title=?,section=?,starts_at=?,location=?,participants=?,topics=?,minutes=?,status=?,updated_at=? WHERE id=?', ...meetingFields(req.body, m), nowIso(), m.id);
  for (const f of (req.body.file_ids || []).map(Number)) run('UPDATE files SET meeting_id=? WHERE id=? AND uploader_id=? AND meeting_id IS NULL', m.id, f, req.user.id);
  S.audit('meeting', m.id, req.user.id, 'updated'); events.broadcastChange({ meeting: m.id });
  return { id: m.id };
}));
app.post('/api/meetings/:id/decisions', wrap(req => {
  S.require_(req.user, 'meetings.manage');
  const m = get('SELECT * FROM meetings WHERE id=?', Number(req.params.id)); if (!m) throw S.notFound();
  const text = S.str(req.body.text, 2000); if (!text) throw S.bad('نص القرار مطلوب');
  if (req.body.to_task && !S.validSection(req.body.section || m.section)) throw S.bad('اختر قسم المهمة');
  const { id } = run('INSERT INTO decisions(meeting_id,text,responsible,due_date) VALUES(?,?,?,?)', m.id, text, S.str(req.body.responsible, 200), S.validDate(req.body.due_date));
  S.audit('decision', id, req.user.id, 'created'); events.broadcastChange({ meeting: m.id });
  if (req.body.to_task) S.decisionToTask(req.user, id, req.body);
  return { id };
}));
app.patch('/api/decisions/:id', wrap(req => {
  S.require_(req.user, 'meetings.manage');
  const d = get('SELECT * FROM decisions WHERE id=?', Number(req.params.id)); if (!d) throw S.notFound();
  if (d.task_id && req.body.status) throw S.bad('حالة هذا القرار تتبع المهمة المرتبطة به');
  run('UPDATE decisions SET text=?, responsible=?, due_date=?, status=? WHERE id=?', S.str(req.body.text, 2000) || d.text,
    req.body.responsible !== undefined ? S.str(req.body.responsible, 200) : d.responsible, req.body.due_date !== undefined ? S.validDate(req.body.due_date) : d.due_date,
    ['pending', 'in_progress', 'done', 'cancelled'].includes(req.body.status) ? req.body.status : d.status, d.id);
  S.audit('decision', d.id, req.user.id, 'updated'); events.broadcastChange({ meeting: d.meeting_id });
}));
app.post('/api/decisions/:id/task', wrap(req => S.decisionToTask(req.user, Number(req.params.id), req.body)));

// ===== الإجراءات التشغيلية =====
app.get('/api/sops', wrap(req => { S.require_(req.user, 'sops.view'); return all('SELECT * FROM sops ORDER BY name').map(s => ({ ...s, section_name: s.section ? D.sectionName(s.section) : null })); }));
app.get('/api/sops/:id', wrap(req => {
  S.require_(req.user, 'sops.view');
  const s = get('SELECT * FROM sops WHERE id=?', Number(req.params.id)); if (!s) throw S.notFound();
  s.files = all('SELECT id,original_name,mime,size FROM files WHERE sop_id=?', s.id);
  s.tasks = all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE sop_id=? ORDER BY id DESC LIMIT 50`, s.id).map(i => D.decorate(i));
  return s;
}));
function sopSave(req, existing) {
  S.require_(req.user, 'sops.manage');
  const b = req.body; const name = S.str(b.name, 300) || (existing && existing.name); if (!name) throw S.bad('اسم الإجراء مطلوب');
  const vals = [name, S.str(b.purpose, 3000), S.str(b.steps, 20000), S.str(b.responsible, 200), S.validSection(b.section), S.validDate(b.approved_at)];
  let id;
  if (existing) { run('UPDATE sops SET name=?,purpose=?,steps=?,responsible=?,section=?,approved_at=?,updated_at=? WHERE id=?', ...vals, nowIso(), existing.id); id = existing.id; }
  else id = run('INSERT INTO sops(name,purpose,steps,responsible,section,approved_at) VALUES(?,?,?,?,?,?)', ...vals).id;
  for (const f of (b.file_ids || []).map(Number)) run('UPDATE files SET sop_id=? WHERE id=? AND uploader_id=? AND sop_id IS NULL', id, f, req.user.id);
  S.audit('sop', id, req.user.id, existing ? 'updated' : 'created'); events.broadcastChange({ sop: id });
  return { id };
}
app.post('/api/sops', wrap(req => sopSave(req)));
app.patch('/api/sops/:id', wrap(req => { const s = get('SELECT * FROM sops WHERE id=?', Number(req.params.id)); if (!s) throw S.notFound(); return sopSave(req, s); }));

// ===== العلاقات والشراكات (بيانات التواصل محمية بصلاحية contacts.view) =====
function partnerOut(p, user) {
  const t = D.todayStr();
  const out = { ...p, followup_due: p.next_followup && p.next_followup <= t };
  if (!D.can(user, 'contacts.view')) { delete out.phone; delete out.email; delete out.contact_notes; out.contacts_hidden = true; }
  return out;
}
app.get('/api/partners', wrap(req => { S.require_(req.user, 'partners.view'); return all(`SELECT * FROM partners ORDER BY awaiting_reply DESC, COALESCE(next_followup,'9999'), name`).map(p => partnerOut(p, req.user)); }));
app.get('/api/partners/:id', wrap(req => {
  S.require_(req.user, 'partners.view');
  const p = get('SELECT * FROM partners WHERE id=?', Number(req.params.id)); if (!p) throw S.notFound();
  const out = partnerOut(p, req.user);
  out.tasks = all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE partner_id=? ORDER BY id DESC`, p.id).map(i => D.decorate(i));
  return out;
}));
function partnerSave(req, ex) {
  S.require_(req.user, 'partners.manage');
  const b = req.body; const name = S.str(b.name, 300) || (ex && ex.name); if (!name) throw S.bad('الاسم مطلوب');
  const vals = [name, b.entity_type === 'person' ? 'person' : 'org', S.str(b.relation_type, 200), S.str(b.phone, 50), S.str(b.email, 200), S.str(b.contact_notes, 2000),
    S.validDate(b.last_contact_at), S.str(b.commitments, 5000), S.validDate(b.next_followup), S.str(b.opportunities, 5000), b.awaiting_reply ? 1 : 0];
  let id;
  if (ex) { run('UPDATE partners SET name=?,entity_type=?,relation_type=?,phone=?,email=?,contact_notes=?,last_contact_at=?,commitments=?,next_followup=?,opportunities=?,awaiting_reply=?,updated_at=? WHERE id=?', ...vals, nowIso(), ex.id); id = ex.id; }
  else id = run('INSERT INTO partners(name,entity_type,relation_type,phone,email,contact_notes,last_contact_at,commitments,next_followup,opportunities,awaiting_reply) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...vals).id;
  S.audit('partner', id, req.user.id, ex ? 'updated' : 'created'); events.broadcastChange({ partner: id });
  return { id };
}
app.post('/api/partners', wrap(req => partnerSave(req)));
app.patch('/api/partners/:id', wrap(req => { const p = get('SELECT * FROM partners WHERE id=?', Number(req.params.id)); if (!p) throw S.notFound(); return partnerSave(req, p); }));

// ===== التقارير =====
app.get('/api/reports', wrap(req => { S.require_(req.user, 'reports.view'); return D.report(['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week'); }));
app.get('/api/reports/export.csv', (req, res) => {
  if (!D.can(req.user, 'reports.view')) return res.status(403).end();
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week';
  const r = D.report(period);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    ['التقرير', `من ${r.from} إلى ${r.to}`], [],
    ['المؤشر', 'القيمة'], ['التكليفات المستلمة', r.received], ['الملاحظات والطلبات', r.notes_received], ['المهام المكتملة', r.completed], ['المهام المتأخرة حاليًا', r.overdue_now],
    ['المهام المفتوحة حاليًا', r.open_now], ['قرارات/اعتمادات صدرت', r.decisions_made], ['قرارات اجتماعات منفذة', r.meeting_decisions_done], ['قرارات اجتماعات تنتظر التنفيذ', r.meeting_decisions_pending],
    ['متوسط مدة الإنجاز (يوم)', r.avg_completion_days ?? 'بيانات غير كافية'], [],
    ['القسم', 'مفتوحة', 'مكتملة في الفترة', 'متأخرة'], ...r.by_section.map(s => [s.name, s.open, s.completed, s.overdue]), [],
    ['المهام المكتملة', 'الرقم المرجعي', 'القسم', 'تاريخ الإكمال'], ...r.completed_items.map(i => [i.title, i.ref, i.section_name, i.completed_at]),
  ].map(row => row.map(q).join(',')).join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="report-${period}-${r.to}.csv"` });
  res.send('﻿' + lines);
});

app.get('/api/users', wrap(() => all('SELECT id,name,role FROM users WHERE active=1')));
app.post('/api/backup', wrap(req => { S.require_(req.user, 'item.manage'); return { file: path.basename(backup('manual')) }; }));
app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));

// ===== الملفات الثابتة =====
app.use('/fonts', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource', 'ibm-plex-sans-arabic'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); } }));

// ===== المهام المجدولة: تذكير المواعيد، التأخر، الملخص اليومي، النسخ الاحتياطي =====
function scheduler() {
  try {
    const t = D.todayStr(); const tomorrow = D.addDays(t, 1);
    const due = all(`SELECT * FROM items WHERE kind IN ${D.TASK_KINDS} AND ${D.OPEN} AND due_date IN (?,?)`, t, tomorrow);
    for (const i of due) {
      N.notifyRole('manager', { type: 'deadline_soon', title: `${i.due_date === t ? 'مستحقة اليوم' : 'مستحقة غدًا'}: ${i.title}`, body: `${i.ref} — ${D.sectionName(i.section)}`, link: `#/item/${i.id}`, urgent: i.priority === 'urgent', dedupe: `due:${i.id}:${i.due_date}:${i.due_date === t ? 'today' : 'tomorrow'}` });
    }
    const overdue = all(`SELECT * FROM items WHERE kind IN ${D.TASK_KINDS} AND ${D.OPEN} AND due_date<?`, t);
    for (const i of overdue) {
      const p = { type: 'overdue', title: `مهمة متأخرة: ${i.title}`, body: `${i.ref} — كان موعدها ${i.due_date}`, link: `#/item/${i.id}`, urgent: i.priority !== 'normal', dedupe: `overdue:${i.id}:${i.due_date}` };
      N.notifyRole('manager', p);
      if (i.source === 'owner' && i.priority !== 'normal') N.notify(i.created_by, p);
    }
    // ملخص يومي بعد السابعة صباحًا بتوقيت المنصة
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: D.TZ, hour: '2-digit', hour12: false }).format(new Date()));
    if (hour >= 7) {
      const h = { today: D.todayRibbon().length, urgent: D.urgentRibbon().length, overdue: overdue.length, approvals: get("SELECT COUNT(*) c FROM approvals WHERE status='pending'").c };
      const body = `مهام اليوم: ${h.today} • عاجلة: ${h.urgent} • متأخرة: ${h.overdue} • بانتظار قرار: ${h.approvals}`;
      for (const u of all('SELECT id FROM users WHERE active=1')) N.notify(u.id, { type: 'digest', title: `الملخص اليومي ${t}`, body, link: '#/', dedupe: `digest:${t}` });
      const lastBackup = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter(f => f.startsWith('office-auto-')).sort().pop();
      if (!lastBackup || !lastBackup.includes(new Date().toISOString().slice(0, 10))) backup('auto');
    }
    run('DELETE FROM sessions WHERE expires_at<?', nowIso());
  } catch (e) { console.error('scheduler', e); }
}

if (require.main === module) {
  const creds = ensureUsers();
  if (creds) console.log('\n' + creds);
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => console.log(`المنصة تعمل على http://localhost:${PORT}`));
  setTimeout(scheduler, 3000);
  setInterval(scheduler, 5 * 60 * 1000).unref();
}

module.exports = { app, scheduler };
