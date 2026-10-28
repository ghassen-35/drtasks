'use strict';
// بيانات تجريبية مميزة بوضوح (is_demo=1 وتظهر بشارة «بيانات تجريبية») — للإضافة: npm run demo:seed  للحذف: npm run demo:clear
const { get, all, run, tx, ensureUsers } = require('../src/db');
const D = require('../src/domain');
const S = require('../src/services');

const cmd = process.argv[2];
ensureUsers();
const owner = get("SELECT * FROM users WHERE role='owner'");
const manager = get("SELECT * FROM users WHERE role='manager'");

function clear() {
  tx(() => {
    const ids = all('SELECT id FROM items WHERE is_demo=1').map(r => r.id);
    if (ids.length) {
      const q = ids.join(',');
      run(`DELETE FROM files WHERE item_id IN (${q})`);
      run(`DELETE FROM messages WHERE item_id IN (${q})`);
      run(`DELETE FROM approvals WHERE item_id IN (${q})`);
      run(`DELETE FROM audit_log WHERE entity='item' AND entity_id IN (${q})`);
      run(`UPDATE decisions SET task_id=NULL WHERE task_id IN (${q})`);
      run(`UPDATE items SET parent_id=NULL WHERE parent_id IN (${q})`);
      run(`DELETE FROM items WHERE id IN (${q})`);
    }
    run('DELETE FROM decisions WHERE meeting_id IN (SELECT id FROM meetings WHERE is_demo=1)');
    for (const t of ['meetings', 'sops', 'partners']) run(`DELETE FROM ${t} WHERE is_demo=1`);
    run('UPDATE items SET project_id=NULL WHERE project_id IN (SELECT id FROM projects WHERE is_demo=1)');
    run('DELETE FROM projects WHERE is_demo=1');
    run("DELETE FROM notifications WHERE link LIKE '#/item/%' AND CAST(substr(link,9) AS INTEGER) NOT IN (SELECT id FROM items)");
    console.log(`حُذفت البيانات التجريبية (${ids.length} عنصر)`);
  });
}

