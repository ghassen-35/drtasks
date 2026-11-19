'use strict';
/* منصة إدارة مكتب عبدالله عبدالعزيز التويجري — الواجهة (بدون أطر خارجية) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I = (n, c) => window.icon(n, c);
const state = { me: null, meta: null, view: null, stale: false, counts: {} };
const app = $('#app');

// ===== الاتصال بالخادم =====
async function api(method, url, body) {
  const opt = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  let data = null; try { data = await res.json(); } catch { }
  // انتهت الجلسة: تظهر شاشة الدخول ويُترك الطلب معلقًا (لا خطأ غير ملتقط من طلبات خلفية متزامنة)
  if (res.status === 401 && url !== '/api/login') { if (state.me) { state.me = null; renderLogin('انتهت جلستك. سجّل الدخول من جديد.'); } else if (!$('#lf')) renderLogin(); return new Promise(() => { }); }
  if (!res.ok) throw new Error((data && data.error) || 'تعذر تنفيذ الطلب');
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b = {}) => api('POST', u, b);

// ===== تنسيق التواريخ =====
const today = () => state.meta ? state.meta.today : new Date().toISOString().slice(0, 10);
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const dfmt = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'short', day: 'numeric', month: 'short' });
const dfmtY = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'short', year: 'numeric' });
const tfmt = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { hour: 'numeric', minute: '2-digit' });
function fmtDate(d) {
  if (!d) return '—';
  const t = today();
  if (d === t) return 'اليوم'; if (d === addDays(t, 1)) return 'غدًا'; if (d === addDays(t, -1)) return 'أمس';
  const x = new Date(d.slice(0, 10) + 'T12:00:00Z');
  return d.slice(0, 4) === t.slice(0, 4) ? dfmt.format(x) : dfmtY.format(x);
}
function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso); const s = (Date.now() - d) / 1000;
  if (s < 60) return 'الآن';
  if (s < 3600) { const m = Math.floor(s / 60); return m === 1 ? 'منذ دقيقة' : m === 2 ? 'منذ دقيقتين' : `منذ ${m} دقيقة`; }
  if (s < 86400) { const h = Math.floor(s / 3600); return h === 1 ? 'منذ ساعة' : h === 2 ? 'منذ ساعتين' : `منذ ${h} ساعات`; }
  return `${dfmtY.format(d)} ${tfmt.format(d)}`;
}
const fmtDue = (i) => i.due_date ? `${fmtDate(i.due_date)}${i.due_time ? ' ' + i.due_time : ''}` : 'بدون موعد';

// ===== عناصر مشتركة =====
const statusChip = (s) => `<span class="chip st-${s}">${esc(state.meta.statuses[s] || s)}</span>`;
const prioChip = (p) => p === 'normal' ? '' : `<span class="chip p-${p}">${esc(state.meta.priorities[p])}</span>`;
const dueChip = (i) => !i.due_date ? '' : `<span class="chip ${i.is_overdue ? 'overdue' : i.is_due_today ? 'today' : ''}">${I('clock')}${esc(fmtDue(i))}${i.is_overdue ? ' — متأخرة' : ''}</span>`;
const kindLabel = (i) => i.kind === 'assignment' ? 'تكليف' : i.kind === 'note' ? (i.msg_type_label || 'ملاحظة') : 'مهمة';
const sectionName = (k) => (state.meta.sections.find(s => s.key === k) || {}).name || '—';
const demoChip = (x) => x.is_demo ? '<span class="chip demo">بيانات تجريبية</span>' : '';
// التحية: الحساب الأعلى بعباراته المعتمدة بينها فاصل، والبقية بأسمائهم (تُرجع HTML آمنًا)
const hello = () => state.me.role === 'owner' && state.meta && state.meta.owner_greeting
  ? state.meta.owner_greeting.split('|').map(x => x.trim()).filter(Boolean).map(x => `<span class="g-part">${esc(x)}</span>`).join('<span class="g-sep" aria-hidden="true">·</span>')
  : esc(`مرحبًا، ${state.me.name}`);
const OT = () => (state.meta && state.meta.owner_title) || 'مدير الشؤون التعليمية'; // مسمى الحساب الأعلى
const isOwner = () => state.me.role === 'owner';
const isManager = () => state.me.role === 'manager';
const isMember = () => state.me.role === 'member';
const DEFAULT_APP_NAME = 'مكتب عبدالله عبدالعزيز التويجري';
const appName = () => (state.meta && state.meta.app_name) || state.appName || DEFAULT_APP_NAME;
const can = (p) => state.me.perms.includes(p);
const canAddAny = () => can('task.create') || can('assignment.create') || can('projects.manage');
const canEditItem = (i) => can('item.manage') || (can('item.edit') && (!isMember() || !i || i.kind === 'task'));
const canAddSub = () => ['task.create', 'item.edit', 'subtask.create'].some(can);

// ألوان المهام المعتمدة: أحمر عاجلة، أزرق مستحقة، رمادي معلقة
const COLOR_ICON = { red: 'alert', blue: 'clock', gray: 'bell' };
const COLOR_TITLE = { red: 'الأحمر: عاجلة', blue: 'الأزرق: مهام اليوم', gray: 'الرمادي: قيد المتابعة' };
const colorChip = (i) => i.color ? `<span class="chip col-${i.color}" title="${esc(state.meta.colors[i.color].hint)}">${I(COLOR_ICON[i.color])}${esc(state.meta.colors[i.color].label)}</span>` : '';
const colorLegendHtml = (counts) => `<div class="r-legend small color-legend">${['red', 'blue', 'gray'].map(c => `<span title="${esc(state.meta.colors[c].hint)}"><i class="lg c-${c}"></i>${esc(state.meta.colors[c].label)}${counts ? ` (${counts[c] || 0})` : ''}</span>`).join('')}
  <details><summary>ما معنى الألوان؟</summary>${['red', 'blue', 'gray'].map(c => `<div class="color-explain"><span class="cbox c-${c}">${I(COLOR_ICON[c])}</span><div><b>${COLOR_TITLE[c]}</b><div class="small muted">${esc(state.meta.colors[c].hint)}</div></div></div>`).join('')}</details></div>`;
// مفتاح الألوان الظاهر تحت الشريط: اللون ومسماه وعدده وتفسيره، بالترتيب المعتمد
const colorKeyHtml = (counts) => `<div class="color-key" aria-label="تفسير الألوان">${['red', 'blue', 'gray'].map(c => `<a class="ck c-${c}" href="#/tasks?scope=open&color=${c}">
    <span class="cbox c-${c}">${I(COLOR_ICON[c])}</span>
    <span class="ck-t"><b>${esc(state.meta.colors[c].label)} <span class="n">${counts[c] || 0}</span></b><small>${esc(state.meta.colors[c].hint)}</small></span></a>`).join('')}</div>`;
function itemRow(i, { actions = '', showSection = true, showUpdated = false } = {}) {
  return `<div class="row c-${i.color || 'none'} ${i.status === 'done' ? 'done' : ''}">
    <div class="main">
      <a class="title" href="#/item/${i.id}">${esc(i.title)}</a>
      <div class="meta">
        ${i.kind !== 'task' ? `<span class="chip kind">${esc(kindLabel(i))}</span>` : ''}
        ${colorChip(i)}${statusChip(i.status)} ${i.color === 'red' && i.priority === 'urgent' ? '' : prioChip(i.priority)} ${dueChip(i)}
        ${i.recurrence ? `<span class="chip rec">${I('repeat')}${esc(state.meta.recurrences[i.recurrence] || '')}</span>` : ''}
        ${i.subtasks_total ? `<span class="chip">${I('list')}${i.subtasks_done}/${i.subtasks_total}</span>` : ''}
        ${i.parent_task_id ? `<span class="chip">فرعية من: ${esc(i.parent_task_title || '')}</span>` : ''}
        ${showSection && i.section ? `<span class="chip">${esc(sectionName(i.section))}</span>` : ''}
        ${i.pending_approvals ? `<span class="chip st-waiting_approval">${I('gavel')}بانتظار قرار</span>` : ''}
        ${i.files_count ? `<span class="chip">${I('clip')}${i.files_count}</span>` : ''}
        ${demoChip(i)}
        <span class="txt ltr">${esc(i.ref)}</span>
        ${i.assignee ? `<span class="txt">المسؤول: ${esc(i.assignee)}</span>` : ''}
        ${showUpdated ? `<span class="txt">آخر تحديث: ${fmtTs(i.updated_at)}</span>` : ''}
      </div>
      ${i.next_step ? `<div class="small muted" style="margin-top:4px">الخطوة التالية: ${esc(i.next_step)}</div>` : ''}
    </div>
    ${actions ? `<div class="side">${actions}</div>` : ''}
  </div>`;
}
const countTxt = (n, one, two, many) => n === 0 ? 'لا نتائج' : n === 1 ? `${one} واحدة` : n === 2 ? two : `${n} ${n <= 10 ? many : one}`;
const listOrEmpty = (items, fn, empty = 'لا توجد عناصر') => items.length ? `<div class="list">${items.map(fn).join('')}</div>` : `<div class="empty">${empty}</div>`;

// نوعان: نتيجة إجراء المستخدم (تظهر دائمًا وتحل محل سابقتها)، والإشعارات الواردة (واحد ظاهر، والبقية تُجمع في «تنبيهات أخرى»)
function toast(msg, kind = '', onClick, { notif = false } = {}) {
  if (!notif) $$('#toasts .toast.act').forEach(t => t.remove());
  if (notif && $$('#toasts .toast.notif').length >= 1) {
    let more = $('#toasts .toast.more');
    if (!more) { more = document.createElement('div'); more.className = 'toast more'; more.dataset.n = '0'; more.setAttribute('role', 'status'); more.onclick = () => { more.remove(); location.hash = '#/notifications'; }; $('#toasts').appendChild(more); }
    more.dataset.n = String(Number(more.dataset.n) + 1);
    more.textContent = `+${more.dataset.n} ${Number(more.dataset.n) === 1 ? 'تنبيه آخر' : 'تنبيهات أخرى'} — اضغط لعرض الإشعارات`;
    clearTimeout(more._t); more._t = setTimeout(() => more.remove(), 9000);
    return;
  }
  const el = document.createElement('div'); el.className = `toast ${kind} ${notif ? 'notif' : 'act'}`; el.textContent = msg; el.setAttribute('role', 'status');
  el.onclick = () => { el.remove(); onClick && onClick(); };
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), kind === 'urgent' ? 9000 : notif ? 6000 : 4500);
}
const showErr = (e) => toast(e.message || String(e), 'err');

// ===== النوافذ المنبثقة =====
function openModal({ title, body, submit = 'حفظ', submitClass = 'primary', onSubmit, wide = false, init }) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal" ${wide ? 'style="max-width:820px"' : ''} novalidate>
    <div class="mh"><h2>${esc(title)}</h2><button type="button" class="iconbtn" data-close aria-label="إغلاق">${I('x')}</button></div>
    <div class="mb"><div class="err-box hidden"></div>${body}</div>
    <div class="mf">${onSubmit ? `<button class="btn ${submitClass}" type="submit">${esc(submit)}</button>` : ''}<button type="button" class="btn ghost" data-close>${onSubmit ? 'إلغاء' : 'إغلاق'}</button></div>
  </form>`;
  document.body.appendChild(bg); document.body.style.overflow = 'hidden';
  const form = $('form', bg);
  // Escape يغلق النافذة العليا أينما كان التركيز
  const onKey = (e) => { if (e.key === 'Escape' && bg === $$('.modal-bg').pop()) close(); };
  const close = () => { document.removeEventListener('keydown', onKey); bg.remove(); document.body.style.overflow = ''; if (state.reloadMe && !$('.modal-bg')) { state.reloadMe = false; onChange({ user: state.me.id }); } else if (state.stale) refreshView(); };
  $$('[data-close]', bg).forEach(b => b.onclick = close);
  // الضغط خارج النافذة لا يضيّع ما كُتب دون تأكيد
  let dirty = false; form.addEventListener('input', () => { dirty = true; });
  bg.addEventListener('mousedown', e => { if (e.target === bg && (!dirty || confirm('إغلاق النافذة وتجاهل ما كتبته؟'))) close(); });
  document.addEventListener('keydown', onKey);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form); btn.disabled = true;
    const err = $('.err-box', form); err.classList.add('hidden');
    try { await onSubmit(formData(form), form); close(); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); }
    finally { btn.disabled = false; }
  };
  if (init) init(form);
  initFileFields(form);
  setTimeout(() => { const f = $('input:not([type=hidden]):not([type=radio]):not([type=checkbox]),textarea', form); f && f.focus(); }, 50);
  return { form, close };
}
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') { if (el.dataset.multi) { (o[el.name] = o[el.name] || []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value;
  }
  $$('.filefield', form).forEach(ff => { o[ff.dataset.name || 'file_ids'] = JSON.parse(ff.dataset.ids || '[]'); });
  return o;
}
const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(sel ?? '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
// الأقسام التي يعمل فيها المستخدم (الموظف بنطاق «أقسام محددة» يرى أقسامه فقط)
const mySections = () => { const g = state.me.grants; return g && g.scope === 'sections' ? state.meta.sections.filter(s => g.sections.includes(s.key)) : state.meta.sections; };
const sectionSelect = (sel, name = 'section', blank = false) => `<select name="${name}">${blank ? opt('', '— اختر —', sel) : ''}${mySections().map(s => opt(s.key, s.name, sel)).join('')}</select>`;
const sectionSeg = (sel, name = 'section') => `<div class="seg">${mySections().map(s => `<label><input type="radio" name="${name}" value="${s.key}" ${sel === s.key ? 'checked' : ''}><span>${esc(s.name)}</span></label>`).join('')}</div>`;
const prioSeg = (sel = 'normal') => `<div class="seg">${Object.entries(state.meta.priorities).map(([k, v]) => `<label><input type="radio" name="priority" value="${k}" ${sel === k ? 'checked' : ''}><span class="p-${k}">${v}</span></label>`).join('')}</div>`;
const field = (label, html) => `<label class="f"><span>${label}</span>${html}</label>`;

// ===== المجلدات: أسماء بالمسار الكامل (مجلد / مجلد فرعي) =====
function folderPaths(folders) {
  const by = Object.fromEntries(folders.map(f => [f.id, f]));
  const pathOf = (f) => { const p = []; for (let x = f, n = 0; x && n < 20; x = by[x.parent_id], n++) p.unshift(x.name); return p.join(' / '); };
  return folders.map(f => ({ ...f, path: pathOf(f) })).sort((a, b) => (a.section + a.path).localeCompare(b.section + b.path, 'ar'));
}
const optData = (v, label, sel, data = '') => `<option value="${esc(v)}" ${String(sel ?? '') === String(v) ? 'selected' : ''} ${data}>${esc(label)}</option>`;
const folderSelect = (folders, sel, blank = '— بدون مجلد —') => `<select name="folder_id">${opt('', blank, sel)}${folderPaths(folders).map(fo => optData(fo.id, fo.path, sel, `data-section="${fo.section}"`)).join('')}</select>`;

// ===== نوع المهمة: مستقلة، دورية، ضمن مشروع، ضمن مبادرة =====
const TASK_TYPES = { single: 'مستقلة', recurring: 'دورية', project: 'ضمن مشروع', initiative: 'ضمن مبادرة' };
function taskTypeOf(i, projects) {
  if (i.recurrence) return 'recurring';
  if (i.project_id) { const p = projects.find(x => x.id == i.project_id); return p && p.kind === 'initiative' ? 'initiative' : 'project'; }
  return i.task_type || 'single';
}
function classifyHtml(i, projects) {
  const t = taskTypeOf(i, projects);
  return `${field('نوع المهمة', `<div class="seg">${Object.entries(TASK_TYPES).map(([k, v]) => `<label><input type="radio" name="task_type" value="${k}" ${k === t ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>`)}
    <div class="grid2">
      <label class="f" data-show="recurring"><span>تتكرر</span><select name="recurrence">${Object.entries(state.meta.recurrences).map(([k, v]) => opt(k, v, i.recurrence || 'weekly')).join('')}</select></label>
      <label class="f" data-show="project initiative"><span data-plabel>المشروع</span><select name="project_id">${opt('', '— اختر —', i.project_id)}${projects.map(p => optData(p.id, `${sectionName(p.section)}: ${p.name}`, i.project_id, `data-section="${p.section}" data-folder="${p.folder_id || ''}" data-kind="${p.kind || 'project'}"`)).join('')}</select></label>
    </div>
    <p class="small muted" data-show="recurring">عند إنجاز المهمة الدورية تُنشأ تلقائيًا للموعد التالي.</p>`;
}
// تحويل اختيار «نوع المهمة» إلى الحقول التي يحفظها الخادم
function applyTaskType(d) {
  const t = d.task_type; delete d.task_type;
  if (t === undefined) return d;
  if (t !== 'recurring') d.recurrence = '';
  if (t === 'recurring' && !d.recurrence) throw new Error('اختر مدة التكرار');
  if (t === 'project' || t === 'initiative') { if (!d.project_id) throw new Error(t === 'initiative' ? 'اختر المبادرة' : 'اختر المشروع'); }
  else d.project_id = '';
  return d;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { }
  const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
}

// ===== المرفقات والملاحظات الصوتية =====
function fileFieldHtml(name = 'file_ids', voice = true) {
  return `<div class="filefield" data-name="${name}" data-ids="[]">
    <div class="btn-row">
      <label class="btn sm">${I('clip')} إرفاق ملفات أو صور<input type="file" multiple hidden></label>
      ${voice && window.MediaRecorder && navigator.mediaDevices ? `<button type="button" class="btn sm" data-rec>${I('mic')} ملاحظة صوتية</button>` : ''}
      <span class="rec hidden">جارٍ التسجيل…</span>
    </div>
    <div class="files"></div>
  </div>`;
}
function initFileFields(root) {
  $$('.filefield', root).forEach(ff => {
    if (ff.dataset.bound) return; ff.dataset.bound = 1;
    const list = $('.files', ff);
    const add = (f) => {
      const ids = JSON.parse(ff.dataset.ids); ids.push(f.id); ff.dataset.ids = JSON.stringify(ids);
      const chip = document.createElement('span'); chip.className = 'file';
      chip.innerHTML = `${I(f.is_voice ? 'mic' : 'file')}<span>${esc(f.original_name)}</span><button type="button" aria-label="إزالة">${I('x')}</button>`;
      $('button', chip).onclick = () => { ff.dataset.ids = JSON.stringify(JSON.parse(ff.dataset.ids).filter(x => x !== f.id)); chip.remove(); };
      list.appendChild(chip);
    };
    const upload = async (files, voice = false) => {
      const fd = new FormData(); for (const f of files) fd.append('files', f); if (voice) fd.append('voice', '1');
      try { (await api('POST', '/api/files', fd)).forEach(add); } catch (e) { showErr(e); }
    };
    const inp = $('input[type=file]', ff);
    inp.onchange = () => { if (inp.files.length) upload(inp.files); inp.value = ''; };
    const recBtn = $('[data-rec]', ff); const recLbl = $('.rec', ff);
    if (recBtn) {
      let rec = null, chunks = [];
      recBtn.onclick = async () => {
        if (rec) { rec.stop(); return; }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          rec = new MediaRecorder(stream); chunks = [];
          rec.ondataavailable = e => chunks.push(e.data);
          rec.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            const type = rec.mimeType || 'audio/webm'; const ext = type.includes('mp4') ? 'm4a' : 'webm';
            upload([new File(chunks, `ملاحظة-صوتية-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`, { type })], true);
            rec = null; recLbl.classList.add('hidden'); recBtn.innerHTML = `${I('mic')} ملاحظة صوتية`;
          };
          rec.start(); recLbl.classList.remove('hidden'); recBtn.innerHTML = `${I('stop')} إيقاف التسجيل`;
        } catch { toast('تعذر الوصول إلى الميكروفون — تحقق من الإذن أو من أن الاتصال آمن (HTTPS)', 'err'); }
      };
    }
  });
}
function filesHtml(files) {
  if (!files || !files.length) return '';
  return `<div class="files">${files.map(f => {
    const url = `/api/files/${f.id}`;
    if (/^image\//.test(f.mime)) return `<a href="${url}" target="_blank" rel="noopener"><img class="thumb" src="${url}" alt="${esc(f.original_name)}" loading="lazy"></a>`;
    if (/^audio\//.test(f.mime)) return `<span class="file" style="flex-direction:column;align-items:stretch">${I('mic')}<audio controls preload="none" src="${url}"></audio></span>`;
    return `<a class="file" href="${url}" target="_blank" rel="noopener">${I('file')}<span>${esc(f.original_name)}</span></a>`;
  }).join('')}</div>`;
}

// ===== الدخول =====
function renderLogin(msg) {
  closeEvents();
  app.innerHTML = `<div class="login"><form class="card" id="lf">
    <img src="/img/logo.png" alt="الشعار">
    <h1 id="loginName">${esc(appName())}</h1><p class="sub">منصة إدارة المكتب والمتابعة</p>
    <div class="err-box ${msg ? '' : 'hidden'}">${esc(msg || '')}</div>
    ${field('اسم المستخدم', '<input type="text" name="username" autocomplete="username" required dir="ltr">')}
    ${field('كلمة المرور', '<input type="password" name="password" autocomplete="current-password" required dir="ltr">')}
    <button class="btn primary" style="width:100%">دخول</button>
  </form></div>`;
  fetch('/api/health').then(r => r.json()).then(h => { if (h.app_name) { state.appName = h.app_name; const n = $('#loginName'); if (n) n.textContent = h.app_name; document.title = h.app_name; } }).catch(() => { });
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try { await POST('/api/login', formData(e.target)); await boot(); }
    catch (ex) { const b = $('.err-box', e.target); b.textContent = ex.message; b.classList.remove('hidden'); }
  };
}

// ===== الهيكل والتنقل =====
function navItems() {
  const c = state.counts;
  const common = [
    { h: '#/meetings', i: 'calendar', t: 'الاجتماعات والقرارات' },
    { h: '#/sops', i: 'book', t: 'الإجراءات التشغيلية' },
    { h: '#/partners', i: 'handshake', t: 'العلاقات والشراكات' },
    { h: '#/reports', i: 'chart', t: 'التقارير والإنجازات' },
    { h: '#/files', i: 'folder', t: 'الأرشيف والملفات' },
  ];
  if (isMember()) return [
    { h: '#/', i: 'dash', t: 'الرئيسية' },
    { h: '#/tasks', i: 'list', t: state.me.grants && state.me.grants.scope !== 'own' ? 'المهام' : 'مهامي' },
    { h: '#/files', i: 'folder', t: 'الملفات' },
    ...common.filter(n => n.h === '#/sops' || can({ '#/meetings': 'meetings.view', '#/partners': 'partners.view', '#/reports': 'reports.view' }[n.h])),
  ];
  if (isOwner()) return [
    { h: '#/', i: 'dash', t: 'الرئيسية' },
    { h: '#/command', i: 'chart', t: 'لوحة القيادة' },
    { h: '#/my', i: 'list', t: 'طلباتي وتكليفاتي' },
    { h: '#/decisions', i: 'gavel', t: 'بانتظار قراري', n: c.pending_decisions },
    { h: '#/directives', i: 'flag', t: 'التوجيهات والقرارات' },
    ...common,
  ];
  return [
    { h: '#/', i: 'dash', t: 'الرئيسية' },
    { h: '#/command', i: 'chart', t: 'لوحة القيادة' },
    { h: '#/inbox', i: 'inbox', t: 'الوارد من ' + OT() + '', n: c.inbox_pending },
    { h: '#/dashboard', i: 'alert', t: 'لوحة المتابعة' },
    { h: '#/tasks', i: 'list', t: 'كل المهام' },
    { h: '#/approvals', i: 'gavel', t: 'طلبات الاعتماد', n: c.pending_decisions, o: true },
    { h: '#/directives', i: 'flag', t: 'التوجيهات والقرارات' },
    ...common,
  ];
}
function bottomItems() {
  const c = state.counts;
  if (isMember()) return [{ h: '#/', i: 'dash', t: 'الرئيسية' }, { h: '#/tasks', i: 'list', t: 'المهام' }, { h: '#/notifications', i: 'bell', t: 'الإشعارات', n: c.unread }, { h: '#/more', i: 'more', t: 'المزيد' }];
  return isOwner()
    ? [{ h: '#/', i: 'dash', t: 'الرئيسية' }, { h: '#/my', i: 'list', t: 'طلباتي' }, { h: '#/decisions', i: 'gavel', t: 'قراري', n: c.pending_decisions }, { h: '#/notifications', i: 'bell', t: 'الإشعارات', n: c.unread }, { h: '#/more', i: 'more', t: 'المزيد' }]
    : [{ h: '#/', i: 'dash', t: 'الرئيسية' }, { h: '#/inbox', i: 'inbox', t: 'الوارد', n: c.inbox_pending }, { h: '#/dashboard', i: 'alert', t: 'المتابعة' }, { h: '#/notifications', i: 'bell', t: 'الإشعارات', n: c.unread }, { h: '#/more', i: 'more', t: 'المزيد' }];
}
function renderShell() {
  const me = state.me;
  app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#/"><img src="/img/logo.png" alt=""><span class="t"><b>${esc(appName())}</b><small>${esc(me.name)}</small></span></a>
    <span class="role-chip desk-only">${esc(me.role_label || '')}</span>
    <span class="spacer"></span>
    <div class="actions">
      ${canAddAny() ? `<button class="btn primary" id="btnAdd" title="إضافة مهمة أو مشروع أو مبادرة">${I('plus')} <span>إضافة</span></button>` : ''}
      ${isOwner() ? `<button class="btn" id="btnNote" title="إرسال ملاحظة أو طلب">${I('note')} <span class="desk-only">إرسال ملاحظة أو طلب</span></button>` : ''}
      <button class="iconbtn" id="btnToday" aria-label="مهام اليوم" title="مهام اليوم">${I('calendarCheck')}</button>
      <a class="iconbtn desk-only" href="#/notifications" aria-label="الإشعارات">${I('bell')}<span class="badge hidden" id="bellN"></span></a>
    </div>
  </header>
  <div class="layout">
    <nav class="sidenav" id="sidenav" aria-label="القائمة"></nav>
    <main id="main" tabindex="-1"></main>
  </div>
  <nav class="bottomnav" id="bottomnav" aria-label="التنقل السريع"></nav>`;
  if (canAddAny()) $('#btnAdd').onclick = () => modalAdd();
  if (isOwner()) $('#btnNote').onclick = () => modalNote();
  $('#btnToday').onclick = () => modalToday();
  document.title = appName();
  renderNav();
}
function renderNav() {
  const route = location.hash || '#/';
  const active = (h) => (h === '#/' ? route === '#/' || route === '' : route.startsWith(h));
  const sn = $('#sidenav'); if (!sn) return;
  sn.innerHTML = navItems().map(n => `<a href="${n.h}" class="${active(n.h) ? 'active' : ''}">${I(n.i)}<span>${n.t}</span>${n.n ? `<span class="count ${n.o ? 'o' : ''}">${n.n}</span>` : ''}</a>`).join('')
    + (can('folders.view') ? `<div class="sep"></div><div class="lbl">الأقسام</div>`
    + mySections().map(s => `<a href="#/section/${s.key}" class="${route === '#/section/' + s.key ? 'active' : ''}">${I(s.icon)}<span>${s.name}</span></a>`).join('') : '')
    + `<div class="sep"></div><a href="#/notifications" class="${active('#/notifications') ? 'active' : ''}">${I('bell')}<span>الإشعارات</span>${state.counts.unread ? `<span class="count">${state.counts.unread}</span>` : ''}</a>
       <a href="#/settings" class="${active('#/settings') ? 'active' : ''}">${I('settings')}<span>الإعدادات</span></a>
       <a href="#" id="logoutLink">${I('logout')}<span>تسجيل الخروج</span></a>`;
  $('#logoutLink').onclick = (e) => { e.preventDefault(); logout(); };
  $('#bottomnav').innerHTML = bottomItems().map(n => `<a href="${n.h}" class="${active(n.h) ? 'active' : ''}">${I(n.i)}<span>${n.t}</span>${n.n ? `<span class="badge">${n.n}</span>` : ''}</a>`).join('');
  const b = $('#bellN'); if (b) { b.textContent = state.counts.unread; b.classList.toggle('hidden', !state.counts.unread); }
}
async function refreshCounts() {
  try { const me = await GET('/api/me'); state.counts = { unread: me.unread, inbox_pending: me.inbox_pending, pending_decisions: me.pending_decisions }; renderNav(); } catch { }
}
async function logout() { try { await POST('/api/logout'); } catch { } state.me = null; renderLogin(); }

// ===== الموجّه =====
const routes = [
  [/^#?\/?$/, viewHome],
  [/^#\/section\/(\w+)$/, viewSection],
  [/^#\/item\/(\d+)$/, viewItem],
  [/^#\/folder\/(\d+)$/, viewFolder],
  [/^#\/directives$/, viewDirectives],
  [/^#\/directive\/(\d+)$/, viewDirective],
  [/^#\/my$/, viewMy],
  [/^#\/decisions$/, viewDecisions],
  [/^#\/approvals$/, viewDecisions],
  [/^#\/inbox$/, viewInbox],
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/tasks(?:\?(.*))?$/, viewTasks],
  [/^#\/command$/, viewCommand],
  [/^#\/files$/, viewFiles],
  [/^#\/meetings$/, viewMeetings],
  [/^#\/meeting\/(\d+)$/, viewMeeting],
  [/^#\/sops$/, viewSops],
  [/^#\/sop\/(\d+)$/, viewSop],
  [/^#\/partners$/, viewPartners],
  [/^#\/partner\/(\d+)$/, viewPartner],
  [/^#\/reports$/, viewReports],
  [/^#\/notifications$/, viewNotifications],
  [/^#\/settings$/, viewSettings],
  [/^#\/more$/, viewMore],
];
async function route() {
  if (!state.me) return;
  const h = location.hash || '#/';
  const host = $('#main'); if (!host) return;
  // الانتقال إلى صفحة أخرى (أو زر الرجوع في الجوال) يغلق النوافذ المفتوحة فلا تبقى نافذة مخفية خلف أخرى
  $$('.modal-bg [data-close]').forEach(x => x.click());
  renderNav();
  // لكل انتقال حاوية خاصة: صفحة سابقة تأخر تحميلها تكتب في حاويتها القديمة غير المعروضة، فلا تطمس الصفحة الحالية
  const main = document.createElement('div'); main.className = 'view';
  host.replaceChildren(main);
  const current = () => main.isConnected;
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      state.view = null; state.stale = false;
      main.innerHTML = '<div class="empty">جارٍ التحميل…</div>';
      try { const v = (await fn(main, ...m.slice(1))) || null; if (current()) state.view = v; }
      catch (e) { if (current()) main.innerHTML = `<div class="card"><div class="err-box">${esc(e.message)}</div><a class="btn" href="#/">العودة للرئيسية</a></div>`; }
      if (current()) window.scrollTo(0, 0);
      return;
    }
  }
  main.innerHTML = '<div class="empty">الصفحة غير موجودة</div>';
}
window.addEventListener('hashchange', route);

// تحديث العرض الحالي عند تغيّر البيانات من الطرف الآخر (دون فقدان ما يُكتب)
let refreshTimer = null;
function refreshView() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if ($('.modal-bg')) { state.stale = true; return; }
    state.stale = false;
    refreshCounts();
    if (state.view && state.view.refresh) { try { await state.view.refresh(); } catch { } }
    else if (!document.activeElement || !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) route();
    else state.stale = true;
  }, 350);
}

// ===== إشعارات الجهاز (سطح المكتب والجوال) =====
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const b64ToU8 = (b) => { const p = '='.repeat((4 - b.length % 4) % 4); const s = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...s].map(c => c.charCodeAt(0))); };
async function enablePush() {
  if (isIOS() && !isStandalone()) throw new Error('على iPhone: افتح المنصة من زر المشاركة ← «إضافة إلى الشاشة الرئيسية»، ثم افتحها من أيقونتها وفعّل الإشعارات (iOS 16.4 أو أحدث)');
  if (!pushSupported()) throw new Error('هذا المتصفح أو الاتصال لا يدعم إشعارات الجهاز (تتطلب HTTPS)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('لم يُمنح إذن الإشعارات. يمكن تغييره من إعدادات المتصفح للموقع');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(state.meta.vapid) });
  await POST('/api/push/subscribe', sub.toJSON());
  return true;
}
// يعيد تسجيل اشتراك الجهاز بصمت إن كان الإذن ممنوحًا (مثلًا بعد تغيير الخادم)
async function resyncPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(state.meta.vapid) });
    await POST('/api/push/subscribe', sub.toJSON());
  } catch { /* لا شيء */ }
}
function notifBannerHtml() {
  const dismissed = (() => { try { return localStorage.getItem('notif-banner') === 'off'; } catch { return false; } })();
  const iosNeedsInstall = isIOS() && !isStandalone();
  if (dismissed || (!iosNeedsInstall && (!pushSupported() || Notification.permission === 'granted'))) return '';
  if (!iosNeedsInstall && Notification.permission === 'denied') return '';
  return `<div class="notif-banner" id="notifBanner">${I('bell')}<div class="nb-text"><b>فعّل الإشعارات على هذا الجهاز</b><span class="small">${iosNeedsInstall
    ? 'على iPhone: زر المشاركة ← «إضافة إلى الشاشة الرئيسية»، ثم افتح المنصة من أيقونتها واضغط «تفعيل».'
    : 'لتصلك التكليفات والتحديثات والقرارات فورًا حتى والمنصة مغلقة.'}</span></div>
    ${iosNeedsInstall ? '' : '<button type="button" class="btn primary sm" data-nb="on">تفعيل</button>'}<button type="button" class="iconbtn" data-nb="off" aria-label="إخفاء">${I('x')}</button></div>`;
}
function bindNotifBanner(root) {
  const b = $('#notifBanner', root); if (!b) return;
  const on = $('[data-nb=on]', b); if (on) on.onclick = async () => { try { await enablePush(); toast('فُعّلت الإشعارات على هذا الجهاز', 'ok'); b.remove(); } catch (e) { showErr(e); } };
  $('[data-nb=off]', b).onclick = () => { try { localStorage.setItem('notif-banner', 'off'); } catch { } b.remove(); };
}
// إشعار نظام (سطح المكتب/الجوال) عند وصول تنبيه والتبويب في الخلفية. وسم n<id> يمنع تكراره مع إشعار Push
async function systemNotify(n) {
  try {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const priv = state.privateLock !== false;
    reg.showNotification(priv ? (n.urgent ? `تنبيه عاجل — ${appName()}` : appName()) : n.title, {
      body: priv ? 'لديك إشعار جديد في المنصة' : (n.body || ''), tag: `n${n.id}`, icon: '/img/icon-192.png', badge: '/img/icon-192.png', dir: 'rtl', lang: 'ar', data: { link: n.link || '' },
    });
  } catch { /* لا شيء */ }
}

