'use strict';
// نقطة التشغيل على Node: ملفات ثابتة + SSE + تخزين الملفات على القرص + SMTP + مهام دورية
const fs = require('fs');
const path = require('path');
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { streamSSE } = require('hono/streaming');
const cfg = require('../config');
const db = require('../db');
const events = require('../events');
const N = require('../notify');
const auth = require('../auth');
const { createApp } = require('../app');
const { runScheduler } = require('../scheduler');
const sqlite = require('./sqlite');

cfg.set(process.env);
const DATA_DIR = cfg.get('DATA_DIR', path.join(__dirname, '..', '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const { backup } = sqlite.init(DATA_DIR, cfg.get('DB_FILE'));

// ===== البريد: SMTP وملف اختباري =====
N.registerMailProvider('smtp', async (msg) => {
  if (!cfg.get('SMTP_HOST')) throw new Error('SMTP_HOST غير مضبوط');
  const t = require('nodemailer').createTransport({
    host: cfg.get('SMTP_HOST'), port: Number(cfg.get('SMTP_PORT', '587')), secure: cfg.flag('SMTP_SECURE'),
    auth: cfg.get('SMTP_USER') ? { user: cfg.get('SMTP_USER'), pass: cfg.get('SMTP_PASS') } : undefined,
  });
  await t.sendMail({ from: cfg.get('EMAIL_FROM', 'office-platform@localhost'), ...msg });
});
N.registerMailProvider('file', async (msg) => { // اختبار: يحفظ الرسالة في data/outbox دون إرسال
  const dir = path.join(DATA_DIR, 'outbox'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.eml`), `To: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
});

// ===== الأحداث الفورية عبر SSE =====
const clients = new Map(); // userId -> Set<stream>
const write = (s, event, data) => s.writeSSE({ event, data: JSON.stringify(data) }).catch(() => { });
events.setTransport({
  sendTo: (userId, event, data) => { for (const s of clients.get(userId) || []) write(s, event, data); },
  broadcast: (event, data) => { for (const set of clients.values()) for (const s of set) write(s, event, data); },
});

const hops = Number(cfg.get('TRUST_PROXY', '0')) || 0;
const P = {
  realtime: 'sse',
  clientIp(c) {
    const xff = (c.req.header('x-forwarded-for') || '').split(',').map(x => x.trim()).filter(Boolean);
    if (hops && xff.length) return xff[Math.max(0, xff.length - hops)]; // الطبقة الموثوقة من اليمين، لا ما يدّعيه العميل
    return (c.env && c.env.incoming && c.env.incoming.socket.remoteAddress) || 'unknown';
  },
  blobs: {
    async put(name, bytes) { fs.writeFileSync(path.join(UPLOAD_DIR, name), bytes); },
    async get(name) { try { return new Uint8Array(fs.readFileSync(path.join(UPLOAD_DIR, path.basename(name)))); } catch { return null; } },
  },
  backup: (label) => path.basename(backup(label)),
  handleEvents(c, user) {
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      if (!clients.has(user.id)) clients.set(user.id, new Set());
      clients.get(user.id).add(stream);
      const off = () => { const s = clients.get(user.id); if (s) { s.delete(stream); if (!s.size) clients.delete(user.id); } };
      stream.onAbort(off);
      await stream.writeSSE({ event: 'ready', data: '1', retry: 3000 });
      while (!stream.aborted) { await stream.sleep(25000); await stream.writeSSE({ event: 'ping', data: '' }).catch(() => { }); }
      off();
    });
  },
};

const app = createApp(P);
const publicDir = path.relative(process.cwd(), path.join(__dirname, '..', '..', 'public')) || '.';
app.use('/_headers', (c) => c.notFound()); // خاص بـ Cloudflare
app.use('*', serveStatic({ root: publicDir, onFound: (p, c) => { if (/\.html$|sw\.js$/.test(p)) c.header('Cache-Control', 'no-cache'); } }));
app.get('*', serveStatic({ path: path.join(publicDir, 'index.html') }));

function dailyBackup() {
  const dir = path.join(DATA_DIR, 'backups');
  const last = fs.readdirSync(dir).filter(f => f.startsWith('office-auto-')).sort().pop();
  if (!last || !last.includes(new Date().toISOString().slice(0, 10))) backup('auto');
}
const tick = () => runScheduler({ dailyBackup });

async function main() {
  const created = await auth.ensureUsers();
  if (created) {
    console.log('\n' + created.text);
    if (created.generated) fs.writeFileSync(path.join(DATA_DIR, 'initial-credentials.txt'), created.text, { mode: 0o600 });
  }
  const port = Number(cfg.get('PORT', '3000'));
  serve({ fetch: app.fetch, port, hostname: cfg.get('HOST', '0.0.0.0') }, () => console.log(`المنصة تعمل على http://localhost:${port}`));
  setTimeout(tick, 3000);
  setInterval(tick, 5 * 60 * 1000).unref();
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { main };
