'use strict';
// بيانات أولية حقيقية يطلبها المكتب (ليست تجريبية): تُطبَّق مرة واحدة تلقائيًا عند تشغيل المنصة.
// كل مجموعة لها مفتاح؛ بعد نجاحها يُحفظ المفتاح في kv فلا تُعاد. وكل مجلد أو مهمة موجودة بالاسم نفسه تُتخطى (لا تكرار).
// قاعدة المكتب: أي مجلد بلا مهام تُنشأ له مهمة «متابعة <اسم المجلد>».
const { get, run, tx, kvGet, kvSet } = require('./db');

const DATASETS = [
  {
    key: 'seed:association-2026-11',
    section: 'association', // الجمعية
    direct: [ // مهام تحت القسم مباشرة
      'تفعيل مجلس الشؤون التعليمية بالمنطقة',
      'تفعيل المجلس الاستشاري للشؤون التعليمية',
      'آلية الرد على الإيميلات',
    ],
    folders: [
      { name: 'الخطة التشغيلية 2027', tasks: ['متابعة إنجاز الخطة التشغيلية'] },
      { name: 'وحدة التدريب', tasks: [] },
      { name: 'متابعة أداء الفريق', tasks: ['خطة لكل فرد في الفريق', 'مسابقة التميز والأداء في الإدارة التعليمية'] },
      { name: 'التمثل القرآني', tasks: ['تصوير المادة', 'مراجعة السيناريو', 'تحديد موعد التصوير'] },
      { name: 'الموارد البشرية', tasks: ['تسكين الموظفين الجدد'] },
      { name: 'مشروع التلقين', tasks: ['موازنة حلقات التلقين في المجمعات', 'شركة التلقين'] },
      { name: 'مدرسة عبدالعزيز المسند', tasks: ['متابعة أبو إياد بخصوص الصك'] },
      { name: 'وحدة الابتكار', tasks: ['مراجعة الملف وتطويره'] },
      { name: 'الموهوبون', tasks: ['اكتشاف الموهوبين من الطلاب', 'اكتشاف الموهوبين من المشرفين'] },
      { name: 'أفكار', tasks: ['رسائل وصايا إلى معلم القرآن', 'رسائل عن التمثل'] },
      { name: 'المباني والمرافق', tasks: [] },
      { name: 'الدعم', tasks: [] },
      { name: 'ورش الإدارة التعليمية', tasks: [] },
      { name: 'أفضل الممارسات', tasks: [] },
      { name: 'الشخصيات والجهات', tasks: [] },
    ],
  },
];

// تطبيق المجموعات التي لم تُطبَّق بعد. يتطلب وجود حساب مدير المكتب (منشئ المهام).
// SEED_DATA=0 يعطّلها (لبيئات الاختبار).
function applySeeds(cfg) {
  if (cfg && String(cfg.get('SEED_DATA', '1')) === '0') return [];
  const S = require('./services');
  const mgr = get("SELECT * FROM users WHERE role='manager' AND member=0 AND active=1 ORDER BY id LIMIT 1");
  if (!mgr) return [];
  const user = { ...mgr, role: 'manager' };
  const done = [];
  for (const ds of DATASETS) {
    if (kvGet(ds.key)) continue;
    const stats = tx(() => {
      const st = { folders: 0, tasks: 0, skipped: 0 };
      const taskExists = (title, folderId) => !!get(`SELECT id FROM items WHERE title=? AND section=? AND folder_id IS ? AND kind IN ('task','assignment') AND status!='cancelled'`, title, ds.section, folderId);
      const addTask = (title, folderId) => {
        if (taskExists(title, folderId)) { st.skipped++; return; }
        S.createTask(user, { title, section: ds.section, folder_id: folderId || undefined }); st.tasks++;
      };
      for (const t of ds.direct || []) addTask(t, null);
      for (const f of ds.folders || []) {
        let folder = get('SELECT id FROM folders WHERE section=? AND parent_id IS NULL AND name=?', ds.section, f.name);
        if (!folder) { folder = { id: run('INSERT INTO folders(section,name) VALUES(?,?)', ds.section, f.name).id }; S.audit('folder', folder.id, user.id, 'created'); st.folders++; } else st.skipped++;
        const tasks = f.tasks && f.tasks.length ? f.tasks : [`متابعة ${f.name}`];
        for (const t of tasks) addTask(t, folder.id);
      }
      kvSet(ds.key, new Date().toISOString());
      return st;
    });
    done.push({ key: ds.key, ...stats });
  }
  if (done.length) require('./events').broadcastChange({ seed: true });
  return done;
}

module.exports = { applySeeds, DATASETS };