// ===== المزامنة الفورية: SSE على Node وWebSocket على Cloudflare =====
let es = null, ws = null, wsWanted = false, wsTries = 0, wsPing = null;
function onNotification(n) {
  systemNotify(n);
  toast(n.title, n.urgent ? 'urgent' : '', () => { if (n.link) location.hash = n.link.replace(/^#/, ''); }, { notif: true });
  refreshCounts();
}
function connectWs() {
  if (!wsWanted || (ws && ws.readyState <= 1)) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  ws.onopen = () => { if (wsTries) refreshView(); wsTries = 0; clearInterval(wsPing); wsPing = setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 30000); };
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === 'change') onChange(m.data); else if (m.event === 'notification') onNotification(m.data); else if (m.event === 'logout') forcedLogout();
  };
  ws.onclose = () => { clearInterval(wsPing); if (wsWanted) setTimeout(connectWs, Math.min(30000, 1000 * 2 ** Math.min(wsTries++, 5))); };
}
function openEvents() {
  closeEvents();
  if (state.meta.realtime === 'ws') { wsWanted = true; connectWs(); return; }
  es = new EventSource('/api/events');
  es.addEventListener('change', (e) => onChange(e.data));
  es.addEventListener('notification', (e) => onNotification(JSON.parse(e.data)));
  es.addEventListener('logout', forcedLogout);
  es.onerror = () => { /* يعيد المتصفح الاتصال تلقائيًا */ };
}
// تغيّر شيء: إن كان حسابي (صلاحياتي مثلًا) أُعيد قراءة الحساب ورسم الواجهة، ثم تحديث العرض
async function onChange(raw) {
  if (!state.me) return;
  let scope = raw; try { if (typeof raw === 'string') scope = JSON.parse(raw); } catch { scope = {}; }
  if (scope && scope.user === state.me.id) {
    if ($('.modal-bg')) { state.reloadMe = true; state.stale = true; return; } // لا نمسح نافذة مفتوحة؛ نُحدّث بعد إغلاقها
    try { const me = await GET('/api/me'); state.me = me; state.meta = await GET('/api/meta'); renderShell(); route(); return; } catch { return; }
  }
  if (scope && scope.user) { state.meta = await GET('/api/meta').catch(() => state.meta); }
  refreshView();
}
// أوقف المدير الحساب أو غيّر كلمة مروره: خروج فوري
function forcedLogout() { closeEvents(); state.me = null; renderLogin('انتهت جلستك. سجّل الدخول من جديد.'); }
function closeEvents() {
  if (es) { es.close(); es = null; }
  wsWanted = false; clearInterval(wsPing);
  if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch { /* مغلق */ } }
}

// ===== شريطا مهام اليوم والمهام العاجلة =====
// شريط «المتابعة» الموحد بالترتيب المعتمد: العاجلة (أحمر) ← مهام اليوم (أزرق) ← قيد المتابعة (رمادي)
function followRibbonHtml(follow) {
  const items = (follow || []).map(i => ({ i, tone: 'c-' + i.color, why: `${i.color_label}: ${i.follow_reason || ''}` }));
  const paused = localStorage.getItem('ribbons-paused') === '1';
  const due = (i) => (i.due_date ? fmtDate(i.due_date) + (i.due_time ? ' ' + i.due_time : '') : '');
  const one = ({ i, tone, why }) => `<button type="button" class="r-item r-pill ${tone}" data-id="${i.id}" title="${esc(why)}">
      <span class="r-tag">${I(COLOR_ICON[i.color])}${esc(i.color_label)}</span>${i.section ? `<span class="r-sec">${esc(i.section_name)}</span>` : ''}<b>${esc(i.title)}</b>${due(i) ? `<small>· ${esc(due(i))}</small>` : ''}</button>`;
  const content = items.map(one).join('');
  const dur = Math.max(25, items.length * 8);
  return `<section class="ribbon follow ${paused ? 'paused' : ''} ${items.length < 2 ? 'static' : ''}" aria-label="المتابعة: العاجلة ثم مهام اليوم ثم قيد المتابعة">
    <div class="r-title"><span class="dot"></span>المتابعة <span class="n">${items.length}</span></div>
    <div class="r-view">${items.length
      ? `<div class="r-track" style="--dur:${dur}s">${content}${items.length >= 2 ? `<span class="dup" aria-hidden="true" style="display:contents">${content.replace(/<button /g, '<button tabindex="-1" ')}</span>` : ''}</div>`
      : '<div class="r-empty">لا توجد مهام عاجلة ولا مهام لليوم ولا مهام قيد المتابعة</div>'}</div>
    ${items.length >= 2 ? `<button type="button" class="r-ctl" data-toggle aria-label="${paused ? 'تشغيل الحركة' : 'إيقاف الحركة'}" title="${paused ? 'تشغيل الحركة' : 'إيقاف الحركة'}">${I(paused ? 'play' : 'pause')}</button>` : ''}
  </section>
  ${colorKeyHtml(items.reduce((a, x) => { const c = x.tone.slice(2); a[c] = (a[c] || 0) + 1; return a; }, {}))}`;
}
function bindRibbons(root) {
  $$('.ribbon .r-item', root).forEach(b => b.onclick = () => location.hash = `#/item/${b.dataset.id}`);
  $$('.ribbon [data-toggle]', root).forEach(b => b.onclick = () => {
    const p = localStorage.getItem('ribbons-paused') === '1' ? '0' : '1';
    localStorage.setItem('ribbons-paused', p);
    $$('.ribbon', root).forEach(r => {
      r.classList.toggle('paused', p === '1');
      const t = $('[data-toggle]', r); if (t) { t.innerHTML = I(p === '1' ? 'play' : 'pause'); t.setAttribute('aria-label', p === '1' ? 'تشغيل الحركة' : 'إيقاف الحركة'); }
    });
  });
}

// ===== الصفحة الرئيسية =====
function tileHtml(s) {
  const sec = state.meta.sections.find(x => x.key === s.key);
  const st = (v, label, tone) => `<div class="st ${v ? tone : 'zero'}"><b>${v}</b><span>${label}</span></div>`;
  // زر (+) خارج الرابط (لا يصح وضع زر داخل رابط) ويُثبَّت فوق زاوية المربع
  return `<div class="tile-wrap"><a class="tile" href="#/section/${s.key}" aria-label="${esc(s.name)}">
    <div class="th"><div class="ic">${I(sec.icon)}</div><h3>${esc(s.name)}</h3></div>
    <div class="stats">
      ${st(s.open, 'مفتوحة', 'blue')}${st(s.due_today, 'مستحقة اليوم', 'orange')}${st(s.overdue, 'متأخرة', 'red')}${st(s.awaiting_decision, 'بانتظار قرار', 'orange')}
    </div>
    ${s.extra && s.extra.length ? `<div class="extra">${s.extra.map(e => `<span>${esc(e.label)}: ${e.value}</span>`).join('')}</div>` : ''}
    <div class="top">${s.top ? `أهم متابعة: <b>${esc(s.top.title)}</b>${s.top.due_date ? ` — ${esc(fmtDate(s.top.due_date))}` : ''}` : '<span class="muted">لا توجد متابعات مفتوحة</span>'}</div>
  </a><button type="button" class="tile-add" data-add-section="${s.key}" aria-label="${isOwner() ? 'تكليف جديد' : 'مهمة جديدة'} في ${esc(s.name)}" title="${isOwner() ? 'تكليف جديد' : 'مهمة جديدة'} في ${esc(s.name)}">${I('plus')}</button></div>`;
}
function bindTileAdd(root) {
  $$('[data-add-section]', root).forEach(b => b.onclick = () => isOwner() ? modalAssignment({ section: b.dataset.addSection }) : modalTask({ section: b.dataset.addSection }));
}
async function viewHome(main) {
  const hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const greg = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  async function load() {
    const [h, pend] = await Promise.all([GET('/api/home'), isOwner() ? GET('/api/approvals?status=pending') : Promise.resolve([])]);
    if (h.member) { // عضو فريق: ما يخصه فقط
      main.innerHTML = `
        <div class="hello"><h1>${hello()}</h1><span class="date">${esc(greg)} — ${esc(hijri)}</span></div>
        ${notifBannerHtml()}
        ${followRibbonHtml(h.follow_ribbon)}
        <div class="card section-gap"><div class="card-h">${I('list')}<h2>مهامي المفتوحة</h2><span class="chip">${h.my_items.length}</span><span class="spacer"></span><a class="btn sm" href="#/tasks">كل مهامي</a></div>
          ${listOrEmpty(h.my_items, i => itemRow(i, { showUpdated: true }), 'لا توجد مهام مسندة إليك أو في مشاريعك حاليًا')}</div>
        <div class="card"><div class="card-h">${I('folder')}<h2>مشاريعي</h2></div>
          ${listOrEmpty(h.projects, p => `<div class="row"><div class="main"><span class="title">${esc(p.name)}</span><div class="meta"><span class="chip">${esc(p.section_name)}</span>${p.folder_name ? `<span class="chip">${I('folder')}${esc(p.folder_name)}</span>` : ''}</div></div></div>`, 'لم تُضف إلى أي مشروع بعد')}</div>`;
      bindRibbons(main); bindNotifBanner(main);
      return;
    }
    const s = h.summary;
    const cmdLink = `<a class="cmd-link section-gap" href="#/command">${I('chart')}<span><b>لوحة القيادة</b><small>المؤشرات، ما يحتاج تدخلك، توزيع العمل، والتوجيهات</small></span>${I('back', 'chev')}</a>`;
    let roleHtml = '';
    if (isOwner()) {
      roleHtml += `
      <div class="card section-gap"><div class="card-h"><h2>ملخص المكتب</h2></div>
        <div class="kpis">
          <a class="kpi blue" href="#/my"><b>${s.open_assignments}</b><span>تكليفاتي المفتوحة</span></a>
          <a class="kpi red" href="#/my"><b>${s.urgent}</b><span>مهام عاجلة</span></a>
          <a class="kpi red" href="#/my"><b>${s.overdue}</b><span>مهام متأخرة</span></a>
          <a class="kpi orange" href="#/decisions"><b>${s.pending_decisions}</b><span>تنتظر قراري</span></a>
        </div></div>
      <div class="cols section-gap">
        <div class="card"><div class="card-h">${I('gavel')}<h2>بانتظار قراري</h2><span class="spacer"></span><a class="btn sm" href="#/decisions">عرض الكل</a></div>
          ${listOrEmpty(pend.slice(0, 4), a => `<div class="row ${a.blocking ? 'p-urgent' : 'p-important'}"><div class="main"><a class="title" href="#/item/${a.item_id}">${esc(a.title)}</a>
            <div class="meta"><span class="chip st-waiting_approval">${esc(a.kind_label)}</span><span class="chip">${esc(a.section_name)}</span>${a.blocking ? '<span class="chip overdue">يعطل التنفيذ</span>' : ''}<span class="txt">${fmtTs(a.requested_at)}</span></div></div></div>`, 'لا شيء ينتظر قرارك الآن')}
        </div>
        <div class="card"><div class="card-h">${I('note')}<h2>آخر تحديثات مدير المكتب</h2></div>
          ${listOrEmpty(h.updates, u => `<a class="row" href="#/item/${u.item_id}"><div class="main"><span class="title">${esc(u.item_title)}</span>
            <div class="small" style="white-space:pre-wrap">${esc((u.body || '').slice(0, 160))}</div><div class="meta"><span class="txt">${fmtTs(u.created_at)}</span></div></div></a>`, 'لا توجد تحديثات بعد')}
        </div>
        <div class="card"><div class="card-h">${I('checkCircle')}<h2>أبرز الإنجازات</h2></div>
          ${listOrEmpty(h.achievements, i => itemRow(i), 'لا توجد إنجازات مسجلة بعد')}
        </div>
        <div class="card"><div class="card-h">${I('calendar')}<h2>الاجتماعات القادمة</h2></div>
          ${listOrEmpty(h.meetings, meetingRow, 'لا توجد اجتماعات قادمة')}
        </div>
      </div>`;
    } else {
      const inbox = await GET('/api/items?kind=inbox');
      const pendingInbox = inbox.filter(inboxPending);
      roleHtml += `
      <div class="card section-gap"><div class="card-h">${I('inbox')}<h2>الوارد من ${OT()}</h2><span class="chip ${pendingInbox.length ? 'p-urgent' : ''}">${pendingInbox.length} يحتاج إجراء</span><span class="spacer"></span><a class="btn sm" href="#/inbox">صندوق الوارد</a></div>
        ${listOrEmpty(pendingInbox.slice(0, 5), i => itemRow(i, { actions: inboxActions(i) }), 'لا يوجد وارد جديد')}
      </div>
      <div class="cols section-gap">
        <div class="card"><div class="card-h">${I('alert')}<h2>المتابعة التنفيذية</h2><span class="spacer"></span><a class="btn sm" href="#/dashboard">لوحة المتابعة</a></div>
          <div class="kpis">
            <a class="kpi blue" href="#/tasks"><b>${s.open}</b><span>مهام مفتوحة</span></a>
            <a class="kpi red" href="#/dashboard"><b>${s.overdue}</b><span>متأخرة</span></a>
            <a class="kpi red" href="#/dashboard"><b>${s.urgent}</b><span>عاجلة</span></a>
            <a class="kpi orange" href="#/approvals"><b>${s.pending_decisions}</b><span>تنتظر قرار ${OT()}</span></a>
          </div></div>
        <div class="card"><div class="card-h">${I('calendar')}<h2>الاجتماعات القادمة</h2></div>${listOrEmpty(h.meetings, meetingRow, 'لا توجد اجتماعات قادمة')}</div>
      </div>`;
    }
    main.innerHTML = `
      <div class="hello"><h1>${hello()}</h1><span class="date">${esc(greg)} — ${esc(hijri)}</span></div>
      ${notifBannerHtml()}
      ${followRibbonHtml(h.follow_ribbon)}
      ${cmdLink}
      <div class="tiles">${h.tiles.map(tileHtml).join('')}</div>
      ${roleHtml}`;
    bindRibbons(main); bindInboxActions(main); bindTileAdd(main); bindNotifBanner(main);
  }
  await load();
  return { refresh: load };
}
const meetingRow = (m) => `<a class="row" href="#/meeting/${m.id}"><div class="main"><span class="title">${esc(m.title)}</span>
  <div class="meta"><span class="chip">${I('calendar')}${esc(fmtDate(m.starts_at.slice(0, 10)))} ${esc(m.starts_at.slice(11, 16))}</span>${m.location ? `<span class="txt">${esc(m.location)}</span>` : ''}${demoChip(m)}</div></div></a>`;

