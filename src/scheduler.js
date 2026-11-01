'use strict';
// المهام الدورية (كل 5 دقائق): تذكير المواعيد والتأخر، الملخص اليومي، تنظيف الجلسات
const { get, all, run, nowIso } = require('./db');
const D = require('./domain');
const N = require('./notify');

// ===== المهام المجدولة: تذكير المواعيد، التأخر، الملخص اليومي، النسخ الاحتياطي =====
function runScheduler({ dailyBackup } = {}) {
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
      if (dailyBackup) dailyBackup();
    }
    run('DELETE FROM sessions WHERE expires_at<?', nowIso());
  } catch (e) { console.error('scheduler', e); }
}


module.exports = { runScheduler };
