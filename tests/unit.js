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
  t('لا يمكن إيقاف حساب رجل الأعمال', e3 === 400);
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