// ===== صندوق الوارد (مدير المكتب) =====
const inboxPending = (i) => i.status !== 'cancelled' && (!i.acknowledged_at || i.kind === 'assignment' || (i.kind === 'note' && i.is_open));
function nextAction(i) {
  if (!i.acknowledged_at) return 'تأكيد الاستلام';
  if (i.kind === 'assignment') return 'تحويل إلى مهمة';
  if (i.kind === 'note' && i.is_open) return i.msg_type === 'info' ? 'الاطلاع وإغلاق' : 'مراجعة واتخاذ إجراء';
  return 'متابعة';
}
function inboxActions(i) {
  if (!isManager()) return '';
  let a = '';
  if (!i.acknowledged_at && i.status !== 'cancelled') a += `<button class="btn sm orange" data-ack="${i.id}">${I('check')} تأكيد الاستلام</button>`;
  if (i.kind !== 'task' && i.status !== 'cancelled') a += `<button class="btn sm" data-convert="${i.id}">تحويل إلى مهمة</button>`;
  return a + `<span class="small muted">الإجراء التالي: ${esc(nextAction(i))}</span>`;
}
function bindInboxActions(root) {
  $$('[data-ack]', root).forEach(b => b.onclick = async () => { b.disabled = true; try { await POST(`/api/items/${b.dataset.ack}/ack`); toast('تم تأكيد الاستلام', 'ok'); refreshView(); } catch (e) { showErr(e); b.disabled = false; } });
  $$('[data-convert]', root).forEach(b => b.onclick = async () => { const d = await GET(`/api/items/${b.dataset.convert}`); modalConvert(d.item); });
}
async function viewInbox(main) {
  let tab = 'pending';
  async function load() {
    const items = await GET('/api/items?kind=inbox');
    const shown = tab === 'pending' ? items.filter(inboxPending) : items;
    main.innerHTML = `<div class="page-h">${I('inbox')}<h1>الوارد من ${OT()}</h1></div>
      <div class="tabs"><button data-tab="pending" class="${tab === 'pending' ? 'active' : ''}">يحتاج إجراء (${items.filter(inboxPending).length})</button><button data-tab="all" class="${tab === 'all' ? 'active' : ''}">الكل (${items.length})</button></div>
      ${listOrEmpty(shown, i => itemRow(i, { actions: inboxActions(i), showUpdated: true }), 'لا يوجد وارد يحتاج إجراء')}`;
    $$('[data-tab]', main).forEach(b => b.onclick = () => { tab = b.dataset.tab; load(); });
    bindInboxActions(main);
  }
  await load(); return { refresh: load };
}

