'use strict';
// اختبارات منطق الخادم: قواعد الشريط العاجل، منع تكرار الإشعارات، الإشعارات المجدولة، عدم التكرار عند التحويل
const fs = require('fs'); const os = require('os'); const path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'office-unit-'));
require('../src/config').set({ PBKDF2_ITERATIONS: '1000' });
require('../src/node/sqlite').init(DATA);
const { get, all, run } = require('../src/db');
const D = require('../src/domain');
const S = require('../src/services');
const { runScheduler: scheduler } = require('../src/scheduler');
(async () => {
await require('../src/auth').ensureUsers();
const owner = get("SELECT * FROM users WHERE role='owner'"); const mgr = get("SELECT * FROM users WHERE role='manager'");
let ok = 0, fail = 0;
const t = (name, cond) => { if (cond) { ok++; console.log('✔ ' + name); } else { fail++; console.log('✘ ' + name); } };
const today = D.todayStr(); const y = D.addDays(today, -1);

const normalToday = S.createTask(mgr, { title: 'عادية اليوم', section: 'family', due_date: today });
const normalLate = S.createTask(mgr, { title: 'عادية متأخرة', section: 'family', due_date: y });
const impLate = S.createTask(mgr, { title: 'مهمة متأخرة', section: 'family', due_date: y, priority: 'important' });
const urgent = S.createAssignment(owner, { title: 'عاجلة', section: 'commercial', priority: 'urgent' });
const blocked = S.createTask(mgr, { title: 'تنتظر قرارًا', section: 'association' });
S.requestApproval(mgr, blocked.id, { kind: 'approval', title: 'موافقة', blocking: true });
const nonBlock = S.createTask(mgr, { title: 'قرار غير مانع', section: 'association' });
S.requestApproval(mgr, nonBlock.id, { kind: 'approval', title: 'موافقة', blocking: false });

const today_ = D.todayRibbon().map(i => i.id); const urg = D.urgentRibbon().map(i => i.id);
t('مستحقة اليوم ليست عاجلة تلقائيًا', today_.includes(normalToday.id) && !urg.includes(normalToday.id));
t('المتأخرة العادية لا تدخل الشريط العاجل', !urg.includes(normalLate.id));
t('المتأخرة عالية الأولوية عاجلة', urg.includes(impLate.id));
t('أولوية «عاجل» تظهر في العاجلة', urg.includes(urgent.id));
t('قرار مانع ينتظر رجل الأعمال يظهر في العاجلة', urg.includes(blocked.id));
t('قرار غير مانع لا يظهر في العاجلة', !urg.includes(nonBlock.id));
S.updateItem(mgr, normalToday.id, { status: 'stalled' });
t('المتعثرة تظهر في العاجلة', D.urgentRibbon().some(i => i.id === normalToday.id));

const before = get('SELECT COUNT(*) c FROM notifications').c;
scheduler(); const mid = get('SELECT COUNT(*) c FROM notifications').c; scheduler(); scheduler();
const after = get('SELECT COUNT(*) c FROM notifications').c;
t('المجدول ينشئ تذكيرات الموعد والتأخر', mid > before && all("SELECT * FROM notifications WHERE type='overdue'").length > 0);
t('لا تتكرر تنبيهات المجدول عند تشغيله مجددًا', after === mid);

const n0 = get("SELECT COUNT(*) c FROM notifications WHERE user_id=?", mgr.id).c;
for (let i = 0; i < 3; i++) S.addMessage(owner, urgent.id, { body: 'رسالة ' + i });
const n1 = get("SELECT COUNT(*) c FROM notifications WHERE user_id=?", mgr.id).c;
t('الرسائل المتتالية غير المقروءة تُدمج في إشعار واحد', n1 - n0 === 1);

const before2 = get('SELECT COUNT(*) c FROM items').c;
S.convertToTask(mgr, urgent.id, { section: 'commercial' });
t('التحويل إلى مهمة لا ينشئ سجلًا جديدًا', get('SELECT COUNT(*) c FROM items').c === before2 && get('SELECT kind FROM items WHERE id=?', urgent.id).kind === 'task');
let threw = false; try { S.convertToTask(mgr, urgent.id, {}); } catch { threw = true; }
t('لا يمكن تحويل المهمة مرتين', threw);

const note = S.createNote(owner, { msg_type: 'info', description: 'للاطلاع فقط' });
t('الملاحظة لا تُنشئ مهمة تلقائيًا', get('SELECT kind FROM items WHERE id=?', note.id).kind === 'note' && !D.todayRibbon().some(i => i.id === note.id));

const m = run("INSERT INTO meetings(title,starts_at) VALUES('اجتماع','2026-01-01T10:00')").id;
const dec = run("INSERT INTO decisions(meeting_id,text) VALUES(?, 'قرار')", m).id;
threw = false; try { S.decisionToTask(mgr, dec, {}); } catch { threw = true; }
t('القرار بلا قسم يطلب تحديد القسم بدل إنشاء مهمة ناقصة', threw && !get('SELECT task_id FROM decisions WHERE id=?', dec).task_id);
S.decisionToTask(mgr, dec, { section: 'association' }); threw = false; try { S.decisionToTask(mgr, dec, { section: 'association' }); } catch { threw = true; }
t('قرار الاجتماع لا يتحول إلى مهمتين', threw && get('SELECT COUNT(*) c FROM items WHERE decision_id=?', dec).c === 1);


// ---- حسابات الفريق: رؤية محصورة وصلاحيات محدودة
{
  const D2 = require('../src/domain');
  const eff = (id) => get(`SELECT id,name,${D2.roleSql()} AS role FROM users WHERE id=?`, id);
  const proj = run("INSERT INTO projects(section,name) VALUES('association','مشروع الفريق')").id;
  const proj2 = run("INSERT INTO projects(section,name) VALUES('association','مشروع آخر')").id;
  const { id: memId } = await S.createUser(mgr, { name: 'سعد', username: 'saad', password: 'Saad#2026x', project_ids: [proj] });
  const mem = eff(memId);
  t('عضو الفريق يُحمَّل بدور member (لا manager)', mem.role === 'member' && !D2.can(mem, 'item.manage') && !D2.can(mem, 'item.view'));
  const inProj = S.createTask(mgr, { title: 'مهمة في مشروعه', section: 'association', project_id: proj });
  const assigned = S.createTask(mgr, { title: 'مهمة مسندة إليه', section: 'family', assignee_id: memId });
  const hidden = S.createTask(mgr, { title: 'مهمة لا تخصه', section: 'association', project_id: proj2 });
  t('يُشعَر العضو عند إسناد مهمة إليه وعند إضافته لمشروع', all('SELECT title FROM notifications WHERE user_id=?', memId).some(n => n.title.includes('أُسندت إليك')) && all('SELECT title FROM notifications WHERE user_id=?', memId).some(n => n.title.includes('أُضفت إلى مشروع')));
  t('اسم المسؤول يُضبط من الحساب المسند', S.getItem(assigned.id).assignee === 'سعد');
  t('يرى العضو مهام مشروعه والمسندة إليه فقط', S.canSee(mem, inProj) && S.canSee(mem, assigned) && !S.canSee(mem, hidden));
  let e1 = null; try { S.addMessage(mem, hidden.id, { body: 'x' }); } catch (e) { e1 = e.status; }
  t('لا يستطيع العضو مراسلة مهمة لا يراها (404)', e1 === 404);
  const before = get("SELECT COUNT(*) c FROM notifications WHERE user_id=?", mgr.id).c;
  S.addMessage(mem, inProj.id, { body: 'بدأت العمل', kind: 'update' });
  t('تحديث العضو يُبلَّغ به مدير المكتب', get("SELECT COUNT(*) c FROM notifications WHERE user_id=?", mgr.id).c > before);
  S.updateItem(mem, inProj.id, { status: 'in_progress' });
  t('يستطيع العضو تحديث حالة مهمته', S.getItem(inProj.id).status === 'in_progress');
  const denied = [() => S.updateItem(mem, inProj.id, { status: 'cancelled' }), () => S.updateItem(mem, inProj.id, { title: 'تغيير' }), () => S.acknowledge(mem, inProj.id),
    () => S.createTask(mem, { title: 'x', section: 'family' }), () => S.requestApproval(mem, inProj.id, { kind: 'report', title: 'x' }), () => S.listUsers(mem)];
  t('العضو ممنوع من الإلغاء والتعديل والاستلام والإنشاء وطلب الاعتماد وإدارة المستخدمين', denied.every(f => { try { f(); return false; } catch (e) { return e.status === 403 || e.status === 404; } }));
  let e2 = null; try { S.scopeFor({ id: 999, role: 'nobody' }); } catch (e) { e2 = e.status; }
  t('دور غير معروف لا يرى شيئًا (403)', e2 === 403);
  t('notifyRole("manager") لا يصل إلى أعضاء الفريق', (() => { const n0 = get('SELECT COUNT(*) c FROM notifications WHERE user_id=?', memId).c; require('../src/notify').notifyRole('manager', { type: 'digest', title: 'للمدير فقط' }); return get('SELECT COUNT(*) c FROM notifications WHERE user_id=?', memId).c === n0; })());
  await S.updateUser(mgr, memId, { active: false });
  t('إيقاف الحساب يحذف جلساته ويمنع ظهوره', !get('SELECT active FROM users WHERE id=?', memId).active);
  let e3 = null; try { await S.updateUser(mgr, owner.id, { active: false }); } catch (e) { e3 = e.status; }
  t('لا يمكن إيقاف حساب رجل الأعمال', [400, 403].includes(e3));
}
// ---- المجلدات
{
  const fold = run("INSERT INTO folders(section,name) VALUES('association','الحلقات')").id;
  const p3 = run("INSERT INTO projects(section,name,folder_id) VALUES('association','برنامج الحفظ',?)", fold).id;
  const tk = S.createTask(mgr, { title: 'مهمة عبر المشروع', section: 'association', project_id: p3 });
  t('المهمة تنتقل إلى مجلد مشروعها تلقائيًا', S.getItem(tk.id).folder_id === fold);
  let e4 = null; try { S.createTask(mgr, { title: 'خطأ', section: 'family', folder_id: fold }); } catch (e) { e4 = e.status; }
  t('لا تُوضع مهمة في مجلد من قسم آخر', e4 === 400);
  S.updateItem(mgr, tk.id, { section: 'family', project_id: null });
  t('تغيير القسم يُخرج المهمة من مجلد القسم القديم', S.getItem(tk.id).folder_id === null);
}

// ---- تعديل رجل الأعمال، المهام الفرعية، المهام الدورية، المبادرات، المجلدات الفرعية
{
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.status; } };
  const tk = S.createTask(mgr, { title: 'مهمة يعدلها رجل الأعمال', section: 'association' });
  S.updateItem(owner, tk.id, { priority: 'urgent', due_date: today, category: 'commitment' });
  const ed = S.getItem(tk.id);
  t('رجل الأعمال يعدّل الأولوية والموعد والتصنيف', ed.priority === 'urgent' && ed.due_date === today && ed.category === 'commitment');
  t('رجل الأعمال لا يغيّر حالة مهمة ليست فرعية', err(() => S.updateItem(owner, tk.id, { status: 'done' })) === 403);

  const st = S.createSubtask(owner, tk.id, { title: 'خطوة أولى' });
  t('المهمة الفرعية ترث القسم وتظهر تحت أصلها', st.parent_task_id === tk.id && st.section === 'association' && S.subtasksOf(tk.id).length === 1);
  t('لا مهمة فرعية تحت مهمة فرعية', err(() => S.createSubtask(mgr, st.id, { title: 'x' })) === 400);
  S.updateItem(owner, st.id, { status: 'done' });
  t('رجل الأعمال يُنجز المهمة الفرعية والتقدم يُحسب', S.getItem(tk.id).subtasks_done === 1 && S.getItem(tk.id).subtasks_total === 1);

  t('حساب المواعيد الدورية (نهاية الشهر والأسبوع والسنة)', S.advanceDate('2026-01-31', 'monthly') === '2026-02-28' && S.advanceDate('2026-11-15', 'weekly') === '2026-11-22'
    && S.advanceDate('2028-02-29', 'yearly') === '2029-02-28' && S.advanceDate('2026-12-31', 'daily') === '2027-01-01');
  const rec = S.createTask(mgr, { title: 'تقرير أسبوعي', section: 'association', recurrence: 'weekly', due_date: today });
  S.createSubtask(mgr, rec.id, { title: 'جمع الأرقام' });
  S.updateItem(mgr, rec.id, { status: 'done' });
  const r1 = S.getItem(rec.id); const nx = r1.next_occurrence_id && S.getItem(r1.next_occurrence_id);
  t('إنجاز المهمة الدورية ينشئ الموعد التالي مع مهامها الفرعية', nx && nx.due_date === D.addDays(today, 7) && nx.recurrence === 'weekly' && nx.is_open && !nx.completed_at && S.subtasksOf(nx.id).length === 1);
  S.updateItem(mgr, rec.id, { status: 'in_progress' }); S.updateItem(mgr, rec.id, { status: 'done' });
  t('إعادة فتح المهمة الدورية وإنجازها لا يكرر الموعد التالي', get("SELECT COUNT(*) c FROM items WHERE title='تقرير أسبوعي' AND parent_task_id IS NULL").c === 2);
  t('تكرار غير صالح يُرفض', err(() => S.createTask(mgr, { title: 'x', section: 'family', recurrence: 'hourly' })) === 400);

  const ini = run("INSERT INTO projects(section,name,kind) VALUES('dawah','مبادرة تجريبية','initiative')").id;
  const it = S.createTask(mgr, { title: 'ضمن مبادرة', section: 'dawah', project_id: ini });
  t('المهمة ضمن مبادرة تحمل نوعها', S.getItem(it.id).project_kind === 'initiative');
  t('لا تُربط مهمة بمبادرة من قسم آخر', err(() => S.createTask(mgr, { title: 'x', section: 'family', project_id: ini })) === 400);
  const asg = S.createAssignment(owner, { title: 'تكليف دوري ضمن مبادرة', section: 'dawah', project_id: ini, recurrence: 'monthly' });
  t('تكليف رجل الأعمال يقبل المبادرة والتكرار', asg.project_id === ini && asg.recurrence === 'monthly');
}

