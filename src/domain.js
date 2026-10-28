'use strict';
// ثوابت المجال، الصلاحيات، وقواعد الحساب (الأشرطة، المربعات، التقارير)
const { get, all } = require('./db');

const TZ = process.env.TZ_NAME || 'Asia/Riyadh';

const SECTIONS = [
  { key: 'association', name: 'الجمعية', icon: 'building' },
  { key: 'dawah', name: 'المشاريع الدعوية', icon: 'mosque' },
  { key: 'commercial', name: 'التجاري', icon: 'briefcase' },
  { key: 'personal', name: 'الشخصي والأكاديمية', icon: 'graduation' },
  { key: 'family', name: 'الأسري', icon: 'home' },
  { key: 'partnerships', name: 'الشراكات', icon: 'handshake' },
];
const SECTION_KEYS = SECTIONS.map(s => s.key);
const sectionName = (k) => (SECTIONS.find(s => s.key === k) || {}).name || '—';

const STATUSES = {
  new: 'جديد',
  acknowledged: 'تم تأكيد الاستلام',
  in_progress: 'قيد التنفيذ',
  waiting_info: 'بانتظار معلومات',
  waiting_reply: 'بانتظار رد',
  waiting_approval: 'بانتظار اعتماد',
  done: 'مكتمل',
  stalled: 'متعثر',
  cancelled: 'ملغى',
};
const CLOSED_STATUSES = ['done', 'cancelled'];
const PRIORITIES = { normal: 'عادي', important: 'مهم', urgent: 'عاجل' };
const MSG_TYPES = {
  info: 'ملاحظة للاطلاع',
  action: 'طلب يحتاج إلى إجراء',
  modify: 'تعديل على مهمة قائمة',
  inquiry: 'استفسار',
  directive: 'توجيه أو قرار جديد',
};
const CATEGORIES = {
  general: 'مهمة', commitment: 'التزام', opportunity: 'فرصة', appointment: 'موعد', academic: 'مهمة أكاديمية',
};
const APPROVAL_KINDS = {
  report: 'تقرير للاعتماد', proposal: 'عرض أو مقترح', commercial: 'قرار تجاري', approval: 'طلب موافقة',
  guidance: 'مسألة تحتاج توجيه', inquiry: 'استفسار يعطل التنفيذ', final: 'اعتماد النتيجة النهائية',
};

// الصلاحيات تُفحص في الخادم لكل عملية — وليس بإخفاء الأزرار فقط
const PERMS = {
  owner: new Set([
    'item.view', 'item.message', 'assignment.create', 'note.create', 'item.cancel_own',
    'approval.decide', 'reports.view', 'meetings.view', 'sops.view', 'partners.view', 'contacts.view',
  ]),
  manager: new Set([
    'item.view', 'item.message', 'item.manage', 'task.create', 'approval.request',
    'reports.view', 'meetings.view', 'meetings.manage', 'sops.view', 'sops.manage',
    'partners.view', 'partners.manage', 'contacts.view', 'projects.manage',
  ]),
};
const can = (user, perm) => !!(user && PERMS[user.role] && PERMS[user.role].has(perm));

function todayStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

const TASK_KINDS = "('assignment','task')";
const OPEN = "status NOT IN ('done','cancelled')";

const ITEM_LIST_COLS = `i.id,i.ref,i.kind,i.msg_type,i.source,i.title,i.section,i.category,i.project_id,i.parent_id,i.priority,i.due_date,i.due_time,
  i.status,i.assignee,i.next_step,i.requires_approval,i.acknowledged_at,i.converted_at,i.created_at,i.updated_at,i.closed_at,i.completed_at,i.is_demo,
  i.created_by,(SELECT name FROM users u WHERE u.id=i.created_by) AS created_by_name,
  (SELECT COUNT(*) FROM approvals a WHERE a.item_id=i.id AND a.status='pending') AS pending_approvals,
  (SELECT p.name FROM projects p WHERE p.id=i.project_id) AS project_name,
  (SELECT COUNT(*) FROM files f WHERE f.item_id=i.id) AS files_count`;

function decorate(item, today = todayStr()) {
  if (!item) return item;
  const open = !CLOSED_STATUSES.includes(item.status);
  item.is_open = open;
  item.is_overdue = open && !!item.due_date && item.due_date < today;
  item.is_due_today = open && item.due_date === today;
  item.section_name = sectionName(item.section);
  item.status_label = STATUSES[item.status] || item.status;
  item.priority_label = PRIORITIES[item.priority];
  if (item.msg_type) item.msg_type_label = MSG_TYPES[item.msg_type];
  return item;
}

// ===== شريط مهام اليوم: كل مهمة/تكليف مفتوح موعده اليوم =====
function todayRibbon() {
  const t = todayStr();
  return all(`SELECT ${ITEM_LIST_COLS} FROM items i WHERE kind IN ${TASK_KINDS} AND ${OPEN} AND due_date=?
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, COALESCE(due_time,'99:99')`, t).map(i => decorate(i, t));
}

