'use strict';
/* منصة إدارة مكتب رجل الأعمال — الواجهة (بدون أطر خارجية) */
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
  if (res.status === 401 && url !== '/api/login') { state.me = null; renderLogin(); throw new Error('يلزم تسجيل الدخول'); }
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
  if (s < 3600) return `منذ ${Math.floor(s / 60)} د`;
  if (s < 86400) return `منذ ${Math.floor(s / 3600)} س`;
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
const isOwner = () => state.me.role === 'owner';
const isManager = () => state.me.role === 'manager';
const can = (p) => state.me.perms.includes(p);

function itemRow(i, { actions = '', showSection = true, showUpdated = false } = {}) {
  return `<div class="row p-${i.priority} ${i.status === 'done' ? 'done' : ''}">
    <div class="main">
      <a class="title" href="#/item/${i.id}">${esc(i.title)}</a>
      <div class="meta">
        <span class="chip kind">${esc(kindLabel(i))}</span>
        ${statusChip(i.status)} ${prioChip(i.priority)} ${dueChip(i)}
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
const listOrEmpty = (items, fn, empty = 'لا توجد عناصر') => items.length ? `<div class="list">${items.map(fn).join('')}</div>` : `<div class="empty">${empty}</div>`;

function toast(msg, kind = '', onClick) {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; el.setAttribute('role', 'status');
  el.onclick = () => { el.remove(); onClick && onClick(); };
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), kind === 'urgent' ? 9000 : 4500);
}
const showErr = (e) => toast(e.message || String(e), 'err');

// ===== النوافذ المنبثقة =====
function openModal({ title, body, submit = 'حفظ', submitClass = 'primary', onSubmit, wide = false, init }) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal" ${wide ? 'style="max-width:820px"' : ''} novalidate>
    <div class="mh"><h2>${esc(title)}</h2><button type="button" class="iconbtn" data-close aria-label="إغلاق">${I('x')}</button></div>
    <div class="mb"><div class="err-box hidden"></div>${body}</div>
    <div class="mf">${onSubmit ? `<button class="btn ${submitClass}" type="submit">${esc(submit)}</button>` : ''}<button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`;
  document.body.appendChild(bg); document.body.style.overflow = 'hidden';
  const form = $('form', bg);
  const close = () => { bg.remove(); document.body.style.overflow = ''; if (state.stale) refreshView(); };
  $$('[data-close]', bg).forEach(b => b.onclick = close);
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  bg.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
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
const sectionSelect = (sel, name = 'section', blank = false) => `<select name="${name}">${blank ? opt('', '— اختر —', sel) : ''}${state.meta.sections.map(s => opt(s.key, s.name, sel)).join('')}</select>`;
const sectionSeg = (sel, name = 'section') => `<div class="seg">${state.meta.sections.map(s => `<label><input type="radio" name="${name}" value="${s.key}" ${sel === s.key ? 'checked' : ''}><span>${esc(s.name)}</span></label>`).join('')}</div>`;
const prioSeg = (sel = 'normal') => `<div class="seg">${Object.entries(state.meta.priorities).map(([k, v]) => `<label><input type="radio" name="priority" value="${k}" ${sel === k ? 'checked' : ''}><span class="p-${k}">${v}</span></label>`).join('')}</div>`;
const field = (label, html) => `<label class="f"><span>${label}</span>${html}</label>`;

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
    <h1>منصة إدارة المكتب</h1><p class="sub">التواصل بين رجل الأعمال ومدير المكتب</p>
    <div class="err-box ${msg ? '' : 'hidden'}">${esc(msg || '')}</div>
    ${field('اسم المستخدم', '<input type="text" name="username" autocomplete="username" required dir="ltr">')}
    ${field('كلمة المرور', '<input type="password" name="password" autocomplete="current-password" required dir="ltr">')}
    <button class="btn primary" style="width:100%">دخول</button>
  </form></div>`;
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
  ];
  if (isOwner()) return [
    { h: '#/', i: 'dash', t: 'الرئيسية' },
    { h: '#/my', i: 'list', t: 'طلباتي وتكليفاتي' },
    { h: '#/decisions', i: 'gavel', t: 'بانتظار قراري', n: c.pending_decisions },
    ...common,
  ];
  return [
    { h: '#/', i: 'dash', t: 'الرئيسية' },
    { h: '#/inbox', i: 'inbox', t: 'الوارد من رجل الأعمال', n: c.inbox_pending },
    { h: '#/dashboard', i: 'alert', t: 'لوحة المتابعة' },
    { h: '#/tasks', i: 'list', t: 'كل المهام' },
    { h: '#/approvals', i: 'gavel', t: 'طلبات الاعتماد', n: c.pending_decisions, o: true },
    ...common,
  ];
}
function bottomItems() {
  const c = state.counts;
  return isOwner()
    ? [{ h: '#/', i: 'dash', t: 'الرئيسية' }, { h: '#/my', i: 'list', t: 'طلباتي' }, { h: '#/decisions', i: 'gavel', t: 'قراري', n: c.pending_decisions }, { h: '#/notifications', i: 'bell', t: 'الإشعارات', n: c.unread }, { h: '#/more', i: 'more', t: 'المزيد' }]
    : [{ h: '#/', i: 'dash', t: 'الرئيسية' }, { h: '#/inbox', i: 'inbox', t: 'الوارد', n: c.inbox_pending }, { h: '#/dashboard', i: 'alert', t: 'المتابعة' }, { h: '#/notifications', i: 'bell', t: 'الإشعارات', n: c.unread }, { h: '#/more', i: 'more', t: 'المزيد' }];
}
function renderShell() {
  const me = state.me;
  app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#/"><img src="/img/logo.png" alt=""><span class="t"><b>مكتب رجل الأعمال</b><small>${esc(me.name)}</small></span></a>
    <span class="role-chip desk-only">${isOwner() ? 'رجل الأعمال' : 'مدير المكتب'}</span>
    <span class="spacer"></span>
    <div class="actions">
      ${isOwner() ? `<button class="btn primary" id="btnAssign">${I('plus')} <span>تكليف جديد</span></button>
        <button class="btn" id="btnNote" title="إرسال ملاحظة أو طلب">${I('note')} <span class="desk-only">إرسال ملاحظة أو طلب</span></button>`
      : `<button class="btn primary" id="btnTask">${I('plus')} <span>مهمة جديدة</span></button>`}
      <a class="iconbtn desk-only" href="#/notifications" aria-label="الإشعارات">${I('bell')}<span class="badge hidden" id="bellN"></span></a>
    </div>
  </header>
  <div class="layout">
    <nav class="sidenav" id="sidenav" aria-label="القائمة"></nav>
    <main id="main" tabindex="-1"></main>
  </div>
  <nav class="bottomnav" id="bottomnav" aria-label="التنقل السريع"></nav>`;
  if (isOwner()) { $('#btnAssign').onclick = () => modalAssignment(); $('#btnNote').onclick = () => modalNote(); }
  else $('#btnTask').onclick = () => modalTask();
  renderNav();
}
function renderNav() {
  const route = location.hash || '#/';
  const active = (h) => (h === '#/' ? route === '#/' || route === '' : route.startsWith(h));
  const sn = $('#sidenav'); if (!sn) return;
  sn.innerHTML = navItems().map(n => `<a href="${n.h}" class="${active(n.h) ? 'active' : ''}">${I(n.i)}<span>${n.t}</span>${n.n ? `<span class="count ${n.o ? 'o' : ''}">${n.n}</span>` : ''}</a>`).join('')
    + `<div class="sep"></div><div class="lbl">الأقسام</div>`
    + state.meta.sections.map(s => `<a href="#/section/${s.key}" class="${route === '#/section/' + s.key ? 'active' : ''}">${I(s.icon)}<span>${s.name}</span></a>`).join('')
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
  [/^#\/my$/, viewMy],
  [/^#\/decisions$/, viewDecisions],
  [/^#\/approvals$/, viewDecisions],
  [/^#\/inbox$/, viewInbox],
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/tasks$/, viewTasks],
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
  const main = $('#main'); if (!main) return;
  renderNav();
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      state.view = null; state.stale = false;
      main.innerHTML = '<div class="empty">جارٍ التحميل…</div>';
      try { state.view = (await fn(main, ...m.slice(1))) || null; } catch (e) { main.innerHTML = `<div class="card"><div class="err-box">${esc(e.message)}</div><a class="btn" href="#/">العودة للرئيسية</a></div>`; }
      window.scrollTo(0, 0);
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

// ===== المزامنة الفورية (SSE) =====
let es = null;
function openEvents() {
  closeEvents();
  es = new EventSource('/api/events');
  es.addEventListener('change', refreshView);
  es.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    toast(n.title, n.urgent ? 'urgent' : '', () => { if (n.link) location.hash = n.link.replace(/^#/, ''); });
    refreshCounts();
  });
  es.onerror = () => { /* يعيد المتصفح الاتصال تلقائيًا */ };
}
function closeEvents() { if (es) { es.close(); es = null; } }

// ===== شريطا مهام اليوم والمهام العاجلة =====
function ribbonHtml(tone, title, items, emptyMsg, sub) {
  const paused = localStorage.getItem('ribbons-paused') === '1';
  const one = (i) => `<button type="button" class="r-item" data-id="${i.id}">
      <b>${esc(i.title)}</b><small>${esc(sub(i))}</small></button>`;
  const content = items.map(one).join('');
  const dur = Math.max(25, items.length * 8);
  return `<section class="ribbon ${tone} ${paused ? 'paused' : ''} ${items.length < 2 ? 'static' : ''}" aria-label="${esc(title)}">
    <div class="r-title">${I(tone === 'red' ? 'alert' : 'clock')}${esc(title)} <span class="n">${items.length}</span></div>
    <div class="r-view">${items.length
      ? `<div class="r-track" style="--dur:${dur}s">${content}${items.length >= 2 ? `<span class="dup" aria-hidden="true" style="display:contents">${content.replace(/<button /g, '<button tabindex="-1" ')}</span>` : ''}</div>`
      : `<div class="r-empty">${esc(emptyMsg)}</div>`}</div>
    ${items.length >= 2 ? `<button type="button" class="r-ctl" data-toggle aria-label="${paused ? 'تشغيل الحركة' : 'إيقاف الحركة'}" title="${paused ? 'تشغيل الحركة' : 'إيقاف الحركة'}">${I(paused ? 'play' : 'pause')}</button>` : ''}
  </section>`;
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
  return `<a class="tile" href="#/section/${s.key}" aria-label="${esc(s.name)}">
    <div class="th"><div class="ic">${I(sec.icon)}</div><h3>${esc(s.name)}</h3></div>
    <div class="stats">
      ${st(s.open, 'مفتوحة', 'blue')}${st(s.due_today, 'مستحقة اليوم', 'orange')}${st(s.overdue, 'متأخرة', 'red')}${st(s.awaiting_decision, 'بانتظار قرار', 'orange')}
    </div>
    ${s.extra && s.extra.length ? `<div class="extra">${s.extra.map(e => `<span>${esc(e.label)}: ${e.value}</span>`).join('')}</div>` : ''}
    <div class="top">${s.top ? `أهم متابعة: <b>${esc(s.top.title)}</b>${s.top.due_date ? ` — ${esc(fmtDate(s.top.due_date))}` : ''}` : '<span class="muted">لا توجد متابعات مفتوحة</span>'}</div>
  </a>`;
}
async function viewHome(main) {
  const hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const greg = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  async function load() {
    const [h, pend] = await Promise.all([GET('/api/home'), isOwner() ? GET('/api/approvals?status=pending') : Promise.resolve([])]);
    const sub = (i) => [i.section_name, i.due_time || (i.due_date ? fmtDate(i.due_date) : ''), i.assignee, i.status_label].filter(Boolean).join(' • ');
    const subU = (i) => [i.urgent_reasons.join('، '), i.section_name, i.due_date ? fmtDate(i.due_date) : '', i.status_label].filter(Boolean).join(' • ');
    const s = h.summary;
    let roleHtml = '';
    if (isOwner()) {
      roleHtml = `
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
      roleHtml = `
      <div class="card section-gap"><div class="card-h">${I('inbox')}<h2>الوارد من رجل الأعمال</h2><span class="chip ${pendingInbox.length ? 'p-urgent' : ''}">${pendingInbox.length} يحتاج إجراء</span><span class="spacer"></span><a class="btn sm" href="#/inbox">صندوق الوارد</a></div>
        ${listOrEmpty(pendingInbox.slice(0, 5), i => itemRow(i, { actions: inboxActions(i) }), 'لا يوجد وارد جديد')}
      </div>
      <div class="cols section-gap">
        <div class="card"><div class="card-h">${I('alert')}<h2>المتابعة التنفيذية</h2><span class="spacer"></span><a class="btn sm" href="#/dashboard">لوحة المتابعة</a></div>
          <div class="kpis">
            <a class="kpi blue" href="#/tasks"><b>${s.open}</b><span>مهام مفتوحة</span></a>
            <a class="kpi red" href="#/dashboard"><b>${s.overdue}</b><span>متأخرة</span></a>
            <a class="kpi red" href="#/dashboard"><b>${s.urgent}</b><span>عاجلة</span></a>
            <a class="kpi orange" href="#/approvals"><b>${s.pending_decisions}</b><span>تنتظر قرار رجل الأعمال</span></a>
          </div></div>
        <div class="card"><div class="card-h">${I('calendar')}<h2>الاجتماعات القادمة</h2></div>${listOrEmpty(h.meetings, meetingRow, 'لا توجد اجتماعات قادمة')}</div>
      </div>`;
    }
    main.innerHTML = `
      <div class="hello"><h1>مرحبًا، ${esc(state.me.name)}</h1><span class="date">${esc(greg)} — ${esc(hijri)}</span></div>
      ${ribbonHtml('orange', 'مهام اليوم', h.today_ribbon, 'لا توجد مهام مستحقة اليوم', sub)}
      ${ribbonHtml('red', 'المهام العاجلة', h.urgent_ribbon, 'لا توجد مهام عاجلة حاليًا', subU)}
      <div class="tiles">${h.tiles.map(tileHtml).join('')}</div>
      ${roleHtml}`;
    bindRibbons(main); bindInboxActions(main);
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
    main.innerHTML = `<div class="page-h">${I('inbox')}<h1>الوارد من رجل الأعمال</h1></div>
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
      <div class="kpis" style="margin-bottom:14px">${d.groups.map(g => `<a class="kpi ${g.tone === 'gray' ? 'blue' : g.tone}" href="#g-${g.key}"><b>${g.items.length}</b><span>${esc(g.title)}</span></a>`).join('')}</div>
      ${d.groups.map(g => `<div class="card" id="g-${g.key}"><div class="card-h"><h2>${esc(g.title)}</h2><span class="chip">${g.items.length}</span></div>
        ${listOrEmpty(g.items.slice(0, 30), i => itemRow(i, { actions: g.key === 'unack' ? inboxActions(i) : quickStatus(i) }), 'لا يوجد')}</div>`).join('')}`;
    bindInboxActions(main); bindQuickStatus(main);
  }
  await load(); return { refresh: load };
}
function quickStatus(i) {
  if (!isManager() || !i.is_open || i.kind === 'note') return '';
  return `<select class="qs" data-id="${i.id}" aria-label="تحديث الحالة" style="min-height:36px;width:auto">
    ${opt('', 'تحديث سريع للحالة…')}${['in_progress', 'waiting_reply', 'waiting_info', 'stalled', 'done'].filter(s => s !== i.status).map(s => opt(s, state.meta.statuses[s])).join('')}</select>`;
}
function bindQuickStatus(root) {
  $$('select.qs', root).forEach(s => s.onchange = async () => {
    if (!s.value) return;
    try { await api('PATCH', `/api/items/${s.dataset.id}`, { status: s.value }); toast('تم تحديث الحالة', 'ok'); refreshView(); }
    catch (e) { showErr(e); s.value = ''; }
  });
}

// ===== قوائم المهام مع البحث والتصفية =====
function filtersHtml(f, { section = true, kindSel = false } = {}) {
  return `<form class="filters" id="flt">
    <input type="search" name="q" placeholder="بحث بالعنوان أو الرقم المرجعي أو المسؤول" value="${esc(f.q || '')}">
    ${section ? `<select name="section">${opt('', 'كل الأقسام', f.section)}${state.meta.sections.map(s => opt(s.key, s.name, f.section)).join('')}</select>` : ''}
    <select name="scope">${opt('open', 'المفتوحة', f.scope)}${opt('today', 'مستحقة اليوم', f.scope)}${opt('overdue', 'المتأخرة', f.scope)}${opt('closed', 'المكتملة والملغاة', f.scope)}${opt('', 'الكل', f.scope)}</select>
    <select name="status">${opt('', 'كل الحالات', f.status)}${Object.entries(state.meta.statuses).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
    <select name="priority">${opt('', 'كل الأولويات', f.priority)}${Object.entries(state.meta.priorities).map(([k, v]) => opt(k, v, f.priority)).join('')}</select>
    <select name="category">${opt('', 'كل التصنيفات', f.category)}${Object.entries(state.meta.categories).map(([k, v]) => opt(k, v, f.category)).join('')}</select>
  </form>`;
}
function bindFilters(root, f, reload) {
  const form = $('#flt', root); if (!form) return;
  let t; const go = () => { Object.assign(f, formData(form)); reload(); };
  form.oninput = () => { clearTimeout(t); t = setTimeout(go, 300); };
  form.onsubmit = (e) => { e.preventDefault(); go(); };
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

async function viewTasks(main) {
  const f = { scope: 'open' };
  main.innerHTML = `<div class="page-h">${I('list')}<h1>كل المهام والتكليفات</h1><span class="spacer"></span>${isManager() ? `<button class="btn primary" id="add">${I('plus')} مهمة جديدة</button>` : ''}</div>${filtersHtml(f)}<div id="res"></div>`;
  const add = $('#add', main); if (add) add.onclick = () => modalTask();
  async function load() { const items = await GET('/api/items?' + qs({ kind: 'tasks', ...f })); $('#res', main).innerHTML = `<p class="small muted">${items.length} نتيجة</p>` + listOrEmpty(items, i => itemRow(i, { actions: quickStatus(i), showUpdated: true })); bindQuickStatus(main); }
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
  let tab = 'tasks';
  async function load() {
    const [home, projects] = await Promise.all([GET('/api/home'), GET('/api/projects?section=' + key)]);
    const s = home.tiles.find(t => t.key === key);
    main.innerHTML = `<div class="page-h"><div class="tile" style="min-height:0;padding:0;border:0;box-shadow:none;background:none;cursor:default"><div class="th"><div class="ic">${I(sec.icon)}</div><h1>${esc(sec.name)}</h1></div></div><span class="spacer"></span>
        ${isOwner() ? `<button class="btn primary" id="add">${I('plus')} تكليف في هذا القسم</button>` : `<button class="btn primary" id="add">${I('plus')} مهمة في هذا القسم</button>`}</div>
      <div class="kpis">
        <div class="kpi blue"><b>${s.open}</b><span>مهام مفتوحة</span></div><div class="kpi orange"><b>${s.due_today}</b><span>متابعات مستحقة اليوم</span></div>
        <div class="kpi red"><b>${s.overdue}</b><span>متأخرة</span></div><div class="kpi orange"><b>${s.awaiting_decision}</b><span>بانتظار قرار أو اعتماد</span></div>
        ${(s.extra || []).map(e => `<div class="kpi"><b>${e.value}</b><span>${esc(e.label)}</span></div>`).join('')}
      </div>
      <div class="tabs section-gap"><button data-tab="tasks" class="${tab === 'tasks' ? 'active' : ''}">المهام</button><button data-tab="projects" class="${tab === 'projects' ? 'active' : ''}">المشاريع والمبادرات (${projects.length})</button>
        ${key === 'partnerships' ? `<button data-tab="partners" class="${tab === 'partners' ? 'active' : ''}">سجل الجهات والشخصيات</button>` : ''}</div>
      <div id="tabc"></div>`;
    $('#add', main).onclick = () => isOwner() ? modalAssignment({ section: key }) : modalTask({ section: key });
    $$('[data-tab]', main).forEach(b => b.onclick = () => { tab = b.dataset.tab; load(); });
    const tc = $('#tabc', main);
    if (tab === 'tasks') {
      tc.innerHTML = filtersHtml(f, { section: false }) + '<div id="res"></div>';
      const loadTasks = async () => { const items = await GET('/api/items?' + qs({ kind: 'tasks', ...f })); $('#res', tc).innerHTML = listOrEmpty(items, i => itemRow(i, { showSection: false, actions: quickStatus(i), showUpdated: true }), 'لا توجد مهام مطابقة'); bindQuickStatus(tc); };
      bindFilters(tc, f, loadTasks); await loadTasks();
    } else if (tab === 'projects') {
      tc.innerHTML = `${can('projects.manage') ? `<div class="btn-row" style="margin-bottom:10px"><button class="btn" id="addP">${I('plus')} مشروع / مبادرة</button></div>` : ''}
        ${listOrEmpty(projects, p => `<div class="row"><div class="main"><span class="title">${esc(p.name)}</span>${p.description ? `<div class="small muted">${esc(p.description)}</div>` : ''}
          <div class="meta"><span class="chip ${p.status === 'active' ? 'st-in_progress' : p.status === 'done' ? 'st-done' : ''}">${({ active: 'جارٍ', paused: 'متوقف', done: 'منتهٍ' })[p.status]}</span><span class="txt">${p.open_tasks} مهمة مفتوحة</span>${demoChip(p)}</div></div>
          <div class="side"><button class="btn sm" data-pf="${p.id}">مهامه</button>${can('projects.manage') ? `<button class="btn sm" data-pe="${p.id}">تعديل</button>` : ''}</div></div>`, 'لا توجد مشاريع مسجلة')}`;
      const addP = $('#addP', tc); if (addP) addP.onclick = () => modalProject({ section: key });
      $$('[data-pe]', tc).forEach(b => b.onclick = () => modalProject(projects.find(p => p.id == b.dataset.pe)));
      $$('[data-pf]', tc).forEach(b => b.onclick = (e) => { e.preventDefault(); f.project_id = b.dataset.pf; f.scope = ''; tab = 'tasks'; load(); });
    } else if (tab === 'partners') {
      await renderPartnersInto(tc);
    }
  }
  await load(); return { refresh: load };
}

// ===== تفاصيل المهمة + المحادثة =====
async function viewItem(main, id) {
  main.innerHTML = `<div id="ih"></div>
    <div class="card section-gap"><div class="card-h">${I('note')}<h2>المحادثة والتحديثات والقرارات</h2></div><div class="timeline" id="tl"></div></div>
    <form class="composer no-print" id="cmp">
      <textarea name="body" placeholder="${isOwner() ? 'اكتب ملاحظة أو ردًا لمدير المكتب على هذه المهمة…' : 'اكتب رسالة أو تحديثًا لرجل الأعمال…'}" aria-label="نص الرسالة"></textarea>
      ${isManager() ? `<div class="grid2" style="margin-top:8px"><select name="kind" aria-label="نوع الرسالة">${opt('update', 'تحديث تنفيذ')}${opt('message', 'رسالة / استفسار')}</select><input type="text" name="next_step" placeholder="الخطوة التالية (اختياري)"></div>` : ''}
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
    renderHead(); renderTimeline(); renderLog();
    refreshCounts(); // الخادم يعلّم إشعارات هذه المهمة كمقروءة عند فتحها
  }
  function renderHead() {
    const i = data.item;
    const fact = (k, v) => v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '';
    const pendingCount = data.approvals.filter(a => a.status === 'pending').length;
    $('#ih', main).innerHTML = `<div class="card item-head">
      <div class="btn-row" style="margin-bottom:6px"><a class="btn sm ghost" href="javascript:history.back()">${I('back')} رجوع</a><span class="ref">${esc(i.ref)}</span>${demoChip(i)}</div>
      <h1>${esc(i.title)}</h1>
      <div class="meta btn-row" style="margin-top:8px"><span class="chip kind">${esc(kindLabel(i))}</span>${statusChip(i.status)}${prioChip(i.priority)}${dueChip(i)}
        ${i.acknowledged_at ? `<span class="chip st-acknowledged">${I('check')}تم تأكيد الاستلام ${fmtTs(i.acknowledged_at)}</span>` : (i.kind !== 'task' && i.status !== 'cancelled' ? '<span class="chip st-new">لم يُؤكد الاستلام بعد</span>' : '')}
        ${i.requires_approval ? '<span class="chip st-waiting_approval">يتطلب اعتماد النتيجة</span>' : ''}${i.closed_at ? '<span class="chip st-done">مغلقة نهائيًا</span>' : ''}
        ${pendingCount ? `<span class="chip overdue">${I('gavel')}${pendingCount} طلب ينتظر القرار</span>` : ''}</div>
      <dl class="facts">
        ${fact('القسم', esc(i.section_name))}${fact('المشروع', esc(i.project_name || ''))}${fact('التصنيف', esc(state.meta.categories[i.category] || ''))}
        ${fact('المسؤول عن التنفيذ', esc(i.assignee || ''))}${fact('مصدر التكليف', i.source === 'owner' ? 'رجل الأعمال' : i.source === 'meeting' ? 'قرار اجتماع' : 'مدير المكتب')}
        ${fact('تاريخ الإنشاء', fmtTs(i.created_at))}${fact('الموعد النهائي', esc(fmtDue(i)))}${fact('آخر تحديث', fmtTs(i.updated_at))}
        ${fact('الخطوة التالية', esc(i.next_step || ''))}
        ${data.parent ? fact('مرتبطة بالمهمة', `<a href="#/item/${data.parent.id}">${esc(data.parent.ref)} — ${esc(data.parent.title)}</a>`) : ''}
        ${data.meeting ? fact('صادرة عن اجتماع', `<a href="#/meeting/${data.meeting.id}">${esc(data.meeting.title)}</a>`) : ''}
        ${data.sop ? fact('الإجراء التشغيلي', `<a href="#/sop/${data.sop.id}">${esc(data.sop.name)}</a>`) : ''}
        ${data.partner ? fact('الجهة', `<a href="#/partner/${data.partner.id}">${esc(data.partner.name)}</a>`) : ''}
      </dl>
      ${i.description ? `<div class="desc">${esc(i.description)}</div>` : ''}
      ${i.original_text && i.source === 'owner' ? `<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">النص الأصلي كما أرسله رجل الأعمال</summary><div class="orig">${esc(i.original_text)}</div></details>` : ''}
      ${data.files.length ? `<div style="margin-top:10px"><div class="small muted">المرفقات</div>${filesHtml(data.files)}</div>` : ''}
      <div class="actions-bar no-print" id="acts"></div>
    </div>`;
    renderActions();
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
      a.push(`<button class="btn" data-a="edit">تعديل</button>`);
      if (i.is_open) a.push(`<button class="btn ghost" data-s="cancelled">إلغاء</button>`);
    }
    if (isOwner() && i.created_by === state.me.id && i.is_open && !i.closed_at) a.push(`<button class="btn ghost" data-s="cancelled">إلغاء التكليف</button>`);
    if (isOwner()) a.push(`<button class="btn" data-a="noteOn">${I('note')} إرسال ملاحظة مستقلة على المهمة</button>`);
    bar.innerHTML = a.join('');
    bar.classList.toggle('hidden', !a.length);
    $$('[data-s]', bar).forEach(b => b.onclick = async () => {
      const s = b.dataset.s;
      if (s === 'cancelled' && !confirm('تأكيد الإلغاء؟')) return;
      let note = '';
      if (s === 'stalled') { note = prompt('سبب التعثر (اختياري):') || ''; }
      try { await api('PATCH', `/api/items/${id}`, { status: s, status_note: note }); toast('تم تحديث الحالة', 'ok'); await load(); } catch (e) { showErr(e); }
    });
    $$('[data-a]', bar).forEach(b => b.onclick = async () => {
      const act = b.dataset.a;
      try {
        if (act === 'ack') { await POST(`/api/items/${id}/ack`); toast('تم تأكيد الاستلام وإبلاغ رجل الأعمال', 'ok'); await load(); }
        else if (act === 'convert') modalConvert(data.item, load);
        else if (act === 'noteDone') { await api('PATCH', `/api/items/${id}`, { status: 'done' }); await load(); }
        else if (act === 'approval') modalApproval(data.item, load);
        else if (act === 'result') modalResult(data.item, load);
        else if (act === 'close') { await POST(`/api/items/${id}/close`); toast('أُغلقت المهمة وحُفظ سجلها', 'ok'); await load(); }
        else if (act === 'edit') modalTask(data.item, load);
        else if (act === 'noteOn') modalNote({ parent_id: data.item.id });
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
      ctl = `<div class="btn-row" style="margin-top:6px"><span class="small muted">بانتظار قرار رجل الأعمال</span><button class="btn sm ghost" data-withdraw="${ap.id}">سحب الطلب</button></div>`;
    }
    return `<div class="approval ${decided ? 'decided-' + ap.status : ''}">
      <div class="who">${I('gavel')}<b>${esc(ap.kind_label)}</b> • ${esc(ap.requested_by_name)} • ${fmtTs(ap.requested_at)} ${ap.blocking && !decided ? '<span class="chip overdue">يعطل التنفيذ</span>' : ''}</div>
      <h3>${esc(ap.title)}</h3>
      ${ap.body ? `<div class="desc">${esc(ap.body)}</div>` : ''}
      ${filesHtml(ap.files)}
      ${ap.options.length && decided ? `<div class="small muted">البدائل: ${ap.options.map(esc).join(' | ')}</div>` : ''}
      ${decided ? `<div style="margin-top:6px"><span class="chip ${ap.status === 'approved' || ap.status === 'chosen' || ap.status === 'answered' ? 'st-done' : ap.status === 'rejected' ? 'st-stalled' : 'p-important'}">${decLabel}</span>
        ${ap.decided_by_name ? `<span class="small muted"> — ${esc(ap.decided_by_name)} • ${fmtTs(ap.decided_at)}</span>` : ''}
        ${ap.chosen_option ? `<div><b>البديل المختار:</b> ${esc(ap.chosen_option)}</div>` : ''}${ap.decision_note ? `<div class="desc">${esc(ap.decision_note)}</div>` : ''}</div>` : ''}
      ${ctl}</div>`;
  }
  function renderTimeline() {
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
    $$('[data-withdraw]', main).forEach(b => b.onclick = async () => { if (!confirm('سحب طلب الاعتماد؟')) return; try { await POST(`/api/approvals/${b.dataset.withdraw}/withdraw`); await load(); } catch (e) { showErr(e); } });
  }
  function renderLog() {
    const L = { created: 'إنشاء', acknowledged: 'تأكيد الاستلام', converted: 'تحويل إلى مهمة', status: 'تغيير الحالة', updated: 'تعديل', message: 'رسالة', update_posted: 'تحديث تنفيذ', closed: 'إغلاق نهائي' };
    const F = { kind: 'النوع', status: 'الحالة', title: 'العنوان', description: 'الوصف', section: 'القسم', assignee: 'المسؤول', due_date: 'الموعد', priority: 'الأولوية', next_step: 'الخطوة التالية', requires_approval: 'اشتراط الاعتماد', category: 'التصنيف', project_id: 'المشروع', due_time: 'الوقت', sop_id: 'الإجراء', partner_id: 'الجهة' };
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
function modalAssignment(pre = {}) {
  openModal({
    title: 'تكليف جديد إلى مدير المكتب', submit: 'إرسال إلى مدير المكتب',
    body: `${field('عنوان التكليف *', '<input type="text" name="title" required maxlength="300">')}
      ${field('وصف المطلوب', '<textarea name="description" placeholder="ما المطلوب تحديدًا؟ أي تفاصيل أو سياق مهم"></textarea>')}
      ${field('القسم المعني *', sectionSeg(pre.section))}
      ${field('درجة الأهمية', prioSeg('normal'))}
      <div class="grid2">${field('الموعد المطلوب (اختياري)', '<input type="date" name="due_date">')}${field('الوقت (اختياري)', '<input type="time" name="due_time">')}</div>
      ${field('المرفقات والملاحظة الصوتية', fileFieldHtml())}`,
    onSubmit: async (d) => {
      if (!d.section) throw new Error('اختر القسم المعني');
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
  const [projects, sops, partners] = await Promise.all([GET('/api/projects'), GET('/api/sops'), GET('/api/partners')]);
  return `${field('العنوان *', `<input type="text" name="title" required value="${esc(i.title || '')}">`)}
    ${withDesc ? field('الوصف', `<textarea name="description">${esc(i.description || '')}</textarea>`) : ''}
    <div class="grid2">
      ${field('القسم *', sectionSelect(i.section, 'section', true))}
      ${field('التصنيف', `<select name="category">${Object.entries(state.meta.categories).map(([k, v]) => opt(k, v, i.category || 'general')).join('')}</select>`)}
      ${field('المشروع', `<select name="project_id">${opt('', '— بدون —', i.project_id)}${projects.map(p => opt(p.id, `${sectionName(p.section)}: ${p.name}`, i.project_id)).join('')}</select>`)}
      ${field('المسؤول عن التنفيذ', `<input type="text" name="assignee" value="${esc(i.assignee || state.me.name)}">`)}
      ${field('الموعد النهائي', `<input type="date" name="due_date" value="${esc(i.due_date || '')}">`)}
      ${field('الوقت', `<input type="time" name="due_time" value="${esc(i.due_time || '')}">`)}
    </div>
    ${field('الأولوية', prioSeg(i.priority || 'normal'))}
    ${field('الخطوة التالية', `<input type="text" name="next_step" value="${esc(i.next_step || '')}">`)}
    <div class="grid2">
      ${field('الإجراء التشغيلي المرتبط', `<select name="sop_id">${opt('', '— بدون —', i.sop_id)}${sops.map(s => opt(s.id, s.name, i.sop_id)).join('')}</select>`)}
      ${field('الجهة / الشراكة المرتبطة', `<select name="partner_id">${opt('', '— بدون —', i.partner_id)}${partners.map(p => opt(p.id, p.name, i.partner_id)).join('')}</select>`)}
    </div>
    <label class="check"><input type="checkbox" name="requires_approval" ${i.requires_approval ? 'checked' : ''}> تتطلب اعتماد رجل الأعمال للنتيجة النهائية قبل الإغلاق</label>`;
}
async function modalTask(i, after) {
  const editing = i && i.id;
  openModal({
    title: editing ? `تعديل ${i.ref}` : 'مهمة جديدة', wide: true,
    body: await taskFormBody(i || {}) + (editing ? '' : field('المرفقات', fileFieldHtml())),
    onSubmit: async (d) => {
      if (!d.section) throw new Error('اختر القسم');
      if (editing) { delete d.file_ids; await api('PATCH', `/api/items/${i.id}`, d); toast('حُفظت التعديلات', 'ok'); after && after(); }
      else { const it = await POST('/api/tasks', d); toast(`أُنشئت المهمة ${it.ref}`, 'ok'); location.hash = `#/item/${it.id}`; }
      refreshView();
    },
  });
}
async function modalConvert(i, after) {
  openModal({
    title: `تحويل ${i.ref} إلى مهمة منظمة`, wide: true, submit: 'تحويل إلى مهمة',
    body: `<div class="info-box" style="margin-bottom:12px">يتم التحويل في السجل نفسه — يبقى الرقم المرجعي والنص الأصلي والمحادثة كما هي دون إنشاء نسخة مكررة.</div>` + await taskFormBody(i),
    onSubmit: async (d) => { await POST(`/api/items/${i.id}/convert`, d); toast('حُوّل إلى مهمة', 'ok'); after ? after() : (location.hash = `#/item/${i.id}`); refreshView(); },
  });
}
function modalApproval(i, after, preset = {}) {
  const kinds = Object.entries(state.meta.approval_kinds).filter(([k]) => k !== 'final');
  openModal({
    title: 'طلب اعتماد أو قرار من رجل الأعمال', submit: 'إرسال الطلب',
    body: `${field('نوع الطلب', `<select name="kind">${kinds.map(([k, v]) => opt(k, v, preset.kind || 'report')).join('')}</select>`)}
      ${field('العنوان *', `<input type="text" name="title" required value="${esc(preset.title || '')}">`)}
      ${field('التفاصيل', '<textarea name="body" placeholder="ملخص ما يحتاج إلى قرار، والتوصية إن وجدت"></textarea>')}
      ${field('بدائل مقترحة (اختياري — كل بديل في سطر)', '<textarea name="options" style="min-height:70px"></textarea>')}
      <label class="check"><input type="checkbox" name="blocking" checked> هذا القرار يعطل التنفيذ (يظهر في شريط المهام العاجلة)</label>
      ${field('المرفقات (تقرير، عرض…)', fileFieldHtml('file_ids', false))}`,
    onSubmit: async (d) => { await POST(`/api/items/${i.id}/approvals`, d); toast('أُرسل الطلب إلى رجل الأعمال', 'ok'); after && after(); },
  });
}
function modalResult(i, after) {
  openModal({
    title: 'رفع النتيجة النهائية', submit: i.requires_approval ? 'رفع النتيجة وطلب الاعتماد' : 'رفع النتيجة وإكمال المهمة', submitClass: 'green',
    body: `${i.requires_approval ? '<div class="warn-box" style="margin-bottom:10px">هذه المهمة تتطلب اعتماد رجل الأعمال؛ ستُرسل النتيجة إليه وتكتمل المهمة بعد اعتماده.</div>' : ''}
      ${field('ملخص النتيجة *', '<textarea name="body" required></textarea>')}${field('المرفقات', fileFieldHtml('file_ids', false))}`,
    onSubmit: async (d) => {
      if (!d.body.trim()) throw new Error('اكتب ملخص النتيجة');
      if (i.requires_approval) await POST(`/api/items/${i.id}/approvals`, { kind: 'final', title: `اعتماد النتيجة النهائية: ${i.title}`, body: d.body, file_ids: d.file_ids, blocking: true });
      else { await POST(`/api/items/${i.id}/messages`, { body: d.body, kind: 'result', file_ids: d.file_ids }); await api('PATCH', `/api/items/${i.id}`, { status: 'done' }); }
      toast(i.requires_approval ? 'أُرسلت النتيجة لاعتماد رجل الأعمال' : 'اكتملت المهمة', 'ok'); after && after();
    },
  });
}
function modalProject(p = {}) {
  openModal({
    title: p.id ? 'تعديل المشروع' : 'مشروع / مبادرة جديدة',
    body: `${field('الاسم *', `<input type="text" name="name" required value="${esc(p.name || '')}">`)}${field('الوصف', `<textarea name="description">${esc(p.description || '')}</textarea>`)}
      <div class="grid2">${field('القسم', sectionSelect(p.section))}${p.id ? field('الحالة', `<select name="status">${opt('active', 'جارٍ', p.status)}${opt('paused', 'متوقف', p.status)}${opt('done', 'منتهٍ', p.status)}</select>`) : ''}</div>`,
    onSubmit: async (d) => { p.id ? await api('PATCH', `/api/projects/${p.id}`, d) : await POST('/api/projects', d); refreshView(); },
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
    ${d.task_id ? `<a class="chip kind" href="#/item/${d.task_id}">المهمة ${esc(d.task_ref)}</a>` : ''}</div></div>
    ${can('meetings.manage') && !d.task_id ? `<div class="side"><button class="btn sm primary" data-d2t="${d.id}" data-section="${esc(d.meeting_section || '')}">تحويل إلى مهمة</button>
      <select class="dst" data-id="${d.id}" style="min-height:36px;width:auto">${['pending', 'in_progress', 'done', 'cancelled'].map(s => opt(s, ({ pending: 'لم يبدأ', in_progress: 'قيد التنفيذ', done: 'منفذ', cancelled: 'ملغى' })[s], d.status)).join('')}</select></div>` : ''}</div>`;
}
function bindDecisionActions(root, reload) {
  $$('[data-d2t]', root).forEach(b => b.onclick = () => openModal({
    title: 'تحويل القرار إلى مهمة', submit: 'إنشاء المهمة',
    body: `${field('القسم *', sectionSelect(b.dataset.section, 'section', true))}${field('الأولوية', prioSeg('normal'))}<p class="small muted">تُربط المهمة بالاجتماع والقرار، ويتبع القرار حالتها دون تكرار.</p>`,
    onSubmit: async (d) => { if (!d.section) throw new Error('اختر القسم'); const t = await POST(`/api/decisions/${b.dataset.d2t}/task`, d); toast(`أُنشئت المهمة ${t.ref} مرتبطة بالاجتماع`, 'ok'); reload(); },
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
      <div class="card"><div class="card-h"><h2>القرارات الصادرة</h2><span class="spacer"></span>${can('meetings.manage') ? `<button class="btn sm primary" id="addD">${I('plus')} قرار</button>` : ''}</div>
      ${listOrEmpty(m.decisions, decisionRowHtml, 'لا توجد قرارات مسجلة')}</div>`;
    const e = $('#edit', main); if (e) e.onclick = () => modalMeeting(m);
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
        <div class="kpi"><b>${r.avg_completion_days ?? '—'}</b><span>متوسط مدة الإنجاز (يوم)${r.avg_completion_days == null ? ' — بيانات غير كافية' : ''}</span></div>
      </div>
      <div class="card section-gap"><div class="card-h"><h2>توزيع المهام حسب الأقسام الستة</h2><span class="spacer"></span><span class="small muted"><span class="chip st-in_progress">مفتوحة</span> <span class="chip st-done">مكتملة في الفترة</span> <span class="chip overdue">منها متأخرة</span></span></div>
        <div class="bars">${r.by_section.map(s => `<div class="bar"><span>${esc(s.name)}</span><div class="track" title="مفتوحة ${s.open} • مكتملة ${s.completed} • متأخرة ${s.overdue}">
          <div class="fill late" style="width:${s.overdue / max * 100}%"></div><div class="fill" style="width:${(s.open - s.overdue) / max * 100}%"></div><div class="fill done" style="width:${s.completed / max * 100}%"></div></div><b>${s.open + s.completed}</b></div>`).join('')}</div></div>
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
const b64ToU8 = (b) => { const p = '='.repeat((4 - b.length % 4) % 4); const s = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...s].map(c => c.charCodeAt(0))); };
async function viewSettings(main) {
  const [p, deliveries] = await Promise.all([GET('/api/prefs'), GET('/api/deliveries')]);
  const T = state.meta.notif_types;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const em = state.meta.email;
  main.innerHTML = `<div class="page-h">${I('settings')}<h1>الإعدادات</h1></div>
  <form class="card" id="pf">
    <div class="card-h"><h2>تخصيص الإشعارات</h2></div>
    <h3>1) داخل المنصة</h3><p class="small muted">تظهر في مركز الإشعارات وفي التنبيه المنبثق. التنبيهات العاجلة تصل دائمًا.</p>
    <div class="grid2">${Object.entries(T).map(([k, v]) => `<label class="check"><input type="checkbox" data-group="inapp" value="${k}" ${p.inapp[k] !== false ? 'checked' : ''}> ${v}</label>`).join('')}</div>
    <h3 class="section-gap">2) إشعارات الجوال (Push)</h3>
    ${pushSupported ? `<div class="btn-row"><button type="button" class="btn" id="pushOn">${I('bell')} تفعيل الإشعارات على هذا الجهاز</button><span class="small muted">الأجهزة المسجلة: ${p.push_devices}</span></div>`
      : `<div class="warn-box">هذا المتصفح أو الاتصال لا يدعم إشعارات Push. تتطلب اتصالًا آمنًا HTTPS (أو localhost)، وعلى iPhone يجب إضافة المنصة إلى الشاشة الرئيسية أولًا (iOS 16.4+).</div>`}
    <label class="check"><input type="checkbox" name="push_enabled" ${p.push.enabled ? 'checked' : ''}> إرسال إشعارات Push</label>
    <label class="check"><input type="checkbox" name="push_urgent_only" ${p.push.urgent_only ? 'checked' : ''}> العاجلة فقط</label>
    <label class="check"><input type="checkbox" name="private_lock_screen" ${p.private_lock_screen ? 'checked' : ''}> إخفاء التفاصيل في إشعارات شاشة القفل (يظهر «لديك إشعار جديد» فقط)</label>
    <details><summary class="small" style="cursor:pointer">أنواع إشعارات Push</summary><div class="grid2">${Object.entries(T).map(([k, v]) => `<label class="check"><input type="checkbox" data-group="push" value="${k}" ${p.push.types.includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div></details>
    <h3 class="section-gap">3) البريد الإلكتروني</h3>
    ${em.configured ? `<div class="info-box">مزود البريد مُعد (${esc(em.mode)}).</div>` : '<div class="warn-box">لم يُعد مزود البريد بعد على الخادم — لن تُرسل رسائل فعلية حتى يُضبط SMTP (انظر دليل التشغيل). يمكنك حفظ تفضيلاتك الآن.</div>'}
    ${field('بريدك الإلكتروني', `<input type="email" name="email_address" dir="ltr" value="${esc(p.email_address || '')}">`)}
    <label class="check"><input type="checkbox" name="email_enabled" ${p.email.enabled ? 'checked' : ''}> أوافق على استلام إشعارات بالبريد الإلكتروني</label>
    <div class="grid2">${['new_assignment', 'approval_request', 'new_message', 'overdue', 'digest', 'decision'].map(k => `<label class="check"><input type="checkbox" data-group="email" value="${k}" ${p.email.types.includes(k) ? 'checked' : ''}> ${T[k]}</label>`).join('')}</div>
    <h3 class="section-gap">واتساب (مستقبلًا)</h3>
    <div class="warn-box">${state.meta.whatsapp.configured ? 'تكامل واتساب الرسمي مُعد على الخادم.' : 'غير مفعّل. يتطلب ربطًا رسميًا عبر WhatsApp Business Platform (حساب أعمال موثّق وقوالب معتمدة وتكلفة لكل محادثة). المنصة تعمل بالكامل دونه.'}</div>
    <div class="grid2">${field('رقم واتساب (بالصيغة الدولية)', `<input type="tel" name="whatsapp_phone" dir="ltr" value="${esc(p.whatsapp_phone)}" placeholder="9665xxxxxxxx">`)}<label class="check" style="margin-top:24px"><input type="checkbox" name="whatsapp_enabled" ${p.whatsapp_enabled ? 'checked' : ''}> استلام التنبيهات عبر واتساب عند تفعيله</label></div>
    <div class="btn-row section-gap"><button class="btn primary">حفظ التفضيلات</button><button type="button" class="btn" id="test">إرسال إشعار تجريبي</button></div>
  </form>
  <div class="card"><div class="card-h"><h2>سجل الإرسال خارج المنصة</h2></div>
    ${deliveries.length ? deliveries.map(d => `<div class="log-row">${fmtTs(d.created_at)} — ${esc({ push: 'Push', email: 'بريد', whatsapp: 'واتساب' }[d.channel] || d.channel)}: ${esc({ sent: 'أُرسل', failed: 'فشل', skipped: 'تُخطي', not_configured: 'غير مُعد' }[d.status] || d.status)} ${d.detail ? `<span class="muted ltr">${esc(d.detail)}</span>` : ''}</div>`).join('') : '<div class="muted small">لا يوجد</div>'}</div>
  <form class="card" id="pw"><div class="card-h"><h2>تغيير كلمة المرور</h2></div>
    <div class="grid2">${field('الحالية', '<input type="password" name="current" autocomplete="current-password" dir="ltr">')}${field('الجديدة (8 أحرف على الأقل)', '<input type="password" name="next" autocomplete="new-password" dir="ltr">')}</div>
    <button class="btn">تغيير</button></form>
  ${isManager() ? `<div class="card"><div class="card-h"><h2>النسخ الاحتياطي</h2></div><p class="small muted">تُنشأ نسخة تلقائية يوميًا (آخر 14 نسخة) في مجلد data/backups على الخادم.</p><button class="btn" id="bk">${I('download')} إنشاء نسخة احتياطية الآن</button></div>` : ''}`;
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
  if (po) po.onclick = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('لم يُمنح إذن الإشعارات');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(state.meta.vapid) });
      await POST('/api/push/subscribe', sub.toJSON());
      toast('فُعّلت الإشعارات على هذا الجهاز', 'ok'); route();
    } catch (e) { showErr(e); }
  };
  $('#pw', main).onsubmit = async (e) => { e.preventDefault(); try { await POST('/api/password', formData(e.target)); toast('تم تغيير كلمة المرور', 'ok'); e.target.reset(); } catch (ex) { showErr(ex); } };
  const bk = $('#bk', main); if (bk) bk.onclick = async () => { try { const r = await POST('/api/backup'); toast('أُنشئت النسخة: ' + r.file, 'ok'); } catch (e) { showErr(e); } };
}

async function viewMore(main) {
  main.innerHTML = `<div class="page-h"><h1>المزيد</h1></div><div class="list">
    ${navItems().map(n => `<a class="row" href="${n.h}"><div class="main"><span class="title">${I(n.i)} ${n.t}</span></div>${n.n ? `<span class="chip p-urgent">${n.n}</span>` : ''}</a>`).join('')}
    <div class="lbl small muted" style="margin-top:8px">الأقسام</div>
    ${state.meta.sections.map(s => `<a class="row" href="#/section/${s.key}"><div class="main"><span class="title">${I(s.icon)} ${s.name}</span></div></a>`).join('')}
    <a class="row" href="#/settings"><div class="main"><span class="title">${I('settings')} الإعدادات والإشعارات</span></div></a>
    <a class="row" href="#" id="lo"><div class="main"><span class="title">${I('logout')} تسجيل الخروج</span></div></a></div>`;
  $('#lo', main).onclick = (e) => { e.preventDefault(); logout(); };
}

// ===== الإقلاع =====
async function boot() {
  try {
    const me = await GET('/api/me');
    state.me = me; state.counts = { unread: me.unread, inbox_pending: me.inbox_pending, pending_decisions: me.pending_decisions };
    state.meta = await GET('/api/meta');
    renderShell(); openEvents(); await route();
  } catch (e) { if (!state.me) renderLogin(); }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
// تحديث تاريخ "اليوم" والبيانات عند العودة للتبويب
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) { GET('/api/meta').then(m => { state.meta = m; }).catch(() => { }); refreshView(); } });
boot();
