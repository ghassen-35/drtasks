'use strict';
/**
 * سيناريو الاختبار الإلزامي (17) — اختبار فعلي عبر متصفح حقيقي (Chromium) لحسابين في نفس الوقت:
 * رجل الأعمال على مقاس جوال، ومدير المكتب على مقاس كمبيوتر، مع خادم وقاعدة بيانات جديدة.
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
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const TARGET = process.env.E2E_TARGET === 'cf' ? 'cloudflare' : 'node';
const SHOTS = path.join(ROOT, 'tests', 'screenshots', TARGET);
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let step = 0;
async function check(name, fn) {
  step++;
  try { await fn(); results.push([step, name, 'نجح']); console.log(`✔ ${step}. ${name}`); }
  catch (e) { results.push([step, name, 'فشل: ' + e.message]); console.log(`✘ ${step}. ${name}\n   ${e.message}`); throw e; }
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
    OWNER_PASSWORD: 'Owner#2026x', MANAGER_PASSWORD: 'Manager#2026x', OWNER_EMAIL: 'owner@example.test', MANAGER_EMAIL: 'manager@example.test',
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
const stopServer = () => new Promise(r => { server.removeAllListeners('exit'); server.on('exit', r); server.kill(); setTimeout(() => { try { process.kill(server.pid, 'SIGKILL'); } catch { /* انتهى */ } }, 8000).unref(); });
async function apiAs(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, url, body]);
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
  for (const p of [owner, mgr]) p.on('pageerror', e => consoleErrors.push(e.message));
  const TITLE = 'إعداد التقرير السنوي لبرامج الجمعية';
  let itemId, ref, tileBefore;

  try {
    await check('يسجل رجل الأعمال الدخول (جوال)', async () => {
      await login(owner, 'owner', 'Owner#2026x');
      assert(await owner.isVisible('text=تكليف جديد'), 'زر التكليف غير ظاهر');
      const order = await owner.$$eval('main .ribbon', rs => rs.map(r => r.classList.contains('red') ? 'red' : 'orange'));
      assert(order.join() === 'red,orange', 'ترتيب الأشرطة: العاجلة يجب أن تكون أولًا — ' + order.join());
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
    await mgr.goto(BASE + '/#/inbox'); await mgr.waitForSelector('h1:has-text("الوارد من رجل الأعمال")');

    await check('يرسل رجل الأعمال تكليفًا يتعلق بالجمعية (مع مرفق)', async () => {
      await owner.click('#btnAssign');
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

    await check('يرى رجل الأعمال تأكيد الاستلام (فوريًا) ويصله إشعار', async () => {
      await owner.waitForSelector('.chip.st-acknowledged', { timeout: 8000 });
      const n = (await apiAs(owner, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.type === 'acknowledged'), 'لا يوجد إشعار تأكيد الاستلام');
    });

    await check('يحوّل مدير المكتب التكليف إلى مهمة في قسم الجمعية دون تكرار', async () => {
      await mgr.goto(`${BASE}/#/item/${itemId}`); await mgr.waitForSelector('#acts button:has-text("تحويل إلى مهمة")');
      await mgr.click('#acts button:has-text("تحويل إلى مهمة")');
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
      await mgr.click('#acts button:has-text("بدء/استئناف التنفيذ")');
      await mgr.waitForSelector('.item-head .chip.st-in_progress');
      await mgr.fill('#cmp textarea[name=body]', 'تم جمع بيانات 4 برامج من أصل 6، والعمل جارٍ على البقية.');
      await mgr.click('#cmp button:has-text("إرسال")');
      await mgr.waitForSelector('.msg.update:has-text("تم جمع بيانات 4 برامج")');
    });

    await check('يتلقى رجل الأعمال إشعارًا بالتحديث ويراه في المهمة', async () => {
      await owner.waitForSelector('.msg.update:has-text("تم جمع بيانات 4 برامج")', { timeout: 8000 });
      const n = (await apiAs(owner, 'GET', '/api/notifications')).body;
      assert(n.some(x => x.type === 'new_message' && x.title.includes('تحديث من مدير المكتب')), 'لا يوجد إشعار تحديث');
      assert(n.some(x => x.type === 'status_change'), 'لا يوجد إشعار تغيير حالة');
    });

    await check('يرسل رجل الأعمال ملاحظة على المهمة', async () => {
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
      await mgr.click('#acts button:has-text("طلب اعتماد")');
      await mgr.selectOption('.modal select[name=kind]', 'report');
      await mgr.fill('.modal input[name=title]', 'مسودة التقرير السنوي للجمعية');
      await mgr.fill('.modal textarea[name=body]', 'مرفق المسودة الأولى مع المقارنة بالعام الماضي.');
      const f = path.join(DATA, 'report.txt'); fs.writeFileSync(f, 'مسودة التقرير');
      await mgr.setInputFiles('.modal input[type=file]', f); await mgr.waitForSelector('.modal .files .file');
      await mgr.click('.modal button:has-text("إرسال الطلب")');
      await mgr.waitForSelector('.approval:has-text("مسودة التقرير السنوي للجمعية")');
      await mgr.waitForSelector('.item-head .chip.st-waiting_approval');
    });

    await check('تظهر المهمة في «بانتظار قراري» لدى رجل الأعمال', async () => {
      await owner.goto(`${BASE}/#/decisions`);
      await owner.waitForSelector('.row:has-text("مسودة التقرير السنوي للجمعية")');
      await owner.screenshot({ path: path.join(SHOTS, '03-owner-decisions-mobile.png'), fullPage: true });
      const home = (await apiAs(owner, 'GET', '/api/home')).body;
      assert(home.urgent_ribbon.some(i => i.id === itemId), 'لم تظهر في شريط العاجلة رغم أن القرار يعطل التنفيذ');
    });

    await check('يطلب رجل الأعمال تعديل التقرير (برفض مسبّب) ثم يعتمد النسخة المعدلة', async () => {
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

    await check('يستكمل مدير المكتب العمل ويعيد الطلب فيعتمده رجل الأعمال', async () => {
      await mgr.fill('#cmp textarea[name=body]', 'أُضيف قسم المستفيدين.'); await mgr.click('#cmp button:has-text("إرسال")');
      await mgr.waitForSelector('.msg:has-text("أُضيف قسم المستفيدين")');
      await mgr.click('#acts button:has-text("طلب اعتماد")');
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
      // الصلاحيات مطبقة في الخادم: رجل الأعمال لا يستطيع تغيير الحالة أو تأكيد الاستلام
      assert((await apiAs(owner, 'PATCH', `/api/items/${itemId}`, { status: 'done' })).status === 403, 'رجل الأعمال غيّر الحالة');
      assert((await apiAs(owner, 'POST', `/api/items/${itemId}/ack`)).status === 403, 'رجل الأعمال أكّد الاستلام');
      assert((await apiAs(mgr, 'POST', `/api/approvals/1/decide`, { decision: 'approved' })).status === 403, 'مدير المكتب اتخذ قرارًا');
      assert((await apiAs(owner, 'POST', `/api/items/${itemId}/approvals`, { kind: 'report', title: 'x' })).status === 403, 'رجل الأعمال طلب اعتمادًا');
      // حد المحاولات لكل مستخدم يصمد أمام تزوير عنوان IP عبر X-Forwarded-For
      let last = 0;
      for (let k = 0; k < 31; k++) {
        last = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.${k}.1` }, body: JSON.stringify({ username: 'ghost', password: 'wrong' }) })).status;
      }
      assert(last === 429, 'لم يُفعَّل حد المحاولات لكل مستخدم: ' + last);
      assert((await apiAs(mgr, 'POST', '/api/assignments', { title: 'x', section: 'family' })).status === 403, 'مدير المكتب أنشأ تكليفًا باسم رجل الأعمال');
      // حماية CSRF وتسجيل الدخول
      const csrf = await owner.evaluate(async () => (await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
      assert(csrf === 403, 'طلب بلا ترويسة الحماية قُبل');
      const anon = await (await fetch(BASE + '/api/items')).status;
      assert(anon === 401, 'وصول دون تسجيل دخول');
    });

    await check('يرفع مدير المكتب النتيجة النهائية ويعتمدها رجل الأعمال ثم تُغلق', async () => {
      await mgr.click('#acts button:has-text("رفع النتيجة النهائية")');
      await mgr.fill('.modal textarea[name=body]', 'التقرير السنوي النهائي جاهز ومرفق.');
      await mgr.click('.modal button:has-text("رفع النتيجة وطلب الاعتماد")');
      await mgr.waitForSelector('.approval:has-text("اعتماد النتيجة النهائية")');
      await owner.waitForSelector('form.decide', { timeout: 8000 });
      await owner.click('form.decide button:has-text("اعتماد")');
      await owner.waitForSelector('.item-head .chip.st-done', { timeout: 8000 });
      await mgr.waitForSelector('.item-head .chip.st-done', { timeout: 8000 });
      await mgr.click('#acts button:has-text("إغلاق نهائي")');
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

    await check('الاجتماعات: إنشاء اجتماع وقرار يتحول إلى مهمة مرتبطة ويتابعه رجل الأعمال', async () => {
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
      assert(!(await owner.isVisible('#add')), 'زر إنشاء اجتماع ظاهر لرجل الأعمال');
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

    await check('الواجهة على الجوال والكمبيوتر: لا تمرير أفقي، والصفحات الأساسية تعمل', async () => {
      for (const [p, pages] of [[owner, ['#/', '#/my', '#/decisions', '#/notifications', '#/reports', '#/section/association', '#/meetings', '#/settings', '#/more']],
        [mgr, ['#/', '#/inbox', '#/dashboard', '#/tasks', '#/meetings', '#/sops', '#/partners', '#/reports', '#/settings', '#/section/partnerships']]]) {
        for (const h of pages) {
          await p.goto(BASE + '/' + h); await p.waitForSelector('main h1', { timeout: 8000 });
          assert(await noHScroll(p), `تمرير أفقي في ${h}`);
        }
      }
      // مقاس جوال لمدير المكتب أيضًا
      await mgr.setViewportSize({ width: 390, height: 844 });
      for (const h of ['#/', '#/inbox', '#/dashboard', `#/item/${itemId}`]) { await mgr.goto(BASE + '/' + h); await mgr.waitForSelector('main h1'); assert(await noHScroll(mgr), `تمرير أفقي (جوال/مدير) في ${h}`); }
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
      await mgr.goto(BASE + '/#/'); await mgr.waitForSelector('.ribbon.orange [data-toggle]');
      assert(await mgr.evaluate(() => getComputedStyle(document.querySelector('.ribbon.orange .r-track')).animationName) === 'ticker', 'الشريط لا يتحرك');
      await mgr.click('.ribbon.orange [data-toggle]');
      assert(await mgr.evaluate(() => getComputedStyle(document.querySelector('.ribbon.orange .r-track')).animationPlayState) === 'paused', 'زر الإيقاف لا يعمل');
      await mgr.click('.ribbon.orange [data-toggle]');
      await mgr.emulateMedia({ reducedMotion: 'reduce' }); await mgr.reload(); await mgr.waitForSelector('.ribbon.orange .r-item');
      assert(await mgr.evaluate(() => getComputedStyle(document.querySelector('.ribbon.orange .r-track')).animationName) === 'none', 'لا يحترم تقليل الحركة');
      await mgr.click('.ribbon.orange .r-item:has-text("مهمة اختبار الشريط 1")');
      await mgr.waitForSelector('h1:has-text("مهمة اختبار الشريط 1")');
      assert(!consoleErrors.length, 'أخطاء JavaScript: ' + consoleErrors.join(' | '));
    });
  } catch (e) {
    if (global.serverLog) { await new Promise(r => setTimeout(r, 1500)); console.log('--- سجل الخادم (بدون أسطر الطلبات العادية) ---\n' + global.serverLog().split('\n').filter(l => !/wrangler:info\] (GET|POST|PUT|PATCH) .* (200|101|304)/.test(l) && !/Request.cf|undici|DOMException|processTicks|Request was cancelled/.test(l)).join('\n').slice(-3500)); }
  } finally {
    await browser.close(); await stopServer(); pushSrv.close(); mailSrv.close();
    const failed = results.filter(r => !r[2].startsWith('نجح'));
    const md = `# نتائج اختبار السيناريو الإلزامي — ${TARGET === 'node' ? 'Node' : 'Cloudflare (workerd محليًا)'}\n\nتاريخ التشغيل: ${new Date().toISOString()}\n\n| # | الخطوة | النتيجة |\n|---|---|---|\n${results.map(r => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n')}\n\nالحالة العامة: ${failed.length || results.length < 23 ? 'فشل' : 'نجاح كامل'} (${results.length - failed.length}/${results.length})\n`;
    fs.writeFileSync(path.join(ROOT, 'tests', TARGET === 'node' ? 'RESULTS.md' : 'RESULTS-cloudflare.md'), md);
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n${results.length - failed.length}/${results.length} نجحت`);
    process.exit(failed.length || results.length < 23 ? 1 : 0);
  }
})();