// ===== شريط المهام العاجلة: قواعد صريحة منفصلة عن تاريخ الاستحقاق =====
// 1) أولوية «عاجل» ومفتوحة   2) متأخرة وأولويتها «مهم» أو «عاجل»
// 3) حالتها «متعثر»            4) تنتظر قرارًا من رجل الأعمال يعطّل التنفيذ (طلب اعتماد مانع)
const URGENT_REASONS = {
  urgent: 'أولوية عاجلة', overdue: 'متأخرة وعالية الأولوية', stalled: 'متعثرة', decision: 'تنتظر قرارًا يعطل التنفيذ',
};
function urgentRibbon() {
  const t = todayStr();
  const rows = all(`SELECT ${ITEM_LIST_COLS},
      (SELECT COUNT(*) FROM approvals a WHERE a.item_id=i.id AND a.status='pending' AND a.blocking=1) AS blocking_approvals
    FROM items i WHERE kind IN ${TASK_KINDS} AND ${OPEN} AND (
      priority='urgent'
      OR (due_date < ? AND priority IN ('important','urgent'))
      OR status='stalled'
      OR EXISTS (SELECT 1 FROM approvals a WHERE a.item_id=i.id AND a.status='pending' AND a.blocking=1)
    )`, t);
  return rows.map(i => {
    decorate(i, t);
    const reasons = [];
    if (i.priority === 'urgent') reasons.push('urgent');
    if (i.is_overdue && i.priority !== 'normal') reasons.push('overdue');
    if (i.status === 'stalled') reasons.push('stalled');
    if (i.blocking_approvals > 0) reasons.push('decision');
    i.urgent_reasons = reasons.map(r => URGENT_REASONS[r]);
    i.urgent_score = (reasons.includes('urgent') ? 4 : 0) + (reasons.includes('overdue') ? 3 : 0) + (reasons.includes('stalled') ? 2 : 0) + (reasons.includes('decision') ? 2 : 0);
    return i;
  }).sort((a, b) => b.urgent_score - a.urgent_score || String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
}

// ===== المربعات الستة: كل الأرقام من قاعدة البيانات =====
function sectionStats(key) {
  const t = todayStr(); const week = addDays(t, 7);
  const c = (sql, ...p) => get(sql, ...p).c;
  const base = `FROM items WHERE section=? AND kind IN ${TASK_KINDS}`;
  const s = {
    key, name: sectionName(key),
    open: c(`SELECT COUNT(*) c ${base} AND ${OPEN}`, key),
    due_today: c(`SELECT COUNT(*) c ${base} AND ${OPEN} AND due_date=?`, key, t),
    overdue: c(`SELECT COUNT(*) c ${base} AND ${OPEN} AND due_date<?`, key, t),
    awaiting_decision: c(`SELECT COUNT(*) c FROM approvals a JOIN items i ON i.id=a.item_id WHERE i.section=? AND a.status='pending'`, key),
    unacknowledged: c(`SELECT COUNT(*) c FROM items WHERE section=? AND kind IN ('assignment','note') AND acknowledged_at IS NULL AND status!='cancelled'`, key),
  };
  const top = get(`SELECT id,ref,title,due_date,priority,status FROM items WHERE section=? AND kind IN ${TASK_KINDS} AND ${OPEN}
    ORDER BY CASE WHEN status='stalled' THEN 0 WHEN priority='urgent' THEN 1 WHEN due_date<? THEN 2 WHEN due_date=? THEN 3 WHEN priority='important' THEN 4 ELSE 5 END,
    COALESCE(due_date,'9999-12-31') LIMIT 1`, key, t, t);
  s.top = top ? decorate(top, t) : null;
  const catOpen = (cat) => c(`SELECT COUNT(*) c ${base} AND ${OPEN} AND category=?`, key, cat);
  const activeProjects = c(`SELECT COUNT(*) c FROM projects WHERE section=? AND status='active'`, key);
  const upcomingAppts = c(`SELECT COUNT(*) c ${base} AND ${OPEN} AND category IN ('appointment','commitment') AND due_date BETWEEN ? AND ?`, key, t, week);
  switch (key) {
    case 'association': s.extra = [{ label: 'المبادرات والمشاريع', value: activeProjects }, { label: 'اعتمادات مطلوبة', value: s.awaiting_decision }]; break;
    case 'dawah': s.extra = [{ label: 'مشاريع جارية', value: activeProjects }, { label: 'مستحقة خلال أسبوع', value: c(`SELECT COUNT(*) c ${base} AND ${OPEN} AND due_date BETWEEN ? AND ?`, key, t, week) }]; break;
    case 'commercial': s.extra = [{ label: 'التزامات تجارية', value: catOpen('commitment') }, { label: 'فرص للمتابعة', value: catOpen('opportunity') }]; break;
    case 'personal': s.extra = [{ label: 'مواعيد خلال أسبوع', value: upcomingAppts }, { label: 'مهام أكاديمية', value: catOpen('academic') }]; break;
    case 'family': s.extra = [{ label: 'مواعيد والتزامات قادمة', value: upcomingAppts }]; break;
    case 'partnerships': {
      s.extra = [
        { label: 'جهات تنتظر ردًا', value: c(`SELECT COUNT(*) c FROM partners WHERE awaiting_reply=1`) },
        { label: 'اتصالات خلال أسبوع', value: c(`SELECT COUNT(*) c FROM partners WHERE next_followup BETWEEN ? AND ?`, t, week) },
        { label: 'فرص مفتوحة', value: catOpen('opportunity') },
      ];
      s.due_today += c(`SELECT COUNT(*) c FROM partners WHERE next_followup=?`, t);
      break;
    }
  }
  return s;
}

// ===== التقارير =====
function report(period = 'week') {
  const t = todayStr();
  const from = period === 'day' ? t : period === 'month' ? addDays(t, -29) : addDays(t, -6);
  // نحوّل الحدود إلى UTC تقريبيًا بتوقيت الرياض (+03:00)
  const fromIso = new Date(from + 'T00:00:00+03:00').toISOString();
  const c = (sql, ...p) => get(sql, ...p).c;
  const r = {
    period, from, to: t,
    // التكليفات المستلمة من رجل الأعمال (تبقى source='owner' حتى بعد تحويلها إلى مهمة)
    received: c(`SELECT COUNT(*) c FROM items WHERE kind IN ('assignment','task') AND source='owner' AND created_at>=?`, fromIso),
    notes_received: c(`SELECT COUNT(*) c FROM items WHERE kind='note' AND created_at>=?`, fromIso),
    completed: c(`SELECT COUNT(*) c FROM items WHERE kind IN ${TASK_KINDS} AND status='done' AND completed_at>=?`, fromIso),
    overdue_now: c(`SELECT COUNT(*) c FROM items WHERE kind IN ${TASK_KINDS} AND ${OPEN} AND due_date<?`, t),
    open_now: c(`SELECT COUNT(*) c FROM items WHERE kind IN ${TASK_KINDS} AND ${OPEN}`),
    decisions_made: c(`SELECT COUNT(*) c FROM approvals WHERE decided_at>=?`, fromIso),
    meeting_decisions_done: c(`SELECT COUNT(*) c FROM decisions d LEFT JOIN items i ON i.id=d.task_id WHERE COALESCE(i.status,d.status)='done'`),
    meeting_decisions_pending: c(`SELECT COUNT(*) c FROM decisions d LEFT JOIN items i ON i.id=d.task_id WHERE COALESCE(i.status,d.status) NOT IN ('done','cancelled')`),
    approvals_pending: c(`SELECT COUNT(*) c FROM approvals WHERE status='pending'`),
  };
  r.by_section = SECTIONS.map(s => ({
    key: s.key, name: s.name,
    open: c(`SELECT COUNT(*) c FROM items WHERE section=? AND kind IN ${TASK_KINDS} AND ${OPEN}`, s.key),
    completed: c(`SELECT COUNT(*) c FROM items WHERE section=? AND kind IN ${TASK_KINDS} AND status='done' AND completed_at>=?`, s.key, fromIso),
    overdue: c(`SELECT COUNT(*) c FROM items WHERE section=? AND kind IN ${TASK_KINDS} AND ${OPEN} AND due_date<?`, s.key, t),
  }));
  const done = all(`SELECT created_at, completed_at FROM items WHERE kind IN ${TASK_KINDS} AND status='done' AND completed_at IS NOT NULL AND completed_at>=?`, fromIso);
  r.avg_completion_days = done.length >= 3
    ? Math.round(done.reduce((s, x) => s + (new Date(x.completed_at) - new Date(x.created_at)), 0) / done.length / 86400000 * 10) / 10
    : null; // بيانات غير كافية
  r.completed_items = all(`SELECT ${ITEM_LIST_COLS} FROM items i WHERE kind IN ${TASK_KINDS} AND status='done' AND completed_at>=? ORDER BY completed_at DESC LIMIT 50`, fromIso).map(i => decorate(i, t));
  return r;
}

module.exports = {
  TZ, SECTIONS, SECTION_KEYS, sectionName, STATUSES, CLOSED_STATUSES, PRIORITIES, MSG_TYPES, CATEGORIES, APPROVAL_KINDS,
  PERMS, can, todayStr, addDays, decorate, todayRibbon, urgentRibbon, sectionStats, report, ITEM_LIST_COLS, TASK_KINDS, OPEN,
};
