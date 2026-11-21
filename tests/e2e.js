'use strict';
/**
 * سيناريو الاختبار الإلزامي (17) — اختبار فعلي عبر متصفح حقيقي (Chromium) لحسابين في نفس الوقت:
 * مدير الشؤون التعليمية على مقاس جوال، ومدير المكتب على مقاس كمبيوتر، مع خادم وقاعدة بيانات جديدة.
 * التشغيل: npm run test:e2e
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium, devices } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'office-e2e-'));
// منفذ عشوائي، مع تجنب المنافذ التي يحظرها Chrome (ERR_UNSAFE_PORT)
const UNSAFE = new Set([3659, 4045]);
let PORT; do { PORT = 3200 + Math.floor(Math.random() * 500); } while (UNSAFE.has(PORT));
const BASE = `http://localhost:${PORT}`;
const TARGET = process.env.E2E_TARGET === 'cf' ? 'cloudflare' : 'node';
const SHOTS = path.join(ROOT, 'tests', 'screenshots', TARGET);
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let step = 0;
async function check(name, fn) {
  step++;
  try { await fn(); results.push([step, name, 'نجح']); console.log(`✔ ${step}. ${name}`); }
  catch (e) {
    results.push([step, name, 'فشل: ' + e.message]); console.log(`✘ ${step}. ${name}\n   ${e.message}`);
    // لقطات وتشخيص لكل صفحة مفتوحة عند الفشل (لتحليل الأعطال المتقطعة)
    for (const [k, pg] of Object.entries(global.pages || {})) {
      try { await pg.screenshot({ path: path.join(SHOTS, `fail-${step}-${k}.png`), fullPage: true }); console.log(`   [${k}] ${pg.url()} toasts=${JSON.stringify(await pg.$$eval('.toast', t => t.map(x => x.textContent)))} modals=${JSON.stringify(await pg.$$eval('.modal-bg', ms => ms.map(m => [m.querySelector('h2') && m.querySelector('h2').textContent, [...m.querySelectorAll('input,textarea')].map(i => i.name + '=' + (i.type === 'radio' ? i.checked : i.value)).join(';')])))}`); } catch { /* مغلقة */ }
    }
    throw e;
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// خادم Push وهمي يستقبل الطلبات المشفّرة التي يرسلها الخادم (يتحقق من جانب الإرسال لدينا)
const pushHits = [];
const pushSrv = http.createServer((req, res) => {
  let len = 0; req.on('data', c => len += c.length);
  req.on('end', () => { pushHits.push({ url: req.url, enc: req.headers['content-encoding'], auth: /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{80,}$/.test(req.headers.authorization || ''), len }); res.writeHead(201); res.end(); });
});

// خادم بريد وهمي بصيغة Resend: يتحقق من مسار الإرسال الفعلي في الشيفرة (دون إرسال حقيقي)
const mails = [];
const mailSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => { try { mails.push(JSON.parse(b)); } catch { /* تجاهل */ } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"test"}'); });
});

let server;
function startServer() {
  const cfg = {
    OWNER_PASSWORD: 'Owner#2026x', MANAGER_PASSWORD: 'Manager#2026x', SEED_DATA: '0', ADMIN_RECOVERY_CODE: 'Recovery-Code-2026', OWNER_EMAIL: 'owner@example.test', MANAGER_EMAIL: 'manager@example.test',
    EMAIL_MODE: 'resend', RESEND_API_KEY: 'test-key', RESEND_API_URL: `http://127.0.0.1:${mailSrv.address().port}/emails`, EMAIL_FROM: 'office@example.test',
  };
  return new Promise((resolve, reject) => {
    if (TARGET === 'node') {
      server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/node/server.js'], { cwd: ROOT, env: { ...process.env, ...cfg, DATA_DIR: DATA, PORT: String(PORT), TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } else { // Cloudflare: المحرك الفعلي workerd محليًا مع Durable Object وSQLite
      const vars = Object.entries(cfg).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
      server = spawn(path.join(ROOT, 'node_modules', '.bin', 'wrangler'), ['dev', '--port', String(PORT), '--persist-to', path.join(DATA, 'state'), ...vars], { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let out = ''; let done = false; global.serverLog = () => out;
    const ready = () => { if (!done && /المنصة تعمل|Ready on/.test(out)) { done = true; setTimeout(resolve, TARGET === 'cf' ? 500 : 0); } };
    server.stdout.on('data', d => { out += d; ready(); });
    server.stderr.on('data', d => { if (TARGET === 'node') process.stderr.write(d); else out += d; });
    server.on('exit', c => reject(new Error('server exited ' + c)));
  });
}
// يُلتقط معرّف العملية الحالية: بعد إعادة التشغيل يشير server إلى الخادم الجديد ويجب ألا يُقتل
const stopServer = () => new Promise(r => { const old = server; old.removeAllListeners('exit'); old.on('exit', r); old.kill(); setTimeout(() => { if (old.exitCode === null && old.signalCode === null) try { process.kill(old.pid, 'SIGKILL'); } catch { /* انتهى */ } }, 8000).unref(); });
async function apiAs(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, url, body]);
}
// زر في شريط الإجراءات: على الجوال قد يكون خلف «كل الإجراءات» فنفتحها أولًا كما يفعل المستخدم
async function act(page, sel) {
  const el = page.locator(sel).first(); await el.waitFor({ state: 'attached' });
  if (!(await el.isVisible())) { const more = page.locator('#acts [data-more]'); if (await more.isVisible() && (await more.getAttribute('aria-expanded')) !== 'true') await more.click(); }
  await el.click();
}
async function login(page, user, pass) {
  await page.goto(BASE);
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pass);
  await page.click('button:has-text("دخول")');
  await page.waitForSelector('.tiles');
}
const noHScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1);

