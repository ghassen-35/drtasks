// نقطة التشغيل على Cloudflare: Worker يوجّه كل طلبات /api إلى Durable Object واحد يملك قاعدة البيانات (SQLite)
// والاتصالات الفورية (WebSocket Hibernation) والمهام الدورية (Alarm). الملفات الثابتة يخدمها Cloudflare مباشرة.
import { DurableObject } from 'cloudflare:workers';
import cfg from '../config.js';
import db from '../db.js';
import events from '../events.js';
import auth from '../auth.js';
import { createApp } from '../app.js';
import { runScheduler } from '../scheduler.js';

const CHUNK = 512 * 1024; // حد صف SQLite في Durable Object هو 2MB

export class OfficeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.setupError = null;
    cfg.set(env);
    const storage = ctx.storage; const sql = storage.sql;
    db.setBackend({
      all: (q, p) => sql.exec(q, ...p).toArray(),
      run: (q, p) => { sql.exec(q, ...p); const r = sql.exec('SELECT last_insert_rowid() id, changes() ch').one(); return { id: Number(r.id), changes: Number(r.ch) }; },
      transaction: (fn) => storage.transactionSync(fn),
    });
    events.setTransport({
      sendTo: (userId, event, data) => { for (const ws of ctx.getWebSockets(`u${userId}`)) try { ws.send(JSON.stringify({ event, data })); } catch { /* اتصال مغلق */ } },
      broadcast: (event, data) => { for (const ws of ctx.getWebSockets()) try { ws.send(JSON.stringify({ event, data })); } catch { /* اتصال مغلق */ } },
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); // نبض الاتصال دون إيقاظ الكائن
    const blobs = {
      async put(name, bytes) {
        storage.transactionSync(() => {
          for (let i = 0, seq = 0; i < bytes.length || seq === 0; i += CHUNK, seq++) sql.exec('INSERT INTO file_chunks(name,seq,data) VALUES(?,?,?)', name, seq, bytes.slice(i, i + CHUNK));
        });
      },
      async get(name) {
        const rows = sql.exec('SELECT data FROM file_chunks WHERE name=? ORDER BY seq', name).toArray();
        if (!rows.length) return null;
        const out = new Uint8Array(rows.reduce((n, r) => n + r.data.byteLength, 0)); let o = 0;
        for (const r of rows) { out.set(new Uint8Array(r.data), o); o += r.data.byteLength; }
        return out;
      },
    };
    this.app = createApp({ realtime: 'ws', clientIp: (c) => c.req.header('cf-connecting-ip') || 'unknown', blobs });
    ctx.blockConcurrencyWhile(async () => {
      db.applySchema();
      await this.setup();
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 60 * 1000);
    });
  }

  async setup() {
    try { await auth.ensureUsers({ requirePasswords: true }); this.setupError = null; }
    catch (e) { if (!(e instanceof auth.SetupError)) throw e; this.setupError = e.message; }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (this.setupError) await this.setup(); // ربما أُضيفت الأسرار بعد إنشاء الكائن
    if (this.setupError) return Response.json({ error: `إعداد المنصة غير مكتمل: ${this.setupError}` }, { status: 503 });
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade') === 'websocket') {
      const origin = request.headers.get('Origin');
      if (origin && new URL(origin).origin !== url.origin) return new Response('forbidden', { status: 403 }); // يمنع اختطاف الاتصال من موقع آخر
      const user = await this.app.authenticate(request.headers.get('cookie'));
      if (!user) return new Response('unauthorized', { status: 401 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, [`u${user.id}`]);
      return new Response(null, { status: 101, webSocket: client });
    }
    return this.app.fetch(request, this.env);
  }

  webSocketMessage() { /* لا رسائل واردة سوى النبض (يُجاب تلقائيًا) */ }
  webSocketClose(ws, code) { try { ws.close(code); } catch { /* مغلق */ } }
  webSocketError(ws) { try { ws.close(1011); } catch { /* مغلق */ } }

  async alarm() {
    try { if (!this.setupError) runScheduler(); } finally { await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000); }
  }
}

export default {
  fetch(request, env) {
    const ns = env.OFFICE;
    return ns.get(ns.idFromName('main'), { locationHint: 'me' }).fetch(request); // 'me' = الشرق الأوسط (تلميح لمكان الإنشاء)
  },
};