// ---- صلاحيات الموظفين القابلة للتخصيص
{
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.status || e.message; } };
  const load = (id) => get(`SELECT id,name,${D.roleSql()} AS role,grants FROM users WHERE id=?`, id);
  const bogus = await S.createUser(mgr, { name: 'خطأ', username: 'bogus', password: 'Bogus#2026x', grants: { scope: 'sections', sections: ['dawah'], perms: ['bogus.perm'] } }).then(() => null, e => e.status);
  t('صلاحية غير معروفة تُرفض برسالة ولا يُنشأ الحساب', bogus === 400 && !get("SELECT id FROM users WHERE username='bogus'"));
  t('صيغ صلاحيات خاطئة تُرفض (400 لا 500)', [5, null, [], { sections: 'dawah' }, { scope: 'god' }, { perms: 'task.create' }].every(g => D.validateGrants(g).errs.length > 0));
  t('إدارة المشاريع مع نطاق «مهامه فقط» تُرفض', D.validateGrants({ scope: 'own', perms: ['projects.manage'] }).errs.length > 0);
  t('تكرار الصلاحيات يُزال', D.parseGrants({ scope: 'all', perms: Array(500).fill('task.create') }).perms.length === 1);
  const { id: cId } = await S.createUser(mgr, { name: 'نورة', username: 'noura', password: 'Noura#2026x',
    grants: { scope: 'sections', sections: ['dawah'], perms: ['task.create', 'subtask.create', 'item.edit', 'projects.manage'] } });
  const co = load(cId);
  t('الموظف لا يملك صلاحيات المدير أو المالك', D.can(co, 'task.create') && !D.can(co, 'item.manage') && !D.can(co, 'approval.decide') && !D.can(co, 'users.manage'));
  const inSec = S.createTask(mgr, { title: 'مهمة في قسم الدعوة', section: 'dawah' });
  const outSec = S.createTask(mgr, { title: 'مهمة في الأسري', section: 'family' });
  t('منسّق القسم يرى كل مهام قسمه فقط', S.canSee(co, inSec) && !S.canSee(co, outSec));
  S.updateItem(co, inSec.id, { priority: 'urgent', due_date: today });
  t('صلاحية التعديل تسمح بتعديل تفاصيل مهام قسمه', S.getItem(inSec.id).priority === 'urgent');
  t('ولا تسمح بمهام خارج قسمه', err(() => S.updateItem(co, outSec.id, { priority: 'urgent' })) === 404);
  t('ولا بالإلغاء', err(() => S.updateItem(co, inSec.id, { status: 'cancelled' })) === 403);
  const mine = S.createTask(co, { title: 'مهمة أنشأها المنسق', section: 'dawah' });
  t('مهمة ينشئها الموظف بلا مسؤول تُسند إليه فيراها', mine.assignee_id === cId && S.canSee(co, S.getItem(mine.id)));
  t('منسّق قسم لا ينشئ مهمة في قسم آخر ولو لنفسه', err(() => S.createTask(co, { title: 'خارج القسم', section: 'family' })) === 403);
  t('المنسّق يضيف مهام فرعية في قسمه فقط', !!S.createSubtask(co, inSec.id, { title: 'فرعية' }).id && err(() => S.createSubtask(co, outSec.id, { title: 'x' })) === 404);
  t('المنسّق لا ينشئ مجلدًا أو مشروعًا خارج قسمه', err(() => S.assertSectionAllowed(co, 'family')) === 403 && err(() => S.assertSectionAllowed(co, 'dawah')) === null);
  // ثغرات وجدها اختبار الصلاحيات
  t('لا ينشئ الموظف مهمة لغيره في قسم خارج نطاقه', err(() => S.createTask(co, { title: 'x', section: 'family', assignee_id: mgr.id })) === 403);
  t('لا يربط مهمة بمهمة أصل لا يراها', S.createTask(co, { title: 'y', section: 'dawah', parent_task_id: outSec.id }).parent_task_id === null);
  t('لا ينقل مهمة إلى قسم خارج نطاقه', err(() => S.updateItem(co, inSec.id, { section: 'family' })) === 403 && S.getItem(inSec.id).section === 'dawah');
  const appr = S.createTask(mgr, { title: 'تتطلب اعتمادًا', section: 'dawah', requires_approval: 1 });
  t('لا يُلغي الموظف شرط اعتماد النتيجة', err(() => S.updateItem(co, appr.id, { requires_approval: false })) === 403 && err(() => S.updateItem(co, appr.id, { status: 'done' })) === 400);
  const canc = S.createTask(mgr, { title: 'ستُلغى', section: 'dawah' }); S.updateItem(mgr, canc.id, { status: 'cancelled' });
  t('لا يعيد الموظف فتح مهمة ملغاة', err(() => S.updateItem(co, canc.id, { status: 'in_progress' })) === 403);
  const asgD = S.createAssignment(owner, { title: 'تكليف للدعوة', section: 'dawah' });
  t('الموظف لا يرى تكليف رجل الأعمال قبل تحويله ولا يغيّر حالته', !S.canSee(co, asgD) && err(() => S.updateItem(co, asgD.id, { status: 'done' })) === 404);
  t('حسابا المالك والمدير لا يعدّلهما غير صاحبيهما', (await S.updateUser(mgr, owner.id, { password: 'NewOwner#2026' }).then(() => null, e => e.status)) === 403
    && (await S.updateUser(owner, mgr.id, { email: 'x@y.z' }).then(() => null, e => e.status)) === 403);

  const { id: eId } = await S.createUser(mgr, { name: 'سالم', username: 'salem', password: 'Salem#2026x' });
  const ex = load(eId);
  t('المنفّذ الافتراضي: لا إنشاء ولا تعديل ولا رؤية للأقسام', !D.can(ex, 'task.create') && !D.can(ex, 'item.edit') && !D.can(ex, 'folders.view') && !S.canSee(ex, inSec));
  t('المنفّذ لا يضيف مهام فرعية', err(() => S.createSubtask(ex, inSec.id, { title: 'x' })) === 403);

  await S.updateUser(mgr, eId, { grants: { scope: 'all', perms: ['meetings.view'] } });
  const ex2 = load(eId);
  const note = S.createNote(owner, { msg_type: 'info', description: 'ملاحظة خاصة للمدير', section: 'family' });
  t('«كل المكتب» لا يكشف ملاحظات رجل الأعمال الخاصة', !D.can(ex2, 'item.view') && !S.canSee(ex2, note) && S.canSee(ex2, outSec));
  t('تغيير الصلاحيات يسري فورًا ويُشعَر الموظف', D.can(ex2, 'meetings.view') && S.canSee(ex2, outSec)
    && all('SELECT title FROM notifications WHERE user_id=?', eId).some(n => n.title.includes('صلاحياتك')));
  t('نطاق «أقسام محددة» بلا أقسام يُرفض', (await S.updateUser(mgr, eId, { grants: { scope: 'sections', sections: [] } }).then(() => null, e => e.status)) === 400);
  t('لا تُخصص صلاحيات لحساب المدير', (await S.updateUser(mgr, mgr.id, { grants: { scope: 'all' } }).then(() => null, e => e.status)) === 400);
}