(async () => {
  await new Promise(r => pushSrv.listen(0, r));
  await new Promise(r => mailSrv.listen(0, r));
  const pushPort = pushSrv.address().port;
  await startServer();
  const browser = await chromium.launch();
  const ownerCtx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ar-SA' });
  const mgrCtx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ar-SA' });
  const owner = await ownerCtx.newPage();
  const mgr = await mgrCtx.newPage();
  const consoleErrors = [];
  global.pages = { owner, mgr };
  for (const p of [owner, mgr]) p.on('pageerror', e => consoleErrors.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 4).join(' | ')));
  const TITLE = 'إعداد التقرير السنوي لبرامج الجمعية';
  let itemId, ref, tileBefore, folderId, projectId;
  const staff = {};

  try {
    await check('يسجل مدير الشؤون التعليمية الدخول (جوال)', async () => {
      await login(owner, 'owner', 'Owner#2026x');
      assert(await owner.isVisible('#btnAdd') && await owner.isVisible('#btnToday'), 'زر الإضافة أو مهام اليوم غير ظاهر');
      assert((await owner.$$('main .ribbon')).length === 1 && await owner.isVisible('main .ribbon.follow'), 'يجب أن يكون هناك شريط متابعة واحد');
      assert((await owner.textContent('.topbar .brand b')).includes('مكتب عبدالله عبدالعزيز التويجري'), 'اسم المنصة غير صحيح');
      // المربعات على الجوال: عمودان وشكل قريب من المربع
      const tg = await owner.evaluate(() => { const t = document.querySelector('.tile-wrap').getBoundingClientRect(); return { cols: getComputedStyle(document.querySelector('.tiles')).gridTemplateColumns.split(' ').length, ratio: t.height / t.width }; });
      assert(tg.cols === 2 && tg.ratio > 0.95 && tg.ratio < 1.1, 'المربعات على الجوال ليست مربعات في عمودين: ' + JSON.stringify(tg));
      await owner.screenshot({ path: path.join(SHOTS, '01-owner-home-mobile.png'), fullPage: true });
    });

    // مدير المكتب يفتح صندوق الوارد مسبقًا لاختبار المزامنة الفورية + تفعيل البريد و Push (اشتراك وهمي)
    await login(mgr, 'manager', 'Manager#2026x');
    const prefs = (await apiAs(mgr, 'GET', '/api/prefs')).body;
    await apiAs(mgr, 'PUT', '/api/prefs', { ...prefs, email: { enabled: true, types: ['new_assignment', 'approval_request'] }, email_address: 'manager@example.test', private_lock_screen: true });
    // مفاتيح اشتراك صالحة الشكل (P-256) كما يولدها المتصفح
    const ecdh = require('crypto').createECDH('prime256v1'); ecdh.generateKeys();
    await apiAs(mgr, 'POST', '/api/push/subscribe', { endpoint: `http://127.0.0.1:${pushPort}/push/mgr`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: require('crypto').randomBytes(16).toString('base64url') } });
    tileBefore = (await apiAs(mgr, 'GET', '/api/home')).body.tiles.find(t => t.key === 'association');
    // مساحة العمل المشتركة: مدير المكتب يفتح قائمة المهام على جهاز آخر لاختبار المزامنة الفورية
    await mgr.goto(BASE + '/#/tasks?scope=open'); await mgr.waitForSelector('h1:has-text("كل المهام")');

    await check('مساحة عمل مشتركة: يضيف مدير الشؤون التعليمية مهمة من جواله (مع مرفق) فتصبح مهمة مباشرة لا تكليفًا', async () => {
      await owner.click('#btnAdd'); await owner.click('.modal [data-k=task]'); await owner.waitForSelector('.modal input[name=title]');
      await owner.fill('.modal input[name=title]', TITLE);
      await owner.fill('.modal textarea[name=description]', 'إعداد التقرير السنوي متضمنًا الأرقام والإنجازات، ورفعه للاعتماد.');
      await owner.selectOption('.modal select[name=section]', 'association');
      await owner.click('.modal .seg label:has-text("مهم")');
      await owner.evaluate(() => document.querySelectorAll('.modal details').forEach(d => { d.open = true; }));
      await owner.check('.modal input[name=requires_approval]');
      const f = path.join(DATA, 'brief.txt'); fs.writeFileSync(f, 'ملف توضيحي للمهمة');
      await owner.setInputFiles('.modal input[type=file]', f);
      await owner.waitForSelector('.modal .files .file');
      await owner.click('.modal button[type=submit]');
      await owner.waitForSelector(`h1:has-text("${TITLE}")`);
      itemId = Number(owner.url().match(/item\/(\d+)/)[1]);
      ref = await owner.textContent('.item-head .ref');
      assert(/^MH-\d{4}-\d{4}$/.test(ref.trim()), 'يجب أن تكون مهمة مباشرة (MH): ' + ref);
      assert(!(await owner.isVisible('text=لم يُؤكد الاستلام بعد')), 'لا حاجة لتأكيد استلام بين المدير ومدير المكتب');
      const it = (await apiAs(owner, 'GET', `/api/items/${itemId}`)).body.item;
      assert(it.kind === 'task' && it.source === 'owner' && it.requires_approval, 'المهمة لم تُحفظ كما يجب: ' + JSON.stringify({ kind: it.kind, source: it.source }));
    });

    await check('السيناريو الأول: تظهر المهمة لدى مدير المكتب على جهازه فورًا دون إعادة تحميل', async () => {
      await mgr.waitForSelector(`.row a.title:has-text("${TITLE}")`, { timeout: 8000 });
      await mgr.screenshot({ path: path.join(SHOTS, '02-manager-inbox-desktop.png'), fullPage: true });
    });

    await check('يصل إشعار فعلي لمدير المكتب: داخل المنصة + بريد (وضع الملف) + Push (خادم اختبار)', async () => {
      await mgr.waitForSelector('.toast', { timeout: 5000 });
      const n = (await apiAs(mgr, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.type === 'new_assignment' && x.title.includes(TITLE) && !x.read_at), 'لا يوجد إشعار داخل المنصة');
      assert(await mgr.isVisible('#bellN:not(.hidden)'), 'عداد الإشعارات غير ظاهر');
      await new Promise(r => setTimeout(r, 1500));
      assert(mails.some(m => m.to.includes('manager@example.test') && m.subject.includes(TITLE)), 'لم يُرسل بريد لمدير المكتب: ' + JSON.stringify(mails.map(m => m.subject)));
      assert(pushHits.length >= 1 && pushHits[0].enc === 'aes128gcm' && pushHits[0].auth, 'لم يُرسل طلب Push مشفر: ' + JSON.stringify(pushHits));
    });

    await check('السيناريو الثاني: يعدّل مدير المكتب موعد المهمة فيراه المدير فورًا، ويُسجَّل من عدّل', async () => {
      await mgr.goto(`${BASE}/#/item/${itemId}`); await mgr.waitForSelector('#editTop');
      await mgr.click('#editTop'); await mgr.waitForSelector('.modal input[name=due_date]');
      const due = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
      await mgr.fill('.modal input[name=due_date]', due);
      await mgr.fill('.modal input[name=next_step]', 'جمع بيانات البرامج من المشرفين');
      await mgr.click('.modal button[type=submit]'); await mgr.waitForSelector('.modal-bg', { state: 'detached' });
      // المدير على صفحة المهمة نفسها في جواله: يتحدث الموعد دون إعادة تحميل
      await owner.waitForFunction((d) => { const x = document.querySelector('.facts'); return x && x.textContent.includes(d); }, new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long' }).format(new Date(due + 'T12:00:00')).split(' ')[0], { timeout: 8000 });
      const it = (await apiAs(owner, 'GET', `/api/items/${itemId}`)).body;
      assert(it.item.due_date === due, 'الموعد لم يُحفظ');
      assert(it.messages.some(m => m.kind === 'system' && m.body.includes('عدّل مدير المكتب')), 'لم يُسجَّل من عدّل');
    });

    await check('يبدأ التنفيذ ويضيف تحديثًا', async () => {
      await act(mgr, '#acts [data-s=in_progress]');
      await mgr.waitForSelector('.item-head .chip.st-in_progress');
      await mgr.fill('#cmp textarea[name=body]', 'تم جمع بيانات 4 برامج من أصل 6، والعمل جارٍ على البقية.');
      await mgr.click('#cmp button:has-text("إرسال")');
      await mgr.waitForSelector('.msg.update:has-text("تم جمع بيانات 4 برامج")');
    });

    await check('يتلقى مدير الشؤون التعليمية إشعارًا بالتحديث ويراه في المهمة', async () => {
      await owner.waitForSelector('.msg.update:has-text("تم جمع بيانات 4 برامج")', { timeout: 8000 });
      const n = (await apiAs(owner, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.type === 'new_message' && x.title.includes('تحديث من مدير المكتب')), 'لا يوجد إشعار تحديث');
      assert(n.some(x => x.type === 'status_change'), 'لا يوجد إشعار تغيير حالة');
    });

    await check('يرسل مدير الشؤون التعليمية ملاحظة على المهمة', async () => {
      await owner.fill('#cmp textarea[name=body]', 'أضف مقارنة بأرقام العام الماضي لو سمحت.');
      await owner.click('#cmp button:has-text("إرسال")');
      await owner.waitForSelector('.msg.owner:has-text("مقارنة بأرقام العام الماضي")');
    });

    await check('تظهر الملاحظة لدى مدير المكتب داخل المهمة نفسها', async () => {
      await mgr.waitForSelector('.msg.owner:has-text("مقارنة بأرقام العام الماضي")', { timeout: 8000 });
      const n = (await apiAs(mgr, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.type === 'new_message' && x.link === `#/item/${itemId}`), 'لا يوجد إشعار بالملاحظة');
    });

    await check('يرفع مدير المكتب تقريرًا ويطلب اعتماده (مع مرفق)', async () => {
      await act(mgr, '#acts [data-a=approval]');
      await mgr.selectOption('.modal select[name=kind]', 'report');
      await mgr.fill('.modal input[name=title]', 'مسودة التقرير السنوي للجمعية');
      await mgr.fill('.modal textarea[name=body]', 'مرفق المسودة الأولى مع المقارنة بالعام الماضي.');
      const f = path.join(DATA, 'report.txt'); fs.writeFileSync(f, 'مسودة التقرير');
      await mgr.setInputFiles('.modal input[type=file]', f); await mgr.waitForSelector('.modal .files .file');
      await mgr.click('.modal button:has-text("إرسال الطلب")');
      await mgr.waitForSelector('.approval:has-text("مسودة التقرير السنوي للجمعية")');
      await mgr.waitForSelector('.item-head .chip.st-waiting_approval');
    });

    await check('تظهر المهمة في «بانتظار قراري» لدى مدير الشؤون التعليمية', async () => {
      await owner.goto(`${BASE}/#/decisions`);
      await owner.waitForSelector('.row:has-text("مسودة التقرير السنوي للجمعية")');
      await owner.screenshot({ path: path.join(SHOTS, '03-owner-decisions-mobile.png'), fullPage: true });
      const home = (await apiAs(owner, 'GET', '/api/home')).body;
      assert(home.urgent_ribbon.some(i => i.id === itemId), 'لم تظهر في شريط العاجلة رغم أن القرار يعطل التنفيذ');
    });

    await check('يطلب مدير الشؤون التعليمية تعديل التقرير (برفض مسبّب) ثم يعتمد النسخة المعدلة', async () => {
      await owner.click('.row:has-text("مسودة التقرير السنوي للجمعية") a:has-text("اتخاذ القرار")');
      await owner.waitForSelector('form.decide');
      // طلب التعديل بدون سبب يجب أن يُرفض من الخادم
      await owner.click('form.decide button:has-text("طلب تعديل")');
      await owner.waitForSelector('.toast.err:has-text("وضّح السبب")');
      await owner.fill('form.decide textarea[name=note]', 'أضف قسمًا عن المستفيدين.');
      await owner.click('form.decide button:has-text("طلب تعديل")');
      await owner.waitForSelector('.approval.decided-changes_requested');
    });

    await check('يظهر القرار لدى مدير المكتب', async () => {
      await mgr.waitForSelector('.approval.decided-changes_requested', { timeout: 8000 });
      await mgr.waitForSelector('.sys.decision:has-text("طلب تعديل")');
      const n = (await apiAs(mgr, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.type === 'decision'), 'لا يوجد إشعار قرار');
    });

    await check('يستكمل مدير المكتب العمل ويعيد الطلب فيعتمده مدير الشؤون التعليمية', async () => {
      await mgr.fill('#cmp textarea[name=body]', 'أُضيف قسم المستفيدين.'); await mgr.click('#cmp button:has-text("إرسال")');
      await mgr.waitForSelector('.msg:has-text("أُضيف قسم المستفيدين")');
      await act(mgr, '#acts [data-a=approval]');
      await mgr.fill('.modal input[name=title]', 'التقرير السنوي — النسخة المعدلة');
      await mgr.click('.modal button:has-text("إرسال الطلب")');
      await owner.waitForSelector('form.decide', { timeout: 8000 });
      await owner.click('form.decide button:has-text("اعتماد")');
      await owner.waitForSelector('.approval.decided-approved');
      await mgr.waitForSelector('.approval.decided-approved', { timeout: 8000 });
    });

    await check('سياسة الإغلاق: لا تكتمل المهمة المشروطة بالاعتماد دون اعتماد النتيجة', async () => {
      const r = await apiAs(mgr, 'PATCH', `/api/items/${itemId}`, { status: 'done' });
      assert(r.status === 400, 'سُمح بالإكمال دون اعتماد');
      // مساحة عمل مشتركة: سياسة الإغلاق تنطبق على المدير كما تنطبق على مدير المكتب، والقرار للمدير وحده
      assert((await apiAs(owner, 'PATCH', `/api/items/${itemId}`, { status: 'done' })).status === 400, 'المدير تجاوز سياسة الإغلاق');
      assert((await apiAs(mgr, 'POST', `/api/approvals/1/decide`, { decision: 'approved' })).status === 403, 'مدير المكتب اتخذ قرارًا');
      assert((await apiAs(owner, 'POST', `/api/items/${itemId}/approvals`, { kind: 'report', title: 'x' })).status === 403, 'مدير الشؤون التعليمية طلب اعتمادًا');
      // حد المحاولات لكل مستخدم يصمد أمام تزوير عنوان IP عبر X-Forwarded-For
      let last = 0;
      for (let k = 0; k < 31; k++) {
        last = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.${k}.1` }, body: JSON.stringify({ username: 'ghost', password: 'wrong' }) })).status;
      }
      assert(last === 429, 'لم يُفعَّل حد المحاولات لكل مستخدم: ' + last);
      assert((await apiAs(mgr, 'POST', '/api/assignments', { title: 'x', section: 'family' })).status === 403, 'مدير المكتب أنشأ تكليفًا باسم مدير الشؤون التعليمية');
      // حماية CSRF وتسجيل الدخول
      const csrf = await owner.evaluate(async () => (await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
      assert(csrf === 403, 'طلب بلا ترويسة الحماية قُبل');
      const anon = await (await fetch(BASE + '/api/items')).status;
      assert(anon === 401, 'وصول دون تسجيل دخول');
    });

    await check('يرفع مدير المكتب النتيجة النهائية ويعتمدها مدير الشؤون التعليمية ثم تُغلق', async () => {
      await act(mgr, '#acts [data-a=result]');
      await mgr.fill('.modal textarea[name=body]', 'التقرير السنوي النهائي جاهز ومرفق.');
      await mgr.click('.modal button:has-text("رفع النتيجة وطلب الاعتماد")');
      await mgr.waitForSelector('.approval:has-text("اعتماد النتيجة النهائية")');
      await owner.waitForSelector('form.decide', { timeout: 8000 });
      await owner.click('form.decide button:has-text("اعتماد")');
      await owner.waitForSelector('.item-head .chip.st-done', { timeout: 8000 });
      await mgr.waitForSelector('.item-head .chip.st-done', { timeout: 8000 });
      await act(mgr, '#acts button:has-text("إغلاق نهائي")');
      await mgr.waitForSelector('.chip:has-text("مغلقة نهائيًا")');
      await owner.screenshot({ path: path.join(SHOTS, '04-owner-item-mobile.png'), fullPage: true });
      await mgr.screenshot({ path: path.join(SHOTS, '05-manager-item-desktop.png'), fullPage: true });
    });

    await check('تتحدث مؤشرات القسم ولوحة التحكم تلقائيًا', async () => {
      const home = (await apiAs(owner, 'GET', '/api/home')).body;
      const tile = home.tiles.find(t => t.key === 'association');
      assert(tile.open === tileBefore.open, `المفتوحة يجب أن تعود كما كانت بعد الإكمال (${tileBefore.open} → ${tile.open})`);
      const rep = (await apiAs(owner, 'GET', '/api/reports?period=day')).body;
      assert(rep.completed >= 1 && rep.received >= 1 && rep.decisions_made >= 3, 'التقرير لم يتحدث: ' + JSON.stringify({ c: rep.completed, r: rep.received, d: rep.decisions_made }));
      assert(rep.by_section.find(s => s.key === 'association').completed >= 1, 'توزيع الأقسام لم يتحدث');
      await owner.goto(BASE + '/#/'); await owner.waitForSelector('.tiles');
      const tileText = await owner.textContent('a.tile[href="#/section/association"]');
      assert(tileText.includes('الجمعية'), 'المربع غير ظاهر');
    });

    await check('يُحفظ سجل التكليف والمحادثة والقرار بشكل دائم (بعد إعادة تشغيل الخادم)', async () => {
      await stopServer(); await startServer();
      await owner.goto(`${BASE}/#/item/${itemId}`);
      await owner.waitForSelector('.msg.owner:has-text("مقارنة بأرقام العام الماضي")');
      const d = (await apiAs(owner, 'GET', `/api/items/${itemId}`)).body;
      assert(d.item.original_text.includes('إعداد التقرير السنوي'), 'النص الأصلي مفقود');
      assert(d.approvals.length === 3 && d.approvals.filter(a => a.decided_by).length === 3, 'القرارات غير محفوظة');
      // سجل من فعل ماذا: أنشأها المدير، عدّل موعدها مدير المكتب، غيّر حالتها، وأغلقها
      const by = (act) => d.audit.filter(a => a.action === act).map(a => a.user_name);
      assert(by('created').includes('مدير الشؤون التعليمية') && by('updated').includes('مدير المكتب') && d.audit.some(a => a.action === 'status') && by('closed').includes('مدير المكتب'), 'سجل التغييرات ناقص: ' + JSON.stringify(d.audit.map(a => [a.action, a.user_name])));
      assert(d.files.length === 1 && d.approvals[0].files.length === 1, 'المرفقات غير محفوظة');
      const fr = await owner.evaluate(async (id) => (await fetch('/api/files/' + id)).status, d.files[0].id);
      assert(fr === 200, 'تعذر تنزيل المرفق');
    });

    await check('الاجتماعات: إنشاء اجتماع وقرار يتحول إلى مهمة مرتبطة ويتابعه مدير الشؤون التعليمية', async () => {
      await mgr.goto(BASE + '/#/meetings'); await mgr.click('#add');
      await mgr.fill('.modal input[name=title]', 'اجتماع مجلس الإدارة الربعي');
      await mgr.fill('.modal input[name=starts_at]', new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) + 'T19:00');
      await mgr.selectOption('.modal select[name=section]', 'association');
      await mgr.click('.modal button:has-text("حفظ")');
      await mgr.waitForSelector('h1:has-text("اجتماع مجلس الإدارة الربعي")');
      await mgr.click('#addD');
      await mgr.fill('.modal textarea[name=text]', 'إطلاق حملة التسجيل في الحلقات');
      await mgr.click('.modal button:has-text("حفظ")');
      await mgr.waitForSelector('.row:has-text("إطلاق حملة التسجيل") a.chip.kind');
      const tasks = (await apiAs(mgr, 'GET', '/api/items?kind=tasks&q=' + encodeURIComponent('إطلاق حملة التسجيل'))).body;
      assert(tasks.length === 1 && tasks[0].source === 'meeting', 'المهمة المرتبطة بالقرار غير صحيحة');
      await owner.goto(BASE + '/#/meetings'); await owner.click('button[data-tab=decisions]');
      await owner.waitForSelector('.row:has-text("إطلاق حملة التسجيل")');
      assert(await owner.isVisible('#add'), 'مساحة عمل مشتركة: يجب أن يستطيع المدير إنشاء اجتماع كما يفعل مدير المكتب');
    });

    await check('زر (+) في مربع القسم يفتح مهمة جديدة والقسم محدد مسبقًا (للمدير ومدير المكتب)', async () => {
      await owner.goto(BASE + '/#/'); await owner.waitForSelector('.tiles');
      await owner.click('button.tile-add[data-add-section="family"]');
      await owner.waitForSelector('.modal select[name=section]');
      assert(await owner.$eval('.modal select[name=section]', e => e.value) === 'family', 'القسم غير محدد مسبقًا');
      await owner.fill('.modal input[name=title]', 'حجز موعد عائلي من زر المربع');
      await owner.click('.modal button[type=submit]');
      await owner.waitForSelector('h1:has-text("حجز موعد عائلي من زر المربع")');
      const it = (await apiAs(owner, 'GET', '/api/items?kind=all&q=' + encodeURIComponent('حجز موعد عائلي'))).body;
      assert(it.length === 1 && it[0].section === 'family' && it[0].kind === 'task', 'المهمة لم تُنشأ في القسم الصحيح');
      await mgr.goto(BASE + '/#/'); await mgr.waitForSelector('.tiles');
      await mgr.click('button.tile-add[data-add-section="commercial"]');
      await mgr.waitForSelector('.modal select[name=section]');
      assert(await mgr.$eval('.modal select[name=section]', e => e.value) === 'commercial', 'قسم المهمة غير محدد مسبقًا لمدير المكتب');
      await mgr.click('.modal button[data-close]');
    });

    await check('المجلدات: مجلد داخل الجمعية يضم مشروعًا ومهمة، وتظهر في صفحة المجلد', async () => {
      await mgr.goto(BASE + '/#/section/association'); await mgr.waitForSelector('button[data-tab=folders].active');
      await mgr.click('#addF'); await mgr.fill('.modal input[name=name]', 'الحلقات'); await mgr.click('.modal button:has-text("حفظ")');
      await mgr.waitForSelector('h1:has-text("الحلقات")');
      folderId = Number(mgr.url().match(/folder\/(\d+)/)[1]);
      await mgr.click('#addP'); await mgr.waitForSelector('.modal input[name=name]');
      await mgr.fill('.modal input[name=name]', 'برنامج الحفظ المكثف');
      assert(await mgr.$eval('.modal select[name=folder_id]', e => e.value) === String(folderId), 'المجلد غير محدد في المشروع');
      await mgr.click('.modal button:has-text("حفظ")');
      await mgr.waitForSelector('.row:has-text("برنامج الحفظ المكثف")');
      projectId = (await apiAs(mgr, 'GET', '/api/projects?folder_id=' + folderId)).body[0].id;
      await mgr.click('#addT'); await mgr.click('.modal [data-k=task]'); await mgr.waitForSelector('.modal input[name=title]');
      await mgr.fill('.modal input[name=title]', 'تجهيز جدول حلقات الفصل');
      await mgr.click('.modal .seg label:has-text("ضمن مشروع")');
      await mgr.selectOption('.modal select[name=project_id]', String(projectId));
      await mgr.click('.modal button:has-text("حفظ")');
      await mgr.waitForSelector('h1:has-text("تجهيز جدول حلقات الفصل")');
      const t = (await apiAs(mgr, 'GET', '/api/items?kind=tasks&q=' + encodeURIComponent('تجهيز جدول حلقات'))).body[0];
      assert(t.folder_id === folderId && t.project_id === projectId, 'المهمة لم تُربط بالمجلد والمشروع');
      await mgr.goto(BASE + '/#/section/association'); await mgr.waitForSelector('.folder-card:has-text("الحلقات")');
      await mgr.goto(BASE + '/#/folder/' + folderId); await mgr.waitForSelector('#res .row:has-text("تجهيز جدول حلقات الفصل")');
    });

    await check('مجلد فرعي، تعديل مدير الشؤون التعليمية للمهمة، مهام فرعية، مهمة دورية، ومهام اليوم مع النسخ', async () => {
      // مجلد فرعي داخل «الحلقات»
      await mgr.goto(BASE + '/#/folder/' + folderId); await mgr.click('#addSub');
      await mgr.fill('.modal input[name=name]', 'حلقات المساء'); await mgr.click('.modal button:has-text("حفظ")');
      await mgr.waitForSelector('h1:has-text("حلقات المساء")');
      assert((await mgr.textContent('.crumbs')).includes('الحلقات'), 'مسار المجلد الفرعي لا يظهر المجلد الأب');
      // مدير الشؤون التعليمية يفتح مهمة ويعدّل أولويتها وموعدها ويجعلها دورية
      const t = (await apiAs(owner, 'GET', '/api/items?kind=tasks&q=' + encodeURIComponent('تجهيز جدول حلقات'))).body[0];
      const today = (await apiAs(owner, 'GET', '/api/meta')).body.today;
      await owner.goto(BASE + '/#/item/' + t.id); await owner.click('#editTop'); await owner.waitForSelector('.modal select[name=section]');
      await owner.click('.modal input[name=priority][value=urgent] + span');
      await owner.fill('.modal input[name=due_date]', today);
      await owner.click('.modal button:has-text("حفظ")'); await owner.waitForSelector('.modal-bg', { state: 'detached' });
      const e = (await apiAs(owner, 'GET', '/api/items/' + t.id)).body.item;
      assert(e.priority === 'urgent' && e.due_date === today && e.project_id === projectId, 'لم تُحفظ تعديلات مدير الشؤون التعليمية: ' + JSON.stringify([e.priority, e.due_date, e.project_id]));
      // تحويل مهمة أخرى إلى «دورية» من نموذج التعديل
      const r = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'مراجعة الحضور', section: 'association' })).body;
      await owner.goto(BASE + '/#/item/' + r.id); await owner.click('#editTop'); await owner.waitForSelector('.modal select[name=section]');
      await owner.click('.modal .seg label:has-text("دورية")'); await owner.selectOption('.modal select[name=recurrence]', 'monthly');
      await owner.click('.modal button:has-text("حفظ")'); await owner.waitForSelector('.modal-bg', { state: 'detached' });
      assert((await apiAs(owner, 'GET', '/api/items/' + r.id)).body.item.recurrence === 'monthly', 'لم تُحفظ المهمة كدورية');
      await owner.goto(BASE + '/#/item/' + t.id); await owner.waitForSelector('#subAdd');
      // مهام فرعية: مدير الشؤون التعليمية يضيف، ومدير المكتب يُنجز
      await owner.fill('#subAdd input[name=title]', 'حجز القاعة'); await owner.click('#subAdd button');
      await owner.waitForSelector('.subtask:has-text("حجز القاعة")');
      await mgr.goto(BASE + '/#/item/' + t.id); await mgr.waitForSelector('.subtask:has-text("حجز القاعة")');
      await mgr.check('.subtask:has-text("حجز القاعة") input[type=checkbox]'); await mgr.waitForSelector('.subtask.done:has-text("حجز القاعة")');
      // مهام اليوم: تظهر المهمة، وزر النسخ ينسخ نصًا فيه عنوانها
      await owner.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { });
      await owner.click('#btnToday'); await owner.waitForSelector('.modal .today-row:has-text("تجهيز جدول حلقات الفصل")');
      await owner.click('#copyToday'); await owner.waitForSelector('.toast:has-text("نُسخت")');
      const clip = await owner.evaluate(() => navigator.clipboard.readText()).catch(() => null);
      assert(clip === null || (clip.includes('مهام اليوم') && clip.includes('تجهيز جدول حلقات الفصل')), 'نص النسخ غير صحيح');
      await owner.click('.modal [data-close]');
    });

    await check('الإعدادات: إضافة مستخدم وربطه بمشروع', async () => {
      await mgr.goto(BASE + '/#/settings'); await mgr.waitForSelector('#addUser');
      await mgr.click('#addUser');
      await mgr.fill('.modal input[name=name]', 'سعد المشرف'); await mgr.fill('.modal input[name=username]', 'saad');
      await mgr.fill('.modal input[name=password]', 'Saad#2026x');
      await mgr.check(`.modal input[name=project_ids][value="${projectId}"]`);
      await mgr.click('.modal button:has-text("إضافة")');
      await mgr.waitForSelector('#usersAdmin .row:has-text("سعد المشرف") .chip:has-text("برنامج الحفظ المكثف")');
    });

    await check('عضو الفريق يرى مهام مشروعه فقط ويحدّثها، ويُبلَّغ مدير المكتب', async () => {
      const memCtx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-SA' });
      const mem = await memCtx.newPage(); mem.on('pageerror', e => consoleErrors.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 4).join(' | ')));
      await mem.goto(BASE); await mem.fill('input[name=username]', 'saad'); await mem.fill('input[name=password]', 'Saad#2026x');
      await mem.click('button:has-text("دخول")');
      // أول دخول: يُلزم الموظف بتغيير كلمة المرور التي أعطاه إياها المدير
      await mem.waitForSelector('#fpw');
      assert((await apiAs(mem, 'GET', '/api/items?kind=all')).status === 403, 'الخادم سمح بالاستخدام قبل تغيير كلمة المرور');
      await mem.fill('#fpw input[name=current]', 'Saad#2026x'); await mem.fill('#fpw input[name=next]', 'Saad#2026x'); await mem.fill('#fpw input[name=again]', 'Saad#2026x');
      await mem.click('#fpw button[type=submit]'); await mem.waitForSelector('#fpw .err-box:has-text("مختلفة")');
      await mem.fill('#fpw input[name=next]', 'SaadNew#2026'); await mem.fill('#fpw input[name=again]', 'SaadNew#2026');
      await mem.click('#fpw button[type=submit]'); await mem.waitForSelector('h2:has-text("مهامي المفتوحة")');
      assert(await mem.isVisible('.row:has-text("تجهيز جدول حلقات الفصل")'), 'لا يرى مهمة مشروعه');
      assert(!(await mem.isVisible(`.row:has-text("${TITLE}")`)), 'يرى مهمة لا تخصه');
      assert(!(await mem.isVisible('#btnAdd')), 'يظهر للعضو زر إنشاء');
      assert((await apiAs(mem, 'GET', `/api/items/${itemId}`)).status === 404, 'فتح مهمة لا تخصه');
      assert((await apiAs(mem, 'GET', '/api/approvals')).status === 403 && (await apiAs(mem, 'GET', '/api/reports')).status === 403 && (await apiAs(mem, 'GET', '/api/admin/users')).status === 403, 'وصول العضو لما لا يخصه');
      const all = (await apiAs(mem, 'GET', '/api/items?kind=all')).body;
      // مهمة المشروع فقط؛ ومهمتها الفرعية (ترث المشروع) تظهر تحتها لا كبند مستقل
      assert(all.length === 1 && all[0].title === 'تجهيز جدول حلقات الفصل' && all[0].project_id === projectId && all[0].subtasks_total === 1, 'قائمة المهام تكشف غير مهامه: ' + all.map(x => x.title).join('، '));
      const withSubs = (await apiAs(mem, 'GET', '/api/items?kind=all&subtasks=1')).body;
      assert(withSubs.length === 2 && withSubs.every(x => x.project_id === projectId) && withSubs.some(x => x.title === 'حجز القاعة'), 'المهمة الفرعية غير متاحة للعضو');
      await mem.click('.row a.title:has-text("تجهيز جدول حلقات الفصل")');
      await act(mem, '#acts button:has-text("بدء التنفيذ")'); await mem.waitForSelector('.item-head .chip.st-in_progress');
      await mem.fill('#cmp textarea[name=body]', 'جهزت مسودة الجدول وأرسلتها للمعلمين.'); await mem.click('#cmp button:has-text("إرسال")');
      await mem.waitForSelector('.msg:has-text("جهزت مسودة الجدول")');
      const n = (await apiAs(mgr, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.title.includes('سعد المشرف') && x.title.includes('تجهيز جدول حلقات')), 'لم يُبلَّغ المدير بتحديث العضو');
      await mem.screenshot({ path: path.join(SHOTS, '08-member-item-mobile.png'), fullPage: true });
      await memCtx.close();
    });

    await check('الموظف المنفّذ: يرى مهامه فقط، تعثّر بسبب، إنجاز مع الفرعيات، منع التعديل، تحديث الصلاحيات فورًا، والإيقاف يُخرجه', async () => {
      const meta = (await apiAs(mgr, 'GET', '/api/meta')).body; const today = meta.today;
      const mk = async (b) => { const r = await apiAs(mgr, 'POST', '/api/admin/users', { password: 'Staff#2026x', must_change_password: false, ...b }); assert(r.status === 200, 'تعذر إنشاء موظف: ' + JSON.stringify(r.body)); return r.body.id; };
      staff.exec = await mk({ name: 'منفّذ الاختبار', username: 'qa.exec', title: 'منسق ميداني', grants: { scope: 'own', perms: [] } });
      staff.coord = await mk({ name: 'منسّقة الاختبار', username: 'qa.coord', grants: { scope: 'sections', sections: ['dawah'], perms: ['task.create', 'subtask.create', 'item.edit', 'projects.manage'] } });
      staff.asst = await mk({ name: 'مساعد الاختبار', username: 'qa.asst', grants: { scope: 'all', perms: ['task.create', 'subtask.create', 'item.edit', 'meetings.view', 'partners.view'] } });
      const t = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'تجهيز قاعة الاجتماع الأسري', section: 'family', assignee_id: staff.exec, due_date: today, priority: 'important' })).body;
      for (const st of ['ترتيب المقاعد', 'تجهيز الضيافة']) await apiAs(mgr, 'POST', `/api/items/${t.id}/subtasks`, { title: st });
      const other = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'مهمة دعوية غير مسندة', section: 'dawah' })).body;
      const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ar-SA' });
      const ex = await ctx.newPage(); ex.on('pageerror', e => consoleErrors.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 4).join(' | ')));
      await ex.goto(BASE); await ex.fill('input[name=username]', 'qa.exec'); await ex.fill('input[name=password]', 'Staff#2026x'); await ex.click('button:has-text("دخول")');
      await ex.waitForSelector('h2:has-text("مهامي المفتوحة")');
      assert(await ex.isVisible('.row:has-text("تجهيز قاعة الاجتماع الأسري")') && !(await ex.isVisible('.row:has-text("مهمة دعوية غير مسندة")')), 'المنفّذ يرى غير مهامه');
      assert(!(await ex.isVisible('#btnAdd')), 'زر الإضافة ظاهر للمنفّذ');
      const n = (await apiAs(ex, 'GET', '/api/notifications')).body.filter(x => x.title.includes('أُسندت إليك'));
      assert(n.length === 1 && n[0].body.includes('من '), 'إشعار الإسناد ليس واحدًا وغنيًا: ' + n.length);
      await ex.goto(`${BASE}/#/item/${t.id}`); await ex.waitForSelector('#acts');
      assert(!(await ex.isVisible('#editTop')), 'زر تعديل التفاصيل ظاهر للمنفّذ');
      // متعثرة: نافذة بأسباب جاهزة
      await act(ex, '#acts [data-s=stalled]'); await ex.waitForSelector('.modal input[name=reason]');
      await ex.click('.modal label:has-text("نقص معلومات") input'); await ex.click('.modal button:has-text("حفظ")');
      await ex.waitForSelector('.item-head .chip.st-stalled'); await ex.waitForSelector('.sys:has-text("نقص معلومات")');
      // أنجزت: تنبيه الفرعيات المفتوحة و«إنجازها معها»
      await act(ex, '#acts [data-s=done]'); await ex.waitForSelector('.modal .warn-box:has-text("2 مهام فرعية")');
      await ex.fill('.modal textarea[name=body]', 'القاعة جاهزة بالكامل.'); await ex.click('.modal button:has-text("تم الإنجاز")');
      await ex.waitForSelector('.item-head .chip.st-done');
      const subs = (await apiAs(mgr, 'GET', `/api/items/${t.id}`)).body.subtasks;
      assert(subs.length === 2 && subs.every(s => s.status === 'done'), 'الفرعيات لم تُنجز مع الأم');
      // ممنوعات المنفّذ في الخادم
      assert((await apiAs(ex, 'PATCH', `/api/items/${t.id}`, { title: 'تغيير' })).status === 403, 'المنفّذ عدّل التفاصيل');
      assert((await apiAs(ex, 'POST', '/api/tasks', { title: 'x', section: 'family' })).status === 403, 'المنفّذ أنشأ مهمة');
      assert((await apiAs(ex, 'GET', `/api/items/${other.id}`)).status === 404, 'المنفّذ فتح مهمة لا تخصه');
      const csv = await ex.evaluate(async () => (await fetch('/api/items-export.csv?scope=')).text());
      assert(csv.includes('تجهيز قاعة الاجتماع الأسري') && !csv.includes('مهمة دعوية غير مسندة'), 'التصدير يكشف غير مهامه');
      // تغيير الصلاحيات يظهر فورًا دون إعادة تحميل
      await ex.goto(BASE + '/#/'); await ex.waitForSelector('h2:has-text("مهامي المفتوحة")');
      await apiAs(mgr, 'PATCH', `/api/admin/users/${staff.exec}`, { grants: { scope: 'own', perms: ['task.create'] } });
      await ex.waitForSelector('#btnAdd', { timeout: 8000 });
      // الإيقاف يُخرجه فورًا
      await apiAs(mgr, 'PATCH', `/api/admin/users/${staff.exec}`, { active: false });
      await ex.waitForSelector('#lf', { timeout: 8000 });
      assert((await apiAs(ex, 'GET', '/api/me')).status === 401, 'الجلسة بقيت بعد الإيقاف');
      await ctx.close();
    });

    await check('المنسّقة: قسمها فقط، مجلد ومهمة من «إضافة»، تأجيل الموعد، ومنع العمل خارج القسم', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ar-SA' });
      const co = await ctx.newPage(); co.on('pageerror', e => consoleErrors.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 4).join(' | ')));
      await co.goto(BASE); await co.fill('input[name=username]', 'qa.coord'); await co.fill('input[name=password]', 'Staff#2026x'); await co.click('button:has-text("دخول")');
      await co.waitForSelector('#sidenav');
      const secLinks = await co.$$eval('#sidenav a[href^="#/section/"]', as => as.map(a => a.getAttribute('href')));
      assert(secLinks.length === 1 && secLinks[0] === '#/section/dawah', 'الأقسام في القائمة: ' + secLinks.join(','));
      await co.goto(BASE + '/#/section/dawah'); await co.waitForSelector('main h1:has-text("المشاريع الدعوية")');
      assert(await co.isVisible('.row:has-text("مهمة دعوية غير مسندة")') || (await apiAs(co, 'GET', '/api/items?section=dawah')).body.some(i => i.title === 'مهمة دعوية غير مسندة'), 'لا ترى مهام قسمها');
      await co.click('#addF'); await co.fill('.modal input[name=name]', 'الدورات العلمية'); await co.click('.modal button:has-text("حفظ")');
      await co.waitForSelector('main h1:has-text("الدورات العلمية")');
      await co.click('#addT'); await co.click('.modal [data-k=task]'); await co.waitForSelector('.modal input[name=title]');
      const secOpts = await co.$$eval('.modal select[name=section] option', os => os.filter(o => o.value).map(o => o.value));
      assert(secOpts.length === 1 && secOpts[0] === 'dawah', 'النموذج يعرض أقسامًا خارج نطاقها: ' + secOpts.join(','));
      await co.fill('.modal input[name=title]', 'إعداد جدول الدورة الشتوية');
      assert(await co.$eval('.modal select[name=assignee_pick]', s => s.value) === String(staff.coord), 'المسؤول الافتراضي ليس المنشئة');
      await co.click('.modal button:has-text("حفظ")'); await co.waitForSelector('.item-head h1:has-text("إعداد جدول الدورة الشتوية")');
      const it = (await apiAs(co, 'GET', '/api/items?q=' + encodeURIComponent('إعداد جدول الدورة'))).body[0];
      assert(it.folder_name === 'الدورات العلمية' && it.assignee_id === staff.coord, 'المهمة لم تُحفظ في المجلد/للمنسقة');
      // تأجيل بنقرة
      await act(co, '#acts [data-a=postpone]'); await co.waitForSelector('.modal [data-pp]');
      await co.click('.modal [data-pp]:has-text("بعد أسبوع")'); await co.waitForSelector('.modal-bg', { state: 'detached' });
      const due = (await apiAs(co, 'GET', `/api/items/${it.id}`)).body.item.due_date;
      const today = (await apiAs(co, 'GET', '/api/meta')).body.today;
      assert(due && due > today, 'لم يُؤجل الموعد: ' + due);
      // ممنوعات خارج القسم
      const owners = (await apiAs(co, 'GET', '/api/users')).body; const mgrId = owners.find(u => u.role === 'manager').id;
      assert((await apiAs(co, 'POST', '/api/tasks', { title: 'x', section: 'family', assignee_id: mgrId })).status === 403, 'أنشأت مهمة لغيرها خارج قسمها');
      assert((await apiAs(co, 'PATCH', `/api/items/${it.id}`, { section: 'family' })).status === 403, 'نقلت مهمة خارج قسمها');
      assert((await apiAs(co, 'POST', '/api/folders', { section: 'family', name: 'x' })).status === 403, 'أنشأت مجلدًا خارج قسمها');
      assert((await apiAs(co, 'GET', '/api/approvals')).status === 403, 'رأت طلبات الاعتماد');
      await ctx.close();
    });

    await check('المساعد الإداري: كل المهام دون ملاحظات المالك، قرار اجتماع يُسند إليه بحساب، وحماية حسابي المالك والمدير', async () => {
      const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-SA' });
      const as = await ctx.newPage(); as.on('pageerror', e => consoleErrors.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 4).join(' | ')));
      await as.goto(BASE); await as.fill('input[name=username]', 'qa.asst'); await as.fill('input[name=password]', 'Staff#2026x'); await as.click('button:has-text("دخول")');
      await as.waitForSelector('.bottomnav');
      const note = (await apiAs(owner, 'POST', '/api/notes', { msg_type: 'info', description: 'ملاحظة خاصة لمدير المكتب فقط', section: 'family' })).body;
      const all = (await apiAs(as, 'GET', '/api/items?kind=all&scope=')).body;
      assert(new Set(all.map(i => i.section)).size >= 2 && !all.some(i => i.kind === 'note'), 'المساعد لا يرى كل المهام أو يرى الملاحظات');
      assert((await apiAs(as, 'GET', `/api/items/${note.id}`)).status === 404, 'المساعد فتح ملاحظة المالك');
      assert((await apiAs(as, 'GET', '/api/approvals')).status === 403 && (await apiAs(as, 'GET', '/api/meetings')).status === 200, 'صلاحيات الاعتماد/الاجتماعات غير صحيحة');
      // قرار اجتماع ← مهمة بحساب المساعد وموعد
      const m = (await apiAs(mgr, 'POST', '/api/meetings', { title: 'اجتماع المتابعة الأسبوعي', section: 'family', starts_at: (await apiAs(mgr, 'GET', '/api/meta')).body.today + 'T09:00' })).body;
      const d = (await apiAs(mgr, 'POST', `/api/meetings/${m.id}/decisions`, { text: 'تحديث سجل المراسلات الواردة', responsible: 'غير محدد' })).body;
      const task = (await apiAs(mgr, 'POST', `/api/decisions/${d.id}/task`, { section: 'family', assignee_id: staff.asst, due_date: '2026-12-31' })).body;
      assert(task.assignee_id === staff.asst && task.due_date === '2026-12-31', 'القرار لم يُسند بالحساب والموعد: ' + JSON.stringify({ m, d, task }).slice(0, 400));
      assert((await apiAs(as, 'GET', '/api/notifications')).body.some(x => x.title.includes('تحديث سجل المراسلات')), 'لم يصل المساعدَ إشعار المهمة');
      await as.goto(`${BASE}/#/item/${task.id}`); await as.waitForSelector('#editTop');
      // حماية حسابي المالك والمدير من بعضهما
      const users = (await apiAs(mgr, 'GET', '/api/users')).body; const ownerId = users.find(u => u.role === 'owner').id; const mgrId = users.find(u => u.role === 'manager').id;
      assert((await apiAs(mgr, 'PATCH', `/api/admin/users/${ownerId}`, { password: 'Hijack#2026x' })).status === 403, 'المدير غيّر كلمة مرور المالك');
      assert((await apiAs(owner, 'PATCH', `/api/admin/users/${mgrId}`, { email: 'x@example.test' })).status === 403, 'المالك عدّل حساب المدير');
      await ctx.close();
    });

    // فتح صفحة مع ضمان إعادة تحميل بياناتها (الانتقال إلى الرابط نفسه لا يعيد العرض)
    const openFresh = async (pg, h) => { await pg.goto(BASE + '/#/'); await pg.waitForTimeout(150); await pg.goto(BASE + '/' + h); };
    await check('سيناريو كامل: توجيه من المدير ← مهام ← تنفيذ المساعد ← مراجعة وإعادة للتعديل ← قرار المدير نيابةً ← إغلاق ← تقرير', async () => {
      const today = (await apiAs(mgr, 'GET', '/api/meta')).body.today;
      // 1) المدير يصدر توجيهًا (عبر المنصة) لمدير المكتب
      const d = (await apiAs(owner, 'POST', '/api/directives', { title: 'إعداد خطة الاختبارات النهائية للمدارس', section: 'personal', importance: 'important', due_date: '2026-12-20' })).body;
      assert(d.ref && d.channel === 'platform', 'لم يُسجل توجيه المدير: ' + JSON.stringify(d).slice(0, 200));
      assert((await apiAs(mgr, 'GET', '/api/notifications')).body.some(n => n.title.includes('توجيه جديد') && n.title.includes('خطة الاختبارات')), 'لم يُبلَّغ مدير المكتب بالتوجيه');
      // 2) مدير المكتب يحوّله إلى مهام من صفحة التوجيه، ويسند إحداها للمساعد بمخرج مطلوب
      await mgr.goto(`${BASE}/#/directive/${d.id}`); await mgr.waitForSelector('#addT');
      await mgr.click('#addT'); await mgr.waitForSelector('.modal input[name=title]');
      await mgr.fill('.modal input[name=title]', 'إعداد جدول الاختبارات');
      await mgr.fill('.modal input[name=deliverable]', 'جدول اختبارات معتمد بصيغة PDF');
      await mgr.selectOption('.modal select[name=assignee_pick]', String(staff.asst));
      await mgr.click('.modal button:has-text("حفظ")'); await mgr.waitForSelector('.item-head h1:has-text("إعداد جدول الاختبارات")');
      const t1 = (await apiAs(mgr, 'GET', `/api/directives/${d.id}`)).body.tasks.find(x => x.title === 'إعداد جدول الاختبارات');
      assert(t1 && t1.assignee_id === staff.asst && t1.deliverable && t1.priority === 'important', 'المهمة لم ترث التوجيه أو المسؤول أو المخرج');
      await apiAs(mgr, 'POST', '/api/tasks', { title: 'حجز قاعات الاختبار', section: 'personal', directive_id: d.id });
      // 3) المساعد ينفذ ويرفع المخرج
      const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-SA' }); const as = await ctx.newPage(); as.on('pageerror', e => consoleErrors.push(e.message));
      global.pages.asst = as;
      await as.goto(BASE); await as.fill('input[name=username]', 'qa.asst'); await as.fill('input[name=password]', 'Staff#2026x'); await as.click('button:has-text("دخول")'); await as.waitForSelector('.bottomnav');
      await as.goto(`${BASE}/#/item/${t1.id}`); await as.waitForSelector('#acts [data-s=done]', { state: 'attached' });
      await act(as, '#acts [data-s=done]'); await as.waitForSelector('.modal .info-box:has-text("جدول اختبارات معتمد")');
      await as.fill('.modal textarea[name=body]', 'أُعد الجدول وأرسلته للمدارس للمراجعة.'); await as.click('.modal button:has-text("تم الإنجاز")'); await as.waitForSelector('.item-head .chip.st-done');
      // 4) مدير المكتب يراجع ويعيده للتعديل بسبب، ثم يُنجز مجددًا
      await openFresh(mgr, `#/item/${t1.id}`); await mgr.waitForSelector('.item-head .chip.st-done'); await mgr.waitForSelector('#acts [data-s=in_progress]', { state: 'attached' });
      await act(mgr, '#acts [data-s=in_progress]'); await mgr.waitForSelector('.modal textarea[name=note]');
      await mgr.fill('.modal textarea[name=note]', 'أضف مواعيد اختبارات الإعادة.'); await mgr.click('.modal button:has-text("إعادة فتح")'); await mgr.waitForSelector('.item-head .chip.st-in_progress');
      assert((await apiAs(as, 'GET', '/api/notifications')).body.some(n => n.title.includes('إعداد جدول الاختبارات')), 'لم يُبلَّغ المساعد بإعادة المهمة');
      await apiAs(as, 'PATCH', `/api/items/${t1.id}`, { status: 'done' });
      // 5) رفع الأمر للمدير، والمدير يقرر بالواتس فيسجّله مدير المكتب نيابةً عنه
      const aid = (await apiAs(mgr, 'POST', `/api/items/${t1.id}/approvals`, { kind: 'report', title: 'اعتماد جدول الاختبارات', blocking: true })).body.id;
      await openFresh(mgr, `#/item/${t1.id}`); await mgr.waitForSelector(`[data-proxy="${aid}"]`);
      await mgr.click(`[data-proxy="${aid}"]`); await mgr.waitForSelector('.modal input[name=channel]');
      await mgr.click('.modal input[name=channel][value=whatsapp] + span'); await mgr.click('.modal button:has-text("تسجيل القرار")');
      await mgr.waitForSelector('.approval.decided-approved:has-text("ورد واتساب")');
      // 6) إنجاز المهمة الثانية، فيصبح التوجيه «بانتظار تسجيل النتيجة»، ثم يُغلق بنتيجة
      const t2 = (await apiAs(mgr, 'GET', `/api/directives/${d.id}`)).body.tasks.find(x => x.title === 'حجز قاعات الاختبار');
      await apiAs(mgr, 'PATCH', `/api/items/${t2.id}`, { status: 'done' });
      await apiAs(mgr, 'PATCH', `/api/items/${t1.id}`, { status: 'done' });
      assert((await apiAs(mgr, 'GET', `/api/directives/${d.id}`)).body.state === 'ready', 'التوجيه لم يصبح جاهزًا لتسجيل النتيجة');
      await openFresh(mgr, `#/directive/${d.id}`); await mgr.click('#closeDir'); await mgr.fill('.modal textarea[name=outcome]', 'اعتُمد جدول الاختبارات ووُزّع على 12 مدرسة.'); await mgr.click('.modal button:has-text("إغلاق التوجيه")');
      await mgr.waitForSelector('.info-box:has-text("النتيجة المتحققة")');
      // 7) يظهر في الإنجاز ولوحة القيادة
      const done = (await apiAs(mgr, 'GET', `/api/items?kind=tasks&scope=closed&status=done&done_since=${today}`)).body;
      assert(done.some(x => x.id === t1.id) && done.some(x => x.id === t2.id), 'المهام لا تظهر في المنجزة');
      const cmd = (await apiAs(owner, 'GET', '/api/command')).body;
      assert(cmd.kpis.done_week >= 2, 'لوحة القيادة لا تحسب الإنجاز');
      delete global.pages.asst; await ctx.close();
    });

    await check('حالات واقعية: تأخر، تعثر يحتاج المدير، اجتماع بخمسة قرارات، أعمال متعددة لشخص، تكليف عاجل، تغيير الأولوية والموعد، إلغاء مع حفظ السجل', async () => {
      const today = (await apiAs(mgr, 'GET', '/api/meta')).body.today;
      const minus = (n) => new Date(Date.parse(today + 'T12:00:00Z') - n * 864e5).toISOString().slice(0, 10);
      // تأخر مهمة: تظهر في المتأخرة، والتأجيل يطلب سبب التأخير
      const late = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'تسليم تقرير الحضور', section: 'personal', due_date: minus(2), assignee_id: staff.asst })).body;
      await mgr.goto(`${BASE}/#/item/${late.id}`); await act(mgr, '#acts [data-a=postpone]'); await mgr.waitForSelector('.modal [data-pp]');
      assert(await mgr.isVisible('.modal span:has-text("سبب التأخير *")'), 'التأجيل لا يطلب سبب التأخير');
      await mgr.click('.modal [data-pp]:has-text("غدًا")'); await mgr.waitForSelector('.toast.err:has-text("سبب التأخير")');
      await mgr.fill('.modal input[name=reason]', 'تأخر وصول البيانات من المدارس');
      { const st = await mgr.evaluate(() => [...document.querySelectorAll('.modal-bg')].map(m => (m.querySelector('h2') || {}).textContent + '=' + ((m.querySelector('[name=reason]') || {}).value || '')));
        assert(st.length === 1 && st[0].endsWith('تأخر وصول البيانات من المدارس'), 'لم يُكتب السبب في النافذة: ' + JSON.stringify(st)); }
      await mgr.click('.modal [data-pp]:has-text("غدًا")'); await mgr.waitForSelector('.modal-bg', { state: 'detached' });
      assert((await apiAs(mgr, 'GET', `/api/items/${late.id}`)).body.messages.some(m => m.body.includes('سبب التأخير')), 'سبب التأخير لم يُحفظ');
      // تعثر مشروع يحتاج تدخل المدير: يظهر في «تحتاج تدخلك»
      const st = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'توريد أجهزة المختبر', section: 'personal', priority: 'urgent', due_date: minus(5) })).body;
      await apiAs(mgr, 'PATCH', `/api/items/${st.id}`, { status: 'stalled', status_note: 'المورد لم يلتزم' });
      await owner.goto(`${BASE}/#/command`); await owner.waitForSelector('.card.attn');
      assert(await owner.isVisible('.card.attn .row:has-text("توريد أجهزة المختبر")'), 'المهمة المتعثرة لا تظهر في «تحتاج تدخلك»');
      // اجتماع نتجت عنه خمسة قرارات تتحول إلى مهام دفعة واحدة
      const m = (await apiAs(mgr, 'POST', '/api/meetings', { title: 'اجتماع لجنة الاختبارات', section: 'personal', starts_at: today + 'T10:00' })).body;
      await mgr.goto(`${BASE}/#/meeting/${m.id}`); await mgr.click('#addMany'); await mgr.waitForSelector('.modal textarea[name=text]');
      await mgr.fill('.modal textarea[name=text]', 'اعتماد مواعيد الاختبارات\nتشكيل لجان المراقبة\nطباعة الأسئلة\nتجهيز القاعات\nإبلاغ أولياء الأمور');
      await mgr.selectOption('.modal select[name=assignee_id]', String(staff.asst)); await mgr.click('.modal button:has-text("حفظ القرارات")');
      await mgr.waitForSelector('.card-h:has-text("القرارات الصادرة") .chip:has-text("5")');
      const mt = (await apiAs(mgr, 'GET', `/api/meetings/${m.id}`)).body.decisions;
      assert(mt.length === 5 && mt.every(x => x.task_id), 'القرارات الخمسة لم تتحول إلى مهام');
      // أعمال متعددة لشخص واحد: تظهر في توزيع العمل، والرابط يفتح قائمته
      await openFresh(owner, '#/command'); await owner.waitForSelector('.tbl');
      // اسم الشخص يفتح صفحته، ورقم «مفتوحة» يفتح قائمة مهامه
      const href = await owner.$eval('.tbl a:has-text("مساعد الاختبار")', a => a.getAttribute('href')); // الجدول يتحدث فوريًا فنفتح الرابط مباشرة
      assert(href === `#/person/${staff.asst}`, 'اسم الموظف لا يفتح صفحته: ' + href);
      const openHref = await owner.$eval('.tbl tr:has(a:has-text("مساعد الاختبار")) td:nth-child(2) a', a => a.getAttribute('href'));
      await owner.goto(BASE + '/' + openHref); await owner.waitForSelector('.crumbs:has-text("مهام مساعد الاختبار")');
      const mine = (await apiAs(owner, 'GET', `/api/items?kind=tasks&scope=open&assignee_id=${staff.asst}`)).body;
      assert(mine.length >= 6, 'توزيع العمل لا يعكس المهام المتعددة: ' + mine.length);
      // تكليف عاجل يحتاج تنفيذًا فوريًا
      const urg = (await apiAs(owner, 'POST', '/api/assignments', { title: 'الرد على خطاب الوزارة اليوم', section: 'personal', priority: 'urgent', due_date: today })).body;
      assert((await apiAs(mgr, 'GET', '/api/notifications')).body.some(n => n.urgent && n.title.includes('الرد على خطاب الوزارة')), 'التكليف العاجل لم يصل عاجلًا');
      assert((await apiAs(mgr, 'GET', '/api/home')).body.urgent_ribbon.some(i => i.id === urg.id), 'التكليف العاجل خارج شريط العاجل');
      // تغيير الأولوية والموعد يُسجَّل
      await apiAs(owner, 'PATCH', `/api/items/${late.id}`, { priority: 'urgent', due_date: today });
      const log = (await apiAs(mgr, 'GET', `/api/items/${late.id}`)).body.audit.map(a => a.field);
      assert(log.includes('priority') && log.includes('due_date'), 'تغيير الأولوية/الموعد غير مسجل');
      // إلغاء تكليف مع الاحتفاظ بسجله
      await apiAs(owner, 'PATCH', `/api/items/${urg.id}`, { status: 'cancelled' });
      const c = (await apiAs(owner, 'GET', `/api/items/${urg.id}`)).body;
      assert(c.item.status === 'cancelled' && c.audit.some(a => a.new_value === 'cancelled') && c.messages.length > 0, 'الإلغاء لم يحفظ السجل');
    });

    await check('البحث الشامل: من أي صفحة، بالاسم أو الرقم، ونتائج تُفتح مباشرة، و«فتحتها مؤخرًا»', async () => {
      await mgr.goto(BASE + '/#/meetings'); await mgr.waitForSelector('main h1');
      await mgr.click('#btnSearch'); await mgr.waitForSelector('#sq');
      // «فتحتها مؤخرًا» يتذكر المهمة التي فُتحت سابقًا في هذا الجهاز
      assert(await mgr.isVisible('.sr-group:has-text("فتحتها مؤخرًا")'), 'لا تظهر العناصر المفتوحة مؤخرًا');
      await mgr.fill('#sq', 'التقرير السنوي');
      await mgr.waitForSelector(`.sr-group:has-text("المهام") .sr-row:has-text("${TITLE}")`, { timeout: 8000 });
      await mgr.fill('#sq', 'الجمعية');
      await mgr.waitForSelector('.sr-group:has-text("الأقسام") .sr-row:has-text("الجمعية")');
      await mgr.fill('#sq', 'مساعد');
      await mgr.waitForSelector('.sr-group:has-text("الأشخاص") .sr-row:has-text("مساعد الاختبار")');
      await mgr.click('.sr-group:has-text("الأشخاص") .sr-row:has-text("مساعد الاختبار")');
      await mgr.waitForSelector('h1:has-text("مساعد الاختبار")');
      assert(!(await mgr.$('.modal-bg')), 'نافذة البحث بقيت مفتوحة بعد فتح النتيجة');
      // اختصار لوحة المفاتيح «/»
      await mgr.keyboard.press('/'); await mgr.waitForSelector('#sq'); await mgr.keyboard.press('Escape');
      // صلاحيات البحث: الموظف لا يرى أشخاصًا ولا مهامًا خارج نطاقه
      const memSearch = await (async () => { const c = await browser.newContext(); const pg = await c.newPage(); await pg.goto(BASE); await pg.fill('input[name=username]', 'qa.coord'); await pg.fill('input[name=password]', 'Staff#2026x'); await pg.click('button:has-text("دخول")'); await pg.waitForSelector('#main'); const r = await apiAs(pg, 'GET', '/api/search?q=' + encodeURIComponent('التقرير السنوي')); const r2 = await apiAs(pg, 'GET', '/api/search?q=' + encodeURIComponent('مساعد')); const r3 = await apiAs(pg, 'GET', '/api/people/' + staff.asst); await c.close(); return [r.body, r2.body, r3.status]; })();
      assert(!memSearch[0].groups.some(g => g.key === 'items'), 'الموظفة (قسم الدعوي) ترى مهمة من قسم الجمعية في البحث');
      assert(!memSearch[1].groups.some(g => g.key === 'people') && memSearch[2] === 403, 'الموظف يرى بيانات زملائه');
    });

    await check('السيناريو الرابع: من الرئيسية إلى القائمة والقسم والمهمة والموظف عبر الأرقام والروابط', async () => {
      await owner.goto(BASE + '/#/'); await owner.waitForSelector('.tiles');
      // رقم «مفتوحة» في مربع الجمعية يفتح مهامها المفتوحة مباشرة
      await owner.click('.tile-wrap:has(h3:has-text("الجمعية")) .st[data-go*="scope=open"]');
      await owner.waitForSelector('.crumbs:has-text("الجمعية — المفتوحة")');
      assert(owner.url().includes('section=association') && owner.url().includes('scope=open'), 'الرقم لم يفتح القائمة الصحيحة: ' + owner.url());
      await owner.waitForSelector('#res p.small'); // انتظار اكتمال تحميل القائمة (سطر عدد النتائج)
      const rows = await owner.$$eval('#res .row', r => r.length);
      const api = (await apiAs(owner, 'GET', '/api/items?kind=tasks&section=association&scope=open')).body.length;
      assert(rows === api && rows > 0, `عدد القائمة (${rows}) لا يطابق الرقم (${api})`);
      // اسم القسم في البطاقة يفتح صفحة القسم
      const sec = await owner.$('#res .row a.chip.link[href^="#/section/"]'); assert(sec, 'اسم القسم ليس رابطًا');
      // اسم المسؤول يفتح صفحة الموظف، وأرقامها تفتح قوائمها
      const t2 = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'مراجعة كشوف الحضور', section: 'association', assignee_id: staff.asst, due_date: (await apiAs(mgr, 'GET', '/api/meta')).body.today })).body;
      await owner.goto(`${BASE}/#/item/${t2.id}`); await owner.waitForSelector('.facts');
      await owner.click(`.facts a[href="#/person/${staff.asst}"]`); await owner.waitForSelector('h1:has-text("مساعد الاختبار")');
      await owner.click('.kpi:has-text("اليوم")'); await owner.waitForSelector('.crumbs:has-text("مهام مساعد الاختبار")');
      await owner.waitForSelector('#res .row a.title:has-text("مراجعة كشوف الحضور")');
      // من الرئيسية: بطاقة «تنتظر القرار» وبطاقات اللون تفتح وجهاتها
      await owner.goto(BASE + '/#/'); await owner.waitForSelector('.color-key');
      await owner.click('.color-key .ck.c-blue'); await owner.waitForSelector('#res');
      assert(owner.url().includes('color=blue'), 'بطاقة «مهام اليوم» لم تفتح القائمة المصفاة');
    });

    await check('فاحص الروابط: كل رابط داخلي في الصفحات الأساسية يفتح صفحة سليمة لكل دور (المدير، مدير المكتب، موظف)', async () => {
      const memCtx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-SA' }); const mem = await memCtx.newPage();
      mem.on('pageerror', e => consoleErrors.push('[member] ' + e.message));
      await mem.goto(BASE); await mem.fill('input[name=username]', 'qa.asst'); await mem.fill('input[name=password]', 'Staff#2026x'); await mem.click('button:has-text("دخول")'); await mem.waitForSelector('#main');
      const seeds = { owner: ['#/', '#/tasks', '#/approvals', '#/command', '#/dashboard', '#/directives', '#/meetings', '#/partners', '#/reports', '#/files', '#/more', `#/item/${itemId}`],
        mgr: ['#/', '#/tasks?scope=open', '#/command', '#/dashboard', '#/sops', '#/settings', '#/section/association', `#/person/${staff.asst}`],
        mem: ['#/', '#/tasks', '#/files', '#/more'] };
      const bad = []; let visited = 0;
      for (const [who, pg] of [['owner', owner], ['mgr', mgr], ['mem', mem]]) {
        const seen = new Set(); const queue = [...seeds[who]];
        // نمط واحد لكل نوع صفحة يكفي (item/5 و item/9 نفس الصفحة) مع حد أعلى للزيارات
        const pattern = (h) => h.replace(/\d+/g, 'N').replace(/label=[^&]*/, '');
        const patterns = new Map();
        while (queue.length && seen.size < 70) {
          const h = queue.shift(); if (seen.has(h)) continue; seen.add(h);
          await pg.goto(BASE + '/' + h);
          await pg.waitForFunction(() => { const m = document.querySelector('#main .view'); return m && !m.textContent.includes('جارٍ التحميل…'); }, null, { timeout: 10000 }).catch(() => bad.push(`${who} ${h}: لم تكتمل`));
          visited++;
          const state = await pg.evaluate(() => ({ text: (document.querySelector('#main') || {}).textContent || '', err: [...document.querySelectorAll('#main .err-box:not(.hidden)')].map(e => e.textContent.trim()).filter(Boolean), h1: !!document.querySelector('#main h1') }));
          if (state.text.includes('الصفحة غير موجودة')) bad.push(`${who} ${h}: صفحة غير موجودة`);
          if (state.err.length) bad.push(`${who} ${h}: ${state.err.join(' / ')}`);
          const links = await pg.$$eval('#main a[href^="#/"], .sidenav a[href^="#/"], .bottomnav a[href^="#/"]', a => a.map(x => x.getAttribute('href')));
          for (const l of links) { const k = pattern(l); if (!patterns.has(k) && !seen.has(l)) { patterns.set(k, l); queue.push(l); } }
        }
      }
      await memCtx.close();
      assert(!bad.length, 'روابط معطلة: ' + bad.join(' | '));
      assert(visited > 40, 'عدد الصفحات المفحوصة قليل: ' + visited);
      console.log(`   (فُحصت ${visited} صفحة عبر الأدوار الثلاثة)`);
    });

    await check('السيناريو الخامس: تحديث حالة مهمة من الجوال بخطوة واحدة دون خلل في التصميم', async () => {
      const t3 = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'متابعة خطاب الوزارة', section: 'personal' })).body;
      await owner.goto(`${BASE}/#/item/${t3.id}`); await owner.waitForSelector('.item-qs select');
      assert(await noHScroll(owner), 'تمرير أفقي في صفحة المهمة على الجوال');
      await owner.selectOption('.item-qs select', 'waiting_reply');
      await owner.waitForSelector('.modal textarea, .item-head .chip.st-waiting_reply', { timeout: 8000 });
      if (await owner.$('.modal textarea')) { await owner.fill('.modal textarea', 'بانتظار رد الوزارة'); await owner.click('.modal button[type=submit]'); }
      await owner.waitForSelector('.item-head .chip.st-waiting_reply');
      await owner.waitForSelector('.ribbon-note.c-gray');
      // يظهر لمدير المكتب على جهازه رماديًا «قيد المتابعة»
      const it = (await apiAs(mgr, 'GET', `/api/items/${t3.id}`)).body.item;
      assert(it.color === 'gray' && it.updated_by_name === 'مدير الشؤون التعليمية', 'الحالة أو «آخر تحديث بواسطة» غير صحيحة');
    });

    await check('الواجهة على الجوال والكمبيوتر: لا تمرير أفقي، والصفحات الأساسية تعمل', async () => {
      for (const [p, pages] of [[owner, ['#/', '#/my', '#/decisions', '#/notifications', '#/reports', '#/section/association', '#/meetings', '#/settings', '#/more']],
        [mgr, ['#/', '#/command', '#/directives', '#/files', '#/inbox', '#/dashboard', '#/tasks', '#/meetings', '#/sops', '#/partners', '#/reports', '#/settings', '#/section/partnerships']]]) {
        for (const h of pages) {
          await p.goto(BASE + '/' + h); await p.waitForSelector('main h1', { timeout: 8000 });
          assert(await noHScroll(p), `تمرير أفقي في ${h}`);
        }
      }
      // مقاس جوال لمدير المكتب أيضًا
      await mgr.setViewportSize({ width: 390, height: 844 });
      for (const h of ['#/', '#/command', '#/directives', '#/inbox', '#/dashboard', `#/item/${itemId}`]) { await mgr.goto(BASE + '/' + h); await mgr.waitForSelector('main h1'); assert(await noHScroll(mgr), `تمرير أفقي (جوال/مدير) في ${h}`); }
      await mgr.goto(BASE + '/#/'); await mgr.waitForSelector('.tiles');
      await mgr.screenshot({ path: path.join(SHOTS, '06-manager-home-mobile.png'), fullPage: true });
      await mgr.setViewportSize({ width: 1366, height: 900 });
      await mgr.goto(BASE + '/#/'); await mgr.waitForSelector('.tiles');
      const cols = await mgr.evaluate(() => getComputedStyle(document.querySelector('.tiles')).gridTemplateColumns.split(' ').length);
      assert(cols === 3, 'المربعات على الكمبيوتر ليست ثلاثة أعمدة: ' + cols);
      await mgr.screenshot({ path: path.join(SHOTS, '07-manager-home-desktop.png'), fullPage: true });
      // إيقاف حركة الأشرطة يدويًا ودعم إعداد تقليل الحركة
      await apiAs(mgr, 'POST', '/api/tasks', { title: 'مهمة اختبار الشريط 1', section: 'family', due_date: (await apiAs(mgr, 'GET', '/api/meta')).body.today });
      await apiAs(mgr, 'POST', '/api/tasks', { title: 'مهمة اختبار الشريط 2', section: 'family', due_date: (await apiAs(mgr, 'GET', '/api/meta')).body.today });
      await mgr.goto(BASE + '/#/'); await mgr.waitForSelector('.ribbon.follow [data-toggle]');
      assert(await mgr.evaluate(() => getComputedStyle(document.querySelector('.ribbon.follow .r-track')).animationName) === 'ticker', 'الشريط لا يتحرك');
      await mgr.click('.ribbon.follow [data-toggle]');
      assert(await mgr.evaluate(() => getComputedStyle(document.querySelector('.ribbon.follow .r-track')).animationPlayState) === 'paused', 'زر الإيقاف لا يعمل');
      await mgr.click('.ribbon.follow [data-toggle]');
      await mgr.emulateMedia({ reducedMotion: 'reduce' }); await mgr.reload(); await mgr.waitForSelector('.ribbon.follow .r-item');
      assert(await mgr.evaluate(() => getComputedStyle(document.querySelector('.ribbon.follow .r-track')).animationName) === 'none', 'لا يحترم تقليل الحركة');
      await mgr.click('.ribbon.follow .r-item:has-text("مهمة اختبار الشريط 1")');
      await mgr.waitForSelector('h1:has-text("مهمة اختبار الشريط 1")');
      assert(!consoleErrors.length, 'أخطاء JavaScript: ' + consoleErrors.join(' | '));
    });

    await check('حذف المهمة من قائمة الحالة: تأكيد، تختفي من القوائم والأعداد، وتُستعاد من «المحذوفات»', async () => {
      const meta = (await apiAs(mgr, 'GET', '/api/meta')).body;
      const t = (await apiAs(mgr, 'POST', '/api/tasks', { title: 'مهمة سُجّلت بالخطأ', section: 'family', due_date: meta.today })).body;
      await apiAs(mgr, 'POST', `/api/items/${t.id}/subtasks`, { title: 'خطوة تابعة لها' });
      const openBefore = (await apiAs(mgr, 'GET', '/api/home')).body.tiles.find(x => x.key === 'family').open;
      await mgr.goto(BASE + '/#/tasks?scope=open&section=family'); await mgr.waitForSelector(`#res .row:has(a.title:has-text("مهمة سُجّلت بالخطأ"))`);
      await mgr.selectOption(`#res .row:has(a.title:has-text("مهمة سُجّلت بالخطأ")) select.qs`, '__delete');
      await mgr.waitForSelector('.modal:has-text("حذف المهمة")');
      assert(await mgr.isVisible('.modal:has-text("ستُحذف معها")'), 'لا يذكر المهام الفرعية التي ستُحذف');
      await mgr.fill('.modal input[name=reason]', 'سُجّلت بالخطأ');
      await mgr.click('.modal button[type=submit]'); await mgr.waitForSelector('.modal-bg', { state: 'detached' });
      await mgr.waitForFunction(() => !document.querySelector('#res').textContent.includes('مهمة سُجّلت بالخطأ'), null, { timeout: 8000 });
      const openAfter = (await apiAs(mgr, 'GET', '/api/home')).body.tiles.find(x => x.key === 'family').open;
      assert(openAfter === openBefore - 2, `الأعداد لم تنقص: ${openBefore} ← ${openAfter}`);
      const srch = (await apiAs(mgr, 'GET', '/api/search?q=' + encodeURIComponent('سُجّلت بالخطأ'))).body;
      assert(!srch.groups.some(g => g.key === 'items'), 'المحذوفة تظهر في البحث');
      // الموظف لا يحذف ولا يرى المحذوفات
      const ex = (await apiAs(mgr, 'GET', '/api/admin/users')).body.find(u => u.username === 'qa.asst');
      assert(ex, 'الموظف غير موجود');
      // المحذوفات والاستعادة
      await mgr.goto(BASE + '/#/trash'); await mgr.waitForSelector('h1:has-text("المحذوفات")');
      await mgr.waitForSelector(`.row:has(a.title:has-text("مهمة سُجّلت بالخطأ"))`);
      assert(!(await mgr.isVisible('.row:has(a.title:has-text("خطوة تابعة لها"))')), 'الفرعية المحذوفة مع أمها تظهر منفصلة');
      await mgr.click(`.row:has(a.title:has-text("مهمة سُجّلت بالخطأ")) [data-restore]`);
      await mgr.waitForSelector('.empty:has-text("لا توجد مهام محذوفة"), .row', { timeout: 8000 });
      const it = (await apiAs(mgr, 'GET', `/api/items/${t.id}`)).body;
      assert(!it.item.deleted_at && it.subtasks.length === 1 && it.messages.some(m => m.body.includes('سُجّلت بالخطأ')), 'لم تُستعد كما كانت، أو لم يُسجَّل سبب الحذف');
      assert((await apiAs(mgr, 'GET', '/api/home')).body.tiles.find(x => x.key === 'family').open === openBefore, 'الأعداد لم تعد بعد الاستعادة');
    });

    await check('مهمة بالصوت: يتحدث المدير فتُنشأ المهمة بعنوانها وأولويتها وموعدها ووقتها ومسؤولها، ويُحفظ النص كما قيل', async () => {
      const c = await browser.newContext({ ...devices['iPhone 13'], locale: 'ar-SA', permissions: ['microphone'] });
      // محاكاة خدمة الكلام في الجهاز: تعيد الجملة المنطوقة على دفعتين (مؤقتة ثم نهائية) كما يفعل الجوال
      await c.addInitScript(() => {
        class FakeSR { constructor() { this.lang = ''; } start() { setTimeout(() => {
          const said = window.__said || 'عاجل، الرد على خطاب الإدارة العامة بخصوص خطة الفصل الثاني يوم الأحد الساعة عشرة صباحا، مساعد الاختبار، والمطلوب خطاب رد معتمد';
          const ev = (fin, txt) => ({ results: Object.assign([Object.assign([{ transcript: txt }], { isFinal: fin })], {}) });
          this.onresult && this.onresult(ev(false, said.slice(0, 20)));
          setTimeout(() => { this.onresult && this.onresult(ev(true, said)); this.onend && this.onend(); }, 150);
        }, 200); } stop() { this.onend && this.onend(); } }
        window.SpeechRecognition = FakeSR;
      });
      const pg = await c.newPage(); pg.on('pageerror', e => consoleErrors.push('[voice] ' + e.message));
      await pg.goto(BASE); await pg.fill('input[name=username]', 'owner'); await pg.fill('input[name=password]', 'Owner#2026x'); await pg.click('#lf button.primary');
      await pg.waitForSelector('#btnVoice'); await pg.click('#btnVoice');
      await pg.waitForFunction(() => (document.querySelector('#vtitle') || {}).value === 'الرد على خطاب الإدارة العامة بخصوص خطة الفصل الثاني', null, { timeout: 8000 });
      assert(await pg.isVisible('#vfound .chip'), 'لا يظهر ما فهمته المنصة');
      assert(await noHScroll(pg), 'تمرير أفقي في نافذة الصوت على الجوال');
      await pg.screenshot({ path: path.join(SHOTS, '09-voice-task-mobile.png') });
      await pg.click('.modal button[type=submit]');
      await pg.waitForSelector('h1:has-text("الرد على خطاب الإدارة العامة بخصوص خطة الفصل الثاني")');
      const id = Number(pg.url().match(/item\/(\d+)/)[1]);
      const it = (await apiAs(mgr, 'GET', `/api/items/${id}`)).body.item;
      const meta = (await apiAs(mgr, 'GET', '/api/meta')).body;
      const sunday = (() => { const d = new Date(meta.today + 'T12:00:00Z'); let k = (0 - d.getUTCDay() + 7) % 7; if (!k) k = 7; d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); })();
      assert(it.priority === 'urgent' && it.due_date === sunday && it.due_time === '10:00' && it.assignee_id === staff.asst && it.deliverable === 'خطاب رد معتمد' && it.source === 'owner',
        'تفاصيل المهمة غير صحيحة: ' + JSON.stringify({ p: it.priority, d: it.due_date, t: it.due_time, a: it.assignee_id, del: it.deliverable }));
      assert(String(it.description).includes('النص كما قيل'), 'لم يُحفظ النص الأصلي');
      // جملة قصيرة ناقصة: تظهر أسئلة سريعة لما لم يُذكر، ويُجاب عنها بضغطات
      await pg.evaluate(() => { window.__said = 'متابعة توقيع عقد التدريب'; });
      await pg.click('#btnVoice');
      await pg.waitForFunction(() => (document.querySelector('#vtitle') || {}).value === 'متابعة توقيع عقد التدريب', null, { timeout: 8000 });
      await pg.waitForSelector('#vq .vq-row[data-q=assignee]');
      for (const k of ['section', 'assignee', 'date', 'priority']) assert(await pg.$(`#vq .vq-row[data-q=${k}]`), 'لم يظهر سؤال: ' + k);
      await pg.click('#vq .vq-row[data-q=section] .vq-btn:has-text("الجمعية")');
      await pg.click('#vq .vq-row[data-q=assignee] .vq-btn:has-text("مساعد الاختبار")');
      await pg.click('#vq .vq-row[data-q=date] .vq-btn:has-text("غدًا")');
      await pg.click('#vq .vq-row[data-q=priority] .vq-btn:has-text("مهمة")');
      if (await pg.$('#vq .vq-row[data-q=place]')) await pg.click('#vq .vq-row[data-q=place] .vq-btn:has-text("مهمة مستقلة")');
      await pg.waitForSelector('#vq .vq-done');
      await pg.screenshot({ path: path.join(SHOTS, '10-voice-questions-mobile.png') });
      await pg.click('.modal button[type=submit]');
      await pg.waitForSelector('h1:has-text("متابعة توقيع عقد التدريب")');
      const it2 = (await apiAs(mgr, 'GET', `/api/items/${Number(pg.url().match(/item\/(\d+)/)[1])}`)).body.item;
      const tomorrow = (() => { const d = new Date(meta.today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
      assert(it2.section === 'association' && it2.assignee_id === staff.asst && it2.due_date === tomorrow && it2.priority === 'important', 'إجابات الأسئلة لم تُحفظ: ' + JSON.stringify({ s: it2.section, a: it2.assignee_id, d: it2.due_date, p: it2.priority }));
      // مدير المكتب يُبلَّغ بالمهمة الجديدة
      const n = (await apiAs(mgr, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.title.includes('الرد على خطاب الإدارة العامة')), 'لم يُبلَّغ مدير المكتب');
      await c.close();
    });

    await check('إعادة تعيين كلمة المرور من المنصة: مؤقتة من الشريك، رابط البريد، ورمز الاستعادة', async () => {
      const users = (await apiAs(mgr, 'GET', '/api/admin/users')).body; const ownerId = users.find(u => u.username === 'owner').id;
      // (1) مدير المكتب يُصدر كلمة مؤقتة للمدير: يُطلب تأكيد كلمة مروره هو أولًا
      await mgr.goto(BASE + '/#/settings'); await mgr.waitForSelector(`[data-reset-pw="${ownerId}"]`);
      await mgr.click(`[data-reset-pw="${ownerId}"]`); await mgr.waitForSelector('.modal input[name=my_password]');
      await mgr.fill('.modal input[name=my_password]', 'wrong-password'); await mgr.click('.modal button[type=submit]');
      await mgr.waitForSelector('.modal .err-box:not(.hidden)');
      await mgr.fill('.modal input[name=my_password]', 'Manager#2026x'); await mgr.click('.modal button[type=submit]');
      await mgr.waitForSelector('#tpw');
      const temp = (await mgr.textContent('#tpw')).trim();
      assert(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(temp), 'كلمة مؤقتة غير صالحة: ' + temp);
      await mgr.click('.modal [data-close]');
      // جلسة المدير على جواله تنتهي فورًا، ويدخل بالمؤقتة فتُطلب منه كلمة جديدة
      // الجلسة القديمة لم تعد صالحة: أي فتح للمنصة يعيده لصفحة الدخول
      await owner.reload(); await owner.waitForSelector('#lf', { timeout: 10000 });
      assert((await apiAs(owner, 'GET', '/api/me')).status === 401, 'الجلسة القديمة ما زالت صالحة بعد إعادة التعيين');
      await owner.fill('input[name=username]', 'owner'); await owner.fill('input[name=password]', temp); await owner.click('#lf button.primary');
      await owner.waitForSelector('#fpw');
      await owner.fill('#fpw input[name=current]', temp); await owner.fill('#fpw input[name=next]', 'Owner#2026y'); await owner.fill('#fpw input[name=again]', 'Owner#2026y');
      await owner.click('#fpw button[type=submit]'); await owner.waitForSelector('#main .view');
      const on = (await apiAs(owner, 'GET', '/api/notifications')).body;
      assert(on.some(n => n.title.includes('أُعيد تعيين كلمة مرورك') && n.body.includes('مدير المكتب')), 'لم يُبلَّغ صاحب الحساب');
      // (2) «نسيت كلمة المرور؟» برابط على البريد — لمرة واحدة
      const c = await browser.newContext({ ...devices['iPhone 13'], locale: 'ar-SA' }); const pg = await c.newPage();
      pg.on('pageerror', e => consoleErrors.push('[forgot] ' + e.message)); await pg.goto(BASE); await pg.waitForSelector('#forgot'); await pg.click('#forgot');
      await pg.waitForSelector('.modal input[name=username]'); await pg.fill('.modal input[name=username]', 'manager');
      const before = mails.length; await pg.click('.modal button[type=submit]'); await pg.waitForSelector('.modal-bg', { state: 'detached' });
      await new Promise(r => setTimeout(r, 1500));
      const mail = mails.slice(before).find(m => String(m.to).includes('manager@example.test') && m.subject.includes('إعادة تعيين'));
      assert(mail, 'لم يصل رابط إعادة التعيين بالبريد');
      const token = (String(mail.text).match(/#\/reset\/([\w-]+)/) || [])[1]; assert(token, 'لا رابط في الرسالة');
      await pg.goto(BASE + '/#/reset/' + token); await pg.waitForSelector('#rf');
      await pg.fill('#rf input[name=password]', 'Manager#2026y'); await pg.fill('#rf input[name=again]', 'Manager#2026y'); await pg.click('#rf button.primary');
      await pg.waitForSelector('#lf');
      await pg.fill('input[name=username]', 'manager'); await pg.fill('input[name=password]', 'Manager#2026y'); await pg.click('#lf button.primary');
      await pg.waitForSelector('#main .view');
      const reuse = await pg.evaluate(async (t) => (await fetch('/api/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ token: t, password: 'Another#2026' }) })).status, token);
      assert(reuse === 400, 'الرابط يعمل مرة ثانية');
      // الرد واحد لاسم غير موجود (لا يكشف وجود الحساب)
      const ghost = await pg.evaluate(async () => (await fetch('/api/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'no.such.user' }) })).status);
      assert(ghost === 200, 'الرد يكشف أن الحساب غير موجود');
      await c.close();
      // (3) رمز الاستعادة (طوارئ): لحسابي المدير ومدير المكتب فقط
      const post = (b) => fetch(BASE + '/api/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) }).then(r => r.status);
      assert(await post({ username: 'owner', recovery_code: 'wrong-code-0000', password: 'Owner#2026x' }) === 400, 'رمز خاطئ قُبل');
      assert(await post({ username: 'qa.asst', recovery_code: 'Recovery-Code-2026', password: 'Hijack#2026x' }) === 400, 'رمز الاستعادة غيّر كلمة مرور موظف');
      assert(await post({ username: 'owner', recovery_code: 'Recovery-Code-2026', password: 'Owner#2026x' }) === 200, 'رمز الاستعادة الصحيح لم يعمل');
      const lr = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'owner', password: 'Owner#2026x' }) });
      assert(lr.status === 200, 'الدخول بعد الاستعادة لم ينجح');
      assert(!consoleErrors.length, 'أخطاء JavaScript: ' + consoleErrors.join(' | '));
    });
  } catch (e) {
    if (global.serverLog) { await new Promise(r => setTimeout(r, 1500)); console.log('--- سجل الخادم (بدون أسطر الطلبات العادية) ---\n' + global.serverLog().split('\n').filter(l => !/wrangler:info\] (GET|POST|PUT|PATCH) .* (200|101|304)/.test(l) && !/Request.cf|undici|DOMException|processTicks|Request was cancelled/.test(l)).join('\n').slice(-3500)); }
  } finally {
    await browser.close(); await stopServer(); pushSrv.close(); mailSrv.close();
    const failed = results.filter(r => !r[2].startsWith('نجح'));
    const md = `# نتائج اختبار السيناريو الإلزامي — ${TARGET === 'node' ? 'Node' : 'Cloudflare (workerd محليًا)'}\n\nتاريخ التشغيل: ${new Date().toISOString()}\n\n| # | الخطوة | النتيجة |\n|---|---|---|\n${results.map(r => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n')}\n\nالحالة العامة: ${failed.length || results.length < 37 ? 'فشل' : 'نجاح كامل'} (${results.length - failed.length}/${results.length})\n`;
    fs.writeFileSync(path.join(ROOT, 'tests', TARGET === 'node' ? 'RESULTS.md' : 'RESULTS-cloudflare.md'), md);
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n${results.length - failed.length}/${results.length} نجحت`);
    process.exit(failed.length || results.length < 26 ? 1 : 0);
  }
})();
