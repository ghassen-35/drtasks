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
    OWNER_PASSWORD: 'Owner#2026x', MANAGER_PASSWORD: 'Manager#2026x', SEED_DATA: '0', OWNER_EMAIL: 'owner@example.test', MANAGER_EMAIL: 'manager@example.test',
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
    await mgr.goto(BASE + '/#/inbox'); await mgr.waitForSelector('h1:has-text("الوارد من مدير الشؤون التعليمية")');

    await check('يرسل مدير الشؤون التعليمية تكليفًا يتعلق بالجمعية (مع مرفق)', async () => {
      await owner.click('#btnAdd'); await owner.click('.modal [data-k=task]'); await owner.waitForSelector('.modal input[name=title]');
      await owner.fill('.modal input[name=title]', TITLE);
      await owner.fill('.modal textarea[name=description]', 'أرجو إعداد التقرير السنوي متضمنًا الأرقام والإنجازات، ورفعه لي للاعتماد.');
      await owner.click('.modal .seg label:has-text("الجمعية")');
      await owner.click('.modal .seg label:has-text("مهم")');
      const f = path.join(DATA, 'brief.txt'); fs.writeFileSync(f, 'ملف توضيحي للتكليف');
      await owner.setInputFiles('.modal input[type=file]', f);
      await owner.waitForSelector('.modal .files .file');
      await owner.click('.modal button:has-text("إرسال إلى مدير المكتب")');
      await owner.waitForSelector(`h1:has-text("${TITLE}")`);
      itemId = Number(owner.url().match(/item\/(\d+)/)[1]);
      ref = await owner.textContent('.item-head .ref');
      assert(/^TK-\d{4}-\d{4}$/.test(ref.trim()), 'رقم مرجعي غير صالح: ' + ref);
      assert(await owner.isVisible('text=لم يُؤكد الاستلام بعد'), 'حالة الاستلام غير ظاهرة');
    });

    await check('يظهر التكليف في صندوق الوارد لدى مدير المكتب (فوريًا دون إعادة تحميل)', async () => {
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

    await check('يؤكد مدير المكتب الاستلام', async () => {
      await mgr.click(`.row:has(a.title:has-text("${TITLE}")) button:has-text("تأكيد الاستلام")`);
      await mgr.waitForSelector('.toast.ok');
    });

    await check('يرى مدير الشؤون التعليمية تأكيد الاستلام (فوريًا) ويصله إشعار', async () => {
      await owner.waitForSelector('.chip.st-acknowledged', { timeout: 8000 });
      const n = (await apiAs(owner, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.type === 'acknowledged'), 'لا يوجد إشعار تأكيد الاستلام');
    });

    await check('يحوّل مدير المكتب التكليف إلى مهمة في قسم الجمعية دون تكرار', async () => {
      await mgr.goto(`${BASE}/#/item/${itemId}`); await mgr.waitForSelector('#acts button:has-text("تحويل إلى مهمة")', { state: 'attached' });
      await act(mgr, '#acts button:has-text("تحويل إلى مهمة")');
      await mgr.waitForSelector('.modal select[name=section]');
      await mgr.fill('.modal input[name=next_step]', 'جمع بيانات البرامج من المشرفين');
      await mgr.fill('.modal input[name=due_date]', new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10));
      await mgr.check('.modal input[name=requires_approval]');
      await mgr.click('.modal button:has-text("تحويل إلى مهمة")');
      await mgr.waitForSelector('.modal-bg', { state: 'detached' });
      await mgr.waitForSelector('.chip.kind:has-text("مهمة")');
      const list = (await apiAs(mgr, 'GET', '/api/items?kind=all&q=' + encodeURIComponent(TITLE))).body;
      assert(Array.isArray(list) && list.length === 1, 'يوجد تكرار أو خطأ: ' + JSON.stringify(list).slice(0, 200));
      assert(list[0].kind === 'task' && list[0].ref === ref.trim() && list[0].section === 'association', 'التحويل لم يحافظ على السجل');
    });

    await check('يبدأ التنفيذ ويضيف تحديثًا', async () => {
      await act(mgr, '#acts button:has-text("بدء/استئناف التنفيذ")');
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
      await act(mgr, '#acts button:has-text("طلب اعتماد")');
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
      await act(mgr, '#acts button:has-text("طلب اعتماد")');
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
      // الصلاحيات مطبقة في الخادم: مدير الشؤون التعليمية لا يستطيع تغيير الحالة أو تأكيد الاستلام
      assert((await apiAs(owner, 'PATCH', `/api/items/${itemId}`, { status: 'done' })).status === 403, 'مدير الشؤون التعليمية غيّر الحالة');
      assert((await apiAs(owner, 'POST', `/api/items/${itemId}/ack`)).status === 403, 'مدير الشؤون التعليمية أكّد الاستلام');
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
      await act(mgr, '#acts button:has-text("رفع النتيجة النهائية")');
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
      assert(d.item.original_text.includes('أرجو إعداد التقرير السنوي'), 'النص الأصلي مفقود');
      assert(d.approvals.length === 3 && d.approvals.filter(a => a.decided_by).length === 3, 'القرارات غير محفوظة');
      assert(d.audit.some(a => a.action === 'acknowledged') && d.audit.some(a => a.action === 'converted') && d.audit.some(a => a.action === 'closed'), 'سجل التغييرات ناقص');
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
      assert(!(await owner.isVisible('#add')), 'زر إنشاء اجتماع ظاهر لمدير الشؤون التعليمية');
    });

    await check('زر (+) في مربع القسم يفتح تكليفًا جديدًا والقسم محدد مسبقًا', async () => {
      await owner.goto(BASE + '/#/'); await owner.waitForSelector('.tiles');
      await owner.click('button.tile-add[data-add-section="family"]');
      await owner.waitForSelector('.modal input[name=title]');
      assert(await owner.isChecked('.modal input[name=section][value=family]'), 'القسم غير محدد مسبقًا');
      await owner.fill('.modal input[name=title]', 'حجز موعد عائلي من زر المربع');
      await owner.click('.modal button:has-text("إرسال إلى مدير المكتب")');
      await owner.waitForSelector('h1:has-text("حجز موعد عائلي من زر المربع")');
      const it = (await apiAs(owner, 'GET', '/api/items?kind=all&q=' + encodeURIComponent('حجز موعد عائلي'))).body;
      assert(it.length === 1 && it[0].section === 'family' && it[0].kind === 'assignment', 'التكليف لم يُنشأ في القسم الصحيح');
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
      const href = await owner.$eval('.tbl a:has-text("مساعد الاختبار")', a => a.getAttribute('href')); // الجدول يتحدث فوريًا فنفتح الرابط مباشرة
      await owner.goto(BASE + '/' + href); await owner.waitForSelector('.crumbs:has-text("مهام مساعد الاختبار")');
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
  } catch (e) {
    if (global.serverLog) { await new Promise(r => setTimeout(r, 1500)); console.log('--- سجل الخادم (بدون أسطر الطلبات العادية) ---\n' + global.serverLog().split('\n').filter(l => !/wrangler:info\] (GET|POST|PUT|PATCH) .* (200|101|304)/.test(l) && !/Request.cf|undici|DOMException|processTicks|Request was cancelled/.test(l)).join('\n').slice(-3500)); }
  } finally {
    await browser.close(); await stopServer(); pushSrv.close(); mailSrv.close();
    const failed = results.filter(r => !r[2].startsWith('نجح'));
    const md = `# نتائج اختبار السيناريو الإلزامي — ${TARGET === 'node' ? 'Node' : 'Cloudflare (workerd محليًا)'}\n\nتاريخ التشغيل: ${new Date().toISOString()}\n\n| # | الخطوة | النتيجة |\n|---|---|---|\n${results.map(r => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n')}\n\nالحالة العامة: ${failed.length || results.length < 32 ? 'فشل' : 'نجاح كامل'} (${results.length - failed.length}/${results.length})\n`;
    fs.writeFileSync(path.join(ROOT, 'tests', TARGET === 'node' ? 'RESULTS.md' : 'RESULTS-cloudflare.md'), md);
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n${results.length - failed.length}/${results.length} نجحت`);
    process.exit(failed.length || results.length < 26 ? 1 : 0);
  }
})();