// ---- إنجاز المهمة الأم مع فرعياتها
{
  const p = S.createTask(mgr, { title: 'أم بفرعيات', section: 'family' });
  const a = S.createSubtask(mgr, p.id, { title: 'أ' }); const b = S.createSubtask(mgr, p.id, { title: 'ب' });
  S.updateItem(mgr, a.id, { status: 'done' });
  S.updateItem(mgr, p.id, { status: 'done', complete_subtasks: true });
  t('«إنجاز الكل» يُنجز الفرعيات المفتوحة مع أمها', S.getItem(b.id).status === 'done' && S.getItem(p.id).subtasks_done === 2);
  const p2 = S.createTask(mgr, { title: 'أم تبقى فرعيتها', section: 'family' }); const c = S.createSubtask(mgr, p2.id, { title: 'ج' });
  S.updateItem(mgr, p2.id, { status: 'done' });
  t('بدون «إنجاز الكل» تبقى الفرعيات مفتوحة', S.getItem(c.id).status !== 'done');
}

// ---- إشعار الإسناد: واحد وغني بالتفاصيل
{
  const { id: wId } = await S.createUser(mgr, { name: 'وليد', username: 'waleed', password: 'Waleed#2026x' });
  const n0 = get('SELECT COUNT(*) c FROM notifications WHERE user_id=?', wId).c;
  const p = S.createTask(mgr, { title: 'مهمة لوليد', section: 'family', assignee_id: wId, due_date: today, priority: 'important' });
  S.createSubtask(mgr, p.id, { title: 'فرعية 1' }); S.createSubtask(mgr, p.id, { title: 'فرعية 2' });
  const ns = all('SELECT title, body FROM notifications WHERE user_id=? ORDER BY id', wId).slice(n0);
  t('إسناد مهمة بفرعيات يولّد إشعارًا واحدًا', ns.filter(n => n.title.includes('أُسندت إليك')).length === 1);
  t('إشعار الإسناد يذكر من أسند والموعد والأولوية', ns[0] && ns[0].body.includes('من ') && ns[0].body.includes(D.fmtDateAr(today)) && ns[0].body.includes('مهم'));
}