// ===== لوحة المتابعة التنفيذية =====
async function viewDashboard(main) {
  async function load() {
    const d = await GET('/api/dashboard');
    main.innerHTML = `<div class="page-h">${I('alert')}<h1>لوحة المتابعة التنفيذية</h1></div>
      <div class="kpis" style="margin-bottom:14px">${d.groups.map(g => `<a class="kpi ${g.tone === 'gray' ? 'blue' : g.tone}" href="javascript:void(0)" data-open-g="${g.key}"><b>${g.items.length}</b><span>${esc(g.title)}</span></a>`).join('')}</div>
      ${d.groups.filter(g => g.items.length).map(g => `<details class="card dgroup" id="g-${g.key}" ${['urgent', 'today', 'overdue', 'unack', 'stalled'].includes(g.key) ? 'open' : ''}>
        <summary><div class="card-h"><h2>${esc(g.title)}</h2><span class="chip">${g.items.length}</span><span class="spacer"></span>${I('back', 'chev')}</div></summary>
        ${listOrEmpty(g.items.slice(0, 10), i => itemRow(i, { actions: g.key === 'unack' ? inboxActions(i) : quickStatus(i) }), 'لا يوجد')}
        ${g.items.length > 10 ? `<button type="button" class="btn sm ghost" data-more="${g.key}" style="margin-top:8px">عرض الكل (${g.items.length})</button>` : ''}</details>`).join('')}
      ${d.groups.every(g => !g.items.length) ? '<div class="empty">لا توجد متابعات مفتوحة 🎉</div>' : ''}`;
    $$('[data-open-g]', main).forEach(k => k.onclick = () => { const el = $('#g-' + k.dataset.openG, main); if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
    $$('[data-more]', main).forEach(b => b.onclick = () => {
      const g = d.groups.find(x => x.key === b.dataset.more);
      b.previousElementSibling.outerHTML = listOrEmpty(g.items.slice(0, 100), i => itemRow(i, { actions: g.key === 'unack' ? inboxActions(i) : quickStatus(i) }));
      b.remove(); bindInboxActions(main); bindQuickStatus(main, d.groups.flatMap(x => x.items));
    });
    bindInboxActions(main); bindQuickStatus(main, d.groups.flatMap(g => g.items));
  }
  await load(); return { refresh: load };
}
function quickStatus(i) {
  if (!isManager() || !i.is_open || i.kind === 'note') return '';
  return `<select class="qs" data-id="${i.id}" aria-label="تحديث الحالة" style="min-height:36px;width:auto">
    ${opt('', 'تحديث سريع للحالة…')}${['in_progress', 'waiting_reply', 'waiting_info', 'stalled', 'done'].filter(s => s !== i.status).map(s => opt(s, state.meta.statuses[s])).join('')}</select>`;
}
function bindQuickStatus(root, items = []) {
  $$('select.qs', root).forEach(s => s.onchange = async () => {
    if (!s.value) return;
    const it = items.find(x => x.id == s.dataset.id) || { id: Number(s.dataset.id) };
    const v = s.value; s.value = '';
    changeStatus(it, v, refreshView);
  });
}

// ===== تأجيل الموعد بنقرة =====
function modalPostpone(i, after) {
  const base = i.due_date && i.due_date > today() ? i.due_date : today();
  const opts = [['غدًا', addDays(today(), 1)], ['بعد 3 أيام', addDays(base, 3)], ['بعد أسبوع', addDays(base, 7)], ['بعد أسبوعين', addDays(base, 14)]];
  const m = openModal({
    title: 'تأجيل الموعد', submit: 'تأجيل إلى التاريخ المختار',
    body: `<p class="small muted">الموعد الحالي: ${esc(fmtDue(i))}</p>
      <div class="btn-row" style="margin:8px 0 12px">${opts.map(([l, d]) => `<button type="button" class="btn" data-pp="${d}">${l}${fmtDate(d) !== l ? ` <span class="small muted">(${esc(fmtDate(d))})</span>` : ''}</button>`).join('')}</div>
      ${field('أو اختر تاريخًا', `<input type="date" name="due_date" value="${esc(i.due_date || '')}">`)}
      ${field(i.is_overdue ? 'سبب التأخير * (يُحفظ في سجل المهمة)' : 'سبب التأجيل (اختياري، يظهر في المحادثة)', '<input type="text" name="reason" maxlength="200">')}`,
    init: (form) => $$('[data-pp]', form).forEach(b => b.onclick = async () => { try { await save(b.dataset.pp, form.elements.reason.value); m.close(); } catch (e) { showErr(e); } }),
    onSubmit: async (d) => { if (!d.due_date) throw new Error('اختر التاريخ'); await save(d.due_date, d.reason); },
  });
  async function save(date, reason) {
    if (i.is_overdue && !(reason || '').trim()) throw new Error('المهمة متأخرة: اكتب سبب التأخير قبل التأجيل');
    await api('PATCH', `/api/items/${i.id}`, { due_date: date });
    if ((reason || '').trim()) await POST(`/api/items/${i.id}/messages`, { body: `${i.is_overdue ? 'سبب التأخير' : 'تأجيل الموعد'} — الموعد الجديد ${fmtDate(date)}: ${reason.trim()}`, kind: isOwner() ? 'message' : 'update' });
    toast(`أُجّل الموعد إلى ${fmtDate(date)}`, 'ok'); after && after();
  }
}
// أول دخول بكلمة مرور أعطاها المدير: يجب تغييرها قبل استخدام المنصة
function renderForcePassword() {
  closeEvents();
  app.innerHTML = `<div class="login"><form class="card" id="fpw">
    <img src="/img/logo.png" alt="الشعار"><h1>مرحبًا ${esc(state.me.name)}</h1>
    <p class="small muted">لأمان حسابك، اختر كلمة مرور جديدة خاصة بك قبل البدء.</p>
    <div class="err-box hidden"></div>
    ${field('كلمة المرور الحالية (التي أعطاك إياها المدير)', '<input type="password" name="current" autocomplete="current-password" dir="ltr" required>')}
    ${field('كلمة المرور الجديدة (8 أحرف على الأقل)', '<input type="password" name="next" autocomplete="new-password" dir="ltr" minlength="8" required>')}
    ${field('تأكيد كلمة المرور الجديدة', '<input type="password" name="again" autocomplete="new-password" dir="ltr" required>')}
    <button class="btn primary block" type="submit">حفظ والمتابعة</button>
    <button class="btn ghost block" type="button" id="fpwOut">تسجيل الخروج</button></form></div>`;
  const f = $('#fpw'); const err = $('.err-box', f);
  $('#fpwOut').onclick = () => logout();
  f.onsubmit = async (e) => {
    e.preventDefault(); const d = formData(f); err.classList.add('hidden');
    try {
      if (d.next !== d.again) throw new Error('التأكيد لا يطابق كلمة المرور الجديدة');
      await POST('/api/password', { current: d.current, next: d.next });
      toast('تم حفظ كلمة المرور', 'ok'); boot();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  };
}

// ===== تغيير الحالة: نوافذ «أنجزت» و«متعثرة» بدل نوافذ المتصفح =====
const STALL_REASONS = ['طرف خارجي لم يرد', 'نقص معلومات أو مستندات', 'تعارض مع أولوية أخرى', 'عائق مالي أو إداري'];
async function changeStatus(i, status, after) {
  const done = async (body) => { await api('PATCH', `/api/items/${i.id}`, body); toast('تم تحديث الحالة', 'ok'); after && after(); };
  if (status === 'stalled') return modalStalled(i, done);
  if (status === 'in_progress' && ['done', 'cancelled'].includes(i.status)) return openModal({
    title: i.status === 'done' ? 'إعادة المهمة للتعديل' : 'إعادة فتح المهمة', submit: 'إعادة فتح',
    body: field('ما المطلوب تعديله أو سبب إعادة الفتح؟ *', '<textarea name="note" required style="min-height:70px"></textarea>') + '<p class="small muted">يصل السبب إلى المسؤول ويُحفظ في سجل المهمة.</p>',
    onSubmit: async (d) => { if (!(d.note || '').trim()) throw new Error('اكتب السبب'); await done({ status: 'in_progress', status_note: d.note.trim() }); },
  });
  if (status === 'done') return modalDone(i, done, after);
  if (status === 'cancelled' && !confirm('تأكيد إلغاء المهمة؟')) return;
  try { await done({ status }); } catch (e) { showErr(e); }
}
function modalStalled(i, done) {
  openModal({
    title: 'المهمة متعثرة — ما السبب؟', submit: 'حفظ', submitClass: 'red',
    body: `<div class="radios">${STALL_REASONS.map((r, n) => `<label class="check"><input type="radio" name="reason" value="${esc(r)}" ${n ? '' : 'checked'}> ${esc(r)}</label>`).join('')}
        <label class="check"><input type="radio" name="reason" value=""> سبب آخر</label></div>
      ${field('تفاصيل (مطلوبة عند اختيار «سبب آخر»)', '<textarea name="note" style="min-height:70px" placeholder="ما الذي يعيق التنفيذ؟ وما المطلوب لحله؟"></textarea>')}
      <p class="small muted">تظهر المهمة المتعثرة في المهام العاجلة ويُبلَّغ بها مدير المكتب.</p>`,
    onSubmit: async (d) => {
      const note = [d.reason, (d.note || '').trim()].filter(Boolean).join(' — ');
      if (!note) throw new Error('اكتب سبب التعثر');
      await done({ status: 'stalled', status_note: note });
    },
  });
}
function modalDone(i, done) {
  const open = (i.subtasks_total || 0) - (i.subtasks_done || 0);
  openModal({
    title: 'إنجاز المهمة', submit: 'تم الإنجاز', submitClass: 'green',
    body: `${open > 0 ? `<div class="warn-box" style="margin-bottom:10px">في هذه المهمة ${open === 1 ? 'مهمة فرعية مفتوحة' : `${open} مهام فرعية مفتوحة`}.</div>
        <div class="radios" style="margin-bottom:10px"><label class="check"><input type="radio" name="subs" value="all" checked> إنجازها معها</label>
        <label class="check"><input type="radio" name="subs" value="keep"> إبقاؤها مفتوحة</label></div>` : ''}
      ${i.deliverable ? `<div class="info-box" style="margin-bottom:10px"><b>المخرج المطلوب:</b> ${esc(i.deliverable)} — أرفقه أو صِف ما سُلّم.</div>` : ''}
      ${field('ما الذي أُنجز؟ (اختياري)', '<textarea name="body" style="min-height:70px" placeholder="ملخص قصير للنتيجة يصل إلى مدير المكتب"></textarea>')}
      ${field('مرفقات (اختياري)', fileFieldHtml('file_ids', false))}`,
    onSubmit: async (d) => {
      await done({ status: 'done', complete_subtasks: d.subs !== 'keep' }); // الحالة أولًا؛ الملخص بعد نجاحها فقط
      if ((d.body || '').trim() || (d.file_ids || []).length) await POST(`/api/items/${i.id}/messages`, { body: d.body, file_ids: d.file_ids, kind: isManager() ? 'result' : 'update' }).catch(showErr);
    },
  });
}

// ===== قوائم المهام مع البحث والتصفية =====
// شريط التصفية: بحث + شرائح سريعة + «تصفية متقدمة» مطوية + تصدير القائمة كما تظهر
function filtersHtml(f, { section = true } = {}) {
  const adv = ['section', 'status', 'priority', 'category'].filter(k => f[k] && !(k === 'section' && !section)).length;
  const chip = (v, label) => `<label><input type="radio" name="scope" value="${v}" ${String(f.scope ?? '') === v ? 'checked' : ''}><span>${label}</span></label>`;
  return `<form class="filters" id="flt">
    <div class="filters-top"><input type="search" name="q" placeholder="بحث بالعنوان أو الرقم المرجعي أو المسؤول" value="${esc(f.q || '')}" aria-label="بحث">
      <a class="btn sm" data-export href="#" download title="تصدير القائمة كما تظهر (Excel)">${I('download')}<span class="desk-only"> تصدير</span></a></div>
    <div class="seg quick colors" role="group" aria-label="اللون">${['', 'red', 'blue', 'gray'].map(c => `<label><input type="radio" name="color" value="${c}" ${String(f.color || '') === c ? 'checked' : ''}><span class="${c ? 'c-' + c : ''}">${c ? `${I(COLOR_ICON[c])}${esc(state.meta.colors[c].label)}` : 'كل الألوان'}</span></label>`).join('')}</div>
    <div class="seg quick" role="group" aria-label="عرض">${chip('open', 'المفتوحة')}${chip('today', 'اليوم')}${chip('overdue', 'المتأخرة')}${chip('closed', 'المنجزة')}${chip('', 'الكل')}</div>
    <details class="adv" ${adv ? 'open' : ''}><summary>تصفية متقدمة${adv ? ` (${adv})` : ''}</summary><div class="adv-grid">
      ${section ? `<select name="section" aria-label="القسم">${opt('', 'كل الأقسام', f.section)}${mySections().map(s => opt(s.key, s.name, f.section)).join('')}</select>` : ''}
      <select name="status" aria-label="الحالة">${opt('', 'كل الحالات', f.status)}${Object.entries(state.meta.statuses).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
      <select name="priority" aria-label="الأولوية">${opt('', 'كل الأولويات', f.priority)}${Object.entries(state.meta.priorities).map(([k, v]) => opt(k, v, f.priority)).join('')}</select>
      <select name="category" aria-label="التصنيف">${opt('', 'كل التصنيفات', f.category)}${Object.entries(state.meta.categories).map(([k, v]) => opt(k, v, f.category)).join('')}</select>
    </div></details>
  </form>`;
}
function bindFilters(root, f, reload) {
  const form = $('#flt', root); if (!form) return;
  const ex = $('[data-export]', form);
  const syncExport = () => { if (ex) ex.href = '/api/items-export.csv?' + qs(f); };
  let t; const go = () => { Object.assign(f, formData(form)); syncExport(); reload(); };
  form.oninput = (e) => { clearTimeout(t); t = setTimeout(go, e.target.type === 'search' ? 300 : 0); };
  form.onsubmit = (e) => { e.preventDefault(); go(); };
  syncExport();
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

async function viewTasks(main, query) {
  const f = { scope: 'open' };
  // فلاتر قادمة من لوحة القيادة (مثل #/tasks?scope=overdue&priority=urgent)
  const from = new URLSearchParams(query || '');
  for (const k of ['scope', 'status', 'priority', 'section', 'assignee_id', 'assignee', 'done_since', 'q', 'category', 'color']) if (from.has(k)) f[k] = from.get(k);
  const ctxLabel = from.get('label');
  main.innerHTML = `${ctxLabel ? `<div class="btn-row crumbs"><a class="btn sm ghost" href="#/command">${I('back')} لوحة القيادة</a><b>${esc(ctxLabel)}</b></div>` : ''}<div class="page-h">${I('list')}<h1>${isMember() ? 'مهامي' : 'كل المهام والتكليفات'}</h1><span class="spacer"></span>${can('task.create') ? `<button class="btn primary" id="add">${I('plus')} مهمة جديدة</button>` : ''}</div>${filtersHtml(f)}<div id="res"></div>`;
  const add = $('#add', main); if (add) add.onclick = () => modalTask();
  async function load() { const items = await GET('/api/items?' + qs({ kind: 'tasks', ...f })); $('#res', main).innerHTML = `<p class="small muted">${countTxt(items.length, 'نتيجة', 'نتيجتان', 'نتائج')}</p>` + listOrEmpty(items, i => itemRow(i, { actions: quickStatus(i), showUpdated: true })); bindQuickStatus(main, items); }
  bindFilters(main, f, load); await load(); return { refresh: load };
}

// ===== طلباتي وتكليفاتي (رجل الأعمال) =====
async function viewMy(main) {
  const f = { scope: '' };
  main.innerHTML = `<div class="page-h">${I('list')}<h1>طلباتي وتكليفاتي</h1><span class="spacer"></span><button class="btn primary" id="add">${I('plus')} تكليف جديد</button></div>${filtersHtml(f)}<div id="res"></div>`;
  $('#add', main).onclick = () => modalAssignment();
  async function load() {
    const items = await GET('/api/items?' + qs({ kind: 'mine', ...f }));
    $('#res', main).innerHTML = `<p class="small muted">${items.length} طلب/تكليف</p>` + listOrEmpty(items, i => itemRow(i, { showUpdated: true }), 'لم ترسل أي تكليف بعد — استخدم «+ تكليف جديد»');
  }
  bindFilters(main, f, load); await load(); return { refresh: load };
}

// ===== صفحة القسم =====
async function viewSection(main, key) {
  const sec = state.meta.sections.find(s => s.key === key); if (!sec) throw new Error('قسم غير موجود');
  const f = { scope: 'open', section: key };
  let tab = 'folders';
  async function load() {
    const [home, projects, folders] = await Promise.all([GET('/api/home'), GET('/api/projects?section=' + key), GET('/api/folders?section=' + key)]);
    const s = (home.tiles || []).find(t => t.key === key);
    if (!s) throw new Error('هذا القسم خارج صلاحياتك');
    main.innerHTML = `<div class="page-h"><div class="tile" style="min-height:0;padding:0;border:0;box-shadow:none;background:none;cursor:default"><div class="th"><div class="ic">${I(sec.icon)}</div><h1>${esc(sec.name)}</h1></div></div><span class="spacer"></span>
        ${canAddAny() ? `<button class="btn primary" id="add">${I('plus')} إضافة في هذا القسم</button>` : ''}</div>
      <div class="kpis">
        <div class="kpi blue"><b>${s.open}</b><span>مهام مفتوحة</span></div><div class="kpi orange"><b>${s.due_today}</b><span>متابعات مستحقة اليوم</span></div>
        <div class="kpi red"><b>${s.overdue}</b><span>متأخرة</span></div><div class="kpi orange"><b>${s.awaiting_decision}</b><span>بانتظار قرار أو اعتماد</span></div>
        ${(s.extra || []).map(e => `<div class="kpi"><b>${e.value}</b><span>${esc(e.label)}</span></div>`).join('')}
      </div>
      <div class="tabs section-gap"><button data-tab="folders" class="${tab === 'folders' ? 'active' : ''}">${I('folder')} المجلدات (${folders.length})</button><button data-tab="tasks" class="${tab === 'tasks' ? 'active' : ''}">كل المهام</button><button data-tab="projects" class="${tab === 'projects' ? 'active' : ''}">المشاريع والمبادرات (${projects.length})</button>
        ${key === 'partnerships' ? `<button data-tab="partners" class="${tab === 'partners' ? 'active' : ''}">سجل الجهات والشخصيات</button>` : ''}</div>
      <div id="tabc"></div>`;
    const addB = $('#add', main); if (addB) addB.onclick = () => modalAdd({ section: key });
    $$('[data-tab]', main).forEach(b => b.onclick = () => { tab = b.dataset.tab; load(); });
    const tc = $('#tabc', main);
    if (tab === 'folders') {
      const roots = folders.filter(fo => !fo.parent_id);
      tc.innerHTML = `${can('projects.manage') ? `<div class="btn-row" style="margin-bottom:10px"><button class="btn" id="addF">${I('folderPlus')} مجلد جديد</button></div>` : ''}
        ${roots.length ? `<div class="folders">${roots.map(folderCard).join('')}</div>` : `<div class="empty">لا توجد مجلدات بعد${can('projects.manage') ? ' — أنشئ مجلدًا لتجمع فيه المشاريع والمهام المتعلقة به' : ''}</div>`}`;
      const addF = $('#addF', tc); if (addF) addF.onclick = () => modalFolder({ section: key });
    } else if (tab === 'tasks') {
      tc.innerHTML = filtersHtml(f, { section: false }) + '<div id="res"></div>';
      const loadTasks = async () => { const items = await GET('/api/items?' + qs({ kind: 'tasks', ...f })); $('#res', tc).innerHTML = listOrEmpty(items, i => itemRow(i, { showSection: false, actions: quickStatus(i), showUpdated: true }), 'لا توجد مهام مطابقة'); bindQuickStatus(tc, items); };
      bindFilters(tc, f, loadTasks); await loadTasks();
    } else if (tab === 'projects') {
      tc.innerHTML = `${can('projects.manage') ? `<div class="btn-row" style="margin-bottom:10px"><button class="btn" id="addP">${I('briefcase')} مشروع جديد</button><button class="btn" id="addI">${I('flag')} مبادرة جديدة</button></div>` : ''}
        ${listOrEmpty(projects, p => `<div class="row"><div class="main"><span class="title">${kindChip(p)} ${esc(p.name)}</span>${p.description ? `<div class="small muted">${esc(p.description)}</div>` : ''}
          <div class="meta"><span class="chip ${p.status === 'active' ? 'st-in_progress' : p.status === 'done' ? 'st-done' : ''}">${({ active: 'جارٍ', paused: 'متوقف', done: 'منتهٍ' })[p.status]}</span><span class="txt">${p.open_tasks} مهمة مفتوحة</span>${demoChip(p)}</div></div>
          <div class="side"><button class="btn sm" data-pf="${p.id}">مهامه</button>${can('projects.manage') ? `<button class="btn sm" data-pe="${p.id}">تعديل</button>` : ''}</div></div>`, 'لا توجد مشاريع مسجلة')}`;
      const addP = $('#addP', tc); if (addP) addP.onclick = () => modalProject({ section: key, kind: 'project' });
      const addI = $('#addI', tc); if (addI) addI.onclick = () => modalProject({ section: key, kind: 'initiative' });
      $$('[data-pe]', tc).forEach(b => b.onclick = () => modalProject(projects.find(p => p.id == b.dataset.pe)));
      $$('[data-pf]', tc).forEach(b => b.onclick = (e) => { e.preventDefault(); f.project_id = b.dataset.pf; f.scope = ''; tab = 'tasks'; load(); });
    } else if (tab === 'partners') {
      await renderPartnersInto(tc);
    }
  }
  await load(); return { refresh: load };
}

// ===== الأرشيف: كل الملفات المرتبطة بالمهام والاجتماعات والإجراءات، مع البحث =====
async function viewFiles(main) {
  let q = '';
  async function load() {
    const files = await GET('/api/files?' + qs({ q }));
    const where = (f) => f.item_id ? `<a href="#/item/${f.item_id}">${esc(f.item_ref || '')} — ${esc(f.item_title || '')}</a>` : f.meeting_id ? `<a href="#/meeting/${f.meeting_id}">اجتماع: ${esc(f.meeting_title || '')}</a>` : `<a href="#/sop/${f.sop_id}">إجراء: ${esc(f.sop_name || '')}</a>`;
    $('#fl', main).innerHTML = `<p class="small muted">${countTxt(files.length, 'ملف', 'ملفان', 'ملفات')}</p>` + listOrEmpty(files, f => `<div class="row"><div class="main">
      <a class="title" href="/api/files/${f.id}" target="_blank" rel="noopener">${I('file')} ${esc(f.original_name)}</a>
      <div class="meta"><span class="txt">${where(f)}</span>${f.section_name ? `<span class="chip">${esc(f.section_name)}</span>` : ''}<span class="txt">${esc(f.uploader_name || '')} • ${fmtTs(f.created_at)}</span></div></div></div>`, q ? 'لا توجد ملفات مطابقة' : 'لا توجد ملفات بعد');
  }
  main.innerHTML = `<div class="page-h">${I('folder')}<h1>الأرشيف والملفات</h1></div>
    <p class="small muted">كل مرفقات المهام والاجتماعات والإجراءات التي يحق لك الاطلاع عليها، مع المكان الذي تنتمي إليه.</p>
    <div class="filters-top" style="margin-bottom:10px"><input type="search" id="fq" placeholder="بحث باسم الملف أو المهمة أو الاجتماع" aria-label="بحث"></div><div id="fl"></div>`;
  let t; $('#fq', main).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; load(); }, 300); };
  await load(); return { refresh: load };
}

// ===== لوحة القيادة: ماذا لدينا؟ من المسؤول؟ ماذا أُنجز وتأخر؟ ما الذي يحتاج تدخل المدير؟ =====
async function viewCommand(main) {
  async function load() {
    const d = await GET('/api/command'); const k = d.kpis;
    const link = (params, label) => `#/tasks?${qs({ ...params, label })}`;
    const kpi = (tone, n, label, href, sub = '') => `<a class="kpi ${tone}" href="${href}"><b>${n ?? '—'}</b><span>${label}${sub ? `<small class="muted"> ${sub}</small>` : ''}</span></a>`;
    const trend = k.on_time_rate == null || k.on_time_prev == null ? '' : k.on_time_rate > k.on_time_prev ? `↑ من ${k.on_time_prev}%` : k.on_time_rate < k.on_time_prev ? `↓ من ${k.on_time_prev}%` : 'كالشهر السابق';
    const attText = `ما يحتاج تدخل ${OT()} (${d.attention.length}):\n` + d.attention.map((i, n) => `${n + 1}. ${i.title} — ${i.attention_reason}${i.assignee ? ` (${i.assignee})` : ''}`).join('\n');
    main.innerHTML = `<div class="page-h">${I('chart')}<h1>لوحة القيادة</h1><span class="spacer"></span><span class="small muted">${esc(fmtDate(d.today))}</span></div>
      <div class="kpis cmd">
        ${kpi('blue', k.open, 'مهام مفتوحة', link({ scope: 'open' }, 'المهام المفتوحة'))}
        ${kpi('red', k.overdue, 'متأخرة', link({ scope: 'overdue' }, 'المهام المتأخرة'))}
        ${kpi('red', k.urgent, 'عاجلة', link({ scope: 'open', priority: 'urgent' }, 'المهام العاجلة'))}
        ${kpi('red', k.stalled, 'متعثرة', link({ scope: 'open', status: 'stalled' }, 'المهام المتعثرة'))}
        ${kpi('orange', k.awaiting_approval, `تنتظر قرار ${OT()}`, isOwner() ? '#/decisions' : '#/approvals')}
        ${kpi('green', k.done_week, 'أُنجزت هذا الأسبوع', link({ scope: 'closed', status: 'done', done_since: d.week_start }, 'المنجزة خلال 7 أيام'), `• ${k.done_month} خلال 30 يومًا`)}
        ${kpi(k.on_time_rate == null ? '' : k.on_time_rate >= 80 ? 'green' : k.on_time_rate >= 60 ? 'orange' : 'red', k.on_time_rate == null ? '—' : k.on_time_rate + '%', 'الالتزام بالمواعيد (30 يومًا)', '#/reports', k.on_time_total ? `${trend}` : 'لا بيانات كافية')}
        ${kpi('orange', k.directives_open + k.decisions_open, 'توجيهات وقرارات لم تُنفَّذ', '#/directives', k.directives_at_risk ? `• ${k.directives_at_risk} متأخر` : '')}
        ${kpi('', k.meetings_week, 'اجتماعات خلال 7 أيام', '#/meetings')}
      </div>
      <div class="cols section-gap">
        <div class="card ${d.attention.length ? 'attn' : ''}"><div class="card-h">${I('alert')}<h2>تحتاج تدخل ${esc(OT())}</h2><span class="chip ${d.attention.length ? 'p-urgent' : ''}">${d.attention.length}</span><span class="spacer"></span>
            ${d.attention.length && isManager() ? shareLinks(attText, `ما يحتاج تدخل ${OT()}`) : ''}</div>
          <p class="small muted">مهام متعثرة، أو مهمة/عاجلة متأخرة 3 أيام فأكثر.</p>
          ${listOrEmpty(d.attention.slice(0, 8), i => `<a class="row p-urgent" href="#/item/${i.id}"><div class="main"><span class="title">${esc(i.title)}</span>
            <div class="meta"><span class="chip overdue">${esc(i.attention_reason)}</span>${i.assignee ? `<span class="txt">${esc(i.assignee)}</span>` : ''}<span class="txt">${esc(i.section_name || '')}</span></div></div></a>`, 'لا شيء يحتاج تدخلك الآن 👍')}</div>
        <div class="card"><div class="card-h">${I('gavel')}<h2>تنتظر القرار</h2><span class="chip">${d.approvals.length}</span><span class="spacer"></span><a class="btn sm" href="${isOwner() ? '#/decisions' : '#/approvals'}">الكل</a></div>
          ${listOrEmpty(d.approvals.slice(0, 6), a => `<a class="row ${a.blocking ? 'p-urgent' : 'p-important'}" href="#/item/${a.item_id}"><div class="main"><span class="title">${esc(a.title)}</span>
            <div class="meta"><span class="chip st-waiting_approval">${esc(a.kind_label)}</span>${a.blocking ? '<span class="chip overdue">يعطل التنفيذ</span>' : ''}<span class="txt">منذ ${esc(fmtTs(a.requested_at).replace('منذ ', ''))}</span></div></div></a>`, 'لا توجد طلبات معلقة')}</div>
        <div class="card"><div class="card-h">${I('users')}<h2>توزيع العمل والالتزام</h2><span class="spacer"></span><a class="btn sm" href="#/reports">التقارير</a></div>
          ${d.workload.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>المسؤول</th><th>مفتوحة</th><th>متأخرة</th><th>أُنجزت (أسبوع)</th><th>في الموعد</th></tr></thead><tbody>
            ${d.workload.map(p => { const ln = link(p.user_id ? { scope: 'open', assignee_id: p.user_id } : { scope: 'open', assignee: p.name }, `مهام ${p.name}`);
              return `<tr><td><a href="${ln}">${esc(p.name)}</a></td><td><a href="${ln}">${p.open}</a></td><td class="${p.overdue ? 'late' : ''}">${p.overdue ? `<a href="${link(p.user_id ? { scope: 'overdue', assignee_id: p.user_id } : { scope: 'overdue', assignee: p.name }, `متأخرات ${p.name}`)}">${p.overdue}</a>` : 0}</td><td>${p.completed}</td><td>${p.on_time_rate == null ? '—' : p.on_time_rate + '%'}</td></tr>`; }).join('')}
            </tbody></table></div>` : '<div class="empty">لا توجد مهام مسندة</div>'}</div>
        <div class="card"><div class="card-h">${I('flag')}<h2>التوجيهات الجارية</h2><span class="spacer"></span><a class="btn sm" href="#/directives">السجل</a></div>
          ${d.directives_ready.length ? `<div class="info-box" style="margin-bottom:8px">${d.directives_ready.length} ${d.directives_ready.length === 1 ? 'توجيه اكتملت مهامه' : 'توجيهات اكتملت مهامها'} — تحتاج تسجيل النتيجة.</div>` : ''}
          ${listOrEmpty(d.directives, directiveRowHtml, 'لا توجد توجيهات جارية')}</div>
        <div class="card"><div class="card-h">${I('calendar')}<h2>الاجتماعات القادمة</h2><span class="spacer"></span><a class="btn sm" href="#/meetings">الكل</a></div>
          ${listOrEmpty(d.meetings, meetingRow, 'لا توجد اجتماعات قادمة')}</div>
      </div>`;
  }
  await load(); return { refresh: load };
}

// ===== المشاركة مع المدير خارج المنصة (واتساب / بريد) =====
const shareLinks = (text, subject = '') => `<a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}" title="إرسال عبر واتساب">${I('send')} واتساب</a>
  <a class="btn sm" href="mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}" title="إرسال بالبريد">${I('note')} بريد</a>`;
const channelSeg = (sel, name = 'channel', skipPlatform = true) => `<div class="seg">${Object.entries(state.meta.channels).filter(([k]) => !skipPlatform || k !== 'platform').map(([k, v]) => `<label><input type="radio" name="${name}" value="${k}" ${sel === k ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>`;

// تسجيل قرار المدير نيابةً عنه (وصل بالواتس أو البريد أو شفهيًا)
function modalProxyDecision(ap, after) {
  const D = { approved: 'اعتماد', changes_requested: 'طلب تعديل', rejected: 'رفض', ...(ap.options.length ? { chosen: 'اختيار بديل' } : {}), ...(ap.kind === 'inquiry' ? { answered: 'رد على الاستفسار' } : {}) };
  openModal({
    title: `تسجيل قرار ${OT()}`, submit: 'تسجيل القرار',
    body: `<p class="small muted">«${esc(ap.title)}» — يُسجَّل القرار باسم ${esc(OT())} مع قناة وروده واسمك كمسجِّل.</p>
      ${field('القرار *', `<div class="seg">${Object.entries(D).map(([k, v], n) => `<label><input type="radio" name="decision" value="${k}" ${n ? '' : 'checked'}><span>${v}</span></label>`).join('')}</div>`)}
      ${ap.options.length ? field('البديل المختار', `<select name="option_index">${ap.options.map((o, k) => opt(k, o)).join('')}</select>`) : ''}
      ${field('كيف وصل القرار؟ *', channelSeg('whatsapp'))}
      ${field('نص القرار أو الملاحظة (مطلوبة عند الرفض أو طلب التعديل)', '<textarea name="note" style="min-height:70px"></textarea>')}`,
    onSubmit: async (d) => {
      await POST(`/api/approvals/${ap.id}/decide`, { decision: d.decision, note: d.note, option_index: d.option_index, channel: d.channel, on_behalf: true });
      toast('سُجّل القرار', 'ok'); after && after();
    },
  });
}

// ===== التوجيهات والقرارات: توجيه ← مهام ← متابعة ← نتيجة =====
const dirStateTone = (st) => ({ pending: 'st-new', in_progress: 'st-in_progress', at_risk: 'overdue', ready: 'st-waiting_approval', done: 'st-done', cancelled: 'st-cancelled' })[st] || '';
const progressBar = (p) => `<div class="progress" role="progressbar" aria-valuenow="${p}" aria-valuemax="100"><span style="width:${p}%"></span></div>`;
function directiveRowHtml(d) {
  return `<div class="row p-${d.importance === 'urgent' ? 'urgent' : d.importance === 'important' ? 'important' : 'normal'} ${d.state === 'done' ? 'done' : ''}"><div class="main">
    <a class="title" href="#/directive/${d.id}">${esc(d.title)}</a>
    <div class="meta"><span class="chip ${dirStateTone(d.state)}">${esc(d.state_label)}</span>${d.importance !== 'normal' ? `<span class="chip p-${d.importance}">${esc(d.importance_label)}</span>` : ''}
      ${d.due_date ? `<span class="chip ${d.is_overdue ? 'overdue' : ''}">${I('clock')}${esc(fmtDate(d.due_date))}${d.is_overdue ? ' — متأخر' : ''}</span>` : ''}
      ${d.tasks_total ? `<span class="chip">${I('list')}${d.tasks_done}/${d.tasks_total} مهام</span>` : ''}${d.tasks_overdue ? `<span class="chip overdue">${d.tasks_overdue} متأخرة</span>` : ''}
      ${d.channel_label ? `<span class="txt">${esc(d.channel_label)}</span>` : ''}<span class="txt ltr">${esc(d.ref)}</span>${demoChip(d)}</div>
    ${d.tasks_total && d.state !== 'done' ? progressBar(d.progress) : ''}</div></div>`;
}
async function viewDirectives(main) {
  let tab = 'open'; let q = '';
  async function load() {
    const [list, reg] = await Promise.all([tab === 'register' ? [] : GET('/api/directives?' + qs({ status: tab === 'open' ? 'open' : '', q })), tab === 'register' ? GET('/api/register') : null]);
    const closed = tab === 'closed' ? list.filter(d => d.status !== 'open') : list;
    main.innerHTML = `<div class="page-h">${I('flag')}<h1>التوجيهات والقرارات</h1><span class="spacer"></span>${can('directives.manage') ? `<button class="btn primary" id="addDir">${I('plus')} توجيه جديد</button>` : ''}</div>
      <p class="small muted">كل توجيه من ${esc(OT())} — مهما كانت قناة وروده — يُسجَّل هنا ويتحول إلى مهام تنفيذية، ثم يُغلق بنتيجة موثقة. وقرارات الاجتماعات تظهر في «لم يتحول إلى نتيجة».</p>
      <div class="tabs"><button data-tab="open" class="${tab === 'open' ? 'active' : ''}">المفتوحة</button><button data-tab="register" class="${tab === 'register' ? 'active' : ''}">لم يتحول إلى نتيجة بعد</button><button data-tab="closed" class="${tab === 'closed' ? 'active' : ''}">المنفّذة والملغاة</button></div>
      ${tab !== 'register' ? `<div class="filters-top" style="margin-bottom:10px"><input type="search" id="dq" placeholder="بحث في التوجيهات" value="${esc(q)}" aria-label="بحث"></div>` : ''}
      <div id="dl"></div>`;
    const el = $('#dl', main);
    if (tab === 'register') {
      el.innerHTML = `<div class="card"><div class="card-h"><h2>توجيهات مفتوحة</h2><span class="chip">${reg.directives.length}</span></div>${listOrEmpty(reg.directives, directiveRowHtml, 'لا توجد')}</div>
        <div class="card"><div class="card-h"><h2>قرارات اجتماعات لم تُنفَّذ</h2><span class="chip">${reg.decisions.length}</span></div>
        ${listOrEmpty(reg.decisions, d => `<div class="row ${d.is_overdue ? 'p-urgent' : ''}"><div class="main"><span class="title">${esc(d.text)}</span><div class="meta">
          ${d.unassigned ? '<span class="chip overdue">لم يتحول إلى مهمة</span>' : `<span class="chip st-in_progress">${esc(state.meta.statuses[d.task_status] || 'قيد التنفيذ')}</span>`}
          ${d.task_ref ? `<a class="chip kind" href="#/item/${d.task_id}">${esc(d.task_ref)}</a>` : ''}${(d.task_due || d.due_date) ? `<span class="chip ${d.is_overdue ? 'overdue' : ''}">${I('clock')}${esc(fmtDate(d.task_due || d.due_date))}</span>` : ''}
          ${d.responsible ? `<span class="txt">المسؤول: ${esc(d.responsible)}</span>` : ''}<a class="txt" href="#/meeting/${d.meeting_id}">${esc(d.meeting_title)}</a></div></div></div>`, 'كل قرارات الاجتماعات منفّذة')}</div>`;
    } else el.innerHTML = listOrEmpty(closed, directiveRowHtml, tab === 'open' ? 'لا توجد توجيهات مفتوحة' : 'لا توجد');
    $$('[data-tab]', main).forEach(b => b.onclick = () => { tab = b.dataset.tab; load(); });
    const dq = $('#dq', main); if (dq) { let t; dq.oninput = () => { clearTimeout(t); t = setTimeout(() => { q = dq.value; load().then(() => { const x = $('#dq', main); x.focus(); x.setSelectionRange(q.length, q.length); }); }, 300); }; }
    const ad = $('#addDir', main); if (ad) ad.onclick = () => modalDirective();
  }
  await load(); return { refresh: load };
}
// توجيه جديد: نصه، قناة وروده، أهميته، موعده، ومهامه التنفيذية مباشرة
function modalDirective(pre = {}) {
  const people = state.meta.users.filter(u => u.role !== 'owner');
  const row = () => `<div class="dir-task"><input type="text" name="t_title" placeholder="مهمة تنفيذية…" aria-label="عنوان المهمة">
    <select name="t_assignee" aria-label="المسؤول">${opt('', '— المسؤول —')}${people.map(u => opt(u.id, u.name)).join('')}</select>
    <input type="date" name="t_due" aria-label="موعد المهمة"></div>`;
  openModal({
    title: 'تسجيل توجيه وتحويله إلى مهام', submit: 'حفظ التوجيه والمهام', wide: true,
    body: `${field('التوجيه *', '<textarea name="title" required maxlength="300" style="min-height:60px" placeholder="نص التوجيه كما ورد"></textarea>')}
      ${field('تفاصيل أو سياق (اختياري)', '<textarea name="details" style="min-height:50px"></textarea>')}
      ${isOwner() ? '' : field('كيف ورد التوجيه؟ *', channelSeg('whatsapp'))}
      <div class="grid2">${field('القسم', sectionSelect(pre.section, 'section', true))}${field('الموعد المستهدف', '<input type="date" name="due_date">')}</div>
      ${field('الأهمية', `<div class="seg">${Object.entries(state.meta.importance).map(([k, v]) => `<label><input type="radio" name="importance" value="${k}" ${k === 'normal' ? 'checked' : ''}><span class="p-${k}">${v}</span></label>`).join('')}</div>`)}
      <h3 class="section-gap">المهام التنفيذية <span class="small muted">(يمكن إضافتها لاحقًا)</span></h3>
      <div id="dirTasks">${row()}${row()}</div><button type="button" class="btn sm" id="addRow">${I('plus')} مهمة أخرى</button>`,
    init: (form) => { $('#addRow', form).onclick = () => { $('#dirTasks', form).insertAdjacentHTML('beforeend', row()); }; },
    onSubmit: async (d, form) => {
      const tasks = $$('.dir-task', form).map(r => ({ title: $('[name=t_title]', r).value.trim(), assignee_id: $('[name=t_assignee]', r).value || undefined, due_date: $('[name=t_due]', r).value || undefined })).filter(x => x.title);
      if (tasks.length && !d.section) throw new Error('اختر القسم لإنشاء المهام');
      const r = await POST('/api/directives', { title: d.title, details: d.details, channel: d.channel, section: d.section, due_date: d.due_date, importance: d.importance, tasks });
      toast(`سُجّل التوجيه ${r.ref}${tasks.length ? ` و${tasks.length} مهام` : ''}`, 'ok'); location.hash = `#/directive/${r.id}`;
    },
  });
}
async function viewDirective(main, id) {
  async function load() {
    const d = await GET(`/api/directives/${id}`);
    const manage = can('directives.manage') && d.status === 'open';
    const summary = `توجيه ${d.ref}: ${d.title}\nالحالة: ${d.state_label} — ${d.tasks_done}/${d.tasks_total} مهام${d.tasks_overdue ? ` (${d.tasks_overdue} متأخرة)` : ''}\n` + d.tasks.map(t => `• ${t.title} — ${state.meta.statuses[t.status]}${t.assignee ? ` (${t.assignee})` : ''}`).join('\n') + (d.outcome ? `\nالنتيجة: ${d.outcome}` : '');
    main.innerHTML = `<div class="card item-head"><div class="btn-row" style="margin-bottom:6px"><a class="btn sm ghost" href="#/directives">${I('back')} التوجيهات</a><span class="ref">${esc(d.ref)}</span>${demoChip(d)}</div>
      <h1>${esc(d.title)}</h1>
      <div class="meta btn-row" style="margin-top:8px"><span class="chip ${dirStateTone(d.state)}">${esc(d.state_label)}</span>${d.importance !== 'normal' ? `<span class="chip p-${d.importance}">${esc(d.importance_label)}</span>` : ''}
        ${d.due_date ? `<span class="chip ${d.is_overdue ? 'overdue' : ''}">${I('clock')}${esc(fmtDate(d.due_date))}</span>` : ''}</div>
      <dl class="facts">${[['ورد عبر', d.channel_label], ['تاريخ الورود', d.received_at ? fmtDate(d.received_at) : ''], ['القسم', d.section_name || ''], ['سجّله', d.created_by_name || ''], ['الإغلاق', d.closed_at ? fmtTs(d.closed_at) : '']].filter(x => x[1]).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${d.details ? `<div class="desc">${esc(d.details)}</div>` : ''}
      ${d.tasks_total ? `<div class="small muted" style="margin-top:10px">التنفيذ: ${d.progress}%</div>${progressBar(d.progress)}` : ''}
      ${d.outcome ? `<div class="info-box" style="margin-top:10px"><b>النتيجة المتحققة:</b> ${esc(d.outcome)}</div>` : ''}
      <div class="actions-bar no-print">${manage ? `<button class="btn ${d.state === 'ready' ? 'green' : ''}" id="closeDir">${I('checkCircle')} تسجيل النتيجة وإغلاق التوجيه</button><button class="btn" id="editDir">${I('edit')} تعديل</button><button class="btn ghost" id="cancelDir">إلغاء التوجيه</button>` : ''}
        ${shareLinks(summary, `توجيه ${d.ref}`)}</div></div>
      <div class="card"><div class="card-h">${I('list')}<h2>المهام التنفيذية</h2><span class="chip">${d.tasks_done}/${d.tasks_total}</span><span class="spacer"></span>${manage && can('task.create') ? `<button class="btn sm primary" id="addT">${I('plus')} مهمة</button>` : ''}</div>
        ${listOrEmpty(d.tasks, i => itemRow(i, { showUpdated: true }), 'لم يتحول التوجيه إلى مهام بعد')}</div>
      <div class="card"><details class="log"><summary>سجل التوجيه</summary>${d.log.map(l => `<div class="log-row">${fmtTs(l.created_at)} — ${esc(l.user_name || '')}: ${esc({ created: 'سجّل التوجيه', updated: `عدّل ${l.field || ''}` }[l.action] || l.action)}</div>`).join('')}</details></div>`;
    const at = $('#addT', main); if (at) at.onclick = () => modalTask({ section: d.section, directive_id: d.id, priority: d.importance, due_date: d.due_date, description: `ضمن التوجيه ${d.ref}: ${d.title}` });
    const cd = $('#closeDir', main); if (cd) cd.onclick = () => openModal({
      title: 'تسجيل النتيجة وإغلاق التوجيه', submit: 'إغلاق التوجيه', submitClass: 'green',
      body: `${d.state !== 'ready' && d.tasks_total ? `<div class="warn-box" style="margin-bottom:10px">لم تكتمل كل المهام بعد (${d.tasks_done}/${d.tasks_total}).</div>` : ''}${field('ما النتيجة المتحققة؟ *', `<textarea name="outcome" required style="min-height:80px">${esc(d.outcome || '')}</textarea>`)}`,
      onSubmit: async (x) => { await api('PATCH', `/api/directives/${d.id}`, { status: 'done', outcome: x.outcome }); toast('أُغلق التوجيه ووُثّقت نتيجته', 'ok'); load(); },
    });
    const xd = $('#cancelDir', main); if (xd) xd.onclick = () => openModal({
      title: 'إلغاء التوجيه', submit: 'إلغاء التوجيه', submitClass: 'red',
      body: field('سبب الإلغاء *', '<textarea name="reason" required></textarea>') + '<p class="small muted">يبقى التوجيه وسجله محفوظين. المهام المرتبطة لا تُلغى تلقائيًا.</p>',
      onSubmit: async (x) => { await api('PATCH', `/api/directives/${d.id}`, { status: 'cancelled', reason: x.reason }); toast('أُلغي التوجيه مع الاحتفاظ بسجله', 'ok'); load(); },
    });
    const ed = $('#editDir', main); if (ed) ed.onclick = () => openModal({
      title: 'تعديل التوجيه', wide: true,
      body: `${field('التوجيه', `<textarea name="title" required>${esc(d.title)}</textarea>`)}${field('التفاصيل', `<textarea name="details">${esc(d.details || '')}</textarea>`)}
        <div class="grid2">${field('القسم', sectionSelect(d.section, 'section', true))}${field('الموعد المستهدف', `<input type="date" name="due_date" value="${esc(d.due_date || '')}">`)}</div>
        ${field('الأهمية', `<div class="seg">${Object.entries(state.meta.importance).map(([k, v]) => `<label><input type="radio" name="importance" value="${k}" ${k === d.importance ? 'checked' : ''}><span class="p-${k}">${v}</span></label>`).join('')}</div>`)}`,
      onSubmit: async (x) => { await api('PATCH', `/api/directives/${d.id}`, x); toast('حُفظت التعديلات', 'ok'); load(); },
    });
  }
  await load(); return { refresh: load };
}

// ===== المجلدات: القسم ← المجلد ← المشاريع والمهام =====
const kindChip = (p) => p.kind === 'initiative' ? `<span class="chip kind-i">${I('flag')}مبادرة</span>` : `<span class="chip kind-p">${I('briefcase')}مشروع</span>`;
const folderCard = (fo) => `<a class="folder-card" href="#/folder/${fo.id}">${I('folder', 'fi')}<span class="fname">${esc(fo.name)}</span>
  <span class="small muted">${fo.subfolders ? `${fo.subfolders} مجلد فرعي • ` : ''}${fo.projects} مشروع • ${fo.open_tasks} مهمة مفتوحة</span>${fo.description ? `<span class="small">${esc(fo.description.slice(0, 90))}</span>` : ''}${demoChip(fo)}</a>`;
function modalFolder(fo = {}) {
  openModal({
    title: fo.id ? 'تعديل المجلد' : fo.parent ? `مجلد فرعي داخل «${fo.parent.name}»` : 'مجلد جديد',
    body: `${field('اسم المجلد *', `<input type="text" name="name" required value="${esc(fo.name || '')}" placeholder="مثل: الحلقات، برنامج الصيف، الأوقاف">`)}
      ${field('وصف مختصر', `<textarea name="description" style="min-height:60px">${esc(fo.description || '')}</textarea>`)}
      ${fo.id ? '' : fo.parent ? `<input type="hidden" name="parent_id" value="${fo.parent.id}">` : field('القسم', sectionSelect(fo.section))}`,
    onSubmit: async (d) => {
      if (fo.id) { await api('PATCH', `/api/folders/${fo.id}`, d); refreshView(); }
      else { const r = await POST('/api/folders', d); location.hash = `#/folder/${r.id}`; }
    },
  });
}
async function viewFolder(main, id) {
  const f = { scope: 'open', folder_id: id };
  async function load() {
    const [fo, projects] = await Promise.all([GET(`/api/folders/${id}`), GET(`/api/projects?folder_id=${id}`)]);
    const sec = state.meta.sections.find(x => x.key === fo.section);
    const crumbs = fo.path.map((p, n) => n === fo.path.length - 1 ? `<b>${esc(p.name)}</b>` : `<a href="#/folder/${p.id}">${esc(p.name)}</a>`);
    main.innerHTML = `<div class="btn-row crumbs"><a class="btn sm ghost" href="${fo.parent_id ? `#/folder/${fo.parent_id}` : `#/section/${fo.section}`}">${I('back')} رجوع</a>
        <a href="#/section/${fo.section}">${esc(sec.name)}</a>${crumbs.map(c => `<span class="muted">/</span>${c}`).join('')}</div>
      <div class="page-h">${I('folder')}<h1>${esc(fo.name)}</h1><span class="spacer"></span>
        ${can('projects.manage') ? `<button class="btn" id="addSub">${I('folderPlus')} مجلد فرعي</button><button class="btn" id="editF">${I('edit')} تعديل المجلد</button>` : ''}
        ${canAddAny() ? `<button class="btn primary" id="addT">${I('plus')} إضافة في هذا المجلد</button>` : ''}</div>
      ${fo.description ? `<p class="muted">${esc(fo.description)}</p>` : ''}
      ${fo.children.length ? `<div class="card"><div class="card-h"><h2>المجلدات الفرعية</h2><span class="chip">${fo.children.length}</span></div><div class="folders">${fo.children.map(folderCard).join('')}</div></div>` : ''}
      <div class="card"><div class="card-h"><h2>المشاريع والمبادرات</h2><span class="chip">${projects.length}</span><span class="spacer"></span>${can('projects.manage') ? `<button class="btn sm" id="addP">${I('plus')} مشروع / مبادرة في المجلد</button>` : ''}</div>
        ${listOrEmpty(projects, p => `<div class="row"><div class="main"><span class="title">${kindChip(p)} ${esc(p.name)}</span>${p.description ? `<div class="small muted">${esc(p.description)}</div>` : ''}
          <div class="meta"><span class="chip ${p.status === 'active' ? 'st-in_progress' : p.status === 'done' ? 'st-done' : ''}">${({ active: 'جارٍ', paused: 'متوقف', done: 'منتهٍ' })[p.status]}</span><span class="txt">${p.open_tasks} مهمة مفتوحة</span>
          ${(p.members || []).length ? `<span class="txt">${I('users')} ${p.members.map(m => esc(m.name)).join('، ')}</span>` : ''}${demoChip(p)}</div></div>
          <div class="side"><button class="btn sm" data-pf="${p.id}">مهامه</button>${can('projects.manage') ? `<button class="btn sm" data-pe="${p.id}">تعديل</button>` : ''}</div></div>`, 'لا توجد مشاريع في هذا المجلد')}</div>
      <div class="card"><div class="card-h"><h2>المهام</h2>${f.project_id ? `<span class="chip">${esc((projects.find(p => p.id == f.project_id) || {}).name || '')} <button type="button" class="iconbtn" id="clrP" aria-label="إظهار كل مهام المجلد" style="width:24px;height:24px">${I('x')}</button></span>` : ''}</div>
        ${filtersHtml(f, { section: false })}<div id="res"></div></div>`;
    const eF = $('#editF', main); if (eF) eF.onclick = () => modalFolder(fo);
    const aT = $('#addT', main); if (aT) aT.onclick = () => modalAdd({ section: fo.section, folder_id: fo.id });
    const aS = $('#addSub', main); if (aS) aS.onclick = () => modalFolder({ parent: fo });
    const aP = $('#addP', main); if (aP) aP.onclick = () => modalProject({ section: fo.section, folder_id: fo.id });
    $$('[data-pe]', main).forEach(b => b.onclick = () => modalProject(projects.find(p => p.id == b.dataset.pe)));
    $$('[data-pf]', main).forEach(b => b.onclick = () => { f.project_id = b.dataset.pf; load(); });
    const clr = $('#clrP', main); if (clr) clr.onclick = () => { delete f.project_id; load(); };
    const res = $('#res', main);
    const loadTasks = async () => { const items = await GET('/api/items?' + qs({ kind: 'tasks', ...f })); res.innerHTML = listOrEmpty(items, i => itemRow(i, { showSection: false, actions: quickStatus(i), showUpdated: true }), 'لا توجد مهام مطابقة'); bindQuickStatus(main, items); };
    bindFilters(main, f, loadTasks); await loadTasks();
  }
  await load(); return { refresh: load };
}

// ===== تفاصيل المهمة + المحادثة =====
async function viewItem(main, id) {
  main.innerHTML = `<div id="ih"></div><div id="subs"></div>
    <div class="card section-gap"><div class="card-h">${I('note')}<h2>المحادثة والتحديثات والقرارات</h2></div><div class="timeline" id="tl"></div></div>
    <form class="composer no-print" id="cmp">
      <textarea name="body" placeholder="${isOwner() ? 'اكتب ملاحظة أو ردًا لمدير المكتب على هذه المهمة…' : (isMember() ? 'اكتب تحديثًا أو رسالة لمدير المكتب…' : 'اكتب رسالة أو تحديثًا ل" + OT() + "…')}" aria-label="نص الرسالة"></textarea>
      ${!isOwner() ? `<div class="grid2" style="margin-top:8px"><select name="kind" aria-label="نوع الرسالة">${opt('update', 'تحديث تنفيذ')}${opt('message', 'رسالة / استفسار')}</select>${isManager() ? '<input type="text" name="next_step" placeholder="الخطوة التالية (اختياري)">' : ''}</div>` : ''}
      <div class="tools">${fileFieldHtml()}<span class="spacer" style="flex:1"></span><button class="btn primary" type="submit">${I('send')} إرسال</button></div>
    </form>
    <div class="card section-gap"><details class="log" id="log"><summary>سجل الإجراءات والتغييرات</summary><div id="logc"></div></details></div>`;
  initFileFields(main);
  const cmp = $('#cmp', main);
  cmp.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(cmp); if (!d.body.trim() && !d.file_ids.length) return;
    if (d.next_step === '') delete d.next_step;
    const btn = $('button[type=submit]', cmp); btn.disabled = true;
    try {
      await POST(`/api/items/${id}/messages`, d);
      cmp.reset(); const ff = $('.filefield', cmp); ff.dataset.ids = '[]'; $('.files', ff).innerHTML = '';
      await load(); toast('تم الإرسال', 'ok');
    } catch (ex) { showErr(ex); } finally { btn.disabled = false; }
  };
  let data;
  async function load() {
    data = await GET(`/api/items/${id}`);
    renderHead(); renderSubtasks(); renderTimeline(); renderLog();
    refreshCounts(); // الخادم يعلّم إشعارات هذه المهمة كمقروءة عند فتحها
  }
  function renderHead() {
    const i = data.item;
    const fact = (k, v) => v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '';
    const pendingCount = data.approvals.filter(a => a.status === 'pending').length;
    $('#ih', main).innerHTML = `<div class="card item-head">
      <div class="btn-row" style="margin-bottom:6px"><a class="btn sm ghost" href="javascript:history.back()">${I('back')} رجوع</a><span class="ref">${esc(i.ref)}</span>${demoChip(i)}
        ${canEditItem(i) && !i.closed_at && i.kind !== 'note' ? `<span class="spacer" style="flex:1"></span><button class="btn sm" id="editTop">${I('edit')} تعديل التفاصيل</button>` : ''}</div>
      <h1>${esc(i.title)}</h1>
      <div class="meta btn-row" style="margin-top:8px">${colorChip(i)}<span class="chip kind">${esc(kindLabel(i))}</span>${statusChip(i.status)}${prioChip(i.priority)}${dueChip(i)}
        ${i.acknowledged_at ? `<span class="chip st-acknowledged">${I('check')}تم تأكيد الاستلام ${fmtTs(i.acknowledged_at)}</span>` : (i.kind !== 'task' && i.status !== 'cancelled' ? '<span class="chip st-new">لم يُؤكد الاستلام بعد</span>' : '')}
        ${i.requires_approval ? '<span class="chip st-waiting_approval">يتطلب اعتماد النتيجة</span>' : ''}${i.closed_at ? '<span class="chip st-done">مغلقة نهائيًا</span>' : ''}
        ${pendingCount ? `<span class="chip overdue">${I('gavel')}${pendingCount} طلب ينتظر القرار</span>` : ''}</div>
      <dl class="facts">
        ${fact('القسم', esc(i.section_name))}${i.folder_id && can('folders.view') ? fact('المجلد', `<a href="#/folder/${i.folder_id}">${esc(i.folder_name)}</a>`) : fact('المجلد', esc(i.folder_name || ''))}${fact(i.project_kind === 'initiative' ? 'المبادرة' : 'المشروع', esc(i.project_name || ''))}${fact('التصنيف', esc(state.meta.categories[i.category] || ''))}
        ${i.recurrence ? fact('مهمة دورية', `${I('repeat')} ${esc(state.meta.recurrences[i.recurrence])}${i.next_occurrence_id ? ` — <a href="#/item/${i.next_occurrence_id}">الموعد التالي</a>` : ''}`) : ''}
        ${i.deliverable ? fact('المخرج المطلوب', esc(i.deliverable)) : ''}
        ${i.directive_id ? fact('ضمن التوجيه', can('directives.view') ? `<a href="#/directive/${i.directive_id}">${esc(i.directive_ref)}</a>` : esc(i.directive_ref || '')) : ''}
        ${data.parent_task ? fact('مهمة فرعية من', `<a href="#/item/${data.parent_task.id}">${esc(data.parent_task.ref)} — ${esc(data.parent_task.title)}</a>`) : ''}
        ${fact('المسؤول عن التنفيذ', esc(i.assignee || ''))}${fact('مصدر التكليف', i.source === 'owner' ? '' + OT() + '' : i.source === 'meeting' ? 'قرار اجتماع' : esc(i.created_by_name || 'مدير المكتب'))}
        ${fact('تاريخ الإنشاء', fmtTs(i.created_at))}${fact('الموعد النهائي', esc(fmtDue(i)))}${fact('آخر تحديث', fmtTs(i.updated_at))}
        ${fact('الخطوة التالية', esc(i.next_step || ''))}
        ${data.parent ? fact('مرتبطة بالمهمة', `<a href="#/item/${data.parent.id}">${esc(data.parent.ref)} — ${esc(data.parent.title)}</a>`) : ''}
        ${data.meeting ? fact('صادرة عن اجتماع', `<a href="#/meeting/${data.meeting.id}">${esc(data.meeting.title)}</a>`) : ''}
        ${data.sop ? fact('الإجراء التشغيلي', `<a href="#/sop/${data.sop.id}">${esc(data.sop.name)}</a>`) : ''}
        ${data.partner ? fact('الجهة', `<a href="#/partner/${data.partner.id}">${esc(data.partner.name)}</a>`) : ''}
      </dl>
      ${i.description ? `<div class="desc">${esc(i.description)}</div>` : ''}
      ${i.original_text && i.source === 'owner' ? `<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">النص الأصلي كما أرسله ${OT()}</summary><div class="orig">${esc(i.original_text)}</div></details>` : ''}
      ${data.files.length ? `<div style="margin-top:10px"><div class="small muted">المرفقات</div>${filesHtml(data.files)}</div>` : ''}
      <div class="actions-bar no-print" id="acts"></div>
    </div>`;
    const et = $('#editTop', main); if (et) et.onclick = () => modalTask(data.item, load);
    renderActions();
  }
  // المهام الفرعية: قائمة بإنجاز سريع، وإضافة من المكان نفسه
  function renderSubtasks() {
    const i = data.item; const el = $('#subs', main);
    if (i.kind === 'note' || i.parent_task_id) { el.innerHTML = ''; return; }
    const subs = data.subtasks || [];
    const active = subs.filter(x => x.status !== 'cancelled'); const done = active.filter(x => x.status === 'done').length;
    const canAdd = !i.closed_at && canAddSub();
    const canTick = (st) => !st.closed_at && st.status !== 'cancelled' && (isOwner() || isManager() || isMember());
    if (!subs.length && !canAdd) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="card section-gap"><div class="card-h">${I('list')}<h2>المهام الفرعية</h2>${active.length ? `<span class="chip">${done}/${active.length}</span>` : ''}</div>
      ${active.length ? `<div class="progress" role="progressbar" aria-valuenow="${done}" aria-valuemax="${active.length}"><span style="width:${Math.round(done * 100 / active.length)}%"></span></div>` : ''}
      <div class="subtasks">${subs.map(st => `<div class="subtask ${st.status === 'done' ? 'done' : ''} ${st.status === 'cancelled' ? 'cancelled' : ''}">
          <input type="checkbox" data-st="${st.id}" ${st.status === 'done' ? 'checked' : ''} ${canTick(st) ? '' : 'disabled'} aria-label="إنجاز: ${esc(st.title)}">
          <a href="#/item/${st.id}" class="st-title">${esc(st.title)}</a>${dueChip(st)}${st.assignee ? `<span class="small muted">${esc(st.assignee)}</span>` : ''}</div>`).join('') || '<div class="small muted">لا توجد مهام فرعية بعد</div>'}</div>
      ${canAdd ? `<form class="sub-add no-print" id="subAdd"><input type="text" name="title" placeholder="أضف مهمة فرعية…" maxlength="300" aria-label="عنوان المهمة الفرعية">
        <input type="date" name="due_date" aria-label="موعد المهمة الفرعية (اختياري)" title="الموعد (اختياري)"><button class="btn sm primary" type="submit">${I('plus')} إضافة</button></form>` : ''}</div>`;
    $$('[data-st]', el).forEach(cb => cb.onchange = async () => {
      cb.disabled = true;
      try { await api('PATCH', `/api/items/${cb.dataset.st}`, { status: cb.checked ? 'done' : 'in_progress' }); await load(); }
      catch (e) { cb.checked = !cb.checked; cb.disabled = false; showErr(e); }
    });
    const f = $('#subAdd', el);
    if (f && state.subFocusUntil > Date.now()) setTimeout(() => { const t = $('input[name=title]', f); if (t && document.activeElement !== t) t.focus(); }, 0);
    if (f) f.onsubmit = async (e) => {
      e.preventDefault(); const d = formData(f); if (!d.title.trim()) return;
      const b = $('button', f); b.disabled = true;
      try { await POST(`/api/items/${id}/subtasks`, d); toast('أُضيفت المهمة الفرعية', 'ok'); state.subFocusUntil = Date.now() + 4000; await load(); }
      catch (ex) { showErr(ex); b.disabled = false; }
    };
  }
  function renderActions() {
    const i = data.item; const a = []; const bar = $('#acts', main);
    if (isManager() && !i.closed_at) {
      if (!i.acknowledged_at && i.status !== 'cancelled') a.push(`<button class="btn orange" data-a="ack">${I('check')} تأكيد الاستلام</button>`);
      if (i.kind !== 'task' && i.status !== 'cancelled') a.push(`<button class="btn primary" data-a="convert">تحويل إلى مهمة</button>`);
      if (i.kind === 'note' && i.is_open && i.acknowledged_at) a.push(`<button class="btn" data-a="noteDone">تمت المعالجة</button>`);
      if (i.kind !== 'note' && i.is_open) {
        if (['new', 'acknowledged', 'waiting_reply', 'waiting_info', 'stalled'].includes(i.status) && !data.approvals.some(x => x.status === 'pending')) a.push(`<button class="btn" data-s="in_progress">${I('play')} بدء/استئناف التنفيذ</button>`);
        if (i.status !== 'waiting_reply') a.push(`<button class="btn" data-s="waiting_reply">بانتظار رد طرف خارجي</button>`);
        if (i.status !== 'stalled') a.push(`<button class="btn" data-s="stalled">متعثرة</button>`);
        a.push(`<button class="btn" data-a="approval">${I('gavel')} طلب اعتماد / قرار</button>`);
        a.push(`<button class="btn green" data-a="result">${I('checkCircle')} رفع النتيجة النهائية</button>`);
      }
      if (i.status === 'done' && !i.closed_at) a.push(`<button class="btn green" data-a="close">إغلاق نهائي</button>`);
      if (!i.is_open) a.push(`<button class="btn" data-s="in_progress">إعادة فتح</button>`);
      if (i.is_open) a.push(`<button class="btn ghost" data-s="cancelled">إلغاء</button>`);
    }
    if (isMember() && i.is_open && !i.closed_at && i.kind === 'task') {
      if (i.status !== 'in_progress') a.push(`<button class="btn primary" data-s="in_progress">${I('play')} بدء التنفيذ</button>`);
      if (i.status !== 'waiting_reply') a.push(`<button class="btn" data-s="waiting_reply">بانتظار رد طرف خارجي</button>`);
      if (i.status !== 'stalled') a.push(`<button class="btn" data-s="stalled">متعثرة</button>`);
      a.push(`<button class="btn green" data-s="done">${I('checkCircle')} أنجزت المهمة</button>`);
    }
    if (canEditItem(i) && i.is_open && !i.closed_at && i.kind !== 'note') a.push(`<button class="btn" data-a="postpone">${I('clock')} تأجيل الموعد</button>`);
    if (isOwner() && i.created_by === state.me.id && i.is_open && !i.closed_at) a.push(`<button class="btn ghost" data-s="cancelled">إلغاء التكليف</button>`);
    if (i.sop_id && i.is_open && !i.parent_task_id && canAddSub() && (!isMember() || i.kind === 'task')) a.push(`<button class="btn" data-a="applySop">${I('book')} خطوات الإجراء كقائمة تحقق</button>`);
    if (isOwner()) a.push(`<button class="btn" data-a="noteOn">${I('note')} إرسال ملاحظة مستقلة على المهمة</button>`);
    bar.innerHTML = a.join('');
    bar.classList.toggle('hidden', !a.length);
    $$('[data-s]', bar).forEach(b => b.onclick = () => changeStatus(data.item, b.dataset.s, load));
    $$('[data-a]', bar).forEach(b => b.onclick = async () => {
      const act = b.dataset.a;
      try {
        if (act === 'ack') { await POST(`/api/items/${id}/ack`); toast('تم تأكيد الاستلام وإبلاغ ' + OT() + '', 'ok'); await load(); }
        else if (act === 'convert') modalConvert(data.item, load);
        else if (act === 'noteDone') { await api('PATCH', `/api/items/${id}`, { status: 'done' }); await load(); }
        else if (act === 'approval') modalApproval(data.item, load);
        else if (act === 'result') modalResult(data.item, load);
        else if (act === 'close') { await POST(`/api/items/${id}/close`); toast('أُغلقت المهمة وحُفظ سجلها', 'ok'); await load(); }
        else if (act === 'edit') modalTask(data.item, load);
        else if (act === 'noteOn') modalNote({ parent_id: data.item.id });
        else if (act === 'postpone') modalPostpone(data.item, load);
        else if (act === 'applySop') { const r = await POST(`/api/items/${id}/apply-sop`); toast(r.added ? `أُضيفت ${r.added} خطوات كمهام فرعية` : 'كل خطوات الإجراء مضافة مسبقًا', 'ok'); await load(); }
      } catch (e) { showErr(e); }
    });
  }
  function approvalCard(ap) {
    const decided = ap.status !== 'pending';
    const decLabel = { approved: 'تم الاعتماد', rejected: 'مرفوض', changes_requested: 'طُلب تعديل', chosen: 'تم اختيار بديل', answered: 'تم الرد', withdrawn: 'مسحوب' }[ap.status];
    let ctl = '';
    if (!decided && isOwner()) {
      ctl = `<form class="decide" data-aid="${ap.id}">
        ${ap.options.length ? `<div class="opts">${ap.options.map((o, k) => `<label class="check"><input type="radio" name="opt" value="${k}"> ${esc(o)}</label>`).join('')}</div>` : ''}
        <textarea name="note" placeholder="${ap.kind === 'inquiry' ? 'اكتب ردك على الاستفسار' : 'ملاحظة (مطلوبة عند الرفض أو طلب التعديل)'}" style="min-height:60px"></textarea>
        <div class="btn-row" style="margin-top:8px">
          ${ap.kind === 'inquiry' ? `<button class="btn primary sm" data-d="answered">إرسال الرد</button>` : `
          ${ap.options.length ? `<button class="btn primary sm" data-d="chosen">اعتماد البديل المختار</button>` : ''}
          <button class="btn green sm" data-d="approved">${I('check')} اعتماد</button>
          <button class="btn sm" data-d="changes_requested">طلب تعديل</button>
          <button class="btn red sm" data-d="rejected">رفض</button>`}
        </div></form>`;
    } else if (!decided && isManager()) {
      ctl = `<div class="btn-row" style="margin-top:6px"><span class="small muted">بانتظار قرار ${OT()}</span>
        ${can('approval.record') ? `<button class="btn sm primary" data-proxy="${ap.id}">${I('gavel')} تسجيل قرار ${OT()}</button>` : ''}
        ${shareLinks(`طلب قرار: ${ap.title}${ap.body ? '\n' + ap.body : ''}${ap.options.length ? '\nالبدائل: ' + ap.options.join(' | ') : ''}`, `طلب قرار: ${ap.title}`)}
        <button class="btn sm ghost" data-withdraw="${ap.id}">سحب الطلب</button></div>`;
    }
    return `<div class="approval ${decided ? 'decided-' + ap.status : ''}">
      <div class="who">${I('gavel')}<b>${esc(ap.kind_label)}</b> • ${esc(ap.requested_by_name)} • ${fmtTs(ap.requested_at)} ${ap.blocking && !decided ? '<span class="chip overdue">يعطل التنفيذ</span>' : ''}</div>
      <h3>${esc(ap.title)}</h3>
      ${ap.body ? `<div class="desc">${esc(ap.body)}</div>` : ''}
      ${filesHtml(ap.files)}
      ${ap.options.length && decided ? `<div class="small muted">البدائل: ${ap.options.map(esc).join(' | ')}</div>` : ''}
      ${decided ? `<div style="margin-top:6px"><span class="chip ${ap.status === 'approved' || ap.status === 'chosen' || ap.status === 'answered' ? 'st-done' : ap.status === 'rejected' ? 'st-stalled' : 'p-important'}">${decLabel}</span>
        ${ap.decided_by_name ? `<span class="small muted"> — ${esc(ap.decided_by_name)} • ${fmtTs(ap.decided_at)}${ap.decided_channel && ap.decided_channel !== 'platform' ? ` • ورد ${esc(state.meta.channels[ap.decided_channel] || '')}${ap.recorded_by_name ? `، سجّله ${esc(ap.recorded_by_name)}` : ''}` : ''}</span>` : ''}
        ${ap.chosen_option ? `<div><b>البديل المختار:</b> ${esc(ap.chosen_option)}</div>` : ''}${ap.decision_note ? `<div class="desc">${esc(ap.decision_note)}</div>` : ''}</div>` : ''}
      ${ctl}</div>`;
  }
  function renderTimeline() {
    // لا نُضيّع ما كتبه المستخدم في نماذج القرار عند وصول تحديث فوري من الطرف الآخر
    const drafts = {};
    $$('form.decide', main).forEach(f => { const d = formData(f); if (d.note || d.opt) drafts[f.dataset.aid] = d; });
    const apMap = Object.fromEntries(data.approvals.map(a => [a.id, a]));
    const shown = new Set();
    const entries = [
      ...data.messages.map(m => ({ t: m.created_at, k: 'm', m })),
      ...data.notes.map(n => ({ t: n.created_at, k: 'n', n })),
    ].sort((a, b) => a.t.localeCompare(b.t));
    const html = entries.map(e => {
      if (e.k === 'n') {
        const n = e.n;
        return `<div class="note-card"><div class="who">${I('note')}<b>${esc(n.created_by_name)}</b> • ${esc(n.msg_type_label || 'ملاحظة')} • ${fmtTs(n.created_at)} ${statusChip(n.status)}</div>
          <a href="#/item/${n.id}"><b>${esc(n.title)}</b></a>${n.description && n.description !== n.title ? `<div class="desc">${esc(n.description)}</div>` : ''}</div>`;
      }
      const m = e.m;
      if (m.meta && m.meta.event === 'approval_requested' && apMap[m.meta.approval_id]) { shown.add(m.meta.approval_id); return approvalCard(apMap[m.meta.approval_id]); }
      if (m.kind === 'system') return `<div class="sys">${esc(m.body)} • ${fmtTs(m.created_at)}</div>`;
      if (m.kind === 'decision') return `<div class="sys decision">${I('gavel')} ${esc(m.body)} • ${fmtTs(m.created_at)}</div>`;
      return `<div class="msg ${m.author_role} ${m.kind}"><div class="who"><b>${esc(m.author_name)}</b>${m.kind === 'update' ? '<span class="chip st-in_progress">تحديث تنفيذ</span>' : ''}${m.kind === 'result' ? '<span class="chip st-done">النتيجة النهائية</span>' : ''}<span>${fmtTs(m.created_at)}</span></div>
        ${m.body ? `<div class="body">${esc(m.body)}</div>` : ''}${filesHtml(m.files)}</div>`;
    });
    // طلبات لم تُعرض عبر رسالة نظام
    for (const ap of data.approvals) if (!shown.has(ap.id)) html.push(approvalCard(ap));
    $('#tl', main).innerHTML = html.join('') || '<div class="empty">لا توجد رسائل بعد</div>';
    $$('form.decide', main).forEach(f => {
      const dr = drafts[f.dataset.aid];
      if (dr) { f.elements.note.value = dr.note || ''; if (dr.opt) { const r = $(`input[name=opt][value="${dr.opt}"]`, f); if (r) r.checked = true; } }
      let decision = null;
      $$('[data-d]', f).forEach(b => b.onclick = () => { decision = b.dataset.d; });
      f.onsubmit = async (e) => {
        e.preventDefault();
        const d = formData(f);
        try {
          await POST(`/api/approvals/${f.dataset.aid}/decide`, { decision, note: d.note, option_index: d.opt });
          toast('سُجل القرار وأُبلغ مدير المكتب', 'ok'); await load(); refreshCounts();
        } catch (ex) { showErr(ex); }
      };
    });
    $$('[data-proxy]', main).forEach(b => b.onclick = () => modalProxyDecision(data.approvals.find(x => x.id == b.dataset.proxy), load));
    $$('[data-withdraw]', main).forEach(b => b.onclick = async () => { if (!confirm('سحب طلب الاعتماد؟')) return; try { await POST(`/api/approvals/${b.dataset.withdraw}/withdraw`); await load(); } catch (e) { showErr(e); } });
  }
  function renderLog() {
    const L = { created: 'إنشاء', acknowledged: 'تأكيد الاستلام', converted: 'تحويل إلى مهمة', status: 'تغيير الحالة', updated: 'تعديل', message: 'رسالة', update_posted: 'تحديث تنفيذ', closed: 'إغلاق نهائي' };
    const F = { kind: 'النوع', status: 'الحالة', title: 'العنوان', description: 'الوصف', section: 'القسم', assignee: 'المسؤول', due_date: 'الموعد', priority: 'الأولوية', next_step: 'الخطوة التالية', requires_approval: 'اشتراط الاعتماد', category: 'التصنيف', project_id: 'المشروع', due_time: 'الوقت', sop_id: 'الإجراء', partner_id: 'الجهة', folder_id: 'المجلد', assignee_id: 'المسؤول (حساب)', recurrence: 'التكرار', parent_task_id: 'المهمة الأصل' };
    const val = (f, v) => v == null ? '—' : f === 'status' ? (state.meta.statuses[v] || v) : f === 'priority' ? (state.meta.priorities[v] || v) : f === 'section' ? sectionName(v) : f === 'kind' ? ({ assignment: 'تكليف', note: 'ملاحظة', task: 'مهمة' }[v] || v) : v;
    $('#logc', main).innerHTML = data.audit.map(a => `<div class="log-row">${fmtTs(a.created_at)} — <b>${esc(a.user_name || '')}</b>: ${esc(L[a.action] || a.action)}${a.field && a.action !== 'created' ? ` (${esc(F[a.field] || a.field)}: ${esc(String(val(a.field, a.old_value)).slice(0, 60))} ← ${esc(String(val(a.field, a.new_value)).slice(0, 60))})` : ''}</div>`).join('') || '<div class="muted">لا يوجد</div>';
  }
  await load();
  return { refresh: load };
}

// ===== بانتظار قراري / طلبات الاعتماد =====
async function viewDecisions(main) {
  let tab = 'pending';
  async function load() {
    const list = await GET('/api/approvals?status=' + (tab === 'pending' ? 'pending' : 'decided'));
    main.innerHTML = `<div class="page-h">${I('gavel')}<h1>${isOwner() ? 'بانتظار قراري' : 'طلبات الاعتماد المرفوعة'}</h1></div>
      <div class="tabs"><button data-tab="pending" class="${tab === 'pending' ? 'active' : ''}">بانتظار القرار</button><button data-tab="decided" class="${tab === 'decided' ? 'active' : ''}">القرارات السابقة</button></div>
      ${isOwner() && tab === 'pending' ? '<p class="small muted">افتح أي طلب لقراءة التفاصيل والمرفقات والمحادثة، ثم اعتمد أو ارفض أو اطلب تعديلًا. تسجيل الاعتماد لا يُنفّذ أي إجراء مالي أو تعاقدي خارجي تلقائيًا.</p>' : ''}
      ${listOrEmpty(list, a => `<div class="row ${a.status === 'pending' ? (a.blocking ? 'p-urgent' : 'p-important') : 'done'}"><div class="main">
        <a class="title" href="#/item/${a.item_id}">${esc(a.title)}</a>
        <div class="small muted">ضمن: ${esc(a.ref)} — ${esc(a.item_title)}</div>
        ${a.body ? `<div class="small" style="white-space:pre-wrap;margin-top:4px">${esc(a.body.slice(0, 240))}</div>` : ''}
        <div class="meta"><span class="chip st-waiting_approval">${esc(a.kind_label)}</span><span class="chip">${esc(a.section_name)}</span>${a.blocking && a.status === 'pending' ? '<span class="chip overdue">يعطل التنفيذ</span>' : ''}
          ${a.options.length ? `<span class="chip">${a.options.length} بدائل</span>` : ''}${a.files.length ? `<span class="chip">${I('clip')}${a.files.length}</span>` : ''}
          ${a.status !== 'pending' ? `<span class="chip st-done">${esc(({ approved: 'معتمد', rejected: 'مرفوض', changes_requested: 'طُلب تعديل', chosen: 'اختير بديل', answered: 'تم الرد' })[a.status] || a.status)}</span><span class="txt">${fmtTs(a.decided_at)}</span>` : `<span class="txt">طُلب ${fmtTs(a.requested_at)}</span>`}</div></div>
        <div class="side"><a class="btn sm ${a.status === 'pending' && isOwner() ? 'primary' : ''}" href="#/item/${a.item_id}">${a.status === 'pending' && isOwner() ? 'اتخاذ القرار' : 'فتح'}</a></div></div>`, tab === 'pending' ? 'لا توجد طلبات تنتظر القرار' : 'لا توجد قرارات سابقة')}`;
    $$('[data-tab]', main).forEach(b => b.onclick = () => { tab = b.dataset.tab; load(); });
  }
  await load(); return { refresh: load };
}

// ===== النماذج =====
// «إضافة»: اختيار نوع العنصر الجديد — مهمة، مشروع، مبادرة
function modalAdd(pre = {}) {
  const choice = (k, icon, title, sub) => `<button type="button" class="add-choice" data-k="${k}">${I(icon)}<b>${title}</b><span>${sub}</span></button>`;
  const m = openModal({
    title: 'إضافة جديدة',
    body: `<div class="add-choices">
      ${can('directives.manage') ? choice('directive', 'flag', `توجيه من ${OT()}`, 'يُسجَّل بقناة وروده ويتحول إلى مهام تنفيذية تُتابع حتى النتيجة') : ''}
      ${can('task.create') || can('assignment.create') ? choice('task', 'checkCircle', isOwner() ? 'مهمة / تكليف' : 'مهمة', 'مستقلة أو دورية أو ضمن مشروع أو مبادرة') : ''}
      ${can('projects.manage') ? choice('project', 'briefcase', 'مشروع', 'يجمع مهامًا تحت هدف واحد') + choice('initiative', 'flag', 'مبادرة', 'فكرة أو برنامج تُتابع مهامه') : ''}</div>`,
    init: (form) => $$('[data-k]', form).forEach(b => b.onclick = () => {
      m.close(); const k = b.dataset.k;
      if (k === 'task') isOwner() ? modalAssignment(pre) : modalTask(pre);
      else if (k === 'directive') modalDirective(pre);
      else modalProject({ section: pre.section, folder_id: pre.folder_id, kind: k });
    }),
  });
}
// «مهام اليوم»: المستحقة اليوم والمتأخرة، مع نسخها كرسالة (لواتساب أو غيره)
async function modalToday() {
  const [today, overdue] = await Promise.all([GET('/api/items?' + qs({ kind: 'tasks', scope: 'today' })), GET('/api/items?' + qs({ kind: 'tasks', scope: 'overdue' }))]);
  const dateTxt = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const row = (i) => `<a class="today-row" href="#/item/${i.id}"><span class="pdot c-${i.color || 'none'}" aria-hidden="true" title="${esc(i.color_label || '')}"></span>
    <span class="tt">${i.section ? `<b>${esc(i.section_name)}:</b> ` : ''}${esc(i.title)}</span>
    <span class="small muted">${esc(i.is_overdue ? fmtDate(i.due_date) : (i.due_time || (i.assignee !== state.me.name ? i.assignee : '') || ''))}</span></a>`;
  const mark = (i) => ({ red: '🔴 ', blue: '🔵 ', gray: '⚪ ' })[i.color] || '';
  const who = (i) => i.assignee && i.assignee !== state.me.name ? ` (${i.assignee})` : '';
  const line = (i, n, late) => `${n + 1}. ${mark(i)}${i.section ? `[${i.section_name}] ` : ''}${i.title}${late ? ` — منذ ${fmtDate(i.due_date)}` : i.due_time ? ` — ${i.due_time}` : ''}${who(i)}`;
  const text = [`📋 مهام اليوم — ${dateTxt}`, '',
    `مستحقة اليوم (${today.length}):`, ...(today.length ? today.map((i, n) => line(i, n)) : ['لا توجد']),
    ...(overdue.length ? ['', `متأخرة لم تُنجز (${overdue.length}):`, ...overdue.map((i, n) => line(i, n, true))] : [])].join('\n');
  const m = openModal({
    title: 'مهام اليوم',
    body: `<div class="today-top"><p class="small muted">${esc(dateTxt)} • ${esc(hijri)}</p><button type="button" class="btn primary sm" id="copyToday">${I('copy')} نسخ كرسالة</button></div>
      <h3 class="today-h">${I('calendarCheck')} مستحقة اليوم (${today.length})</h3>
      ${today.length ? `<div class="today-list">${today.map(row).join('')}</div>` : '<div class="small muted">لا توجد مهام مستحقة اليوم</div>'}
      ${overdue.length ? `<h3 class="today-h red">${I('alert')} متأخرة لم تُنجز (${overdue.length})</h3><div class="today-list">${overdue.map(row).join('')}</div>` : ''}
      <div style="margin-top:12px">${colorLegendHtml()}</div>`,
    init: (form) => {
      $('#copyToday', form).onclick = async () => { await copyText(text); toast('نُسخت القائمة — الصقها في واتساب أو أي رسالة', 'ok'); };
      $$('.today-row', form).forEach(a => a.addEventListener('click', () => m.close()));
    },
  });
}
async function modalAssignment(pre = {}) {
  const [projects, folders] = await Promise.all([GET('/api/projects'), can('folders.view') ? GET('/api/folders') : []]);
  openModal({
    title: 'تكليف جديد إلى مدير المكتب', submit: 'إرسال إلى مدير المكتب', init: bindTaskForm,
    body: `${field('عنوان التكليف *', '<input type="text" name="title" required maxlength="300">')}
      ${field('وصف المطلوب', '<textarea name="description" placeholder="ما المطلوب تحديدًا؟ أي تفاصيل أو سياق مهم"></textarea>')}
      ${field('القسم المعني *', sectionSeg(pre.section))}
      ${field('المجلد (اختياري)', folderSelect(folders, pre.folder_id))}
      ${classifyHtml(pre, projects)}
      ${field('درجة الأهمية', prioSeg('normal'))}
      <div class="grid2">${field('الموعد المطلوب (اختياري)', '<input type="date" name="due_date">')}${field('الوقت (اختياري)', '<input type="time" name="due_time">')}</div>
      ${field('المرفقات والملاحظة الصوتية', fileFieldHtml())}`,
    onSubmit: async (d) => {
      if (!d.section) throw new Error('اختر القسم المعني');
      applyTaskType(d);
      const it = await POST('/api/assignments', d);
      toast(`أُرسل التكليف ${it.ref} إلى مدير المكتب`, 'ok'); location.hash = `#/item/${it.id}`; refreshView();
    },
  });
}
async function modalNote(pre = {}) {
  const open = await GET('/api/items?kind=all&scope=open');
  const tasks = open.filter(i => i.kind !== 'note');
  openModal({
    title: 'إرسال ملاحظة أو طلب', submit: 'إرسال',
    body: `${field('نوع الرسالة *', `<div class="seg">${Object.entries(state.meta.msg_types).map(([k, v]) => `<label><input type="radio" name="msg_type" value="${k}" ${k === (pre.parent_id ? 'modify' : 'info') ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>`)}
      ${field('النص *', '<textarea name="description" required></textarea>')}
      ${field('الموضوع (اختياري)', '<input type="text" name="title" maxlength="300">')}
      ${field('ربط بمهمة أو تكليف قائم (اختياري)', `<select name="parent_id">${opt('', '— بدون ربط —')}${tasks.map(t => opt(t.id, `${t.ref} — ${t.title}`, pre.parent_id)).join('')}</select>`)}
      <div class="grid2">${field('القسم (اختياري)', sectionSelect('', 'section', true))}${field('الأهمية', `<select name="priority">${Object.entries(state.meta.priorities).map(([k, v]) => opt(k, v, 'normal')).join('')}</select>`)}</div>
      ${field('المرفقات', fileFieldHtml())}
      <p class="small muted">لن تتحول الملاحظة إلى مهمة تلقائيًا؛ يقرر مدير المكتب تحويلها عند الحاجة مع الاحتفاظ بنصها الأصلي.</p>`,
    onSubmit: async (d) => {
      if (!d.parent_id) delete d.parent_id;
      const it = await POST('/api/notes', d);
      toast('أُرسلت الرسالة إلى مدير المكتب', 'ok'); location.hash = `#/item/${d.parent_id || it.id}`; refreshView();
    },
  });
}
async function taskFormBody(i = {}, { withDesc = true } = {}) {
  const [projects, sops, partners, folders] = await Promise.all([GET('/api/projects'), can('sops.view') ? GET('/api/sops') : [], can('partners.view') ? GET('/api/partners') : [], can('folders.view') ? GET('/api/folders') : []]);
  const people = state.meta.users.filter(u => u.role !== 'owner');
  return `${field('العنوان *', `<input type="text" name="title" required value="${esc(i.title || '')}">`)}
    ${withDesc ? field('الوصف', `<textarea name="description">${esc(i.description || '')}</textarea>`) : ''}
    ${field('المخرج المطلوب (ما الذي يُسلَّم عند الإنجاز؟)', `<input type="text" name="deliverable" maxlength="1000" value="${esc(i.deliverable || '')}" placeholder="مثل: تقرير معتمد، جدول نهائي، خطاب مرسل">`)}
    <div class="grid2">
      ${field('القسم *', sectionSelect(i.section, 'section', true))}
      ${can('folders.view') ? field('المجلد', folderSelect(folders, i.folder_id, '— بدون —')) : ''}
      ${assigneeFieldHtml(i, people)}
      ${field('الموعد النهائي', `<input type="date" name="due_date" value="${esc(i.due_date || '')}">`)}
    </div>
    ${field('الأولوية', prioSeg(i.priority || 'normal'))}
    ${classifyHtml(i, projects)}
    ${!i.id && i.directive_id ? `<input type="hidden" name="directive_id" value="${esc(i.directive_id)}">` : ''}
    <details class="more-opts" ${i.id ? 'open' : ''}><summary>خيارات إضافية: الوقت، التصنيف، الخطوة التالية، الإجراء، الجهة${isMember() ? '' : '، اشتراط الاعتماد'}</summary>
    <div class="grid2">
      ${field('الوقت', `<input type="time" name="due_time" value="${esc(i.due_time || '')}">`)}
      ${field('التصنيف', `<select name="category">${Object.entries(state.meta.categories).map(([k, v]) => opt(k, v, i.category || 'general')).join('')}</select>`)}
    </div>
    ${field('الخطوة التالية', `<input type="text" name="next_step" value="${esc(i.next_step || '')}">`)}
    <div class="grid2">
      ${can('sops.view') ? field('الإجراء التشغيلي المرتبط', `<select name="sop_id">${opt('', '— بدون —', i.sop_id)}${sops.map(s => opt(s.id, s.name, i.sop_id)).join('')}</select>`) : ''}
      ${can('partners.view') ? field('الجهة / الشراكة المرتبطة', `<select name="partner_id">${opt('', '— بدون —', i.partner_id)}${partners.map(p => opt(p.id, p.name, i.partner_id)).join('')}</select>`) : ''}
    </div>
    ${isMember() ? '' : `<label class="check"><input type="checkbox" name="requires_approval" ${i.requires_approval ? 'checked' : ''}> تتطلب اعتماد ${OT()} للنتيجة النهائية قبل الإغلاق</label>`}
    </details>`;
}
// في نموذج المهمة: المجلدات والمشاريع تتبع القسم المختار، واختيار مشروع يضبط مجلده
// حقل مسؤول واحد: حسابات المنصة، أو «شخص خارج المنصة» يُكتب اسمه
function assigneeFieldHtml(i, people) {
  const isNew = !i.id;
  const sel = i.assignee_id ? String(i.assignee_id) : (i.assignee ? '__other' : (isNew && !isOwner() ? String(state.me.id) : ''));
  return `<label class="f"><span>المسؤول عن التنفيذ</span><select name="assignee_pick">${opt('', '— غير محدد —', sel)}
      ${people.map(u => opt(u.id, `${u.name}${u.id === state.me.id ? ' (أنا)' : u.role === 'member' ? ` — ${u.title || 'موظف'}` : ''}`, sel)).join('')}
      ${opt('__other', 'شخص خارج المنصة…', sel)}</select></label>
    <label class="f ${sel === '__other' ? '' : 'hidden'}" data-assignee-other><span>اسم المسؤول (خارج المنصة)</span><input type="text" name="assignee" maxlength="200" value="${esc(i.assignee_id ? '' : (i.assignee || ''))}"></label>`;
}
// تحويل اختيار المسؤول إلى حقول الخادم
function applyAssignee(d) {
  if (d.assignee_pick === undefined) return d;
  const p = d.assignee_pick; delete d.assignee_pick;
  if (p === '__other') { d.assignee_id = ''; d.assignee = (d.assignee || '').trim(); if (!d.assignee) throw new Error('اكتب اسم المسؤول'); }
  else { d.assignee_id = p; d.assignee = ''; }
  return d;
}

// المجلدات والمشاريع تتبع القسم المختار، والمشاريع تتبع النوع (مشروع/مبادرة)، واختيار مشروع يضبط مجلده
function bindTaskForm(form) {
  const E = form.elements; const fol = E.folder_id, prj = E.project_id;
  const val = (n) => (E[n] ? E[n].value : '');
  const sync = (ev) => {
    const sec = val('section'), type = val('task_type');
    $$('[data-show]', form).forEach(el => el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(type)));
    const pl = $('[data-plabel]', form);
    const filter = (sel, ok) => { for (const o of sel.options) if (o.value) { const y = ok(o); o.hidden = !y; o.disabled = !y; if (!y && o.selected) sel.value = ''; } };
    if (fol) filter(fol, o => !sec || o.dataset.section === sec);
    if (prj) filter(prj, o => (!sec || o.dataset.section === sec) && (!['project', 'initiative'].includes(type) || o.dataset.kind === type));
    if (pl && prj) {
      const word = type === 'initiative' ? 'المبادرة' : 'المشروع';
      const none = ['project', 'initiative'].includes(type) && ![...prj.options].some(o => o.value && !o.hidden);
      pl.textContent = none ? `${word} — ${type === 'initiative' ? 'لا توجد مبادرات' : 'لا توجد مشاريع'} في ${sec ? 'هذا القسم' : 'المنصة'} بعد` : word;
    }
    if (ev && ev.target === prj && fol) { const o = prj.selectedOptions[0]; if (o && o.dataset.folder) fol.value = o.dataset.folder; }
    const ap = E.assignee_pick, other = $('[data-assignee-other]', form);
    if (ap && other) other.classList.toggle('hidden', ap.value !== '__other');
  };
  form.addEventListener('change', sync); sync();
}
async function modalTask(i, after) {
  const editing = i && i.id;
  openModal({
    title: editing ? `تعديل ${i.ref}` : 'مهمة جديدة', wide: true, init: bindTaskForm,
    body: await taskFormBody(i || {}) + (editing ? '' : field('المرفقات', fileFieldHtml())),
    onSubmit: async (d) => {
      if (!d.section) throw new Error('اختر القسم');
      applyTaskType(d); applyAssignee(d);
      if (!can('partners.view')) delete d.partner_id; // لا يمسح ربطًا لا يراه
      if (editing) { delete d.file_ids; await api('PATCH', `/api/items/${i.id}`, d); toast('حُفظت التعديلات', 'ok'); after && after(); }
      else { const it = await POST('/api/tasks', d); toast(`أُنشئت المهمة ${it.ref}`, 'ok'); location.hash = `#/item/${it.id}`; }
      refreshView();
    },
  });
}
async function modalConvert(i, after) {
  openModal({
    title: `تحويل ${i.ref} إلى مهمة منظمة`, wide: true, submit: 'تحويل إلى مهمة', init: bindTaskForm,
    body: `<div class="info-box" style="margin-bottom:12px">يتم التحويل في السجل نفسه — يبقى الرقم المرجعي والنص الأصلي والمحادثة كما هي دون إنشاء نسخة مكررة.</div>` + await taskFormBody(i),
    onSubmit: async (d) => { applyTaskType(d); applyAssignee(d); await POST(`/api/items/${i.id}/convert`, d); toast('حُوّل إلى مهمة', 'ok'); after ? after() : (location.hash = `#/item/${i.id}`); refreshView(); },
  });
}
function modalApproval(i, after, preset = {}) {
  const kinds = Object.entries(state.meta.approval_kinds).filter(([k]) => k !== 'final');
  openModal({
    title: 'طلب اعتماد أو قرار من ' + OT() + '', submit: 'إرسال الطلب',
    body: `${field('نوع الطلب', `<select name="kind">${kinds.map(([k, v]) => opt(k, v, preset.kind || 'report')).join('')}</select>`)}
      ${field('العنوان *', `<input type="text" name="title" required value="${esc(preset.title || '')}">`)}
      ${field('التفاصيل', '<textarea name="body" placeholder="ملخص ما يحتاج إلى قرار، والتوصية إن وجدت"></textarea>')}
      ${field('بدائل مقترحة (اختياري — كل بديل في سطر)', '<textarea name="options" style="min-height:70px"></textarea>')}
      <label class="check"><input type="checkbox" name="blocking" checked> هذا القرار يعطل التنفيذ (يظهر في شريط المهام العاجلة)</label>
      ${field('المرفقات (تقرير، عرض…)', fileFieldHtml('file_ids', false))}`,
    onSubmit: async (d) => { await POST(`/api/items/${i.id}/approvals`, d); toast('أُرسل الطلب إلى ' + OT() + '', 'ok'); after && after(); },
  });
}
function modalResult(i, after) {
  openModal({
    title: 'رفع النتيجة النهائية', submit: i.requires_approval ? 'رفع النتيجة وطلب الاعتماد' : 'رفع النتيجة وإكمال المهمة', submitClass: 'green',
    body: `${i.requires_approval ? '<div class="warn-box" style="margin-bottom:10px">هذه المهمة تتطلب اعتماد ' + OT() + '؛ ستُرسل النتيجة إليه وتكتمل المهمة بعد اعتماده.</div>' : ''}
      ${field('ملخص النتيجة *', '<textarea name="body" required></textarea>')}${field('المرفقات', fileFieldHtml('file_ids', false))}`,
    onSubmit: async (d) => {
      if (!d.body.trim()) throw new Error('اكتب ملخص النتيجة');
      if (i.requires_approval) await POST(`/api/items/${i.id}/approvals`, { kind: 'final', title: i.title, body: d.body, file_ids: d.file_ids, blocking: true });
      else { await POST(`/api/items/${i.id}/messages`, { body: d.body, kind: 'result', file_ids: d.file_ids }); await api('PATCH', `/api/items/${i.id}`, { status: 'done' }); }
      toast(i.requires_approval ? 'أُرسلت النتيجة لاعتماد ' + OT() + '' : 'اكتملت المهمة', 'ok'); after && after();
    },
  });
}
async function modalProject(p = {}) {
  const folders = await GET('/api/folders');
  const folderSel = (sec) => `<select name="folder_id">${opt('', '— بدون مجلد —', p.folder_id)}${folderPaths(folders).filter(fo => !sec || fo.section === sec).map(fo => opt(fo.id, `${sectionName(fo.section)}: ${fo.path}`, p.folder_id)).join('')}</select>`;
  const kind = p.kind || 'project'; const label = state.meta.project_kinds[kind];
  openModal({
    title: p.id ? `تعديل ${label}` : `${label === 'مبادرة' ? 'مبادرة جديدة' : 'مشروع جديد'}`,
    body: `${field('النوع', `<div class="seg">${Object.entries(state.meta.project_kinds).map(([k, v]) => `<label><input type="radio" name="kind" value="${k}" ${k === kind ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>`)}
      ${field('الاسم *', `<input type="text" name="name" required value="${esc(p.name || '')}">`)}${field('الوصف', `<textarea name="description">${esc(p.description || '')}</textarea>`)}
      <div class="grid2">${p.id ? `<input type="hidden" name="section" value="${esc(p.section)}">` : field('القسم', sectionSelect(p.section))}${field('المجلد', folderSel(p.id ? p.section : null))}
      ${p.id ? field('الحالة', `<select name="status">${opt('active', 'جارٍ', p.status)}${opt('paused', 'متوقف', p.status)}${opt('done', 'منتهٍ', p.status)}</select>`) : ''}</div>`,
    init: (form) => { if (!p.id) { const sec = form.elements.section, fol = form.elements.folder_id; const f = () => { for (const o of fol.options) if (o.value) { const fo = folders.find(x => x.id == o.value); o.hidden = o.disabled = fo.section !== sec.value; if (o.hidden && o.selected) fol.value = ''; } }; sec.addEventListener('change', f); f(); } },
    onSubmit: async (d) => {
      p.id ? await api('PATCH', `/api/projects/${p.id}`, d) : await POST('/api/projects', d);
      toast(p.id ? 'حُفظت التعديلات' : (d.kind === 'initiative' ? `أُنشئت المبادرة «${d.name}»` : `أُنشئ المشروع «${d.name}»`), 'ok'); refreshView();
    },
  });
}

// ===== الاجتماعات والقرارات =====
async function viewMeetings(main) {
  let tab = 'meetings';
  async function load() {
    const [ms, ds] = await Promise.all([GET('/api/meetings'), GET('/api/decisions')]);
    const late = ds.filter(d => d.is_overdue);
    main.innerHTML = `<div class="page-h">${I('calendar')}<h1>الاجتماعات والقرارات</h1><span class="spacer"></span>${can('meetings.manage') ? `<button class="btn primary" id="add">${I('plus')} اجتماع جديد</button>` : ''}</div>
      <div class="kpis" style="margin-bottom:12px"><div class="kpi blue"><b>${ms.filter(m => m.status === 'scheduled' && m.starts_at >= today()).length}</b><span>اجتماعات قادمة</span></div>
        <div class="kpi"><b>${ds.length}</b><span>قرارات مسجلة</span></div><div class="kpi green"><b>${ds.filter(d => d.effective_status === 'done').length}</b><span>قرارات منفذة</span></div>
        <div class="kpi red"><b>${late.length}</b><span>قرارات متأخرة</span></div></div>
      <div class="tabs"><button data-tab="meetings" class="${tab === 'meetings' ? 'active' : ''}">الاجتماعات</button><button data-tab="decisions" class="${tab === 'decisions' ? 'active' : ''}">متابعة القرارات</button></div>
      ${tab === 'meetings' ? listOrEmpty(ms, m => `<a class="row" href="#/meeting/${m.id}"><div class="main"><span class="title">${esc(m.title)}</span><div class="meta">
          <span class="chip ${m.status === 'held' ? 'st-done' : m.status === 'cancelled' ? 'st-cancelled' : 'st-in_progress'}">${({ scheduled: 'مجدول', held: 'منعقد', cancelled: 'ملغى' })[m.status]}</span>
          <span class="chip">${I('calendar')}${esc(fmtDate(m.starts_at.slice(0, 10)))} ${esc(m.starts_at.slice(11, 16))}</span>${m.section_name ? `<span class="chip">${esc(m.section_name)}</span>` : ''}<span class="txt">${m.decisions_count} قرار</span>${demoChip(m)}</div></div></a>`, 'لا توجد اجتماعات')
      : listOrEmpty(ds, decisionRowHtml, 'لا توجد قرارات')}`;
    const add = $('#add', main); if (add) add.onclick = () => modalMeeting();
    $$('[data-tab]', main).forEach(b => b.onclick = () => { tab = b.dataset.tab; load(); });
    bindDecisionActions(main, load);
  }
  await load(); return { refresh: load };
}
function decisionRowHtml(d) {
  return `<div class="row ${d.is_overdue ? 'p-urgent' : d.effective_status === 'done' ? 'done' : ''}"><div class="main"><span class="title">${esc(d.text)}</span><div class="meta">
    <span class="chip st-${d.effective_status}">${esc(d.status_label)}</span>${d.due_date ? `<span class="chip ${d.is_overdue ? 'overdue' : ''}">${I('clock')}${esc(fmtDate(d.due_date))}${d.is_overdue ? ' — متأخر' : ''}</span>` : ''}
    ${d.responsible ? `<span class="txt">المسؤول: ${esc(d.responsible)}</span>` : ''}${d.meeting_title ? `<a class="txt" href="#/meeting/${d.meeting_id}">${esc(d.meeting_title)}</a>` : ''}
    ${d.task_id ? (d.task_hidden ? '<span class="chip">مرتبط بمهمة</span>' : `<a class="chip kind" href="#/item/${d.task_id}">المهمة ${esc(d.task_ref)}</a>`) : ''}</div></div>
    ${can('meetings.manage') && !d.task_id ? `<div class="side"><button class="btn sm primary" data-d2t="${d.id}" data-section="${esc(d.meeting_section || '')}" data-resp="${esc(d.responsible || '')}" data-due="${esc(d.due_date || '')}">تحويل إلى مهمة</button>
      <select class="dst" data-id="${d.id}" style="min-height:36px;width:auto">${['pending', 'in_progress', 'done', 'cancelled'].map(s => opt(s, ({ pending: 'لم يبدأ', in_progress: 'قيد التنفيذ', done: 'منفذ', cancelled: 'ملغى' })[s], d.status)).join('')}</select></div>` : ''}</div>`;
}
function bindDecisionActions(root, reload) {
  $$('[data-d2t]', root).forEach(b => b.onclick = () => openModal({
    title: 'تحويل القرار إلى مهمة', submit: 'إنشاء المهمة',
    body: `${field('القسم *', sectionSelect(b.dataset.section, 'section', true))}
      <div class="grid2">${field('المسؤول', `<select name="assignee_id">${opt('', b.dataset.resp ? `كما في القرار: ${b.dataset.resp}` : '— غير محدد —')}${state.meta.users.filter(u => u.role !== 'owner').map(u => opt(u.id, u.name, (state.meta.users.find(x => x.name === b.dataset.resp) || {}).id)).join('')}</select>`)}
      ${field('الموعد النهائي', `<input type="date" name="due_date" value="${esc(b.dataset.due || '')}">`)}</div>
      ${field('الأولوية', prioSeg('normal'))}<p class="small muted">تُربط المهمة بالاجتماع والقرار، ويتبع القرار حالتها دون تكرار. اختيار حساب يجعل المهمة تظهر للموظف وتصله إشعارًا.</p>`,
    onSubmit: async (d) => { if (!d.section) throw new Error('اختر القسم'); if (!d.assignee_id) delete d.assignee_id; const t = await POST(`/api/decisions/${b.dataset.d2t}/task`, d); toast(`أُنشئت المهمة ${t.ref} مرتبطة بالاجتماع`, 'ok'); reload(); },
  }));
  $$('select.dst', root).forEach(s => s.onchange = async () => { try { await api('PATCH', `/api/decisions/${s.dataset.id}`, { status: s.value }); reload(); } catch (e) { showErr(e); } });
}
async function viewMeeting(main, id) {
  async function load() {
    const m = await GET(`/api/meetings/${id}`);
    main.innerHTML = `<div class="card"><div class="btn-row"><a class="btn sm ghost" href="#/meetings">${I('back')} الاجتماعات</a>${demoChip(m)}</div>
      <div class="page-h"><h1>${esc(m.title)}</h1><span class="spacer"></span>${can('meetings.manage') ? `<button class="btn" id="edit">تعديل / المحضر</button>` : ''}</div>
      <dl class="facts"><div><dt>الموعد</dt><dd>${esc(fmtDate(m.starts_at.slice(0, 10)))} ${esc(m.starts_at.slice(11, 16))}</dd></div><div><dt>المكان</dt><dd>${esc(m.location || '—')}</dd></div>
        <div><dt>القسم</dt><dd>${esc(m.section_name || '—')}</dd></div><div><dt>الحالة</dt><dd>${({ scheduled: 'مجدول', held: 'منعقد', cancelled: 'ملغى' })[m.status]}</dd></div></dl>
      ${m.participants ? `<h3>المشاركون</h3><div class="desc">${esc(m.participants)}</div>` : ''}
      ${m.topics ? `<h3 class="section-gap">الموضوعات</h3><div class="desc">${esc(m.topics)}</div>` : ''}
      ${m.minutes ? `<h3 class="section-gap">محضر الاجتماع</h3><div class="orig">${esc(m.minutes)}</div>` : ''}
      ${filesHtml(m.files)}</div>
      <div class="card"><div class="card-h"><h2>القرارات الصادرة</h2><span class="chip">${m.decisions.length}</span><span class="spacer"></span>${can('meetings.manage') ? `<button class="btn sm" id="addMany">${I('list')} عدة قرارات</button><button class="btn sm primary" id="addD">${I('plus')} قرار</button>` : ''}</div>
      <div class="btn-row no-print" style="margin-bottom:8px">${shareLinks(`محضر: ${m.title} — ${fmtDate(m.starts_at.slice(0, 10))}${m.minutes ? '\n\n' + m.minutes : ''}${m.decisions.length ? '\n\nالقرارات:\n' + m.decisions.map((x, n) => `${n + 1}. ${x.text}${x.responsible ? ` — ${x.responsible}` : ''}${x.due_date ? ` (${fmtDate(x.due_date)})` : ''}`).join('\n') : ''}`, `محضر ${m.title}`)}</div>
      ${listOrEmpty(m.decisions, decisionRowHtml, 'لا توجد قرارات مسجلة')}</div>`;
    const e = $('#edit', main); if (e) e.onclick = () => modalMeeting(m);
    const mm = $('#addMany', main); if (mm) mm.onclick = () => openModal({
      title: 'إضافة عدة قرارات', submit: 'حفظ القرارات', wide: true,
      body: `${field('القرارات * (سطر لكل قرار)', '<textarea name="text" required style="min-height:140px" placeholder="اعتماد خطة الفصل الثاني\nتشكيل لجنة الاختبارات\n…"></textarea>')}
        <label class="check"><input type="checkbox" name="to_task" checked> إنشاء مهمة لكل قرار فورًا</label>
        <div class="grid2">${field('قسم المهام', sectionSelect(m.section, 'section', true))}${field('المسؤول (اختياري)', `<select name="assignee_id">${opt('', '— يُحدَّد لاحقًا —')}${state.meta.users.filter(u => u.role !== 'owner').map(u => opt(u.id, u.name)).join('')}</select>`)}
        ${field('الموعد (اختياري)', '<input type="date" name="due_date">')}</div>`,
      onSubmit: async (d) => { if (d.to_task && !d.section) throw new Error('اختر قسم المهام'); if (!d.assignee_id) delete d.assignee_id; const r = await POST(`/api/meetings/${id}/decisions/bulk`, d); toast(`سُجّل ${r.created} قرارات`, 'ok'); load(); },
    });
    const ad = $('#addD', main); if (ad) ad.onclick = () => openModal({
      title: 'قرار جديد',
      body: `${field('نص القرار *', '<textarea name="text" required></textarea>')}<div class="grid2">${field('المسؤول', '<input type="text" name="responsible">')}${field('الموعد النهائي', '<input type="date" name="due_date">')}</div>
        <label class="check"><input type="checkbox" name="to_task" checked> إنشاء مهمة مرتبطة بهذا القرار فورًا</label>
        ${field('قسم المهمة', sectionSelect(m.section, 'section', true))}`,
      onSubmit: async (d) => { if (d.to_task && !d.section) throw new Error('اختر قسم المهمة'); await POST(`/api/meetings/${id}/decisions`, d); load(); },
    });
    bindDecisionActions(main, load);
  }
  await load(); return { refresh: load };
}
function modalMeeting(m = {}) {
  openModal({
    title: m.id ? 'تعديل الاجتماع' : 'اجتماع جديد', wide: true,
    body: `${field('العنوان *', `<input type="text" name="title" required value="${esc(m.title || '')}">`)}
      <div class="grid2">${field('الموعد *', `<input type="datetime-local" name="starts_at" required value="${esc((m.starts_at || '').slice(0, 16))}">`)}${field('المكان', `<input type="text" name="location" value="${esc(m.location || '')}">`)}
      ${field('القسم', sectionSelect(m.section, 'section', true))}${field('الحالة', `<select name="status">${opt('scheduled', 'مجدول', m.status)}${opt('held', 'منعقد', m.status)}${opt('cancelled', 'ملغى', m.status)}</select>`)}</div>
      ${field('المشاركون', `<textarea name="participants" style="min-height:60px">${esc(m.participants || '')}</textarea>`)}
      ${field('الموضوعات', `<textarea name="topics" style="min-height:70px">${esc(m.topics || '')}</textarea>`)}
      ${field('محضر الاجتماع', `<textarea name="minutes" style="min-height:120px">${esc(m.minutes || '')}</textarea>`)}
      ${field('مرفقات', fileFieldHtml('file_ids', false))}`,
    onSubmit: async (d) => { if (m.id) { await api('PATCH', `/api/meetings/${m.id}`, d); refreshView(); } else { const r = await POST('/api/meetings', d); location.hash = `#/meeting/${r.id}`; } },
  });
}

// ===== الإجراءات التشغيلية =====
async function viewSops(main) {
  async function load() {
    const list = await GET('/api/sops');
    main.innerHTML = `<div class="page-h">${I('book')}<h1>مكتبة الإجراءات التشغيلية</h1><span class="spacer"></span>${can('sops.manage') ? `<button class="btn primary" id="add">${I('plus')} إجراء جديد</button>` : ''}</div>
      ${listOrEmpty(list, s => `<a class="row" href="#/sop/${s.id}"><div class="main"><span class="title">${esc(s.name)}</span>${s.purpose ? `<div class="small muted">${esc(s.purpose.slice(0, 160))}</div>` : ''}
        <div class="meta">${s.section_name ? `<span class="chip">${esc(s.section_name)}</span>` : ''}${s.responsible ? `<span class="txt">المسؤول: ${esc(s.responsible)}</span>` : ''}
        ${s.approved_at ? `<span class="txt">اعتُمد: ${esc(fmtDate(s.approved_at))}</span>` : '<span class="chip">غير معتمد</span>'}<span class="txt">آخر تحديث: ${fmtTs(s.updated_at)}</span>${demoChip(s)}</div></div></a>`, 'لا توجد إجراءات بعد')}`;
    const a = $('#add', main); if (a) a.onclick = () => modalSop();
  }
  await load(); return { refresh: load };
}
async function viewSop(main, id) {
  async function load() {
    const s = await GET(`/api/sops/${id}`);
    const steps = (s.steps || '').split('\n').map(x => x.trim()).filter(Boolean);
    main.innerHTML = `<div class="card"><div class="btn-row"><a class="btn sm ghost" href="#/sops">${I('back')} الإجراءات</a>${demoChip(s)}</div>
      <div class="page-h"><h1>${esc(s.name)}</h1><span class="spacer"></span>${can('sops.manage') ? '<button class="btn" id="edit">تعديل</button>' : ''}</div>
      <dl class="facts"><div><dt>المسؤول</dt><dd>${esc(s.responsible || '—')}</dd></div><div><dt>القسم</dt><dd>${esc(s.section ? sectionName(s.section) : '—')}</dd></div>
        <div><dt>تاريخ الاعتماد</dt><dd>${esc(s.approved_at ? fmtDate(s.approved_at) : 'غير معتمد')}</dd></div><div><dt>آخر تحديث</dt><dd>${fmtTs(s.updated_at)}</dd></div></dl>
      ${s.purpose ? `<h3>الغرض</h3><div class="desc">${esc(s.purpose)}</div>` : ''}
      <h3 class="section-gap">خطوات التنفيذ</h3>${steps.length ? `<ol class="steps-list">${steps.map(x => `<li>${esc(x.replace(/^\d+[.)-]\s*/, ''))}</li>`).join('')}</ol>` : '<div class="muted">لم تُضف خطوات</div>'}
      ${s.files.length ? `<h3 class="section-gap">النماذج والملفات</h3>${filesHtml(s.files)}` : ''}</div>
      <div class="card"><div class="card-h"><h2>مهام مرتبطة بهذا الإجراء</h2></div>${listOrEmpty(s.tasks, i => itemRow(i), 'لا توجد')}</div>`;
    const e = $('#edit', main); if (e) e.onclick = () => modalSop(s);
    if (can('task.create')) { $('.page-h', main).insertAdjacentHTML('beforeend', `<button class="btn primary" id="useSop">${I('plus')} مهمة تتبع هذا الإجراء</button>`); $('#useSop', main).onclick = () => modalTask({ sop_id: s.id, section: s.section, title: s.name }); }
  }
  await load(); return { refresh: load };
}
function modalSop(s = {}) {
  openModal({
    title: s.id ? 'تعديل الإجراء' : 'إجراء تشغيلي جديد', wide: true,
    body: `${field('اسم الإجراء *', `<input type="text" name="name" required value="${esc(s.name || '')}">`)}${field('الغرض', `<textarea name="purpose" style="min-height:60px">${esc(s.purpose || '')}</textarea>`)}
      ${field('خطوات التنفيذ (كل خطوة في سطر)', `<textarea name="steps" style="min-height:140px">${esc(s.steps || '')}</textarea>`)}
      <div class="grid2">${field('المسؤول', `<input type="text" name="responsible" value="${esc(s.responsible || '')}">`)}${field('القسم', sectionSelect(s.section, 'section', true))}
      ${field('تاريخ الاعتماد', `<input type="date" name="approved_at" value="${esc(s.approved_at || '')}">`)}</div>
      ${field('النماذج والملفات', fileFieldHtml('file_ids', false))}`,
    onSubmit: async (d) => { if (s.id) { await api('PATCH', `/api/sops/${s.id}`, d); refreshView(); } else { const r = await POST('/api/sops', d); location.hash = `#/sop/${r.id}`; } },
  });
}

// ===== العلاقات والشراكات =====
async function renderPartnersInto(el) {
  const list = await GET('/api/partners');
  el.innerHTML = `${can('partners.manage') ? `<div class="btn-row" style="margin-bottom:10px"><button class="btn primary" id="addPt">${I('plus')} جهة أو شخصية</button></div>` : ''}
    ${listOrEmpty(list, p => `<a class="row ${p.awaiting_reply ? 'p-important' : ''}" href="#/partner/${p.id}"><div class="main"><span class="title">${esc(p.name)}</span><div class="meta">
      <span class="chip">${p.entity_type === 'person' ? 'شخصية' : 'جهة'}</span>${p.relation_type ? `<span class="chip kind">${esc(p.relation_type)}</span>` : ''}
      ${p.awaiting_reply ? '<span class="chip p-important">تنتظر ردًا</span>' : ''}${p.next_followup ? `<span class="chip ${p.followup_due ? 'today' : ''}">${I('calendar')}المتابعة: ${esc(fmtDate(p.next_followup))}</span>` : ''}
      ${p.last_contact_at ? `<span class="txt">آخر تواصل: ${esc(fmtDate(p.last_contact_at))}</span>` : ''}${demoChip(p)}</div></div></a>`, 'لا توجد جهات مسجلة')}`;
  const a = $('#addPt', el); if (a) a.onclick = () => modalPartner();
}
async function viewPartners(main) {
  main.innerHTML = `<div class="page-h">${I('handshake')}<h1>العلاقات والشراكات</h1></div><div id="pl"></div>`;
  const load = () => renderPartnersInto($('#pl', main));
  await load(); return { refresh: load };
}
async function viewPartner(main, id) {
  async function load() {
    const p = await GET(`/api/partners/${id}`);
    const f = (k, v) => `<div><dt>${k}</dt><dd>${v || '—'}</dd></div>`;
    main.innerHTML = `<div class="card"><div class="btn-row"><a class="btn sm ghost" href="#/partners">${I('back')} الشراكات</a>${demoChip(p)}</div>
      <div class="page-h"><h1>${esc(p.name)}</h1>${p.awaiting_reply ? '<span class="chip p-important">تنتظر ردًا</span>' : ''}<span class="spacer"></span>${can('partners.manage') ? '<button class="btn" id="edit">تعديل</button>' : ''}</div>
      <dl class="facts">${f('النوع', p.entity_type === 'person' ? 'شخصية' : 'جهة')}${f('نوع العلاقة', esc(p.relation_type))}${f('آخر تواصل', p.last_contact_at ? esc(fmtDate(p.last_contact_at)) : '')}${f('المتابعة القادمة', p.next_followup ? esc(fmtDate(p.next_followup)) : '')}</dl>
      ${p.contacts_hidden ? '<div class="warn-box">بيانات التواصل محجوبة وفق صلاحياتك</div>' : `<h3>بيانات التواصل</h3><dl class="facts">${f('الهاتف', p.phone ? `<a class="ltr" href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '')}${f('البريد', p.email ? `<a class="ltr" href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '')}${f('ملاحظات التواصل', esc(p.contact_notes))}</dl>`}
      ${p.commitments ? `<h3 class="section-gap">الالتزامات والوعود</h3><div class="desc">${esc(p.commitments)}</div>` : ''}
      ${p.opportunities ? `<h3 class="section-gap">الفرص المفتوحة</h3><div class="desc">${esc(p.opportunities)}</div>` : ''}</div>
      <div class="card"><div class="card-h"><h2>المهام المرتبطة</h2><span class="spacer"></span>${isManager() ? `<button class="btn sm" id="addT">${I('plus')} مهمة مرتبطة</button>` : ''}</div>${listOrEmpty(p.tasks, i => itemRow(i), 'لا توجد مهام مرتبطة')}</div>`;
    const e = $('#edit', main); if (e) e.onclick = () => modalPartner(p);
    const t = $('#addT', main); if (t) t.onclick = () => modalTask({ section: 'partnerships', partner_id: p.id, title: '' });
  }
  await load(); return { refresh: load };
}
function modalPartner(p = {}) {
  openModal({
    title: p.id ? 'تعديل الجهة' : 'جهة أو شخصية جديدة', wide: true,
    body: `<div class="grid2">${field('الاسم *', `<input type="text" name="name" required value="${esc(p.name || '')}">`)}${field('النوع', `<select name="entity_type">${opt('org', 'جهة', p.entity_type)}${opt('person', 'شخصية', p.entity_type)}</select>`)}
      ${field('نوع العلاقة', `<input type="text" name="relation_type" value="${esc(p.relation_type || '')}" placeholder="شريك، داعم، جهة حكومية…">`)}${field('الهاتف', `<input type="tel" name="phone" dir="ltr" value="${esc(p.phone || '')}">`)}
      ${field('البريد', `<input type="email" name="email" dir="ltr" value="${esc(p.email || '')}">`)}${field('آخر تواصل', `<input type="date" name="last_contact_at" value="${esc(p.last_contact_at || '')}">`)}
      ${field('موعد المتابعة القادمة', `<input type="date" name="next_followup" value="${esc(p.next_followup || '')}">`)}</div>
      ${field('ملاحظات التواصل', `<textarea name="contact_notes" style="min-height:60px">${esc(p.contact_notes || '')}</textarea>`)}
      ${field('الالتزامات والوعود', `<textarea name="commitments" style="min-height:60px">${esc(p.commitments || '')}</textarea>`)}
      ${field('الفرص المفتوحة', `<textarea name="opportunities" style="min-height:60px">${esc(p.opportunities || '')}</textarea>`)}
      <label class="check"><input type="checkbox" name="awaiting_reply" ${p.awaiting_reply ? 'checked' : ''}> تنتظر ردًا منا</label>`,
    onSubmit: async (d) => { if (p.id) { await api('PATCH', `/api/partners/${p.id}`, d); refreshView(); } else { const r = await POST('/api/partners', d); location.hash = `#/partner/${r.id}`; } },
  });
}

// ===== التقارير =====
async function viewReports(main) {
  let period = 'week';
  async function load() {
    const r = await GET('/api/reports?period=' + period);
    const max = Math.max(1, ...r.by_section.map(s => s.open + s.completed));
    main.innerHTML = `<div class="page-h">${I('chart')}<h1>التقارير والإنجازات</h1><span class="spacer"></span>
        <a class="btn no-print" href="/api/reports/export.csv?period=${period}">${I('download')} تصدير Excel (CSV)</a><button class="btn no-print" id="pdf">${I('printer')} طباعة / حفظ PDF</button></div>
      <div class="tabs no-print">${[['day', 'إنجازات اليوم'], ['week', 'ملخص الأسبوع'], ['month', 'ملخص الشهر']].map(([k, v]) => `<button data-p="${k}" class="${period === k ? 'active' : ''}">${v}</button>`).join('')}</div>
      <p class="small muted">الفترة: ${esc(fmtDate(r.from))} — ${esc(fmtDate(r.to))} • جميع الأرقام محسوبة من بيانات المنصة</p>
      <div class="kpis">
        <div class="kpi blue"><b>${r.received}</b><span>تكليفات مستلمة</span></div><div class="kpi"><b>${r.notes_received}</b><span>ملاحظات وطلبات</span></div>
        <div class="kpi green"><b>${r.completed}</b><span>مهام مكتملة</span></div><div class="kpi red"><b>${r.overdue_now}</b><span>متأخرة حاليًا</span></div>
        <div class="kpi"><b>${r.decisions_made}</b><span>قرارات واعتمادات صدرت</span></div><div class="kpi orange"><b>${r.approvals_pending}</b><span>طلبات تنتظر القرار</span></div>
        <div class="kpi green"><b>${r.meeting_decisions_done}</b><span>قرارات اجتماعات منفذة</span></div><div class="kpi orange"><b>${r.meeting_decisions_pending}</b><span>قرارات تنتظر التنفيذ</span></div>
        <div class="kpi ${r.on_time.rate == null ? '' : r.on_time.rate >= 80 ? 'green' : r.on_time.rate >= 60 ? 'orange' : 'red'}"><b>${r.on_time.rate == null ? '—' : r.on_time.rate + '%'}</b><span>الالتزام بالمواعيد${r.on_time.total ? ` (${r.on_time.on_time} من ${r.on_time.total})` : ' — لا مهام منجزة ذات موعد'}</span></div>
        <div class="kpi"><b>${r.avg_completion_days ?? '—'}</b><span>متوسط مدة الإنجاز (يوم)${r.avg_completion_days == null ? ' — بيانات غير كافية' : ''}</span></div>
      </div>
      <div class="card section-gap"><div class="card-h"><h2>توزيع المهام حسب الأقسام الستة</h2><span class="spacer"></span><span class="small muted"><span class="chip st-in_progress">مفتوحة</span> <span class="chip st-done">مكتملة في الفترة</span> <span class="chip overdue">منها متأخرة</span></span></div>
        <div class="bars">${r.by_section.map(s => `<div class="bar"><span>${esc(s.name)}</span><div class="track" title="مفتوحة ${s.open} • مكتملة ${s.completed} • متأخرة ${s.overdue}">
          <div class="fill late" style="width:${s.overdue / max * 100}%"></div><div class="fill" style="width:${(s.open - s.overdue) / max * 100}%"></div><div class="fill done" style="width:${s.completed / max * 100}%"></div></div><b>${s.open + s.completed}</b></div>`).join('')}</div></div>
      <div class="card"><div class="card-h">${I('users')}<h2>عبء العمل حسب المسؤول</h2></div>
        ${r.by_person.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>المسؤول</th><th>مفتوحة</th><th>متأخرة</th><th>مستحقة خلال أسبوع</th><th>أُنجزت في الفترة</th><th>في الموعد</th></tr></thead><tbody>
          ${r.by_person.map(p => `<tr><td>${esc(p.name)}</td><td>${p.open}</td><td class="${p.overdue ? 'late' : ''}">${p.overdue}</td><td>${p.due_week}</td><td>${p.completed}</td><td>${p.on_time_rate == null ? '—' : p.on_time_rate + '%'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا توجد مهام مسندة</div>'}</div>
      <div class="card"><div class="card-h"><h2>المهام المكتملة في الفترة</h2></div>${listOrEmpty(r.completed_items, i => itemRow(i), 'لا توجد مهام مكتملة في هذه الفترة')}</div>`;
    $$('[data-p]', main).forEach(b => b.onclick = () => { period = b.dataset.p; load(); });
    $('#pdf', main).onclick = () => window.print();
  }
  await load(); return { refresh: load };
}

// ===== الإشعارات =====
async function viewNotifications(main) {
  async function load() {
    const list = await GET('/api/notifications');
    main.innerHTML = `<div class="page-h">${I('bell')}<h1>مركز الإشعارات</h1><span class="spacer"></span><button class="btn sm" id="all">تعليم الكل كمقروء</button><a class="btn sm" href="#/settings">تخصيص الإشعارات</a></div>
      ${list.length ? `<div class="list">${list.map(n => `<a class="notif ${n.read_at ? '' : 'unread'} ${n.urgent ? 'urgent' : ''}" href="${esc(n.link || '#/notifications')}" data-id="${n.id}">
        <span class="dot"></span><span style="flex:1;min-width:0"><b>${esc(n.title)}</b>${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ''}<div class="small muted">${fmtTs(n.created_at)}</div></span>
        ${n.urgent ? '<span class="chip overdue">عاجل</span>' : ''}</a>`).join('')}</div>` : '<div class="empty">لا توجد إشعارات</div>'}`;
    $('#all', main).onclick = async () => { await POST('/api/notifications/read-all'); refreshCounts(); load(); };
    $$('.notif', main).forEach(a => a.onclick = () => { POST(`/api/notifications/${a.dataset.id}/read`).then(refreshCounts); });
  }
  await load(); return { refresh: load };
}

// ===== الإعدادات =====
async function viewSettings(main) {
  const [p, deliveries] = await Promise.all([GET('/api/prefs'), GET('/api/deliveries')]);
  const T = state.meta.notif_types;
  const em = state.meta.email;
  const pushState = !pushSupported() ? (isIOS() && !isStandalone() ? 'ios' : 'unsupported') : Notification.permission;
  main.innerHTML = `<div class="page-h">${I('settings')}<h1>الإعدادات</h1></div>
  <form class="card" id="pf">
    <div class="card-h"><h2>تخصيص الإشعارات</h2></div>
    <h3>1) داخل المنصة</h3><p class="small muted">تظهر في مركز الإشعارات وفي التنبيه المنبثق. التنبيهات العاجلة تصل دائمًا.</p>
    <div class="grid2">${Object.entries(T).map(([k, v]) => `<label class="check"><input type="checkbox" data-group="inapp" value="${k}" ${p.inapp[k] !== false ? 'checked' : ''}> ${v}</label>`).join('')}</div>
    <h3 class="section-gap">2) إشعارات الجهاز: سطح المكتب والجوال (Push)</h3>
    <p class="small muted">تظهر كإشعار نظام على الكمبيوتر (Chrome وEdge وFirefox وSafari) وعلى الجوال (Android، وiPhone بعد إضافة المنصة للشاشة الرئيسية)، حتى والمنصة مغلقة. فعّلها على كل جهاز تستخدمه.</p>
    ${pushState === 'granted' ? `<div class="info-box">${I('check')} الإشعارات مفعّلة على هذا الجهاز. الأجهزة المسجلة لحسابك: ${p.push_devices}</div>`
      : pushState === 'denied' ? '<div class="warn-box">الإشعارات محظورة لهذا الموقع في المتصفح. افتح إعدادات الموقع (رمز القفل بجانب العنوان) واسمح بالإشعارات ثم عد إلى هنا.</div>'
      : pushState === 'ios' ? '<div class="warn-box">على iPhone/iPad: زر المشاركة ← «إضافة إلى الشاشة الرئيسية»، ثم افتح المنصة من أيقونتها وعُد إلى هذه الصفحة لتفعيل الإشعارات (iOS 16.4 أو أحدث).</div>'
      : pushState === 'unsupported' ? '<div class="warn-box">هذا المتصفح أو الاتصال لا يدعم إشعارات الجهاز (تتطلب HTTPS).</div>'
      : `<div class="btn-row"><button type="button" class="btn primary" id="pushOn">${I('bell')} تفعيل الإشعارات على هذا الجهاز</button><span class="small muted">الأجهزة المسجلة: ${p.push_devices}</span></div>`}
    <label class="check"><input type="checkbox" name="push_enabled" ${p.push.enabled ? 'checked' : ''}> إرسال إشعارات Push</label>
    <label class="check"><input type="checkbox" name="push_urgent_only" ${p.push.urgent_only ? 'checked' : ''}> العاجلة فقط</label>
    <label class="check"><input type="checkbox" name="private_lock_screen" ${p.private_lock_screen ? 'checked' : ''}> إخفاء التفاصيل في إشعارات شاشة القفل (يظهر «لديك إشعار جديد» فقط)</label>
    <details><summary class="small" style="cursor:pointer">أنواع إشعارات Push</summary><div class="grid2">${Object.entries(T).map(([k, v]) => `<label class="check"><input type="checkbox" data-group="push" value="${k}" ${p.push.types.includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div></details>
    ${isMember() && !em.configured ? '' : `<h3 class="section-gap">3) البريد الإلكتروني</h3>
    ${em.configured ? `<div class="info-box">مزود البريد مُعد (${esc(em.mode)}).</div>` : '<div class="warn-box">لم يُعد مزود البريد بعد على الخادم — لن تُرسل رسائل فعلية حتى يُضبط SMTP (انظر دليل التشغيل). يمكنك حفظ تفضيلاتك الآن.</div>'}
    ${field('بريدك الإلكتروني', `<input type="email" name="email_address" dir="ltr" value="${esc(p.email_address || '')}">`)}
    <label class="check"><input type="checkbox" name="email_enabled" ${p.email.enabled ? 'checked' : ''}> أوافق على استلام إشعارات بالبريد الإلكتروني</label>
    <div class="grid2">${['new_assignment', 'approval_request', 'new_message', 'overdue', 'digest', 'decision'].map(k => `<label class="check"><input type="checkbox" data-group="email" value="${k}" ${p.email.types.includes(k) ? 'checked' : ''}> ${T[k]}</label>`).join('')}</div>
`}
    ${!isManager() && !state.meta.whatsapp.configured ? '' : `    <h3 class="section-gap">واتساب (مستقبلًا)</h3>
    <div class="warn-box">${state.meta.whatsapp.configured ? 'تكامل واتساب الرسمي مُعد على الخادم.' : 'غير مفعّل. يتطلب ربطًا رسميًا عبر WhatsApp Business Platform (حساب أعمال موثّق وقوالب معتمدة وتكلفة لكل محادثة). المنصة تعمل بالكامل دونه.'}</div>
    <div class="grid2">${field('رقم واتساب (بالصيغة الدولية)', `<input type="tel" name="whatsapp_phone" dir="ltr" value="${esc(p.whatsapp_phone)}" placeholder="9665xxxxxxxx">`)}<label class="check" style="margin-top:24px"><input type="checkbox" name="whatsapp_enabled" ${p.whatsapp_enabled ? 'checked' : ''}> استلام التنبيهات عبر واتساب عند تفعيله</label></div>
`}
    <div class="btn-row section-gap"><button class="btn primary">حفظ التفضيلات</button><button type="button" class="btn" id="test">إرسال إشعار تجريبي</button></div>
  </form>
  <div class="card ${isMember() ? 'hidden' : ''}"><div class="card-h"><h2>سجل الإرسال خارج المنصة</h2></div>
    ${deliveries.length ? deliveries.map(d => `<div class="log-row">${fmtTs(d.created_at)} — ${esc({ push: 'Push', email: 'بريد', whatsapp: 'واتساب' }[d.channel] || d.channel)}: ${esc({ sent: 'أُرسل', failed: 'فشل', skipped: 'تُخطي', not_configured: 'غير مُعد' }[d.status] || d.status)} ${d.detail ? `<span class="muted ltr">${esc(d.detail)}</span>` : ''}</div>`).join('') : '<div class="muted small">لا يوجد</div>'}</div>
  ${can('users.manage') ? '<div class="card" id="usersAdmin"></div>' : ''}
  <form class="card" id="pw"><div class="card-h"><h2>تغيير كلمة المرور</h2></div>
    <div class="grid2">${field('الحالية', '<input type="password" name="current" autocomplete="current-password" dir="ltr">')}${field('الجديدة (8 أحرف على الأقل)', '<input type="password" name="next" autocomplete="new-password" dir="ltr">')}</div>
    <button class="btn">تغيير</button></form>
  ${isManager() ? `<div class="card"><div class="card-h"><h2>النسخ الاحتياطي والتصدير</h2></div>
    ${state.meta.file_backup ? '<p class="small muted">تُنشأ نسخة تلقائية يوميًا (آخر 14 نسخة) في مجلد data/backups على الخادم.</p>' : ''}
    <p class="small muted">«تصدير البيانات» ينزّل ملف JSON بكل التكليفات والرسائل والقرارات (دون كلمات المرور ودون محتوى المرفقات) للأرشفة والاطلاع. ليس أداة استعادة تلقائية.</p>
    <div class="btn-row">${state.meta.file_backup ? `<button class="btn" id="bk">${I('download')} إنشاء نسخة احتياطية الآن</button>` : ''}<a class="btn" href="/api/export.json">${I('download')} تصدير البيانات (JSON)</a></div></div>` : ''}`;
  const group = (g) => $$(`[data-group=${g}]`, main).filter(x => x.checked).map(x => x.value);
  $('#pf', main).onsubmit = async (e) => {
    e.preventDefault(); const d = formData(e.target);
    const inapp = Object.fromEntries(Object.keys(T).map(k => [k, group('inapp').includes(k)]));
    try {
      await api('PUT', '/api/prefs', { inapp, push: { enabled: d.push_enabled, urgent_only: d.push_urgent_only, types: group('push') }, email: { enabled: d.email_enabled, types: group('email') }, private_lock_screen: d.private_lock_screen, email_address: d.email_address, whatsapp_phone: d.whatsapp_phone, whatsapp_enabled: d.whatsapp_enabled });
      toast('حُفظت التفضيلات', 'ok');
    } catch (ex) { showErr(ex); }
  };
  $('#test', main).onclick = () => POST('/api/notify/test').catch(showErr);
  const po = $('#pushOn', main);
  if (po) po.onclick = async () => { try { await enablePush(); toast('فُعّلت الإشعارات على هذا الجهاز', 'ok'); route(); } catch (e) { showErr(e); } };
  if (can('users.manage')) await renderUsersAdmin($('#usersAdmin', main));
  $('#pw', main).onsubmit = async (e) => { e.preventDefault(); try { await POST('/api/password', formData(e.target)); toast('تم تغيير كلمة المرور', 'ok'); e.target.reset(); } catch (ex) { showErr(ex); } };
  const bk = $('#bk', main); if (bk) bk.onclick = async () => { try { const r = await POST('/api/backup'); toast('أُنشئت النسخة: ' + r.file, 'ok'); } catch (e) { showErr(e); } };
}

// ===== إدارة المستخدمين وربطهم بالمشاريع =====
// ملخص صلاحيات الموظف بكلمات واضحة
function grantsSummary(g) {
  const m = state.meta;
  return `<span class="chip kind">${esc(m.scopes[g.scope])}${g.scope === 'sections' ? `: ${g.sections.map(sectionName).join('، ')}` : ''}</span>`
    + (g.perms.length ? g.perms.map(p => `<span class="chip">${esc(m.grantable[p].split(' (')[0])}</span>`).join('') : '<span class="txt">تحديث الحالة والتحديثات والمرفقات فقط</span>');
}
// محرر الصلاحيات: قوالب جاهزة + نطاق الرؤية + صلاحيات إضافية
function grantsEditorHtml(g = { scope: 'own', sections: [], perms: [] }) {
  const m = state.meta;
  return `<fieldset class="grants"><legend>الصلاحيات</legend>
    <div class="small muted">قالب جاهز:</div>
    <div class="btn-row" style="margin:4px 0 10px">${Object.entries(m.grant_presets).map(([k, p]) => `<button type="button" class="btn sm" data-preset="${k}">${esc(p.label)}</button>`).join('')}</div>
    ${field('ماذا يرى؟', `<div class="radios">${Object.entries(m.scopes).map(([k, v]) => `<label class="check"><input type="radio" name="g_scope" value="${k}" ${g.scope === k ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div>`)}
    <div data-secs class="${g.scope === 'sections' ? '' : 'hidden'}">${field('الأقسام', `<div class="grid2">${m.sections.map(s => `<label class="check"><input type="checkbox" name="g_sections" data-multi="1" value="${s.key}" ${g.sections.includes(s.key) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>`)}</div>
    ${field('ماذا يستطيع أن يفعل؟', `<div class="radios">
      <label class="check"><input type="checkbox" checked disabled> تحديث حالة مهامه وإضافة التحديثات والمرفقات (دائمًا)</label>
      ${Object.entries(m.grantable).map(([k, v]) => `<label class="check"><input type="checkbox" name="g_perms" data-multi="1" value="${k}" ${g.perms.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div>`)}
    <p class="small muted">لا يملك الموظف أبدًا: الاعتماد والقرارات، إغلاق المهام نهائيًا، الوارد من ${OT()}، إدارة المستخدمين.</p></fieldset>`;
}
function bindGrantsEditor(form) {
  const m = state.meta;
  const sync = () => { const sc = (form.elements.g_scope || {}).value; const d = $('[data-secs]', form); if (d) d.classList.toggle('hidden', sc !== 'sections'); };
  form.addEventListener('change', sync);
  $$('[data-preset]', form).forEach(b => b.onclick = () => {
    const p = m.grant_presets[b.dataset.preset];
    for (const r of form.querySelectorAll('[name=g_scope]')) r.checked = r.value === p.scope;
    for (const c of form.querySelectorAll('[name=g_perms]')) c.checked = p.perms.includes(c.value);
    sync();
  });
}
const grantsFromForm = (d) => { const g = { scope: d.g_scope || 'own', sections: d.g_sections || [], perms: d.g_perms || [] }; delete d.g_scope; delete d.g_sections; delete d.g_perms; return g; };

async function renderUsersAdmin(el) {
  const [users, projects] = await Promise.all([GET('/api/admin/users'), GET('/api/projects')]);
  const pname = (id) => (projects.find(p => p.id === id) || {}).name || `#${id}`;
  el.innerHTML = `<div class="card-h">${I('users')}<h2>المستخدمون والفريق</h2><span class="spacer"></span><button type="button" class="btn primary sm" id="addUser">${I('plus')} إضافة موظف</button></div>
    <p class="small muted">لكل موظف حساب دخول خاص وصلاحيات تحددها: ماذا يرى (مهامه فقط، أو أقسامًا محددة، أو كل المكتب) وماذا يستطيع أن يفعل. تُفحص الصلاحيات في الخادم لكل عملية.</p>
    <div class="list">${users.map(u => `<div class="row ${u.active ? '' : 'done'}"><div class="main"><span class="title">${esc(u.name)} <span class="small muted ltr">@${esc(u.username)}</span></span>
      <div class="meta"><span class="chip kind">${esc(u.title || u.role_label)}</span>${u.must_change_password ? '<span class="chip">لم يغيّر كلمة المرور بعد</span>' : ''}${u.active ? '' : '<span class="chip st-cancelled">موقوف</span>'}${u.email ? `<span class="txt ltr">${esc(u.email)}</span>` : ''}
      ${u.role === 'member' ? grantsSummary(u.grants) + (u.projects.length ? u.projects.map(id => `<span class="chip">${I('folder')}${esc(pname(id))}</span>`).join('') : '') : '<span class="txt">يرى كل المهام</span>'}</div></div>
      <div class="side"><button type="button" class="btn sm" data-edit-user="${u.id}">تعديل</button></div></div>`).join('')}</div>`;
  const projChecks = (sel = []) => projects.length
    ? `<div class="grid2">${projects.map(p => `<label class="check"><input type="checkbox" name="project_ids" data-multi="1" value="${p.id}" ${sel.includes(p.id) ? 'checked' : ''}> ${esc(p.name)} <span class="small muted">(${esc(sectionName(p.section))})</span></label>`).join('')}</div>`
    : '<p class="small muted">لا توجد مشاريع بعد. أنشئها من صفحة القسم أو داخل مجلد.</p>';
  const reload = () => renderUsersAdmin(el);
  $('#addUser', el).onclick = () => openModal({
    title: 'إضافة موظف', submit: 'إضافة', wide: true, init: bindGrantsEditor,
    body: `<div class="grid2">${field('الاسم *', '<input type="text" name="name" required>')}${field('اسم الدخول * (لاتيني)', '<input type="text" name="username" dir="ltr" required autocomplete="off" placeholder="saad">')}
      ${field('كلمة المرور الأولية * (8 أحرف على الأقل)', '<input type="password" name="password" dir="ltr" autocomplete="new-password" required>')}${field('البريد (اختياري)', '<input type="email" name="email" dir="ltr">')}
      ${field('المسمى الوظيفي (اختياري)', '<input type="text" name="title" maxlength="60" placeholder="مثل: منسّق الجمعية، سكرتير">')}</div>
      <label class="check"><input type="checkbox" name="must_change_password" checked> يغيّر كلمة المرور بنفسه عند أول دخول (موصى به)</label>
      ${grantsEditorHtml()}
      ${field('المشاريع التي يشارك فيها', projChecks())}
      <p class="small muted">أبلغ الموظف باسم الدخول وكلمة المرور بطريقة آمنة، ويمكنه تغيير كلمة المرور من الإعدادات.</p>`,
    onSubmit: async (d) => { d.grants = grantsFromForm(d); d.project_ids = (d.project_ids || []).map(Number); await POST('/api/admin/users', d); toast('أُضيف الموظف', 'ok'); reload(); },
  });
  $$('[data-edit-user]', el).forEach(b => b.onclick = () => {
    const u = users.find(x => x.id == b.dataset.editUser);
    openModal({
      title: `تعديل: ${u.name}`, wide: u.role === 'member', init: u.role === 'member' ? bindGrantsEditor : undefined,
      body: `<div class="grid2">${field('الاسم', `<input type="text" name="name" value="${esc(u.name)}" required>`)}${field('البريد', `<input type="email" name="email" dir="ltr" value="${esc(u.email || '')}">`)}
        ${field(u.id === state.me.id || u.role === 'member' ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' + (u.role === 'member' ? ' — سيُطلب منه تغييرها عند دخوله' : '') : 'كلمة المرور', u.id === state.me.id || u.role === 'member' ? '<input type="password" name="password" dir="ltr" autocomplete="new-password">' : '<p class="small muted">يغيّرها صاحب الحساب من إعداداته.</p>')}
        ${u.role === 'member' ? field('المسمى الوظيفي', `<input type="text" name="title" maxlength="60" value="${esc(u.title || '')}">`) : ''}</div>
        ${u.role === 'member' ? `${grantsEditorHtml(u.grants)}${field('المشاريع التي يشارك فيها', projChecks(u.projects))}<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> الحساب مفعّل (إيقافه يسجّل خروجه فورًا)</label>` : '<p class="small muted">' + OT() + ' ومدير المكتب يريان كل المهام، ولا يمكن إيقاف حسابيهما.</p>'}`,
      onSubmit: async (d) => {
        if (u.id !== state.me.id && u.role !== 'member') { toast('حسابا ' + OT() + ' ومدير المكتب يعدّلهما صاحباهما من الإعدادات', 'err'); return; }
        const body = { name: d.name, email: d.email };
        if (u.role === 'member') body.title = d.title;
        if (d.password) body.password = d.password;
        if (u.role === 'member') { body.grants = grantsFromForm(d); body.project_ids = (d.project_ids || []).map(Number); body.active = d.active; }
        await api('PATCH', `/api/admin/users/${u.id}`, body); toast('حُفظت التعديلات', 'ok'); reload();
      },
    });
  });
}

async function viewMore(main) {
  main.innerHTML = `<div class="page-h"><h1>المزيد</h1></div><div class="list">
    ${navItems().map(n => `<a class="row" href="${n.h}"><div class="main"><span class="title">${I(n.i)} ${n.t}</span></div>${n.n ? `<span class="chip p-urgent">${n.n}</span>` : ''}</a>`).join('')}
    ${can('folders.view') ? `<div class="lbl small muted" style="margin-top:8px">الأقسام</div>
    ${mySections().map(s => `<a class="row" href="#/section/${s.key}"><div class="main"><span class="title">${I(s.icon)} ${s.name}</span></div></a>`).join('')}` : ''}
    <a class="row" href="#/settings"><div class="main"><span class="title">${I('settings')} الإعدادات والإشعارات</span></div></a>
    <a class="row" href="#" id="lo"><div class="main"><span class="title">${I('logout')} تسجيل الخروج</span></div></a></div>`;
  $('#lo', main).onclick = (e) => { e.preventDefault(); logout(); };
}

// ===== الإقلاع =====
async function boot() {
  try {
    const me = await GET('/api/me');
    state.me = me; state.counts = { unread: me.unread, inbox_pending: me.inbox_pending, pending_decisions: me.pending_decisions };
    if (me.must_change_password) { renderForcePassword(); return; }
    state.meta = await GET('/api/meta');
    renderShell(); openEvents(); await route();
    resyncPush();
    GET('/api/prefs').then(p => { state.privateLock = p.private_lock_screen; }).catch(() => { });
  } catch (e) { if (!state.me) renderLogin(); }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
// تحديث تاريخ "اليوم" والبيانات عند العودة للتبويب
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) { if (wsWanted) connectWs(); GET('/api/meta').then(m => { state.meta = m; }).catch(() => { }); refreshView(); } });
boot();
