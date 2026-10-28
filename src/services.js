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
  const it = get(`SELECT ${D.ITEM_LIST_COLS}, i.description, i.original_text, i.meeting_id, i.decision_id, i.sop_id, i.partner_id, i.acknowledged_by, i.started_at, i.updated_by
    FROM items i WHERE i.id=?`, id);
  if (!it) throw notFound();
  return D.decorate(it);
}

function validSection(s) { if (s && !D.SECTION_KEYS.includes(s)) throw bad('قسم غير صالح'); return s || null; }
function validPriority(p) { if (p && !D.PRIORITIES[p]) throw bad('أولوية غير صالحة'); return p || 'normal'; }
function validDate(d) { if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('تاريخ غير صالح'); return d || null; }
function validTime(t) { if (t && !/^\d{2}:\d{2}$/.test(t)) throw bad('وقت غير صالح'); return t || null; }
function str(v, max = 5000) { return v == null ? null : String(v).trim().slice(0, max) || null; }

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
function createTask(user, b) {
  require_(user, 'task.create');
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
    sysMsg(id, user.id, `أنشأ ${user.name} المهمة ${ref}`);
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
    sysMsg(id, user.id, `حوّل ${user.name} ${it.kind === 'note' ? 'الملاحظة' : 'التكليف'} إلى مهمة منظمة في قسم ${D.sectionName(section)} — المسؤول: ${str(b.assignee, 200) || user.name}`, { event: 'converted' });
    if (it.source === 'owner') notify(it.created_by, { type: 'status_change', title: `بدأ تنظيم: ${it.title}`, body: `حُوّل إلى مهمة في ${D.sectionName(section)}`, link: link(id), collapse: `item:${id}:status` });
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}

// ===== 6) تعديل بيانات المهمة وحالتها =====
const EDITABLE = ['title', 'description', 'section', 'category', 'project_id', 'assignee', 'due_date', 'due_time', 'priority', 'next_step', 'requires_approval', 'sop_id', 'partner_id'];
function updateItem(user, id, b) {
  const it = getItem(id);
  // رجل الأعمال يستطيع إلغاء تكليفه فقط؛ بقية التعديلات لمدير المكتب
  if (user.role === 'owner') {
    if (Object.keys(b).some(k => k !== 'status') || b.status !== 'cancelled') throw forbidden();
    if (it.created_by !== user.id) throw forbidden();
    require_(user, 'item.cancel_own');
  } else require_(user, 'item.manage');
  if (it.closed_at) throw bad('المهمة مغلقة نهائيًا');
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
      else if (k === 'category') { if (!D.CATEGORIES[v]) throw bad('تصنيف غير صالح'); }
      else if (['project_id', 'sop_id', 'partner_id'].includes(k)) v = v ? Number(v) : null;
      else v = str(v, k === 'description' ? 5000 : 500);
      if (k === 'title' && !v) throw bad('العنوان مطلوب');
      if (String(v ?? '') !== String(it[k] ?? '')) { changes.push([k, it[k], v]); run(`UPDATE items SET ${k}=? WHERE id=?`, v, id); }
    }
    for (const [k, o, n] of changes) audit('item', id, user.id, 'updated', k, o, n);
    if (changes.length) sysMsg(id, user.id, `عدّل ${user.name}: ${changes.map(c => FIELD_LABELS[c[0]] || c[0]).join('، ')}`, { event: 'edited' });
    if (b.status !== undefined && b.status !== it.status) setStatus(user, it, b.status, b.status_note);
    if (changes.length || b.status !== undefined) touch(id, user.id);
    events.broadcastChange({ item: id });
    return getItem(id);
  });
}
const FIELD_LABELS = { title: 'العنوان', description: 'الوصف', section: 'القسم', category: 'التصنيف', project_id: 'المشروع', assignee: 'المسؤول', due_date: 'الموعد', due_time: 'الوقت', priority: 'الأولوية', next_step: 'الخطوة التالية', requires_approval: 'اشتراط الاعتماد', sop_id: 'الإجراء المرتبط', partner_id: 'الجهة المرتبطة' };

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
    notifyRole('manager', { type: 'status_change', title: `ألغى رجل الأعمال: ${it.title}`, body: it.ref, link: link(it.id) });
  }
}

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
  const body = str(b.body, 8000);
  const kind = b.kind === 'update' && user.role === 'manager' ? 'update' : b.kind === 'result' && user.role === 'manager' ? 'result' : 'message';
  if (!body && !fileIds.length) throw bad('اكتب رسالة أو أرفق ملفًا');
  return tx(() => {
    const mid = run('INSERT INTO messages(item_id,author_id,kind,body) VALUES(?,?,?,?)', id, user.id, kind, body).id;
    for (const f of fileIds) run('UPDATE files SET message_id=?, item_id=? WHERE id=? AND uploader_id=? AND message_id IS NULL', mid, id, f, user.id);
    if (b.next_step !== undefined && user.role === 'manager') { run('UPDATE items SET next_step=? WHERE id=?', str(b.next_step, 500), id); audit('item', id, user.id, 'updated', 'next_step', it.next_step, b.next_step); }
    touch(id, user.id);
    audit('item', id, user.id, kind === 'update' ? 'update_posted' : 'message');
    const title = user.role === 'owner' ? `ملاحظة من رجل الأعمال على: ${it.title}` : kind === 'update' ? `تحديث من مدير المكتب: ${it.title}` : `رسالة من مدير المكتب: ${it.title}`;
    notifyRole(otherRole(user), { type: 'new_message', title, body: (body || 'ملف مرفق').slice(0, 200), link: link(id), collapse: `item:${id}:msg:${user.id}` });
    events.broadcastChange({ item: id });
    return mid;
  });
}

function thread(id) {
  const msgs = all(`SELECT m.*, u.name AS author_name, u.role AS author_role FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.item_id=? ORDER BY m.id`, id);
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
    }
    const txt = `قرار رجل الأعمال على «${a.title}»: ${DECISIONS[decision]}${chosen ? ` — ${chosen}` : ''}${note ? `\n${note}` : ''}`;
    sysMsg(a.item_id, user.id, txt, { event: 'decision', approval_id: aid, decision }, 'decision');
    touch(a.item_id, user.id);
    notifyRole('manager', { type: 'decision', title: `${DECISIONS[decision]}: ${a.title}`, body: `${it.ref} — ${note || chosen || ''}`.slice(0, 200), link: link(a.item_id) });
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
  AppError, bad, forbidden, notFound, require_, audit, getItem, createAssignment, createNote, createTask, acknowledge, convertToTask,
  updateItem, closeItem, addMessage, thread, requestApproval, decide, withdrawApproval, decisionToTask, str, validDate, validSection,
};