// ---- تحويل قرار اجتماع إلى مهمة بحساب المسؤول والموعد
{
  const m = run("INSERT INTO meetings(title,section,starts_at) VALUES('اجتماع اختبار','dawah','2026-11-20T10:00')").id;
  const d1 = run("INSERT INTO decisions(meeting_id,text,responsible,due_date) VALUES(?,?,?,?)", m, 'قرار باسم موظف', 'وليد', '2026-12-01').id;
  const d2 = run("INSERT INTO decisions(meeting_id,text,responsible) VALUES(?,?,?)", m, 'قرار بحساب مختار', 'شخص ما').id;
  const w = get("SELECT id FROM users WHERE username='waleed'").id;
  const t1 = S.decisionToTask(mgr, d1, {});
  t('اسم المسؤول المطابق لحساب يربط المهمة بالحساب', t1.assignee_id === w && t1.due_date === '2026-12-01');
  const t2 = S.decisionToTask(mgr, d2, { assignee_id: w, due_date: '2026-12-05' });
  t('المدير يختار حساب المسؤول والموعد عند التحويل', t2.assignee_id === w && t2.due_date === '2026-12-05');
}

// ---- المسمى الوظيفي، تغيير كلمة المرور الإلزامي، عبء العمل، تذكير المسؤول
{
  const { id: hId } = await S.createUser(mgr, { name: 'هند', username: 'hind', password: 'Hind#2026xx', title: 'سكرتيرة' });
  const h = get('SELECT title, must_change_password FROM users WHERE id=?', hId);
  t('الموظف الجديد بمسمى وظيفي ويُلزم بتغيير كلمة المرور', h.title === 'سكرتيرة' && h.must_change_password === 1);
  await S.updateUser(mgr, hId, { password: 'Reset#2026xx' });
  t('إعادة تعيين المدير لكلمة المرور تُلزم بتغييرها مجددًا', get('SELECT must_change_password m FROM users WHERE id=?', hId).m === 1);
  const { id: zId } = await S.createUser(mgr, { name: 'زياد', username: 'ziyad', password: 'Ziyad#2026xx', must_change_password: false });
  t('يمكن إنشاء حساب دون إلزام (للحسابات التجريبية)', get('SELECT must_change_password m FROM users WHERE id=?', zId).m === 0);
  const tk = S.createTask(mgr, { title: 'مهمة هند', section: 'family', assignee_id: hId, due_date: D.addDays(today, -1) });
  const r = D.report('week');
  const row = r.by_person.find(p => p.user_id === hId);
  t('تقرير عبء العمل يحسب مهام الموظف ومتأخراته', row && row.open >= 1 && row.overdue >= 1);
  S.updateItem(mgr, tk.id, { due_date: D.addDays(today, 1) });
  const n0 = get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='deadline_soon'", hId).c;
  scheduler();
  t('الموظف المسؤول يُذكَّر قبل الموعد', get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='deadline_soon'", hId).c === n0 + 1);
}

// ---- قيمة غير مُرسلة تُخزن فارغة بدل خطأ في الخادم
{
  const { id } = run('INSERT INTO meetings(title,starts_at,location) VALUES(?,?,?)', 'اجتماع بلا مكان', '2026-11-20T10:00', undefined);
  t('undefined يُخزَّن NULL ولا يُسقط الطلب', get('SELECT location FROM meetings WHERE id=?', id).location === null);
}

// ---- إصلاحات المراجعة المستقلة
{
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.status || e.message; } };
  const load = (id) => get(`SELECT id,name,${D.roleSql()} AS role,grants FROM users WHERE id=?`, id);
  const { id: aId } = await S.createUser(mgr, { name: 'أ', username: 'rv.a', password: 'RvA#2026xxx', must_change_password: false, grants: { scope: 'own', perms: [] } });
  const { id: bId } = await S.createUser(mgr, { name: 'ب', username: 'rv.b', password: 'RvB#2026xxx', must_change_password: false });
  const A = load(aId);
  // «إنجاز الكل» لا يتجاوز النطاق ولا شرط الاعتماد
  const par = S.createTask(mgr, { title: 'أم لـ أ', section: 'family', assignee_id: aId });
  const hid = S.createSubtask(mgr, par.id, { title: 'فرعية لـ ب', assignee_id: bId });
  run('UPDATE items SET requires_approval=1 WHERE id=?', hid.id);
  const vis = S.createSubtask(mgr, par.id, { title: 'فرعية لـ أ' });
  S.updateItem(A, par.id, { status: 'done', complete_subtasks: true });
  t('«إنجاز الكل» يتخطى فرعية لا يراها الموظف أو تتطلب اعتمادًا', S.getItem(hid.id).status !== 'done' && S.getItem(vis.id).status === 'done');
  // المهمة الفرعية: لا تداخل، لا تكرار، وتتبع أمها
  const p2 = S.createTask(mgr, { title: 'أم تنتقل', section: 'family' }); const c2 = S.createSubtask(mgr, p2.id, { title: 'ابنة' });
  t('لا مهمة أصل عبر إنشاء المهام العادي', S.createTask(mgr, { title: 'محاولة', section: 'family', parent_task_id: c2.id }).parent_task_id === null);
  t('لا تكرار للمهمة الفرعية', err(() => S.updateItem(mgr, c2.id, { recurrence: 'weekly' })) === 400);
  S.updateItem(mgr, p2.id, { section: 'commercial' });
  t('نقل الأم إلى قسم آخر ينقل فرعياتها', S.getItem(c2.id).section === 'commercial');
  S.updateItem(mgr, p2.id, { status: 'cancelled' });
  t('إلغاء الأم يلغي فرعياتها المفتوحة', S.getItem(c2.id).status === 'cancelled');
  // مراجع غير موجودة تُرفض
  t('إجراء أو جهة غير موجودة تُرفض', err(() => S.createTask(mgr, { title: 'x', section: 'family', partner_id: 99999 })) === 400 && err(() => S.updateItem(mgr, par.id, { sop_id: 12345 })) === 400);
  // الموظف بنطاق «كل المكتب» لا يرى تكليف المالك قبل تحويله
  const { id: allId } = await S.createUser(mgr, { name: 'كل', username: 'rv.all', password: 'RvAll#2026xx', must_change_password: false, grants: { scope: 'all', perms: [] } });
  const asg = S.createAssignment(owner, { title: 'تكليف لم يُحوَّل', section: 'family' });
  t('تكليف رجل الأعمال لا يظهر للموظفين قبل تحويله إلى مهمة', !S.canSee(load(allId), asg));
}