function seed() {
  if (get('SELECT id FROM items WHERE is_demo=1')) { console.log('البيانات التجريبية موجودة بالفعل'); return; }
  const t = D.todayStr(); const d = (n) => D.addDays(t, n);
  const notifBefore = get('SELECT COALESCE(MAX(id),0) m FROM notifications').m;
  tx(() => {
    const proj = (section, name) => run('INSERT INTO projects(section,name,description,is_demo) VALUES(?,?,?,1)', section, name, 'مشروع تجريبي').id;
    const p1 = proj('association', 'برنامج الحفاظ الصيفي');
    const p2 = proj('dawah', 'مشروع الدورات العلمية');
    proj('commercial', 'توسعة النشاط العقاري');
    const sop = run(`INSERT INTO sops(name,purpose,steps,responsible,section,approved_at,is_demo) VALUES(?,?,?,?,?,?,1)`,
      'إجراء رفع التقارير الشهرية للجمعية', 'توحيد طريقة إعداد التقرير الشهري واعتماده',
      'جمع بيانات البرامج من المشرفين\nإعداد مسودة التقرير وفق النموذج المعتمد\nمراجعة الأرقام مع المحاسب\nرفع التقرير لرجل الأعمال للاعتماد عبر المنصة\nإرسال النسخة المعتمدة للجهات ذات العلاقة',
      'مدير المكتب', 'association', d(-60)).id;
    const partner = run(`INSERT INTO partners(name,entity_type,relation_type,phone,email,last_contact_at,commitments,next_followup,opportunities,awaiting_reply,is_demo) VALUES(?,?,?,?,?,?,?,?,?,?,1)`,
      'مؤسسة الخير المانحة (تجريبي)', 'org', 'جهة مانحة', '+966500000000', 'demo@example.invalid', d(-10), 'وعد بدعم برنامج الحفاظ الصيفي', d(2), 'منحة تشغيلية للعام القادم', 1).id;

    const mk = (fn, user, b) => fn(user, { ...b, is_demo: 1 });
    const a1 = mk(S.createAssignment, owner, { title: 'إعداد خطة برنامج الحفاظ الصيفي', description: 'خطة تفصيلية بالميزانية والجدول', section: 'association', priority: 'important', due_date: t });
    S.acknowledge(manager, a1.id);
    S.convertToTask(manager, a1.id, { assignee: 'مدير المكتب', next_step: 'جمع عروض المشرفين', project_id: p1, requires_approval: 1, sop_id: sop });
    S.updateItem(manager, a1.id, { status: 'in_progress' });
    const a2 = mk(S.createAssignment, owner, { title: 'متابعة تجديد السجل التجاري', section: 'commercial', priority: 'urgent', due_date: d(1) });
    mk(S.createAssignment, owner, { title: 'ترتيب موعد الكشف الطبي السنوي', section: 'family', priority: 'normal', due_date: d(3) });
    const t1 = mk(S.createTask, manager, { title: 'تجهيز محاضرة الدورة العلمية', section: 'dawah', project_id: p2, due_date: d(-2), priority: 'important' });
    S.updateItem(manager, t1.id, { status: 'in_progress' });
    const t2 = mk(S.createTask, manager, { title: 'الرد على مقترح الشراكة مع المؤسسة المانحة', section: 'partnerships', partner_id: partner, category: 'opportunity', due_date: t });
    S.requestApproval(manager, t2.id, { kind: 'proposal', title: 'اختيار صيغة الشراكة', body: 'تلقينا مقترحين من الجهة المانحة', options: ['شراكة سنوية', 'دعم برنامج واحد'] });
    mk(S.createTask, manager, { title: 'مراجعة جدول مواد الفصل الدراسي', section: 'personal', category: 'academic', due_date: d(5) });
    const t3 = mk(S.createTask, manager, { title: 'تسليم عقد التوريد للمحامي', section: 'commercial', category: 'commitment', due_date: d(-1) });
    S.updateItem(manager, t3.id, { status: 'stalled', status_note: 'بانتظار توقيع الطرف الآخر' });
    mk(S.createNote, owner, { msg_type: 'info', description: 'أفدت الجهة المانحة أنها ستتواصل الأسبوع القادم', section: 'partnerships' });
    void a2;
    const m = run(`INSERT INTO meetings(title,section,starts_at,location,participants,topics,status,is_demo,created_by) VALUES(?,?,?,?,?,?,?,1,?)`,
      'اجتماع مجلس إدارة الجمعية', 'association', `${d(4)}T19:30`, 'مقر الجمعية', 'رجل الأعمال، أعضاء المجلس، مدير المكتب', 'الخطة السنوية\nالميزانية', 'scheduled', manager.id).id;
    const m2 = run(`INSERT INTO meetings(title,section,starts_at,location,participants,minutes,status,is_demo,created_by) VALUES(?,?,?,?,?,?,?,1,?)`,
      'اجتماع متابعة المشاريع الدعوية', 'dawah', `${d(-7)}T10:00`, 'المكتب', 'رجل الأعمال، مدير المكتب', 'نوقشت خطة الدورات واعتُمد الجدول المبدئي.', 'held', manager.id).id;
    run('INSERT INTO decisions(meeting_id,text,responsible,due_date) VALUES(?,?,?,?)', m2, 'اعتماد جدول الدورات للفصل القادم', 'مدير المكتب', d(-1));
    const dec2 = run('INSERT INTO decisions(meeting_id,text,responsible,due_date) VALUES(?,?,?,?)', m2, 'التواصل مع المحاضرين وتأكيد مشاركتهم', 'مدير المكتب', d(6)).id;
    const tk = S.decisionToTask(manager, dec2, {});
    run('UPDATE items SET is_demo=1 WHERE id=?', tk.id);
    void m;
  });
  run('DELETE FROM notifications WHERE id>?', notifBefore);
  console.log('أُضيفت بيانات تجريبية مميزة (is_demo=1). للحذف: npm run demo:clear');
}

if (cmd === 'seed') seed();
else if (cmd === 'clear') clear();
else console.log('الاستخدام: node scripts/demo.js seed|clear');
