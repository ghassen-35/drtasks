'use strict';
// اختبارات منطق الخادم: قواعد الشريط العاجل، منع تكرار الإشعارات، الإشعارات المجدولة، عدم التكرار عند التحويل
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'office-unit-'));
const { get, all, run, ensureUsers } = require('../src/db');
const D = require('../src/domain');
const S = require('../src/services');
const { scheduler } = require('../src/server');
ensureUsers();
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

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${ok}/${ok + fail} نجحت`); process.exit(fail ? 1 : 0);