// ---- سجل التوجيهات: توجيه ← مهام ← نتيجة، وتسجيل قرار المدير نيابةً عنه
{
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.status || e.message; } };
  const { id: asId } = await S.createUser(mgr, { name: 'مساعد التوجيهات', username: 'dir.as', password: 'DirAs#2026x', must_change_password: false });
  t('التوجيه يتطلب قناة الورود عند تسجيله من مدير المكتب', err(() => S.createDirective(mgr, { title: 'توجيه بلا قناة' })) === 400);
  const d = S.createDirective(mgr, { title: 'إعداد خطة الاختبارات النهائية', channel: 'whatsapp', importance: 'important', section: 'personal', due_date: D.addDays(today, 10),
    tasks: [{ title: 'جمع جداول المعلمين', assignee_id: asId }, { title: 'حجز القاعات' }] });
  t('التوجيه يُنشأ برقم مرجعي ومهامه التنفيذية مرتبطة به', /^TW-/.test(d.ref) && d.tasks_total === 2 && d.state === 'in_progress' && d.channel_label === 'واتساب');
  const tasks = all('SELECT id FROM items WHERE directive_id=?', d.id);
  t('مهام التوجيه ترث أهميته وموعده', tasks.every(x => { const i = S.getItem(x.id); return i.priority === 'important' && i.due_date === D.addDays(today, 10); }));
  t('لا يُغلق التوجيه دون تسجيل النتيجة', err(() => S.updateDirective(mgr, d.id, { status: 'done' })) === 400);
  const n0 = get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title LIKE 'اكتملت مهام التوجيه%'", mgr.id).c;
  for (const x of tasks) S.updateItem(mgr, x.id, { status: 'done' });
  const r = S.directiveRow(get('SELECT * FROM directives WHERE id=?', d.id));
  t('اكتمال مهام التوجيه يجعله «بانتظار تسجيل النتيجة» وينبّه مرة واحدة', r.state === 'ready' && r.progress === 100
    && get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title LIKE 'اكتملت مهام التوجيه%'", mgr.id).c === n0 + 1);
  const closed = S.updateDirective(mgr, d.id, { status: 'done', outcome: 'اعتُمدت الخطة ووُزعت على المدارس' });
  t('إغلاق التوجيه بنتيجة موثقة', closed.state === 'done' && closed.outcome.includes('اعتُمدت'));
  t('الموظف لا يدير التوجيهات', err(() => S.createDirective(get(`SELECT id,name,${D.roleSql()} AS role,grants FROM users WHERE id=?`, asId), { title: 'x', channel: 'verbal' })) === 403);
  // قرار المدير يسجله مدير المكتب نيابةً عنه
  const tk = S.createTask(mgr, { title: 'مهمة تتطلب قرار المدير', section: 'personal' });
  const aid = S.requestApproval(mgr, tk.id, { kind: 'approval', title: 'اعتماد الخطة', blocking: true });
  t('تسجيل القرار نيابةً يتطلب ذكر القناة', err(() => S.decide(mgr, aid, { decision: 'approved', on_behalf: true })) === 400);
  S.decide(mgr, aid, { decision: 'approved', on_behalf: true, channel: 'verbal' });
  const ap = get('SELECT * FROM approvals WHERE id=?', aid);
  t('القرار يُسجَّل باسم المدير مع القناة ومن سجّله', ap.status === 'approved' && ap.decided_by === owner.id && ap.decided_channel === 'verbal' && ap.recorded_by === mgr.id
    && all('SELECT body FROM messages WHERE item_id=?', tk.id).some(m => m.body.includes('ورد شفهي')));
  t('مدير المكتب لا يقرر بنفسه دون «نيابةً»', err(() => S.decide(mgr, S.requestApproval(mgr, tk.id, { kind: 'approval', title: 'آخر' }), { decision: 'approved' })) === 403);
}

