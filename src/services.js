'use strict';
// منطق سير العمل: التكليفات، الاستلام، التحويل، الحالات، الرسائل، الاعتمادات — مع سجل التغييرات والإشعارات
const { get, all, run, tx, nowIso, nextRef } = require('./db');
const D = require('./domain');
const { notify, notifyRole } = require('./notify');
const events = require('./events');

class AppError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new AppError(400, m);
const forbidden = (m = 'ليست لديك صلاحية لهذا الإجراء') => new AppError(403, m);
const notFound = (m = 'العنصر غير موجود') => new AppError(404, m);
function require_(user, perm) { if (!D.can(user, perm)) throw forbidden(); }

function audit(entity, id, userId, action, field = null, oldV = null, newV = null) {
  run('INSERT INTO audit_log(entity,entity_id,user_id,action,field,old_value,new_value) VALUES(?,?,?,?,?,?,?)',
    entity, id, userId, action, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV));
}
function sysMsg(itemId, userId, body, meta = null, kind = 'system') {
  return run('INSERT INTO messages(item_id,author_id,kind,body,meta) VALUES(?,?,?,?,?)', itemId, userId, kind, body, meta ? JSON.stringify(meta) : null).id;
}
function touch(itemId, userId) { run('UPDATE items SET updated_at=?, updated_by=? WHERE id=?', nowIso(), userId, itemId); }
const link = (id) => `#/item/${id}`;
const otherRole = (user) => (user.role === 'owner' ? 'manager' : 'owner');

function getItem(id) {
  const it = get(`SELECT ${D.ITEM_LIST_COLS}, (SELECT p.section FROM projects p WHERE p.id=i.project_id) AS project_section, i.description, i.original_text, i.meeting_id, i.decision_id, i.sop_id, i.partner_id, i.acknowledged_by, i.started_at, i.updated_by
    FROM items i WHERE i.id=?`, id);
  if (!it) throw notFound();
  return D.decorate(it);
}

function validSection(s) { if (s && !D.SECTION_KEYS.includes(s)) throw bad('قسم غير صالح'); return s || null; }
function validPriority(p) { if (p && !D.PRIORITIES[p]) throw bad('أولوية غير صالحة'); return p || 'normal'; }
function validDate(d) { if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('تاريخ غير صالح'); return d || null; }
function validTime(t) { if (t && !/^\d{2}:\d{2}$/.test(t)) throw bad('وقت غير صالح'); return t || null; }
function str(v, max = 5000) { return v == null ? null : String(v).trim().slice(0, max) || null; }
function validRecurrence(r) { if (r && !D.RECURRENCES[r]) throw bad('تكرار غير صالح'); return r || null; }
// الموعد التالي للمهمة الدورية (الشهري يثبت على آخر يوم في الشهر عند الحاجة: 31 يناير ← 28/29 فبراير)
function advanceDate(d, r) {
  const x = new Date(d + 'T12:00:00Z'); const day = x.getUTCDate();
  if (r === 'daily') x.setUTCDate(day + 1);
  else if (r === 'weekly') x.setUTCDate(day + 7);
  else {
    x.setUTCDate(1); r === 'monthly' ? x.setUTCMonth(x.getUTCMonth() + 1) : x.setUTCFullYear(x.getUTCFullYear() + 1);
    const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
    x.setUTCDate(Math.min(day, last));
  }
  return x.toISOString().slice(0, 10);
}

// ===== رؤية المهام: المالك والمدير يريان الكل؛ عضو الفريق يرى المهام المسندة إليه أو في مشاريعه فقط =====
function scopeFor(user) {
  if (user.role !== 'member' && D.can(user, 'item.view')) return { sql: '', params: [] };
  if (D.can(user, 'item.view_scoped')) {
    const g = D.parseGrants(user.grants);
    const own = "(i.kind='task' AND (i.assignee_id=? OR i.project_id IN (SELECT project_id FROM project_members WHERE user_id=?)))";
    // كل المكتب: المهام والتكليفات كلها، دون ملاحظات رجل الأعمال الخاصة
    if (g.scope === 'all') return { sql: ` AND i.kind IN ${D.TASK_KINDS}`, params: [] };
    if (!g.sections.length) return { sql: ` AND ${own}`, params: [user.id, user.id] };
    // رؤية الأقسام: كل المهام والتكليفات في الأقسام الممنوحة (لا الملاحظات)
    return { sql: ` AND (${own} OR (i.kind IN ${D.TASK_KINDS} AND i.section IN (${g.sections.map(() => '?').join(',')})))`, params: [user.id, user.id, ...g.sections] };
  }
  throw forbidden();
}
function canSee(user, it) {
  if (user.role !== 'member' && D.can(user, 'item.view')) return true;
  if (!D.can(user, 'item.view_scoped')) return false;
  const sc = scopeFor(user);
  return !!get(`SELECT 1 AS x FROM items i WHERE i.id=?${sc.sql}`, it.id, ...sc.params);
}
// الأقسام المسموحة للموظف (null = كل الأقسام)
function allowedSections(user) {
  if (user.role !== 'member') return null;
  const g = D.parseGrants(user.grants);
  return g.scope === 'all' ? null : g.sections;
}
function assertSectionAllowed(user, section) {
  const secs = allowedSections(user);
  if (secs && !secs.includes(section)) throw forbidden('هذا القسم خارج صلاحياتك');
}
function assertCanSee(user, it) { if (!canSee(user, it)) throw notFound(); } // 404 لا 403: لا نكشف وجود المهمة
const memberProjects = (userId) => all('SELECT project_id FROM project_members WHERE user_id=?', userId).map(r => r.project_id);

// إشعار عضو الفريق المسند إليه (إن وُجد وكان غير صاحب الإجراء)
function notifyAssignee(it, actor, payload) {
  if (!it.assignee_id || it.assignee_id === actor.id) return;
  const u = get('SELECT id, member FROM users WHERE id=? AND active=1', it.assignee_id);
  if (u && u.member) notify(u.id, payload);
}

function validProject(projectId, section) {
  if (!projectId) return null;
  const p = get('SELECT id,section FROM projects WHERE id=?', Number(projectId));
  if (!p) throw bad('المشروع غير موجود');
  if (section && p.section !== section) throw bad('المشروع أو المبادرة تتبع قسمًا آخر');
  return p.id;
}

