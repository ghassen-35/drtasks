'use strict';
// واجهة API — تعمل بلا تغيير على Node (Hono + node-server) وعلى Cloudflare (Worker/Durable Object)
const { Hono } = require('hono');
const { get, all, run, tx, nowIso } = require('./db');
const cfg = require('./config');
const D = require('./domain');
const S = require('./services');
const N = require('./notify');
const events = require('./events');
const whatsapp = require('./whatsapp');
const push = require('./push');
const auth = require('./auth');

const MAX_FILE = 10 * 1024 * 1024; // 10MB لكل ملف
const MAX_UPLOAD = 25 * 1024 * 1024; // لكل طلب رفع

/**
 * P — واجهة النظام المضيف:
 *   realtime: 'sse' | 'ws'      clientIp(c)      blobs.{put,get}      handleEvents(c, user) (SSE فقط)
 *   backup?(label) → اسم الملف   (Node فقط)
 */
function createApp(P) {
  const app = new Hono();

  // ===== ترويسات الأمان =====
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'same-origin');
    c.res.headers.set('X-Frame-Options', 'DENY');
    if (!c.res.headers.has('Content-Security-Policy')) c.res.headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  });

  // ===== الجلسات =====
  const COOKIE = 'sid';
  const SESSION_DAYS = 30;
  const parseCookies = (h = '') => Object.fromEntries(h.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  async function userFromCookie(cookieHeader) {
    const tok = parseCookies(cookieHeader)[COOKIE];
    if (!tok) return null;
    const s = get('SELECT * FROM sessions WHERE token_hash=?', await auth.sha256hex(tok));
    if (!s || s.expires_at < new Date().toISOString()) return null;
    return get(`SELECT id,username,name,${D.roleSql()} AS role,email,prefs,grants,title,must_change_password FROM users WHERE id=? AND active=1`, s.user_id) || null;
  }

  app.use('/api/*', async (c, next) => {
    cfg.runtime.origin = new URL(c.req.url).origin;
    // حماية CSRF: كل طلب معدِّل يجب أن يحمل ترويسة مخصصة لا يمكن لموقع آخر إرسالها
    if (!['GET', 'HEAD'].includes(c.req.method) && c.req.header('X-Requested-With') !== 'fetch') return c.json({ error: 'طلب غير مسموح' }, 403);
    const user = await userFromCookie(c.req.header('cookie'));
    c.set('user', user);
    const p = new URL(c.req.url).pathname;
    if (!user && !['/api/login', '/api/health'].includes(p)) return c.json({ error: 'يلزم تسجيل الدخول' }, 401);
    if (user && user.must_change_password && !['/api/me', '/api/password', '/api/logout', '/api/meta'].includes(p)) return c.json({ error: 'غيّر كلمة المرور أولًا', must_change_password: true }, 403);
    await next();
  });

  app.onError((e, c) => {
    if (!(e instanceof S.AppError)) console.error(e);
    return c.json({ error: e.status ? e.message : 'حدث خطأ غير متوقع' }, e.status || 500);
  });

  // غلاف يعطي المسارات شكل (req, res) البسيط: req.user/body/query/params/ip/header
  async function readBody(c) {
    if (['GET', 'HEAD', 'DELETE'].includes(c.req.method)) return {};
    if (!(c.req.header('content-type') || '').includes('json')) return {};
    const txt = await c.req.text();
    if (txt.length > 1024 * 1024) throw new S.AppError(413, 'الطلب كبير جدًا');
    try { return JSON.parse(txt || '{}'); } catch { throw new S.AppError(400, 'بيانات غير صالحة'); }
  }
  const wrap = (fn) => async (c) => {
    const body = await readBody(c); if (body && typeof body === 'object') delete body.is_demo; // علامة البيانات التجريبية لا تُقبل من الطلبات
    const req = { user: c.get('user'), params: c.req.param(), query: c.req.query(), body, ip: P.clientIp(c), secure: secure(c), header: (n) => c.req.header(n) };
    const res = { setHeader: (k, v) => c.header(k, v, { append: true }) };
    const r = await fn(req, res);
    if (r instanceof Response) return r;
    return c.json(r ?? { ok: true });
  };

  // حدّان للمحاولات الفاشلة خلال ربع ساعة: لكل (عنوان IP + مستخدم)، ولكل مستخدم مهما تغيّر العنوان
  const attempts = new Map();
  const WINDOW = 15 * 60000;
  const LIMITS = { ip: 10, user: 30 };
  const hit = (key) => { const a = attempts.get(key); return !a || Date.now() - a.t > WINDOW ? 0 : a.n; };
  const fail1 = (key) => {
    if (attempts.size > 5000) for (const [k, a] of attempts) if (Date.now() - a.t > WINDOW) attempts.delete(k);
    const a = attempts.get(key); if (!a || Date.now() - a.t > WINDOW) attempts.set(key, { n: 1, t: Date.now() }); else a.n++;
  };
  const secure = (c) => new URL(c.req.url).protocol === 'https:' || cfg.flag('COOKIE_SECURE') || c.req.header('x-forwarded-proto') === 'https';

  app.post('/api/login', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase().slice(0, 100);
    const ipKey = `ip:${req.ip}|${username}`; const userKey = `user:${username}`;
    if (hit(ipKey) >= LIMITS.ip || hit(userKey) >= LIMITS.user) throw new S.AppError(429, 'محاولات كثيرة، حاول بعد ربع ساعة');
    const u = get('SELECT * FROM users WHERE username=? AND active=1', username);
    if (!u || !(await auth.verifyPassword(String(req.body.password || ''), u.password_hash))) { fail1(ipKey); fail1(userKey); throw new S.AppError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة'); }
    attempts.delete(ipKey);
    const tok = auth.randomToken(32);
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', await auth.sha256hex(tok), u.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
    res.setHeader('Set-Cookie', `${COOKIE}=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
    return { ok: true };
  }));
  // req.secure يضبطه الغلاف الخارجي أدناه
  app.post('/api/logout', wrap(async (req, res) => {
    const tok = parseCookies(req.header('cookie'))[COOKIE];
    if (tok) run('DELETE FROM sessions WHERE token_hash=?', await auth.sha256hex(tok));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  }));
  app.get('/api/health', (c) => c.json({ ok: true, app_name: cfg.get('APP_NAME', 'مكتب عبدالله عبدالعزيز التويجري') }));

  app.get('/api/me', wrap(req => {
    const u = { ...req.user }; delete u.prefs;
    u.perms = [...D.effectivePerms(req.user)];
    if (u.role === 'member') u.grants = D.parseGrants(u.grants); else delete u.grants;
    u.role_label = (u.role === 'member' && u.title) || D.ROLE_LABELS[u.role];
    u.unread = get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL', u.id).c;
    if (D.can(u, 'item.view')) { // أعداد عامة للمالك والمدير فقط
      u.pending_decisions = get("SELECT COUNT(*) c FROM approvals WHERE status='pending'").c;
      u.inbox_pending = get("SELECT COUNT(*) c FROM items WHERE kind IN ('assignment','note') AND status!='cancelled' AND (acknowledged_at IS NULL OR kind='assignment' OR status NOT IN ('done','cancelled'))").c;
    } else { u.pending_decisions = 0; u.inbox_pending = 0; }
    return u;
  }));
  app.post('/api/password', wrap(async req => {
    const u = get('SELECT * FROM users WHERE id=?', req.user.id);
    const key = `pw:${u.id}`;
    if (hit(key) >= LIMITS.ip) throw new S.AppError(429, 'محاولات كثيرة، حاول بعد ربع ساعة');
    if (!(await auth.verifyPassword(String(req.body.current || ''), u.password_hash))) { fail1(key); throw S.bad('كلمة المرور الحالية غير صحيحة'); }
    attempts.delete(key);
    const pw = String(req.body.next || '');
    if (pw.length < 8) throw S.bad('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
    if (pw === String(req.body.current || '')) throw S.bad('اختر كلمة مرور جديدة مختلفة عن الحالية');
    run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', await auth.hashPassword(pw), u.id);
    run('DELETE FROM sessions WHERE user_id=? AND token_hash!=?', u.id, await auth.sha256hex(parseCookies(req.header('cookie'))[COOKIE] || '')); // تسجيل الخروج من الأجهزة الأخرى
    return { ok: true };
  }));

  app.get('/api/meta', wrap(async req => ({
    sections: D.SECTIONS, statuses: D.STATUSES, priorities: D.PRIORITIES, msg_types: D.MSG_TYPES, categories: D.CATEGORIES,
    owner_title: D.ownerTitle(), channels: D.CHANNELS, importance: D.IMPORTANCE, approval_kinds: D.APPROVAL_KINDS, recurrences: D.RECURRENCES, project_kinds: D.PROJECT_KINDS, grantable: D.GRANTABLE, scopes: D.SCOPES, grant_presets: D.GRANT_PRESETS, notif_types: N.TYPES, vapid: await push.vapidPublicKey(), realtime: P.realtime, file_backup: !!P.backup, today: D.todayStr(), tz: D.TZ,
    email: N.emailStatus(), whatsapp: { enabled: whatsapp.enabled(), configured: whatsapp.configured() },
    users: all(`SELECT id,name,${D.roleSql()} AS role,title FROM users WHERE active=1 ORDER BY member, id`), app_name: cfg.get('APP_NAME', 'مكتب عبدالله عبدالعزيز التويجري'),
  })));

  // ===== الصفحة الرئيسية: الأشرطة والمربعات والملخصات =====
  app.get('/api/home', wrap(req => {
    const t = D.todayStr();
    if (!D.can(req.user, 'item.view') || req.user.role === 'member') { // موظف: ما يخصه فقط، ومربعات الأقسام الممنوحة له
      const sc = S.scopeFor(req.user);
      const pids = S.memberProjects(req.user.id);
      const secs = D.can(req.user, 'folders.view') ? (S.allowedSections(req.user) || D.SECTION_KEYS) : [];
      return {
        member: true, tiles: secs.map(k => { const t = D.sectionStats(k); delete t.unacknowledged; return t; }), today: t, today_ribbon: D.todayRibbon(sc), urgent_ribbon: D.urgentRibbon(sc),
        my_items: listItems({ kind: 'tasks', scope: 'open' }, req.user),
        projects: pids.length ? all(`SELECT p.*, (SELECT name FROM folders f WHERE f.id=p.folder_id) AS folder_name FROM projects p WHERE p.id IN (${pids.map(() => '?').join(',')}) ORDER BY p.name`, ...pids).map(p => ({ ...p, section_name: D.sectionName(p.section) })) : [],
      };
    }
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
      WHERE u.role='manager' AND u.member=0 AND (m.kind IN ('update','result','message') OR (m.kind IN ('system','decision') AND m.meta IS NOT NULL)) ORDER BY m.id DESC LIMIT 8`);
    out.achievements = all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE kind IN ${D.TASK_KINDS} AND status='done' ORDER BY completed_at DESC LIMIT 5`).map(i => D.decorate(i, t));
    out.meetings = all(`SELECT * FROM meetings WHERE status='scheduled' AND starts_at>=? ORDER BY starts_at LIMIT 5`, t);
    return out;
  }));

  // ===== المهام والتكليفات =====
  function listItems(q, user) {
    const t = D.todayStr();
    const sc = S.scopeFor(user); // يرمي 403 لمن لا يملك رؤية
    const where = ['1=1' + sc.sql]; const p = [...sc.params];
    if (q.folder_id) { where.push('(i.folder_id=? OR i.project_id IN (SELECT id FROM projects WHERE folder_id=?))'); p.push(Number(q.folder_id), Number(q.folder_id)); }
    if (q.kind === 'tasks' || !q.kind) where.push(`i.kind IN ${D.TASK_KINDS}`);
    else if (q.kind === 'inbox') where.push("i.kind IN ('assignment','note')");
    else if (q.kind === 'mine') { where.push("i.source='owner' AND i.created_by=?"); p.push(user.id); }
    else if (q.kind !== 'all') { where.push('i.kind=?'); p.push(q.kind); }
    if (q.section) { where.push('i.section=?'); p.push(q.section); }
    if (q.status) { where.push('i.status=?'); p.push(q.status); }
    if (q.priority) { where.push('i.priority=?'); p.push(q.priority); }
    if (q.project_id) { where.push('i.project_id=?'); p.push(Number(q.project_id)); }
    if (q.category) { where.push('i.category=?'); p.push(q.category); }
    if (q.assignee_id) { where.push('i.assignee_id=?'); p.push(Number(q.assignee_id)); }
    if (q.assignee && !q.assignee_id) { where.push('i.assignee_id IS NULL AND i.assignee=?'); p.push(String(q.assignee).slice(0, 200)); }
    if (q.directive_id) { where.push('i.directive_id=?'); p.push(Number(q.directive_id)); }
    if (q.done_since && /^\d{4}-\d{2}-\d{2}$/.test(q.done_since)) { where.push("i.status='done' AND i.completed_at>=?"); p.push(new Date(q.done_since + 'T00:00:00+03:00').toISOString()); }
    if (q.scope === 'open') where.push(`i.${D.OPEN}`);
    if (q.scope === 'overdue') { where.push(`i.${D.OPEN} AND i.due_date<?`); p.push(t); }
    if (q.scope === 'today') { where.push(`i.${D.OPEN} AND i.due_date=?`); p.push(t); }
    if (q.scope === 'closed') where.push("i.status IN ('done','cancelled')");
    // instr بدل LIKE: في Durable Object يُرفض نمط LIKE الطويل (حد صغير بالبايت، والحرف العربي بايتان)
    if (q.q) { where.push('(' + ['i.title', 'i.description', 'i.ref', 'i.assignee'].map(c => `instr(lower(${c}), lower(?)) > 0`).join(' OR ') + ')'); const s = String(q.q).slice(0, 100); p.push(s, s, s, s); }
    return all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN i.status IN ('done','cancelled') THEN 1 ELSE 0 END, CASE i.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, COALESCE(i.due_date,'9999'), i.id DESC LIMIT ${Math.min(Number(q.limit) || 500, 5000)}`, ...p)
      .map(i => D.decorate(i, t))
      // المهام الفرعية تظهر تحت أمها (مع عداد التقدم) لا كبنود مستقلة — إلا في البحث ومهام اليوم والمتأخرة، أو إن كانت الأم لا تُرى
      .filter(i => !i.parent_task_id || q.q || q.subtasks === '1' || ['today', 'overdue'].includes(q.scope) || !S.canSee(user, { id: i.parent_task_id }));
  }
  app.get('/api/items', wrap(req => listItems(req.query, req.user)));

  function attachFiles(user, itemId, ids) {
    for (const f of (ids || []).map(Number).filter(Boolean)) run('UPDATE files SET item_id=? WHERE id=? AND uploader_id=? AND item_id IS NULL AND message_id IS NULL AND approval_id IS NULL', itemId, f, user.id);
  }
  app.post('/api/assignments', wrap(req => { const it = S.createAssignment(req.user, req.body); attachFiles(req.user, it.id, req.body.file_ids); return it; }));
  app.post('/api/notes', wrap(req => { const it = S.createNote(req.user, req.body); attachFiles(req.user, it.id, req.body.file_ids); return it; }));
  app.post('/api/tasks', wrap(req => { const it = S.createTask(req.user, req.body); attachFiles(req.user, it.id, req.body.file_ids); return it; }));

  app.get('/api/items/:id', wrap(req => {
    const it = S.getItem(Number(req.params.id));
    S.assertCanSee(req.user, it);
    // فتح المهمة يعني الاطلاع على إشعاراتها
    run('UPDATE notifications SET read_at=? WHERE user_id=? AND link=? AND read_at IS NULL', nowIso(), req.user.id, `#/item/${it.id}`);
    const th = S.thread(it.id);
    const extra = {};
    if (it.parent_id) extra.parent = get('SELECT id,ref,title FROM items WHERE id=?', it.parent_id);
    if (it.meeting_id) extra.meeting = get('SELECT id,title,starts_at FROM meetings WHERE id=?', it.meeting_id);
    if (it.sop_id) extra.sop = get('SELECT id,name FROM sops WHERE id=?', it.sop_id);
    if (it.partner_id && D.can(req.user, 'partners.view')) extra.partner = get('SELECT id,name FROM partners WHERE id=?', it.partner_id);
    if (it.meeting_id && !D.can(req.user, 'meetings.view')) delete extra.meeting;
    if (req.user.role === 'member') { th.notes = []; delete extra.parent; it.original_text = null; } // ملاحظات رجل الأعمال ونصه الأصلي لمدير المكتب فقط
    extra.subtasks = S.subtasksOf(it.id).filter(x => S.canSee(req.user, x));
    if (it.parent_task_id) { const pt = get('SELECT id,ref,title FROM items WHERE id=?', it.parent_task_id); if (pt && S.canSee(req.user, pt)) extra.parent_task = pt; }
    return { item: it, ...th, ...extra };
  }));
  app.post('/api/items/:id/subtasks', wrap(req => S.createSubtask(req.user, Number(req.params.id), req.body)));
  app.post('/api/items/:id/apply-sop', wrap(req => S.applySop(req.user, Number(req.params.id))));
  app.post('/api/items/:id/ack', wrap(req => S.acknowledge(req.user, Number(req.params.id))));
  app.post('/api/items/:id/convert', wrap(req => S.convertToTask(req.user, Number(req.params.id), req.body)));
  app.patch('/api/items/:id', wrap(req => S.updateItem(req.user, Number(req.params.id), req.body)));
  app.post('/api/items/:id/close', wrap(req => S.closeItem(req.user, Number(req.params.id))));
  app.post('/api/items/:id/messages', wrap(req => ({ id: S.addMessage(req.user, Number(req.params.id), req.body, req.body.file_ids || []) })));
  app.post('/api/items/:id/approvals', wrap(req => ({ id: S.requestApproval(req.user, Number(req.params.id), req.body, req.body.file_ids || []) })));
  app.post('/api/approvals/:id/decide', wrap(req => S.decide(req.user, Number(req.params.id), req.body)));
  app.post('/api/approvals/:id/withdraw', wrap(req => S.withdrawApproval(req.user, Number(req.params.id))));
  app.get('/api/approvals', wrap(req => {
    if (!D.can(req.user, 'approval.decide') && !D.can(req.user, 'approval.request')) throw S.forbidden();
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
        { key: 'urgent', title: 'المهام العاجلة', tone: 'red', items: D.urgentRibbon() },
        { key: 'today', title: 'مهام اليوم', tone: 'orange', items: D.todayRibbon() },
        { key: 'overdue', title: 'المهام المتأخرة', tone: 'red', items: q(`${TK} AND i.due_date<?`, t) },
        { key: 'unack', title: 'تكليفات جديدة غير مؤكدة الاستلام', tone: 'orange', items: q("i.kind IN ('assignment','note') AND i.acknowledged_at IS NULL AND i.status!='cancelled'") },
        { key: 'not_started', title: 'مهام لم يبدأ تنفيذها', tone: 'gray', items: q(`${TK} AND i.status IN ('new','acknowledged')`) },
        { key: 'waiting_info', title: 'تنتظر معلومات من ' + D.ownerTitle() + '', tone: 'gray', items: q(`${TK} AND i.status='waiting_info'`) },
        { key: 'waiting_approval', title: 'تنتظر اعتماد ' + D.ownerTitle() + '', tone: 'gray', items: q(`${TK} AND i.status='waiting_approval'`) },
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
      req.user.id, String(s.endpoint), JSON.stringify({ p256dh: s.keys.p256dh, auth: s.keys.auth }), String(req.header('user-agent') || '').slice(0, 200));
  }));
  app.post('/api/push/unsubscribe', wrap(req => { run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?', String(req.body.endpoint || ''), req.user.id); }));
  app.post('/api/notify/test', wrap(req => {
    N.notify(req.user.id, { type: 'status_change', title: 'إشعار تجريبي', body: 'هذا إشعار اختبار من صفحة الإعدادات', link: '#/settings' });
  }));

  // SSE
  // ===== المشاريع =====
  app.get('/api/projects', wrap(req => {
    let rows;
    if (D.can(req.user, 'item.view') || (req.user.role === 'member' && S.allowedSections(req.user) === null)) {
      const w = []; const p = [];
      if (req.query.section) { w.push('section=?'); p.push(req.query.section); }
      if (req.query.folder_id) { w.push('folder_id=?'); p.push(Number(req.query.folder_id)); }
      rows = all(`SELECT * FROM projects ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY section, status, name`, ...p);
    } else if (D.can(req.user, 'item.view_scoped')) {
      // مشاريعه + مشاريع الأقسام الممنوحة له
      const secs = S.allowedSections(req.user) || [];
      const extra = []; const ep = [];
      if (req.query.section) { extra.push('p.section=?'); ep.push(req.query.section); }
      if (req.query.folder_id) { extra.push('p.folder_id=?'); ep.push(Number(req.query.folder_id)); }
      rows = all(`SELECT p.* FROM projects p WHERE (p.id IN (SELECT project_id FROM project_members WHERE user_id=?)${secs.length ? ` OR p.section IN (${secs.map(() => '?').join(',')})` : ''})${extra.length ? ' AND ' + extra.join(' AND ') : ''} ORDER BY p.name`, req.user.id, ...secs, ...ep);
    } else throw S.forbidden();
    return rows.map(p => ({ ...p, open_tasks: get(`SELECT COUNT(*) c FROM items WHERE project_id=? AND kind IN ${D.TASK_KINDS} AND ${D.OPEN}`, p.id).c,
      folder_name: p.folder_id ? (get('SELECT name FROM folders WHERE id=?', p.folder_id) || {}).name : null,
      members: D.can(req.user, 'users.manage') ? all('SELECT u.id,u.name FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?', p.id) : undefined }));
  }));
  function validFolder(folderId, section) {
    if (!folderId) return null;
    const f = get('SELECT * FROM folders WHERE id=?', Number(folderId)); if (!f) throw S.bad('المجلد غير موجود');
    if (f.section !== section) throw S.bad('المجلد يتبع قسمًا آخر');
    return f.id;
  }
  app.post('/api/projects', wrap(req => {
    S.require_(req.user, 'projects.manage');
    const name = S.str(req.body.name, 200); if (!name) throw S.bad(req.body.kind === 'initiative' ? 'اسم المبادرة مطلوب' : 'اسم المشروع مطلوب');
    const section = S.validSection(req.body.section); if (!section) throw S.bad('اختر القسم');
    S.assertSectionAllowed(req.user, section);
    const kind = D.PROJECT_KINDS[req.body.kind] ? req.body.kind : 'project';
    const { id } = run('INSERT INTO projects(section,name,description,folder_id,kind) VALUES(?,?,?,?,?)', section, name, S.str(req.body.description), validFolder(req.body.folder_id, section), kind);
    S.audit('project', id, req.user.id, 'created'); events.broadcastChange({ project: id });
    return get('SELECT * FROM projects WHERE id=?', id);
  }));
  app.patch('/api/projects/:id', wrap(req => {
    S.require_(req.user, 'projects.manage');
    const p = get('SELECT * FROM projects WHERE id=?', Number(req.params.id)); if (!p) throw S.notFound();
    S.assertSectionAllowed(req.user, p.section);
    const b = req.body;
    if (D.PROJECT_KINDS[b.kind] && b.kind !== p.kind) run('UPDATE projects SET kind=? WHERE id=?', b.kind, p.id);
    run('UPDATE projects SET name=?, description=?, status=?, folder_id=? WHERE id=?', S.str(b.name, 200) || p.name, b.description !== undefined ? S.str(b.description) : p.description, ['active', 'paused', 'done'].includes(b.status) ? b.status : p.status,
      b.folder_id !== undefined ? validFolder(b.folder_id, p.section) : p.folder_id, p.id);
    S.audit('project', p.id, req.user.id, 'updated'); events.broadcastChange({ project: p.id });
    return get('SELECT * FROM projects WHERE id=?', p.id);
  }));

  // ===== الاجتماعات والقرارات =====
  function decisionRow(d, t = D.todayStr(), user = null) {
    // من لا يرى المهمة المرتبطة لا يرى رقمها ولا حالتها
    if (user && d.task_id && !S.canSee(user, { id: d.task_id })) { d = { ...d, task_ref: null, task_status: null, task_hidden: 1 }; }
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
    return all(`SELECT d.*, m.title AS meeting_title, m.section AS meeting_section, m.starts_at, i.status AS task_status, i.ref AS task_ref FROM decisions d JOIN meetings m ON m.id=d.meeting_id LEFT JOIN items i ON i.id=d.task_id ORDER BY COALESCE(d.due_date,'9999')`).map(d => decisionRow(d, undefined, req.user));
  }));
  app.get('/api/meetings/:id', wrap(req => {
    S.require_(req.user, 'meetings.view');
    const m = get('SELECT * FROM meetings WHERE id=?', Number(req.params.id)); if (!m) throw S.notFound();
    m.decisions = all('SELECT d.*, m.section AS meeting_section, i.status AS task_status, i.ref AS task_ref FROM decisions d JOIN meetings m ON m.id=d.meeting_id LEFT JOIN items i ON i.id=d.task_id WHERE d.meeting_id=? ORDER BY d.id', m.id).map(d => decisionRow(d, undefined, req.user));
    m.files = all('SELECT id,original_name,mime,size FROM files WHERE meeting_id=?', m.id);
    m.section_name = m.section ? D.sectionName(m.section) : null;
    return m;
  }));
  function meetingFields(b, m = {}) {
    const title = S.str(b.title, 300) ?? m.title; if (!title) throw S.bad('عنوان الاجتماع مطلوب');
    const starts = b.starts_at !== undefined ? String(b.starts_at) : m.starts_at; if (!starts || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(starts)) throw S.bad('موعد الاجتماع مطلوب');
    return [title, b.section !== undefined ? S.validSection(b.section) : m.section, starts, b.location !== undefined ? S.str(b.location, 300) : m.location,
      b.participants !== undefined ? S.str(b.participants, 2000) : m.participants, b.topics !== undefined ? S.str(b.topics) : m.topics,
      b.minutes !== undefined ? S.str(b.minutes, 20000) : m.minutes, ['scheduled', 'held', 'cancelled'].includes(b.status) ? b.status : (m.status || 'scheduled')]
      .map(v => (v === undefined ? null : v)); // حقل غير مُرسل = فارغ (SQLite يرفض undefined)
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
  // قرارات متعددة دفعة واحدة (سطر لكل قرار)، ويمكن تحويلها كلها إلى مهام
  app.post('/api/meetings/:id/decisions/bulk', wrap(req => {
    S.require_(req.user, 'meetings.manage');
    const m = get('SELECT * FROM meetings WHERE id=?', Number(req.params.id)); if (!m) throw S.notFound();
    const lines = String(req.body.text || '').split('\n').map(x => x.trim().replace(/^[-•*\d.)]+\s*/, '')).filter(Boolean).slice(0, 30);
    if (!lines.length) throw S.bad('اكتب قرارًا واحدًا على الأقل (سطر لكل قرار)');
    const section = S.validSection(req.body.section || m.section);
    if (req.body.to_task && !section) throw S.bad('اختر قسم المهام');
    const ids = [];
    tx(() => {
      for (const text of lines) {
        const { id } = run('INSERT INTO decisions(meeting_id,text,responsible,due_date) VALUES(?,?,?,?)', m.id, text.slice(0, 2000), S.str(req.body.responsible, 200), S.validDate(req.body.due_date));
        S.audit('decision', id, req.user.id, 'created'); ids.push(id);
        if (req.body.to_task) S.decisionToTask(req.user, id, { section, assignee_id: req.body.assignee_id || undefined, due_date: req.body.due_date || undefined });
      }
    });
    events.broadcastChange({ meeting: m.id });
    return { created: ids.length };
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
    const sc = S.scopeFor(req.user);
    s.tasks = all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE sop_id=?${sc.sql} ORDER BY id DESC LIMIT 50`, s.id, ...sc.params).map(i => D.decorate(i));
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
    const sc = S.scopeFor(req.user);
    out.tasks = all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE partner_id=?${sc.sql} ORDER BY id DESC`, p.id, ...sc.params).map(i => D.decorate(i));
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

  // ===== المجلدات: القسم ← المجلد ← المشاريع والمهام =====
  // مسار المجلد من الأعلى إلى الأسفل (للتنقل والقوائم)
  function folderPath(id) {
    const path = [];
    for (let f = get('SELECT id,name,parent_id FROM folders WHERE id=?', id), n = 0; f && n < 20; f = f.parent_id ? get('SELECT id,name,parent_id FROM folders WHERE id=?', f.parent_id) : null, n++) path.unshift({ id: f.id, name: f.name });
    return path;
  }
  const folderCounts = (f) => ({
    ...f, section_name: D.sectionName(f.section),
    subfolders: get('SELECT COUNT(*) c FROM folders WHERE parent_id=?', f.id).c,
    projects: get('SELECT COUNT(*) c FROM projects WHERE folder_id=?', f.id).c,
    open_tasks: get(`SELECT COUNT(*) c FROM items i WHERE i.kind IN ${D.TASK_KINDS} AND i.${D.OPEN} AND (i.folder_id=? OR i.project_id IN (SELECT id FROM projects WHERE folder_id=?))`, f.id, f.id).c,
  });
  app.get('/api/folders', wrap(req => {
    S.require_(req.user, 'folders.view');
    const rows = req.query.section ? all('SELECT * FROM folders WHERE section=? ORDER BY name', req.query.section) : all('SELECT * FROM folders ORDER BY section, name');
    const secs = S.allowedSections(req.user);
    return rows.filter(f => !secs || secs.includes(f.section)).map(folderCounts);
  }));
  app.get('/api/folders/:id', wrap(req => {
    S.require_(req.user, 'folders.view');
    const f = get('SELECT * FROM folders WHERE id=?', Number(req.params.id)); if (!f) throw S.notFound('المجلد غير موجود');
    const secs = S.allowedSections(req.user); if (secs && !secs.includes(f.section)) throw S.notFound('المجلد غير موجود');
    return { ...folderCounts(f), path: folderPath(f.id), children: all('SELECT * FROM folders WHERE parent_id=? ORDER BY name', f.id).map(folderCounts) };
  }));
  app.post('/api/folders', wrap(req => {
    S.require_(req.user, 'projects.manage');
    const name = S.str(req.body.name, 200); if (!name) throw S.bad('اسم المجلد مطلوب');
    let section = S.validSection(req.body.section); let parentId = null;
    if (req.body.parent_id) { // مجلد فرعي: يرث قسم المجلد الأب
      const parent = get('SELECT * FROM folders WHERE id=?', Number(req.body.parent_id)); if (!parent) throw S.bad('المجلد الأب غير موجود');
      if (section && section !== parent.section) throw S.bad('المجلد الأب يتبع قسمًا آخر');
      if (folderPath(parent.id).length >= 8) throw S.bad('لا يمكن إنشاء أكثر من 8 مستويات من المجلدات');
      section = parent.section; parentId = parent.id;
    }
    if (!section) throw S.bad('اختر القسم');
    S.assertSectionAllowed(req.user, section);
    if (get('SELECT id FROM folders WHERE section=? AND parent_id IS ? AND name=?', section, parentId, name)) throw S.bad('يوجد مجلد بالاسم نفسه في هذا المكان');
    const { id } = run('INSERT INTO folders(section,name,description,parent_id) VALUES(?,?,?,?)', section, name, S.str(req.body.description, 1000), parentId);
    S.audit('folder', id, req.user.id, 'created'); events.broadcastChange({ folder: id });
    return folderCounts(get('SELECT * FROM folders WHERE id=?', id));
  }));
  app.patch('/api/folders/:id', wrap(req => {
    S.require_(req.user, 'projects.manage');
    const f = get('SELECT * FROM folders WHERE id=?', Number(req.params.id)); if (!f) throw S.notFound('المجلد غير موجود');
    S.assertSectionAllowed(req.user, f.section);
    run('UPDATE folders SET name=?, description=? WHERE id=?', S.str(req.body.name, 200) || f.name, req.body.description !== undefined ? S.str(req.body.description, 1000) : f.description, f.id);
    S.audit('folder', f.id, req.user.id, 'updated'); events.broadcastChange({ folder: f.id });
    return folderCounts(get('SELECT * FROM folders WHERE id=?', f.id));
  }));

  // ===== لوحة القيادة: صورة المكتب كاملة، وكل رقم يفتح تفاصيله =====
  app.get('/api/command', wrap(req => {
    if (!(D.can(req.user, 'item.view') && req.user.role !== 'member')) throw S.forbidden();
    const t = D.todayStr(); const c = (sql, ...p) => get(sql, ...p).c;
    const weekStart = D.addDays(t, -6), monthStart = D.addDays(t, -29), prevFrom = D.addDays(t, -59), prevTo = D.addDays(t, -30);
    const iso = (d) => new Date(d + 'T00:00:00+03:00').toISOString();
    const TK = `kind IN ${D.TASK_KINDS}`;
    const month = D.onTimeStats(monthStart, t), prev = D.onTimeStats(prevFrom, prevTo);
    const rep = D.report('week');
    const regDirectives = all("SELECT * FROM directives WHERE status='open'").map(d => S.directiveRow(d, req.user));
    const decisionsOpen = c(`SELECT COUNT(*) c FROM decisions d LEFT JOIN items i ON i.id=d.task_id WHERE COALESCE(i.status,d.status) NOT IN ('done','cancelled')`);
    return {
      today: t, week_start: weekStart, month_start: monthStart,
      kpis: {
        open: c(`SELECT COUNT(*) c FROM items WHERE ${TK} AND ${D.OPEN}`),
        done_week: c(`SELECT COUNT(*) c FROM items WHERE ${TK} AND status='done' AND completed_at>=?`, iso(weekStart)),
        done_month: c(`SELECT COUNT(*) c FROM items WHERE ${TK} AND status='done' AND completed_at>=?`, iso(monthStart)),
        overdue: c(`SELECT COUNT(*) c FROM items WHERE ${TK} AND ${D.OPEN} AND due_date<?`, t),
        urgent: c(`SELECT COUNT(*) c FROM items WHERE ${TK} AND ${D.OPEN} AND priority='urgent'`),
        stalled: c(`SELECT COUNT(*) c FROM items WHERE ${TK} AND status='stalled'`),
        awaiting_approval: c("SELECT COUNT(*) c FROM approvals WHERE status='pending'"),
        meetings_week: c("SELECT COUNT(*) c FROM meetings WHERE status='scheduled' AND substr(starts_at,1,10) BETWEEN ? AND ?", t, D.addDays(t, 7)),
        directives_open: regDirectives.length, directives_at_risk: regDirectives.filter(d => d.state === 'at_risk' || d.is_overdue).length,
        decisions_open: decisionsOpen,
        on_time_rate: month.rate, on_time_total: month.total, on_time_prev: prev.rate,
      },
      attention: D.needsAttention(),
      approvals: all(`SELECT a.id, a.title, a.kind, a.blocking, a.requested_at, i.id AS item_id, i.ref, i.title AS item_title FROM approvals a JOIN items i ON i.id=a.item_id WHERE a.status='pending' ORDER BY a.blocking DESC, a.id LIMIT 20`)
        .map(a => ({ ...a, kind_label: D.APPROVAL_KINDS[a.kind] })),
      directives: regDirectives.filter(d => d.state !== 'ready').slice(0, 8), directives_ready: regDirectives.filter(d => d.state === 'ready'),
      meetings: all("SELECT * FROM meetings WHERE status='scheduled' AND substr(starts_at,1,10)>=? ORDER BY starts_at LIMIT 5", t),
      workload: rep.by_person,
    };
  }));

  // ===== سجل التوجيهات والقرارات =====
  app.get('/api/directives', wrap(req => {
    S.require_(req.user, 'directives.view');
    const w = []; const p = [];
    if (req.query.status && ['open', 'done', 'cancelled'].includes(req.query.status)) { w.push('status=?'); p.push(req.query.status); }
    if (req.query.q) { w.push('(instr(lower(title), lower(?))>0 OR instr(lower(COALESCE(details,"")), lower(?))>0 OR instr(ref, ?)>0)'); const q = String(req.query.q).slice(0, 100); p.push(q, q, q); }
    return all(`SELECT * FROM directives ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, CASE importance WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, COALESCE(due_date,'9999'), id DESC LIMIT 300`, ...p)
      .map(d => S.directiveRow(d, req.user));
  }));
  app.get('/api/directives/:id', wrap(req => {
    S.require_(req.user, 'directives.view');
    const d = get('SELECT * FROM directives WHERE id=?', Number(req.params.id)); if (!d) throw S.notFound('التوجيه غير موجود');
    const sc = S.scopeFor(req.user);
    const out = S.directiveRow(d, req.user);
    out.tasks = all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE i.directive_id=?${sc.sql} ORDER BY i.id`, d.id, ...sc.params).map(i => D.decorate(i));
    out.created_by_name = (get('SELECT name FROM users WHERE id=?', d.created_by) || {}).name;
    out.log = all("SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE entity='directive' AND entity_id=? ORDER BY a.id", d.id);
    return out;
  }));
  app.post('/api/directives', wrap(req => S.createDirective(req.user, req.body)));
  app.patch('/api/directives/:id', wrap(req => S.updateDirective(req.user, Number(req.params.id), req.body)));
  // ما لم يتحول بعد إلى نتيجة: التوجيهات المفتوحة وقرارات الاجتماعات غير المنفذة
  app.get('/api/register', wrap(req => {
    S.require_(req.user, 'directives.view');
    const t = D.todayStr();
    const directives = all("SELECT * FROM directives WHERE status='open' ORDER BY COALESCE(due_date,'9999')").map(d => S.directiveRow(d, req.user));
    const decisions = D.can(req.user, 'meetings.view') ? all(`SELECT d.*, m.title AS meeting_title, m.starts_at, i.status AS task_status, i.ref AS task_ref, i.due_date AS task_due
        FROM decisions d JOIN meetings m ON m.id=d.meeting_id LEFT JOIN items i ON i.id=d.task_id
        WHERE COALESCE(i.status, d.status) NOT IN ('done','cancelled') ORDER BY COALESCE(COALESCE(i.due_date, d.due_date),'9999')`)
      .map(d => ({ ...d, task_ref: d.task_id && S.canSee(req.user, { id: d.task_id }) ? d.task_ref : null, is_overdue: !!(d.task_due || d.due_date) && (d.task_due || d.due_date) < t, unassigned: !d.task_id })) : [];
    return { directives, decisions };
  }));

  // ===== إدارة المستخدمين (حسابات الفريق) =====
  app.get('/api/admin/users', wrap(req => S.listUsers(req.user)));
  app.post('/api/admin/users', wrap(req => S.createUser(req.user, req.body)));
  app.patch('/api/admin/users/:id', wrap(req => S.updateUser(req.user, Number(req.params.id), req.body)));

  // ===== التقارير =====
  app.get('/api/reports', wrap(req => { S.require_(req.user, 'reports.view'); return D.report(['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week'); }));
  app.get('/api/users', wrap(() => all(`SELECT id,name,${D.roleSql()} AS role FROM users WHERE active=1 ORDER BY member, id`)));

  // ===== الأحداث الفورية =====
  app.get('/api/events', (c) => (P.realtime === 'sse' ? P.handleEvents(c, c.get('user')) : c.json({ error: 'استخدم /api/ws' }, 404)));

  // ===== الملفات =====
  app.post('/api/files', async (c) => {
    const user = c.get('user');
    if (Number(c.req.header('content-length') || 0) > MAX_UPLOAD) throw new S.AppError(413, 'حجم الرفع أكبر من 25MB');
    const form = await c.req.formData();
    const files = form.getAll('files').filter(f => typeof f === 'object' && f && 'arrayBuffer' in f).slice(0, 10);
    const voice = form.get('voice') === '1';
    const out = [];
    for (const f of files) {
      if (f.size > MAX_FILE) throw new S.AppError(413, `الملف «${f.name}» أكبر من 10MB`);
      const stored = auth.randomToken(16);
      await P.blobs.put(stored, new Uint8Array(await f.arrayBuffer()));
      const name = String(f.name || 'file').slice(0, 200);
      const { id } = run('INSERT INTO files(uploader_id,original_name,stored_name,mime,size,is_voice) VALUES(?,?,?,?,?,?)', user.id, name, stored, f.type || 'application/octet-stream', f.size, voice ? 1 : 0);
      out.push({ id, original_name: name, mime: f.type, size: f.size, is_voice: voice });
    }
    return c.json(out);
  });
  const INLINE = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/(mp4|webm)|application\/pdf)/;
  // أرشيف الملفات: كل ما يحق للمستخدم رؤيته، مع العنصر الذي ينتمي إليه، وبحث بالاسم
  app.get('/api/files', wrap(req => {
    const u = req.user; const q = String(req.query.q || '').slice(0, 100);
    const rows = all(`SELECT f.id,f.original_name,f.mime,f.size,f.is_voice,f.created_at,f.item_id,f.meeting_id,f.sop_id,f.uploader_id,
        i.ref AS item_ref, i.title AS item_title, i.section AS item_section, m.title AS meeting_title, s.name AS sop_name, us.name AS uploader_name
      FROM files f LEFT JOIN items i ON i.id=f.item_id LEFT JOIN meetings m ON m.id=f.meeting_id LEFT JOIN sops s ON s.id=f.sop_id LEFT JOIN users us ON us.id=f.uploader_id
      WHERE f.is_voice=0 AND (f.item_id IS NOT NULL OR f.meeting_id IS NOT NULL OR f.sop_id IS NOT NULL)${q ? ' AND (instr(lower(f.original_name), lower(?))>0 OR instr(lower(COALESCE(i.title,"")), lower(?))>0 OR instr(lower(COALESCE(m.title,"")), lower(?))>0)' : ''}
      ORDER BY f.id DESC LIMIT 400`, ...(q ? [q, q, q] : []));
    return rows.filter(f => (f.item_id && S.canSee(u, { id: f.item_id })) || (f.meeting_id && D.can(u, 'meetings.view')) || (f.sop_id && D.can(u, 'sops.view')))
      .map(f => ({ ...f, section_name: f.item_section ? D.sectionName(f.item_section) : null })).slice(0, 200);
  }));
  app.get('/api/files/:id', async (c) => {
    const user = c.get('user');
    const f = get('SELECT * FROM files WHERE id=?', Number(c.req.param('id')));
    // الملفات متاحة للمستخدمين المصرح لهم فقط (مرفوعة بواسطتهم أو مرتبطة بعنصر يمكنهم الاطلاع عليه)
    if (!f || !(f.uploader_id === user.id || (f.item_id && S.canSee(user, { id: f.item_id })) || (f.sop_id && D.can(user, 'sops.view')) || (f.meeting_id && D.can(user, 'meetings.view')))) return c.json({ error: 'غير موجود' }, 404);
    const bytes = await P.blobs.get(f.stored_name);
    if (!bytes) return c.json({ error: 'الملف غير متوفر' }, 404);
    const inline = INLINE.test(f.mime || '');
    const headers = {
      'Content-Type': inline ? f.mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
      'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes',
    };
    // دعم Range ضروري لتشغيل الصوت في Safari
    const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : bytes.length - Number(m[2]); let end = m[1] && m[2] ? Number(m[2]) : bytes.length - 1;
      start = Math.max(0, start); end = Math.min(end, bytes.length - 1);
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) } });
    }
    return new Response(bytes, { headers: { ...headers, 'Content-Length': String(bytes.length) } });
  });

  // ===== التقارير: تصدير CSV =====
  // تصدير قائمة المهام كما تظهر للمستخدم (نفس الفلاتر ونفس نطاق الصلاحيات) — يفتح في Excel
  const localTs = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Intl.DateTimeFormat('en-CA', { timeZone: D.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', ''); };
  app.get('/api/items-export.csv', (c) => {
    const user = c.get('user');
    if (!D.can(user, 'item.view') && !D.can(user, 'item.view_scoped')) return c.body(null, 403);
    const rows = listItems({ kind: 'tasks', ...c.req.query(), subtasks: '1', limit: 5000 }, user);
    const q = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return `"${x.replace(/"/g, '""')}"`; }; // منع حقن الصيغ في Excel
    const head = ['الرقم المرجعي', 'العنوان', 'النوع', 'القسم', 'المجلد', 'المشروع/المبادرة', 'المسؤول', 'الحالة', 'الأولوية', 'الموعد النهائي', 'الوقت', 'متأخرة', 'مهمة فرعية من', 'تكرار', 'آخر تحديث', 'تاريخ الإنجاز'];
    const lines = [head, ...rows.map(i => [i.ref, i.title, i.kind === 'assignment' ? 'تكليف' : 'مهمة', i.section_name, i.folder_name, i.project_name, i.assignee, D.STATUSES[i.status], D.PRIORITIES[i.priority],
      i.due_date, i.due_time, i.is_overdue ? 'نعم' : '', i.parent_task_title, i.recurrence ? D.RECURRENCES[i.recurrence] : '', localTs(i.updated_at), localTs(i.completed_at)])].map(r => r.map(q).join(',')).join('\r\n');
    return c.body('\uFEFF' + lines, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tasks-${D.todayStr()}.csv"` });
  });
  app.get('/api/reports/export.csv', (c) => {
    if (!D.can(c.get('user'), 'reports.view')) return c.body(null, 403);
    const period = ['day', 'week', 'month'].includes(c.req.query('period')) ? c.req.query('period') : 'week';
    const r = D.report(period);
    const q = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return `"${x.replace(/"/g, '""')}"`; };
    const lines = [
      ['التقرير', `من ${r.from} إلى ${r.to}`], [],
      ['المؤشر', 'القيمة'], ['التكليفات المستلمة', r.received], ['الملاحظات والطلبات', r.notes_received], ['المهام المكتملة', r.completed], ['المهام المتأخرة حاليًا', r.overdue_now],
      ['المهام المفتوحة حاليًا', r.open_now], ['قرارات/اعتمادات صدرت', r.decisions_made], ['قرارات اجتماعات منفذة', r.meeting_decisions_done], ['قرارات اجتماعات تنتظر التنفيذ', r.meeting_decisions_pending],
      ['متوسط مدة الإنجاز (يوم)', r.avg_completion_days ?? 'بيانات غير كافية'], [],
      ['القسم', 'مفتوحة', 'مكتملة في الفترة', 'متأخرة'], ...r.by_section.map(s => [s.name, s.open, s.completed, s.overdue]), [],
      ['المهام المكتملة', 'الرقم المرجعي', 'القسم', 'تاريخ الإكمال'], ...r.completed_items.map(i => [i.title, i.ref, i.section_name, localTs(i.completed_at)]),
    ].map(row => row.map(q).join(',')).join('\r\n');
    return c.body('\uFEFF' + lines, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="report-${period}-${r.to}.csv"` });
  });

  // ===== نسخة احتياطية =====
  app.post('/api/backup', wrap((req) => {
    S.require_(req.user, 'item.manage');
    if (!P.backup) throw S.bad('النسخ الاحتياطي بملف غير متاح في هذه الاستضافة؛ استخدم «تصدير البيانات (JSON)»');
    return { file: P.backup('manual') };
  }));
  // تصدير كل البيانات (بدون كلمات المرور والجلسات ومفاتيح الإشعارات ومحتوى الملفات) للحفظ والاطلاع
  app.get('/api/export.json', (c) => {
    S.require_(c.get('user'), 'item.manage');
    const tables = ['items', 'messages', 'approvals', 'files', 'audit_log', 'projects', 'meetings', 'decisions', 'sops', 'partners', 'notifications'];
    const data = { exported_at: new Date().toISOString(), note: 'نسخة للأرشفة: لا تتضمن كلمات المرور ولا محتوى الملفات المرفوعة (أسماؤها فقط)' };
    data.users = all(`SELECT id,username,name,${D.roleSql()} AS role,email,active,created_at FROM users`);
    data.folders = all('SELECT * FROM folders'); data.project_members = all('SELECT * FROM project_members');
    for (const t of tables) data[t] = all(`SELECT * FROM ${t}`).map(r => { if (t === 'files') delete r.stored_name; return r; });
    return c.body(JSON.stringify(data, null, 1), 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="office-export-${D.todayStr()}.json"` });
  });

  app.all('/api/*', (c) => c.json({ error: 'غير موجود' }, 404));
  app.authenticate = userFromCookie; // للـ WebSocket على Cloudflare
  return app;
}

module.exports = { createApp };