// ---- لوحة القيادة: الالتزام بالمواعيد، ما يحتاج تدخل المدير، التصعيد وتذكير الاجتماعات
{
  const a = S.createTask(mgr, { title: 'أُنجزت في موعدها', section: 'personal', due_date: today });
  S.updateItem(mgr, a.id, { status: 'done' });
  const b = S.createTask(mgr, { title: 'أُنجزت بعد موعدها', section: 'personal', due_date: D.addDays(today, -2) });
  S.updateItem(mgr, b.id, { status: 'done' });
  const ot = D.onTimeStats(D.addDays(today, -1), today, 'AND i.id IN (?,?)', [a.id, b.id]);
  t('نسبة الالتزام بالمواعيد تحسب المنجز في موعده', ot.total === 2 && ot.on_time === 1 && ot.rate === 50);
  const late = S.createTask(mgr, { title: 'مهمة مهمة متأخرة 4 أيام', section: 'personal', priority: 'important', due_date: D.addDays(today, -4) });
  const late1 = S.createTask(mgr, { title: 'مهمة مهمة متأخرة يومًا', section: 'personal', priority: 'important', due_date: D.addDays(today, -1) });
  const normalLate = S.createTask(mgr, { title: 'عادية متأخرة كثيرًا', section: 'personal', due_date: D.addDays(today, -9) });
  const att = D.needsAttention().map(i => i.id);
  t('«تحتاج تدخل المدير»: المهم المتأخر 3 أيام فأكثر فقط', att.includes(late.id) && !att.includes(late1.id) && !att.includes(normalLate.id));
  const n0 = get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title LIKE 'تحتاج تدخلك:%'", owner.id).c;
  scheduler(); scheduler();
  const n1 = get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title=?", owner.id, 'تحتاج تدخلك: مهمة مهمة متأخرة 4 أيام').c;
  t('التصعيد يصل المدير مرة واحدة لكل حالة', n1 === 1 && get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title LIKE 'تحتاج تدخلك:%'", owner.id).c > n0);
  const m = run("INSERT INTO meetings(title,starts_at,status) VALUES('اجتماع مجلس المدارس',?, 'scheduled')", D.addDays(today, 1) + 'T09:00').id;
  scheduler(); scheduler();
  t('تذكير الاجتماع قبله بيوم مرة واحدة', get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND link=?", mgr.id, `#/meeting/${m}`).c === 1);
  const r = D.report('week');
  t('التقرير يتضمن الالتزام بالمواعيد للمكتب ولكل مسؤول', r.on_time && r.on_time.total >= 2 && r.by_person.some(p => p.on_time_rate !== undefined));
}

// ---- الإجراء التشغيلي كقائمة تحقق، والمخرج المطلوب
{
  const sop = run("INSERT INTO sops(name,steps) VALUES('إجراء إعداد الاختبار', ?)", '1. تجهيز الأسئلة\n2. مراجعة الأسئلة\n3. طباعة النماذج').id;
  const tk = S.createTask(mgr, { title: 'إعداد اختبار الفصل', section: 'personal', sop_id: sop, deliverable: 'نموذج اختبار معتمد' });
  t('المخرج المطلوب يُحفظ مع المهمة', S.getItem(tk.id).deliverable === 'نموذج اختبار معتمد');
  const r1 = S.applySop(mgr, tk.id), r2 = S.applySop(mgr, tk.id);
  t('خطوات الإجراء تصبح مهامًا فرعية مرة واحدة', r1.added === 3 && r2.added === 0 && S.subtasksOf(tk.id).map(x => x.title).join('|') === 'تجهيز الأسئلة|مراجعة الأسئلة|طباعة النماذج');
}

// ---- عبء العمل: الحساب والاسم المكتوب للشخص نفسه صف واحد
{
  S.createTask(mgr, { title: 'باسم مكتوب', section: 'family', assignee: mgr.name });
  run('UPDATE items SET assignee_id=NULL, assignee=? WHERE title=?', mgr.name, 'باسم مكتوب');
  S.createTask(mgr, { title: 'بالحساب', section: 'family', assignee_id: mgr.id });
  const rows = D.report('week').by_person.filter(p => p.name === mgr.name);
  t('الحساب والاسم المكتوب لنفس الشخص يظهران صفًا واحدًا', rows.length === 1);
}

// ---- بيانات المكتب الأولية: مرة واحدة ودون تكرار
{
  const seeds = require('../src/seeds'); const cfg = require('../src/config');
  const before = get("SELECT COUNT(*) c FROM folders WHERE section='association'").c;
  const r = seeds.applySeeds(cfg);
  const f = all("SELECT id,name FROM folders WHERE section='association' AND parent_id IS NULL");
  const inFolder = (name) => all('SELECT title FROM items WHERE folder_id=(SELECT id FROM folders WHERE section=? AND name=?)', 'association', name).map(x => x.title);
  t('الجمعية: 15 مجلدًا و24 مهمة', r.length === 1 && r[0].folders === 15 && r[0].tasks === 24 && f.length === before + 15);
  t('مهام المجلدات كما طُلبت', inFolder('التمثل القرآني').length === 3 && inFolder('الموهوبون').includes('اكتشاف الموهوبين من المشرفين') && inFolder('الموارد البشرية').includes('تسكين الموظفين الجدد'));
  t('المجلد بلا مهام تُنشأ له «متابعة <اسمه>»', inFolder('وحدة التدريب')[0] === 'متابعة وحدة التدريب' && inFolder('الشخصيات والجهات')[0] === 'متابعة الشخصيات والجهات');
  t('مهام تحت الجمعية مباشرة', ['تفعيل مجلس الشؤون التعليمية بالمنطقة', 'آلية الرد على الإيميلات'].every(x => get("SELECT id FROM items WHERE title=? AND section='association' AND folder_id IS NULL", x)));
  t('لا تُطبَّق مرتين', seeds.applySeeds(cfg).length === 0);
  run("DELETE FROM kv WHERE key='seed:association-2026-11'");
  const again = seeds.applySeeds(cfg)[0];
  t('إعادة التطبيق لا تكرر شيئًا', again.folders === 0 && again.tasks === 0 && again.skipped === 39);
}

// ---- ألوان المهام المعتمدة: أحمر عاجلة، أزرق مستحقة، رمادي معلقة
{
  const c = (b, st) => { const x = S.createTask(mgr, { section: 'family', ...b }); if (st) S.updateItem(mgr, x.id, { status: st, status_note: 'سبب' }); return S.getItem(x.id).color; };
  t('أحمر «عاجلة»: أولوية عاجلة، متعثرة، أو تجاوزت موعدها', c({ title: 'ع1', priority: 'urgent' }) === 'red' && c({ title: 'ع2' }, 'stalled') === 'red'
    && c({ title: 'ع3', due_date: D.addDays(today, -1) }) === 'red');
  t('أزرق «مهام اليوم»: موعدها اليوم', c({ title: 'س1', due_date: today }) === 'blue');
  t('رمادي «قيد المتابعة»: تنتظر ردًا أو اعتمادًا أو إجراءً حتى لو موعدها اليوم', c({ title: 'م1', due_date: today }, 'waiting_reply') === 'gray' && c({ title: 'م1ب' }, 'waiting_info') === 'gray');
  t('بلا لون: موعدها غدًا أو بعده أو بلا موعد', c({ title: 'ب1', due_date: D.addDays(today, 1) }) === null && c({ title: 'ب2' }) === null);
  t('المتأخرة بأولوية عادية حمراء', c({ title: 'ع5', priority: 'normal', due_date: D.addDays(today, -3) }) === 'red');
  t('المتأخر المنتظر أحمر (التأخر يستدعي تدخلًا)', c({ title: 'م2', due_date: D.addDays(today, -2) }, 'waiting_reply') === 'red');
  const fr = D.followRibbon(); const order = fr.map(i => ({ red: 0, blue: 1, gray: 2 })[i.color]);
  t('الشريط العلوي مرتب: العاجلة ← مهام اليوم ← قيد المتابعة', fr.length > 0 && order.every((v, k) => k === 0 || order[k - 1] <= v) && new Set(fr.map(i => i.color)).size === 3);
}

// ---- قطع الاتصال الفوري عند إيقاف الحساب أو تغيير كلمة المرور
{
  const events = require('../src/events');
  const cut = []; events.setTransport({ sendTo() { }, broadcast() { }, disconnect: (id) => cut.push(id) });
  const { id: uId } = await S.createUser(mgr, { name: 'مؤقت', username: 'tmp.cut', password: 'Tmp#2026xx' });
  await S.updateUser(mgr, uId, { password: 'Other#2026xx' });
  await S.updateUser(mgr, uId, { active: false });
  t('إيقاف الحساب وتغيير كلمة مروره يقطعان اتصاله الفوري', cut.filter(x => x === uId).length === 2);
  events.setTransport({ sendTo() { }, broadcast() { } });
}

// ---- التشفير: Web Push وكلمات المرور
{
  const nodeCrypto = require('crypto'); const ece = require('http_ece'); const push = require('../src/push'); const auth = require('../src/auth');
  const rx = nodeCrypto.createECDH('prime256v1'); rx.generateKeys();
  const authSecret = nodeCrypto.randomBytes(16);
  const text = JSON.stringify({ title: 'اختبار', body: 'رسالة عربية ✓' });
  const body = Buffer.from(await push.encryptPayload(rx.getPublicKey().toString('base64url'), authSecret.toString('base64url'), text));
  let plain = null; try { plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: rx, authSecret: authSecret.toString('base64url') }).toString('utf8'); } catch (e) { plain = 'ERR ' + e.message; }
  t('تشفير Web Push يفكّه مرجع مستقل (http_ece) إلى النص الأصلي', plain === text);
  const h = await auth.hashPassword('كلمة-سر-1234');
  t('كلمة المرور الصحيحة تُقبل والخاطئة تُرفض', (await auth.verifyPassword('كلمة-سر-1234', h)) && !(await auth.verifyPassword('كلمة-سر-1235', h)));
}

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${ok}/${ok + fail} نجحت`); process.exit(fail ? 1 : 0);
})();