// المجلد والمسؤول (مستخدم في المنصة): يُتحقق منهما ثم يُحدَّثان مع سجل التغييرات
function applyOrg(user, id, b) {
  const it = get('SELECT id,ref,title,section,project_id,folder_id,assignee_id,assignee,parent_task_id,due_date,priority FROM items WHERE id=?', id);
  let folder = b.folder_id !== undefined ? (b.folder_id ? Number(b.folder_id) : null) : it.folder_id;
  if (b.folder_id === undefined && b.project_id && it.project_id) { const p = get('SELECT folder_id FROM projects WHERE id=?', it.project_id); if (p && p.folder_id) folder = p.folder_id; }
  if (folder) {
    const f = get('SELECT section FROM folders WHERE id=?', folder);
    if (!f) throw bad('المجلد غير موجود');
    if (f.section !== it.section) { if (b.folder_id) throw bad('المجلد يتبع قسمًا آخر'); folder = null; }
  }
  let assigneeId = it.assignee_id; let assignee = it.assignee;
  if (b.assignee_id !== undefined) {
    assigneeId = b.assignee_id ? Number(b.assignee_id) : null;
    if (assigneeId) {
      const u = get('SELECT id,name FROM users WHERE id=? AND active=1', assigneeId);
      if (!u) throw bad('المستخدم المسند إليه غير موجود');
      assignee = u.name;
    }
  }
  const changes = [['folder_id', it.folder_id, folder], ['assignee_id', it.assignee_id, assigneeId], ['assignee', it.assignee, assignee]].filter(([, o, n]) => String(o ?? '') !== String(n ?? ''));
  if (!changes.length) return;
  run('UPDATE items SET folder_id=?, assignee_id=?, assignee=? WHERE id=?', folder, assigneeId, assignee, id);
  for (const [k, o, n] of changes) audit('item', id, user.id, 'updated', k, o, n);
  if (assigneeId && assigneeId !== it.assignee_id) {
    // مهمة فرعية لنفس مسؤول الأم: إشعار الأم يكفي (لا سيل إشعارات)
    const parent = it.parent_task_id ? get('SELECT id,assignee_id FROM items WHERE id=?', it.parent_task_id) : null;
    if (!(parent && parent.assignee_id === assigneeId)) {
      const bits = [`من ${user.name}`, it.due_date ? `الموعد ${it.due_date}` : null, it.priority !== 'normal' ? D.PRIORITIES[it.priority] : null].filter(Boolean);
      notifyAssignee({ ...it, assignee_id: assigneeId }, user, { type: 'status_change', title: `أُسندت إليك ${it.parent_task_id ? 'مهمة فرعية' : 'مهمة'}: ${it.title}`, body: `${bits.join(' • ')} — ${it.ref}`, link: link(parent ? parent.id : id), urgent: it.priority === 'urgent' });
    }
  }
}

// ===== 1) رجل الأعمال يرسل تكليفًا =====
function createAssignment(user, b) {
  require_(user, 'assignment.create');
  const title = str(b.title, 300); if (!title) throw bad('عنوان التكليف مطلوب');
  const section = validSection(b.section); if (!section) throw bad('اختر القسم المعني');
  return tx(() => {
    const ref = nextRef('TK');
    const description = str(b.description);
    const { id } = run(`INSERT INTO items(ref,kind,source,title,description,original_text,section,priority,due_date,due_time,status,created_by,updated_by,is_demo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, 'assignment', 'owner', title, description,
      `${title}${description ? '\n\n' + description : ''}`, section, validPriority(b.priority), validDate(b.due_date), validTime(b.due_time), 'new', user.id, user.id, b.is_demo ? 1 : 0);
    audit('item', id, user.id, 'created', 'kind', null, 'assignment');
    if (b.project_id) run('UPDATE items SET project_id=? WHERE id=?', validProject(b.project_id, section), id);
    if (b.recurrence) run('UPDATE items SET recurrence=? WHERE id=?', validRecurrence(b.recurrence), id);
    if (b.folder_id || b.project_id) applyOrg(user, id, { folder_id: b.folder_id || undefined, project_id: b.project_id });
    sysMsg(id, user.id, `أُرسل التكليف ${ref} إلى مدير المكتب`);
    const urgent = b.priority === 'urgent';
    notifyRole('manager', { type: 'new_assignment', title: `${urgent ? 'تكليف عاجل' : 'تكليف جديد'}: ${title}`, body: `${D.sectionName(section)} — ${ref}`, link: link(id), urgent });
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}

// ===== 2) ملاحظة أو طلب (لا تتحول إلى مهمة تلقائيًا) =====
function createNote(user, b) {
  require_(user, 'note.create');
  if (!D.MSG_TYPES[b.msg_type]) throw bad('اختر نوع الرسالة');
  const body = str(b.description); const title = str(b.title, 300) || (body ? body.slice(0, 80) : null);
  if (!title) throw bad('نص الملاحظة مطلوب');
  let parent = null;
  if (b.parent_id) { parent = get('SELECT id,section,title,ref FROM items WHERE id=?', b.parent_id); if (!parent) throw bad('المهمة المرتبطة غير موجودة'); }
  return tx(() => {
    const ref = nextRef('NT');
    const { id } = run(`INSERT INTO items(ref,kind,msg_type,source,title,description,original_text,section,project_id,parent_id,priority,due_date,status,created_by,updated_by,is_demo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, 'note', b.msg_type, 'owner', title, body, `${title}${body && body !== title ? '\n\n' + body : ''}`,
      validSection(b.section) || (parent && parent.section), b.project_id || null, parent ? parent.id : null, validPriority(b.priority), validDate(b.due_date), 'new', user.id, user.id, b.is_demo ? 1 : 0);
    audit('item', id, user.id, 'created', 'kind', null, 'note');
    if (parent) { touch(parent.id, user.id); }
    notifyRole('manager', {
      type: 'new_note', title: `${D.MSG_TYPES[b.msg_type]}: ${title}`, body: parent ? `مرتبطة بـ ${parent.ref} — ${parent.title}` : ref,
      link: link(parent ? parent.id : id), urgent: b.priority === 'urgent',
    });
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}

// ===== 3) مدير المكتب ينشئ مهمة مباشرة =====
function createTask(user, b, { internal = false } = {}) {
  if (!internal) require_(user, 'task.create');
  if (user.role === 'member' && !internal) {
    // حقول داخلية لا يرسلها الموظف (اجتماع، قرار، مهمة أصل، بيانات تجريبية)، والجهة لمن يطّلع على الشراكات فقط
    b = { ...b }; for (const k of ['source', 'meeting_id', 'decision_id', 'parent_task_id', 'is_demo']) delete b[k];
    if (!D.can(user, 'partners.view')) delete b.partner_id;
    delete b.requires_approval;
  }
  // الموظف: المهمة بلا مسؤول تُسند إليه حتى تبقى ضمن ما يراه
  if (user.role === 'member' && !b.assignee_id) b = { ...b, assignee_id: user.id };
  const title = str(b.title, 300); if (!title) throw bad('عنوان المهمة مطلوب');
  const section = validSection(b.section); if (!section) throw bad('اختر القسم');
  if (b.category && !D.CATEGORIES[b.category]) throw bad('تصنيف غير صالح');
  return tx(() => {
    const ref = nextRef('MH');
    const { id } = run(`INSERT INTO items(ref,kind,source,title,description,original_text,section,category,project_id,priority,due_date,due_time,status,assignee,next_step,requires_approval,sop_id,partner_id,meeting_id,decision_id,created_by,updated_by,is_demo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, 'task', b.source === 'meeting' ? 'meeting' : 'manager', title, str(b.description), str(b.description),
      section, b.category || 'general', b.project_id || null, validPriority(b.priority), validDate(b.due_date), validTime(b.due_time), 'new',
      str(b.assignee, 200) || user.name, str(b.next_step, 500), b.requires_approval ? 1 : 0, b.sop_id || null, b.partner_id || null,
      b.meeting_id || null, b.decision_id || null, user.id, user.id, b.is_demo ? 1 : 0);
    audit('item', id, user.id, 'created', 'kind', null, 'task');
    if (b.project_id) validProject(b.project_id, section);
    run('UPDATE items SET recurrence=?, parent_task_id=? WHERE id=?', validRecurrence(b.recurrence), b.parent_task_id || null, id);
    applyOrg(user, id, { folder_id: b.folder_id, assignee_id: b.assignee_id, project_id: b.project_id });
    // الموظف لا ينشئ ما لا يستطيع رؤيته (قسم خارج نطاقه أو مسند لغيره خارج مشاريعه)
    if (user.role === 'member' && !canSee(user, { id })) throw forbidden('لا يمكنك إنشاء مهمة خارج نطاق صلاحياتك (القسم أو المسؤول)');
    sysMsg(id, user.id, `أنشأ ${user.name} ${b.parent_task_id ? 'المهمة الفرعية' : 'المهمة'} ${ref}`);
    if (user.role === 'member') notifyRole('manager', { type: 'new_assignment', title: `أنشأ ${user.name} ${b.parent_task_id ? 'مهمة فرعية' : 'مهمة'}: ${title}`, body: `${D.sectionName(section)} — ${ref}`, link: link(b.parent_task_id || id) });
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}

// ===== 4) تأكيد الاستلام (منفصل عن بدء التنفيذ وعن الإنجاز) =====
function acknowledge(user, id) {
  require_(user, 'item.manage');
  const it = getItem(id);
  if (it.acknowledged_at) throw bad('تم تأكيد الاستلام مسبقًا');
  return tx(() => {
    const at = nowIso();
    run('UPDATE items SET acknowledged_at=?, acknowledged_by=?, status=CASE WHEN status=\'new\' THEN \'acknowledged\' ELSE status END, updated_at=?, updated_by=? WHERE id=?', at, user.id, at, user.id, id);
    audit('item', id, user.id, 'acknowledged', 'status', it.status, it.status === 'new' ? 'acknowledged' : it.status);
    sysMsg(id, user.id, `أكد ${user.name} استلام ${it.kind === 'note' ? 'الملاحظة' : 'التكليف'}`, { event: 'acknowledged' });
    if (it.source === 'owner') notify(it.created_by, { type: 'acknowledged', title: `تم تأكيد استلام: ${it.title}`, body: it.ref, link: link(id) });
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}

// ===== 5) تحويل التكليف/الملاحظة إلى مهمة منظمة — في نفس السجل دون تكرار =====
function convertToTask(user, id, b) {
  require_(user, 'item.manage');
  const it = getItem(id);
  if (it.kind === 'task') throw bad('العنصر مهمة بالفعل');
  if (it.status === 'cancelled') throw bad('لا يمكن تحويل عنصر ملغى');
  const section = validSection(b.section || it.section); if (!section) throw bad('اختر القسم');
  return tx(() => {
    const at = nowIso();
    run(`UPDATE items SET kind='task', converted_at=?, section=?, category=?, project_id=?, assignee=?, due_date=?, due_time=?, priority=?, next_step=?, requires_approval=?, sop_id=?, partner_id=?,
      title=?, description=?, acknowledged_at=COALESCE(acknowledged_at,?), acknowledged_by=COALESCE(acknowledged_by,?),
      status=CASE WHEN status IN ('new') THEN 'acknowledged' ELSE status END, updated_at=?, updated_by=? WHERE id=?`,
      at, section, D.CATEGORIES[b.category] ? b.category : it.category, b.project_id || it.project_id || null, str(b.assignee, 200) || user.name,
      validDate(b.due_date !== undefined ? b.due_date : it.due_date), validTime(b.due_time !== undefined ? b.due_time : it.due_time),
      validPriority(b.priority || it.priority), str(b.next_step, 500), b.requires_approval ? 1 : 0, b.sop_id || null, b.partner_id || null,
      str(b.title, 300) || it.title, str(b.description) || it.description, at, user.id, at, user.id, id);
    audit('item', id, user.id, 'converted', 'kind', it.kind, 'task');
    if (b.recurrence !== undefined) run('UPDATE items SET recurrence=? WHERE id=?', validRecurrence(b.recurrence), id);
    applyOrg(user, id, { folder_id: b.folder_id, assignee_id: b.assignee_id, project_id: b.project_id });
    sysMsg(id, user.id, `حوّل ${user.name} ${it.kind === 'note' ? 'الملاحظة' : 'التكليف'} إلى مهمة منظمة في قسم ${D.sectionName(section)} — المسؤول: ${get('SELECT assignee FROM items WHERE id=?', id).assignee || user.name}`, { event: 'converted' });
    if (it.source === 'owner') notify(it.created_by, { type: 'status_change', title: `بدأ تنظيم: ${it.title}`, body: `حُوّل إلى مهمة في ${D.sectionName(section)}`, link: link(id), collapse: `item:${id}:status` });
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}

// ===== 6) تعديل بيانات المهمة وحالتها =====
const EDITABLE = ['title', 'description', 'section', 'category', 'project_id', 'assignee', 'due_date', 'due_time', 'priority', 'next_step', 'requires_approval', 'sop_id', 'partner_id', 'recurrence'];
function updateItem(user, id, b) {
  const it = getItem(id);
  // رجل الأعمال: يعدّل بيانات أي مهمة (الموعد، الأولوية، التصنيف، المجلد، المشروع…)،
  // أما الحالة فيلغي تكليفه فقط، ويُنجز أو يعيد فتح المهام الفرعية
  if (user.role === 'owner') {
    require_(user, 'item.edit');
    if (b.status !== undefined) {
      const ok = (b.status === 'cancelled' && it.created_by === user.id && D.can(user, 'item.cancel_own'))
        || (it.parent_task_id && ['done', 'in_progress'].includes(b.status));
      if (!ok) throw forbidden();
    }
  } else if (user.role === 'member') {
    // عضو الفريق: يحدّث حالة المهام التي يراها، وضمن حالات العمل؛ وتعديل التفاصيل لمن مُنح item.edit
    require_(user, 'item.work'); assertCanSee(user, it);
    if (it.kind !== 'task') throw forbidden('التكليفات والملاحظات يعالجها مدير المكتب');
    const allowed = ['status', 'status_note', 'complete_subtasks', ...(D.can(user, 'item.edit') ? [...EDITABLE.filter(k => k !== 'requires_approval'), 'folder_id', 'assignee_id'] : [])];
    if (Object.keys(b).some(k => !allowed.includes(k))) throw forbidden('ليست لديك صلاحية تعديل هذا الحقل');
    if (b.status !== undefined && b.status !== it.status) {
      if (it.status === 'cancelled') throw forbidden('المهمة ملغاة؛ إعادة فتحها لمدير المكتب');
      if (!['in_progress', 'waiting_reply', 'stalled', 'done'].includes(b.status)) throw forbidden('لا يمكنك تعيين هذه الحالة');
    }
    if (b.section !== undefined && b.section !== it.section) assertSectionAllowed(user, b.section);
  } else require_(user, 'item.manage');
  if (it.closed_at) throw bad('المهمة مغلقة نهائيًا');
  // نقل المهمة إلى قسم آخر يفك ربطها بمشروع من القسم القديم
  const newSection = b.section !== undefined ? validSection(b.section) : it.section;
  if (b.project_id === undefined && it.project_id && newSection !== it.section && it.project_section !== newSection) b = { ...b, project_id: null };
  return tx(() => {
    const changes = [];
    for (const k of EDITABLE) {
      if (b[k] === undefined) continue;
      let v = b[k];
      if (k === 'section') v = validSection(v);
      else if (k === 'priority') v = validPriority(v);
      else if (k === 'due_date') v = validDate(v);
      else if (k === 'due_time') v = validTime(v);
      else if (k === 'requires_approval') v = v ? 1 : 0;
      else if (k === 'recurrence') v = validRecurrence(v);
      else if (k === 'category') { if (!D.CATEGORIES[v]) throw bad('تصنيف غير صالح'); }
      else if (k === 'project_id') v = validProject(v, b.section !== undefined ? validSection(b.section) : it.section);
      else if (['sop_id', 'partner_id'].includes(k)) v = v ? Number(v) : null;
      else v = str(v, k === 'description' ? 5000 : 500);
      if (k === 'title' && !v) throw bad('العنوان مطلوب');
      if (String(v ?? '') !== String(it[k] ?? '')) { changes.push([k, it[k], v]); run(`UPDATE items SET ${k}=? WHERE id=?`, v, id); }
    }
    for (const [k, o, n] of changes) audit('item', id, user.id, 'updated', k, o, n);
    if (['folder_id', 'assignee_id', 'project_id', 'section'].some(k => b[k] !== undefined)) applyOrg(user, id, b);
    if (changes.length) {
      const what = changes.map(c => FIELD_LABELS[c[0]] || c[0]).join('، ');
      sysMsg(id, user.id, `عدّل ${user.name}: ${what}`, { event: 'edited' });
      if (user.role === 'owner') notifyRole('manager', { type: 'status_change', title: `عدّل رجل الأعمال: ${it.title}`, body: `${what} — ${it.ref}`, link: link(id), collapse: `item:${id}:edit` });
    }
    if (b.status !== undefined && b.status !== it.status) setStatus(user, it, b.status, b.status_note);
    // «إنجاز الكل»: إنجاز المهام الفرعية المفتوحة مع أمها
    if (b.status === 'done' && b.complete_subtasks) {
      const open = all("SELECT * FROM items WHERE parent_task_id=? AND status NOT IN ('done','cancelled') AND closed_at IS NULL", id);
      const at = nowIso();
      for (const st of open) {
        run("UPDATE items SET status='done', completed_at=?, updated_at=?, updated_by=? WHERE id=?", at, at, user.id, st.id);
        audit('item', st.id, user.id, 'status', 'status', st.status, 'done');
        sysMsg(st.id, user.id, `أُنجزت مع المهمة الأم ${it.ref} (${user.name})`, { event: 'status', from: st.status, to: 'done' });
      }
      if (open.length) sysMsg(id, user.id, `أنجز ${user.name} ${open.length} ${open.length === 1 ? 'مهمة فرعية مفتوحة' : 'مهام فرعية مفتوحة'} مع المهمة`, { event: 'subtasks_done' });
    }
    if (changes.length || b.status !== undefined) touch(id, user.id);
    if (user.role === 'member' && !canSee(user, it)) throw forbidden('هذا التعديل يُخرج المهمة من نطاق صلاحياتك');
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}
const FIELD_LABELS = { title: 'العنوان', description: 'الوصف', section: 'القسم', category: 'التصنيف', project_id: 'المشروع', assignee: 'المسؤول', due_date: 'الموعد', due_time: 'الوقت', priority: 'الأولوية', next_step: 'الخطوة التالية', requires_approval: 'اشتراط الاعتماد', sop_id: 'الإجراء المرتبط', partner_id: 'الجهة المرتبطة', recurrence: 'التكرار' };

function hasApprovedFinal(itemId) {
  return !!get("SELECT id FROM approvals WHERE item_id=? AND kind='final' AND status='approved'", itemId);
}
function setStatus(user, it, status, note) {
  if (!D.STATUSES[status]) throw bad('حالة غير صالحة');
  if (status === 'acknowledged' && !it.acknowledged_at) throw bad('استخدم زر «تأكيد الاستلام»');
  // سياسة الإغلاق: المهمة التي تتطلب اعتمادًا لا تكتمل إلا بعد اعتماد النتيجة النهائية
  if (status === 'done' && it.requires_approval && !hasApprovedFinal(it.id)) throw bad('هذه المهمة تتطلب اعتماد رجل الأعمال للنتيجة النهائية قبل اكتمالها. استخدم «رفع النتيجة النهائية».');
  if (status === 'waiting_approval' && !get("SELECT id FROM approvals WHERE item_id=? AND status='pending'", it.id)) throw bad('استخدم «طلب اعتماد» لإرسال ما يحتاج إلى قرار');
  const at = nowIso();
  const sets = ['status=?']; const vals = [status];
  if (status === 'in_progress' && !it.started_at) { sets.push('started_at=?'); vals.push(at); }
  if (status === 'done') { sets.push('completed_at=?'); vals.push(at); }
  if (status !== 'done' && it.status === 'done') { sets.push('completed_at=NULL'); }
  // ضمان التسلسل: لا يُعد بدء التنفيذ استلامًا ضمنيًا دون تسجيله
  if (!it.acknowledged_at && user.role === 'manager' && status !== 'cancelled') { sets.push('acknowledged_at=?', 'acknowledged_by=?'); vals.push(at, user.id); }
  run(`UPDATE items SET ${sets.join(',')} WHERE id=?`, ...vals, it.id);
  audit('item', it.id, user.id, 'status', 'status', it.status, status);
  sysMsg(it.id, user.id, `غيّر ${user.name} الحالة من «${D.STATUSES[it.status]}» إلى «${D.STATUSES[status]}»${note ? ` — ${note}` : ''}`, { event: 'status', from: it.status, to: status });
  // إشعار الطرف الآخر
  const target = user.role === 'manager' ? it.created_by : null;
  if (user.role === 'manager' && it.source === 'owner' && target) {
    notify(target, { type: 'status_change', title: `${D.STATUSES[status]}: ${it.title}`, body: it.ref, link: link(it.id), urgent: status === 'stalled', collapse: `item:${it.id}:status` });
  } else if (user.role === 'owner') {
    notifyRole('manager', { type: 'status_change', title: status === 'cancelled' ? `ألغى رجل الأعمال: ${it.title}` : `${D.STATUSES[status]} (رجل الأعمال): ${it.title}`, body: it.ref, link: link(it.id), collapse: `item:${it.id}:status` });
  } else if (user.role === 'member') {
    notifyRole('manager', { type: 'status_change', title: `${D.STATUSES[status]}: ${it.title}`, body: `${user.name} — ${it.ref}`, link: link(it.id), urgent: status === 'stalled', collapse: `item:${it.id}:status` });
  }
  if (user.role !== 'member') notifyAssignee(it, user, { type: 'status_change', title: `${D.STATUSES[status]}: ${it.title}`, body: it.ref, link: link(it.id), collapse: `item:${it.id}:status` });
  if (status === 'done' && it.recurrence && !it.next_occurrence_id) spawnNextOccurrence(user, it);
}

// ===== المهام الدورية: إنجاز المهمة ينشئ الموعد التالي تلقائيًا (مرة واحدة فقط لكل موعد) =====
function spawnNextOccurrence(user, it) {
  const full = get('SELECT * FROM items WHERE id=?', it.id);
  const t = D.todayStr();
  let next = advanceDate(full.due_date || t, full.recurrence);
  for (let n = 0; next < t && n < 2000; n++) next = advanceDate(next, full.recurrence);
  const ref = nextRef('MH');
  const { id } = run(`INSERT INTO items(ref,kind,source,title,description,original_text,section,category,project_id,folder_id,priority,due_date,due_time,status,assignee,assignee_id,
      requires_approval,sop_id,partner_id,recurrence,acknowledged_at,acknowledged_by,created_by,updated_by,is_demo)
    VALUES(?,'task',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, full.source, full.title, full.description, full.original_text, full.section, full.category,
    full.project_id, full.folder_id, full.priority, next, full.due_time, full.acknowledged_at ? 'acknowledged' : 'new', full.assignee, full.assignee_id,
    full.requires_approval, full.sop_id, full.partner_id, full.recurrence, full.acknowledged_at ? nowIso() : null, full.acknowledged_at ? full.acknowledged_by : null,
    full.created_by, user.id, full.is_demo);
  // المهام الفرعية تتكرر معها مفتوحة من جديد
  for (const st of all("SELECT * FROM items WHERE parent_task_id=? AND status!='cancelled'", full.id)) {
    run(`INSERT INTO items(ref,kind,source,title,description,section,category,project_id,folder_id,priority,status,assignee,assignee_id,parent_task_id,created_by,updated_by,is_demo)
      VALUES(?,'task',?,?,?,?,?,?,?,?,'new',?,?,?,?,?,?)`, nextRef('MH'), st.source, st.title, st.description, st.section, st.category, st.project_id, st.folder_id, st.priority,
      st.assignee, st.assignee_id, id, st.created_by, user.id, st.is_demo);
  }
  run('UPDATE items SET next_occurrence_id=? WHERE id=?', id, full.id);
  audit('item', id, user.id, 'created', 'recurrence_of', null, full.id);
  sysMsg(id, user.id, `أُنشئت تلقائيًا (مهمة ${D.RECURRENCES[full.recurrence]}) بعد إنجاز ${full.ref}`, { event: 'recurring', from: full.id });
  sysMsg(full.id, user.id, `الموعد التالي لهذه المهمة الدورية: ${ref} بتاريخ ${next}`, { event: 'recurring', next: id });
  return id;
}

// ===== المهام الفرعية: تحت مهمة أو تكليف، وترث القسم والمجلد والمشروع =====
function createSubtask(user, parentId, b) {
  if (!['task.create', 'item.edit', 'subtask.create'].some(p => D.can(user, p))) throw forbidden();
  const parent = getItem(parentId);
  assertCanSee(user, parent);
  if (!['task', 'assignment'].includes(parent.kind)) throw bad('المهام الفرعية تُضاف تحت مهمة أو تكليف');
  if (parent.parent_task_id) throw bad('لا يمكن إضافة مهمة فرعية تحت مهمة فرعية');
  if (parent.closed_at) throw bad('المهمة مغلقة نهائيًا');
  return tx(() => {
    const st = createTask(user, {
      title: b.title, description: b.description, section: parent.section, category: parent.category, project_id: parent.project_id, folder_id: parent.folder_id,
      priority: b.priority || parent.priority, due_date: b.due_date || null, assignee_id: b.assignee_id || parent.assignee_id || undefined,
      assignee: b.assignee_id ? undefined : (parent.assignee || (user.role === 'owner' ? 'مدير المكتب' : undefined)), parent_task_id: parent.id, source: user.role === 'owner' ? 'owner' : undefined, is_demo: b.is_demo || parent.is_demo,
    }, { internal: true });
    if (user.role === 'owner') run("UPDATE items SET source='owner' WHERE id=?", st.id);
    sysMsg(parent.id, user.id, `أضاف ${user.name} مهمة فرعية: ${st.title}`, { event: 'subtask', id: st.id });
    touch(parent.id, user.id);
    if (user.role === 'owner') notifyRole('manager', { type: 'new_assignment', title: `مهمة فرعية جديدة من رجل الأعمال: ${st.title}`, body: `تحت ${parent.ref} — ${parent.title}`, link: link(parent.id) });
    events.broadcastChange({ item: parent.id });
    return getItem(st.id);
  });
}
const subtasksOf = (id) => all(`SELECT ${D.ITEM_LIST_COLS} FROM items i WHERE i.parent_task_id=? ORDER BY CASE WHEN i.status IN ('done','cancelled') THEN 1 ELSE 0 END, COALESCE(i.due_date,'9999'), i.id`, id).map(x => D.decorate(x));

function closeItem(user, id) {
  require_(user, 'item.manage');
  const it = getItem(id);
  if (it.closed_at) throw bad('مغلقة مسبقًا');
  if (!['done', 'cancelled'].includes(it.status)) throw bad('لا يمكن الإغلاق النهائي إلا لمهمة مكتملة أو ملغاة');
  if (it.status === 'done' && it.requires_approval && !hasApprovedFinal(id)) throw bad('تتطلب اعتماد النتيجة النهائية قبل الإغلاق');
  return tx(() => {
    run('UPDATE items SET closed_at=?, updated_at=?, updated_by=? WHERE id=?', nowIso(), nowIso(), user.id, id);
    audit('item', id, user.id, 'closed');
    sysMsg(id, user.id, `أغلق ${user.name} المهمة نهائيًا وحُفظ سجلها`, { event: 'closed' });
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}

// ===== 7) المحادثة المرتبطة بالمهمة =====
function addMessage(user, id, b, fileIds = []) {
  require_(user, 'item.message');
  const it = getItem(id);
  assertCanSee(user, it);
  if (it.closed_at) throw bad('المهمة مغلقة نهائيًا؛ لا يمكن إضافة رسائل');
  const body = str(b.body, 8000);
  const kind = b.kind === 'update' && ['manager', 'member'].includes(user.role) ? 'update' : b.kind === 'result' && user.role === 'manager' ? 'result' : 'message';
  if (!body && !fileIds.length) throw bad('اكتب رسالة أو أرفق ملفًا');
  return tx(() => {
    const mid = run('INSERT INTO messages(item_id,author_id,kind,body) VALUES(?,?,?,?)', id, user.id, kind, body).id;
    for (const f of fileIds) run('UPDATE files SET message_id=?, item_id=? WHERE id=? AND uploader_id=? AND message_id IS NULL', mid, id, f, user.id);
    if (b.next_step !== undefined && user.role === 'manager') { run('UPDATE items SET next_step=? WHERE id=?', str(b.next_step, 500), id); audit('item', id, user.id, 'updated', 'next_step', it.next_step, b.next_step); }
    touch(id, user.id);
    audit('item', id, user.id, kind === 'update' ? 'update_posted' : 'message');
    const title = user.role === 'owner' ? `ملاحظة من رجل الأعمال على: ${it.title}` : kind === 'update' ? `تحديث من ${user.name}: ${it.title}` : `رسالة من ${user.name}: ${it.title}`;
    const payload = { type: 'new_message', title, body: (body || 'ملف مرفق').slice(0, 200), link: link(id), collapse: `item:${id}:msg:${user.id}` };
    if (user.role === 'member') notifyRole('manager', payload); else notifyRole(otherRole(user), payload);
    notifyAssignee(it, user, payload);
    events.broadcastChange({ item: id });
    return mid;
  });
}

function thread(id) {
  const msgs = all(`SELECT m.*, u.name AS author_name, ${D.roleSql('u')} AS author_role FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.item_id=? ORDER BY m.id`, id);
  const files = all('SELECT id,message_id,approval_id,original_name,mime,size,is_voice,created_at,uploader_id FROM files WHERE item_id=? ORDER BY id', id);
  for (const m of msgs) { m.files = files.filter(f => f.message_id === m.id); try { m.meta = m.meta ? JSON.parse(m.meta) : null; } catch { m.meta = null; } }
  const approvals = all(`SELECT a.*, ru.name AS requested_by_name, du.name AS decided_by_name FROM approvals a LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users du ON du.id=a.decided_by WHERE a.item_id=? ORDER BY a.id`, id)
    .map(a => ({ ...a, options: a.options ? JSON.parse(a.options) : [], kind_label: D.APPROVAL_KINDS[a.kind], files: files.filter(f => f.approval_id === a.id) }));
  const notes = all(`SELECT ${D.ITEM_LIST_COLS}, i.description FROM items i WHERE parent_id=? ORDER BY id`, id).map(n => D.decorate(n));
  const auditRows = all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE entity='item' AND entity_id=? ORDER BY a.id`, id);
  const itemFiles = files.filter(f => !f.message_id && !f.approval_id);
  return { messages: msgs, approvals, notes, audit: auditRows, files: itemFiles };
}

// ===== 8) طلبات الاعتماد والقرارات =====
function requestApproval(user, id, b, fileIds = []) {
  require_(user, 'approval.request');
  const it = getItem(id);
  if (!D.APPROVAL_KINDS[b.kind]) throw bad('نوع الطلب غير صالح');
  const title = str(b.title, 300); if (!title) throw bad('عنوان الطلب مطلوب');
  const options = (Array.isArray(b.options) ? b.options : String(b.options || '').split('\n')).map(o => String(o).trim()).filter(Boolean).slice(0, 6);
  if (it.kind !== 'task' && b.kind !== 'inquiry') throw bad('حوّل التكليف إلى مهمة أولًا ثم اطلب الاعتماد');
  return tx(() => {
    const aid = run('INSERT INTO approvals(item_id,kind,title,body,options,blocking,requested_by) VALUES(?,?,?,?,?,?,?)',
      id, b.kind, title, str(b.body), options.length ? JSON.stringify(options) : null, b.blocking === false || b.blocking === '0' ? 0 : 1, user.id).id;
    for (const f of fileIds) run('UPDATE files SET approval_id=?, item_id=? WHERE id=? AND uploader_id=? AND approval_id IS NULL AND message_id IS NULL', aid, id, f, user.id);
    const newStatus = b.kind === 'inquiry' ? 'waiting_info' : 'waiting_approval';
    if (it.status !== newStatus) {
      run('UPDATE items SET status=? WHERE id=?', newStatus, id);
      audit('item', id, user.id, 'status', 'status', it.status, newStatus);
    }
    audit('approval', aid, user.id, 'requested', 'kind', null, b.kind);
    sysMsg(id, user.id, `طلب ${user.name} ${D.APPROVAL_KINDS[b.kind]}: ${title}`, { event: 'approval_requested', approval_id: aid }, 'decision');
    touch(id, user.id);
    notifyRole('owner', { type: 'approval_request', title: `${D.APPROVAL_KINDS[b.kind]}: ${title}`, body: `${it.ref} — ${it.title}`, link: link(id), urgent: it.priority === 'urgent' || b.kind === 'inquiry' });
    events.broadcastChange({ item: id });
    return aid;
  });
}

const DECISIONS = { approved: 'اعتماد', rejected: 'رفض', changes_requested: 'طلب تعديل', chosen: 'اختيار بديل', answered: 'رد على الاستفسار' };
function decide(user, aid, b) {
  require_(user, 'approval.decide');
  const a = get('SELECT * FROM approvals WHERE id=?', aid); if (!a) throw notFound('الطلب غير موجود');
  if (a.status !== 'pending') throw bad('تم اتخاذ قرار في هذا الطلب مسبقًا');
  const decision = b.decision; if (!DECISIONS[decision]) throw bad('قرار غير صالح');
  const note = str(b.note, 3000);
  if ((decision === 'rejected' || decision === 'changes_requested') && !note) throw bad('وضّح السبب أو التعديل المطلوب');
  if (decision === 'answered' && !note) throw bad('اكتب الرد');
  let chosen = null;
  if (decision === 'chosen') {
    const opts = a.options ? JSON.parse(a.options) : [];
    chosen = opts[Number(b.option_index)]; if (!chosen) throw bad('اختر أحد البدائل');
  }
  const it = getItem(a.item_id);
  return tx(() => {
    const at = nowIso();
    run('UPDATE approvals SET status=?, decision_note=?, chosen_option=?, decided_by=?, decided_at=? WHERE id=?', decision, note, chosen, user.id, at, aid);
    audit('approval', aid, user.id, 'decided', 'status', 'pending', decision);
    // لا يُنفَّذ أي إجراء مالي أو تعاقدي خارجي تلقائيًا — القرار يُسجَّل فقط ويُبلَّغ به مدير المكتب
    let newStatus = it.status;
    const stillPending = get("SELECT COUNT(*) c FROM approvals WHERE item_id=? AND status='pending'", a.item_id).c;
    if (!stillPending) {
      if (a.kind === 'final' && decision === 'approved') newStatus = 'done';
      else newStatus = 'in_progress';
    }
    if (newStatus !== it.status) {
      run(`UPDATE items SET status=?${newStatus === 'done' ? ', completed_at=?' : ''} WHERE id=?`, ...(newStatus === 'done' ? [newStatus, at, a.item_id] : [newStatus, a.item_id]));
      audit('item', a.item_id, user.id, 'status', 'status', it.status, newStatus);
      if (newStatus === 'done' && it.recurrence && !it.next_occurrence_id) spawnNextOccurrence(user, it);
    }
    const txt = `قرار رجل الأعمال على «${a.title}»: ${DECISIONS[decision]}${chosen ? ` — ${chosen}` : ''}${note ? `\n${note}` : ''}`;
    sysMsg(a.item_id, user.id, txt, { event: 'decision', approval_id: aid, decision }, 'decision');
    touch(a.item_id, user.id);
    notifyRole('manager', { type: 'decision', title: `${DECISIONS[decision]}: ${a.title}`, body: `${it.ref} — ${note || chosen || ''}`.slice(0, 200), link: link(a.item_id) });
    notifyAssignee(it, user, { type: 'decision', title: `${DECISIONS[decision]}: ${a.title}`, body: it.ref, link: link(a.item_id) });
    events.broadcastChange({ item: a.item_id });
    return get('SELECT * FROM approvals WHERE id=?', aid);
  });
}

function withdrawApproval(user, aid) {
  require_(user, 'approval.request');
  const a = get('SELECT * FROM approvals WHERE id=?', aid); if (!a) throw notFound();
  if (a.status !== 'pending') throw bad('لا يمكن سحب طلب تم البت فيه');
  return tx(() => {
    run("UPDATE approvals SET status='withdrawn', decided_at=? WHERE id=?", nowIso(), aid);
    audit('approval', aid, user.id, 'withdrawn');
    const left = get("SELECT COUNT(*) c FROM approvals WHERE item_id=? AND status='pending'", a.item_id).c;
    const it = getItem(a.item_id);
    if (!left && ['waiting_approval', 'waiting_info'].includes(it.status)) { run("UPDATE items SET status='in_progress' WHERE id=?", a.item_id); audit('item', a.item_id, user.id, 'status', 'status', it.status, 'in_progress'); }
    sysMsg(a.item_id, user.id, `سحب ${user.name} طلب «${a.title}»`);
    events.broadcastChange({ item: a.item_id });
  });
}

// ===== حسابات الفريق (إدارة المستخدمين) =====
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
function listUsers(actor) {
  require_(actor, 'users.manage');
  return all(`SELECT id,username,name,${D.roleSql()} AS role,email,active,created_at,grants FROM users ORDER BY member, id`)
    .map(u => ({ ...u, role_label: D.ROLE_LABELS[u.role], projects: memberProjects(u.id), grants: u.role === 'member' ? D.parseGrants(u.grants) : null }));
}
// حفظ صلاحيات الموظف بعد تنقيتها (قائمة بيضاء)، مع سجل التغيير وإشعار الموظف
function setUserGrants(actor, userId, raw) {
  const { g, errs } = D.validateGrants(raw);
  if (errs.length) throw bad(errs.join('، '));
  const before = (get('SELECT grants FROM users WHERE id=?', userId) || {}).grants;
  const json = JSON.stringify(g);
  if (json === JSON.stringify(D.parseGrants(before))) return;
  run('UPDATE users SET grants=? WHERE id=?', json, userId);
  audit('user', userId, actor.id, 'grants', 'grants', before, json);
  notify(userId, { type: 'status_change', title: 'تحدّثت صلاحياتك في المنصة', body: D.SCOPES[g.scope], link: '#/' });
}
function setUserProjects(actor, userId, ids) {
  const want = [...new Set((ids || []).map(Number).filter(Boolean))];
  for (const pid of want) if (!get('SELECT id FROM projects WHERE id=?', pid)) throw bad('مشروع غير موجود');
  const have = memberProjects(userId);
  for (const pid of have.filter(p => !want.includes(p))) run('DELETE FROM project_members WHERE project_id=? AND user_id=?', pid, userId);
  for (const pid of want.filter(p => !have.includes(p))) {
    run('INSERT INTO project_members(project_id,user_id) VALUES(?,?)', pid, userId);
    const p = get('SELECT name FROM projects WHERE id=?', pid);
    notify(userId, { type: 'status_change', title: `أُضفت إلى مشروع: ${p.name}`, body: 'يمكنك الآن رؤية مهامه والمشاركة فيها', link: '#/' });
  }
  if (want.join() !== have.sort().join()) audit('user', userId, actor.id, 'projects', 'projects', have.join(','), want.join(','));
}
async function createUser(actor, b) {
  require_(actor, 'users.manage');
  const name = str(b.name, 100); if (!name) throw bad('الاسم مطلوب');
  const username = String(b.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw bad('اسم المستخدم: 3–32 حرفًا لاتينيًا صغيرًا أو أرقامًا أو . _ -');
  if (get('SELECT id FROM users WHERE username=?', username)) throw bad('اسم المستخدم مستخدم من قبل');
  const pw = String(b.password || ''); if (pw.length < 8) throw bad('كلمة المرور يجب ألا تقل عن 8 أحرف');
  const email = str(b.email, 200); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('بريد إلكتروني غير صالح');
  const hash = await require('./auth').hashPassword(pw);
  return tx(() => {
    // role='manager' مع member=1 = عضو فريق (انظر D.roleSql). صلاحياته محددة بـ PERMS.member
    const { id } = run("INSERT INTO users(username,name,role,email,password_hash,member) VALUES(?,?,'manager',?,?,1)", username, name, email, hash);
    audit('user', id, actor.id, 'created');
    setUserProjects(actor, id, b.project_ids);
    if (b.grants) setUserGrants(actor, id, b.grants);
    return { id };
  });
}
async function updateUser(actor, id, b) {
  require_(actor, 'users.manage');
  const u = get(`SELECT *, ${D.roleSql()} AS eff_role FROM users WHERE id=?`, id); if (!u) throw notFound('المستخدم غير موجود');
  if (u.eff_role !== 'member' && u.id !== actor.id && ['name', 'email', 'password', 'active', 'grants'].some(k => b[k] !== undefined))
    throw forbidden('حسابا رجل الأعمال ومدير المكتب يعدّلهما صاحباهما فقط');
  const hash = b.password ? (String(b.password).length < 8 ? (() => { throw bad('كلمة المرور يجب ألا تقل عن 8 أحرف'); })() : await require('./auth').hashPassword(String(b.password))) : null;
  return tx(() => {
    if (b.name !== undefined) { const n = str(b.name, 100); if (!n) throw bad('الاسم مطلوب'); run('UPDATE users SET name=? WHERE id=?', n, id); }
    if (b.email !== undefined) { const e = str(b.email, 200); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('بريد إلكتروني غير صالح'); run('UPDATE users SET email=? WHERE id=?', e, id); }
    if (b.active !== undefined) {
      if (u.eff_role !== 'member') throw bad('لا يمكن إيقاف حساب رجل الأعمال أو مدير المكتب');
      run('UPDATE users SET active=? WHERE id=?', b.active ? 1 : 0, id);
      if (!b.active) { run('DELETE FROM sessions WHERE user_id=?', id); events.disconnect(id); }
    }
    if (hash) { run('UPDATE users SET password_hash=? WHERE id=?', hash, id); if (id !== actor.id) { run('DELETE FROM sessions WHERE user_id=?', id); events.disconnect(id); } }
    if (b.project_ids !== undefined) setUserProjects(actor, id, b.project_ids);
    if (b.grants !== undefined) { if (u.eff_role !== 'member') throw bad('الصلاحيات تُخصص لحسابات الموظفين فقط'); setUserGrants(actor, id, b.grants); }
    audit('user', id, actor.id, 'updated');
    events.broadcastChange({ user: id });
    return { ok: true };
  });
}

// ===== 9) قرارات الاجتماعات → مهام (دون تكرار) =====
function decisionToTask(user, did, b) {
  require_(user, 'meetings.manage');
  const d = get('SELECT d.*, m.section AS m_section, m.title AS m_title FROM decisions d JOIN meetings m ON m.id=d.meeting_id WHERE d.id=?', did);
  if (!d) throw notFound('القرار غير موجود');
  if (d.task_id) throw bad('هذا القرار مرتبط بمهمة بالفعل');
  return tx(() => {
    const task = createTask(user, {
      title: str(b.title, 300) || d.text.slice(0, 300), description: `قرار صادر عن اجتماع: ${d.m_title}\n\n${d.text}`,
      section: b.section || d.m_section, assignee: d.responsible || user.name, due_date: d.due_date, priority: b.priority || 'normal',
      source: 'meeting', meeting_id: d.meeting_id, decision_id: d.id,
    });
    run("UPDATE decisions SET task_id=?, status='in_progress' WHERE id=?", task.id, did);
    audit('decision', did, user.id, 'converted', 'task_id', null, task.id);
    return task;
  });
}

module.exports = {
  AppError, bad, forbidden, notFound, require_, audit, getItem, scopeFor, canSee, assertCanSee, memberProjects, listUsers, createUser, updateUser, createAssignment, createNote, createTask, acknowledge, convertToTask,
  allowedSections, assertSectionAllowed, createSubtask, subtasksOf, spawnNextOccurrence, advanceDate, validProject, validRecurrence,
  updateItem, closeItem, addMessage, thread, requestApproval, decide, withdrawApproval, decisionToTask, str, validDate, validSection,
};
