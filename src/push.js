'use strict';
// Web Push (RFC 8030 + VAPID RFC 8292 + تشفير aes128gcm RFC 8291) بـ WebCrypto فقط — يعمل على Node وCloudflare
const db = require('./db');
const cfg = require('./config');
const { b64url } = require('./auth');
const enc = new TextEncoder();
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

let vapidCache = null;
async function vapidKeys() {
  if (vapidCache) return vapidCache;
  const envPub = cfg.get('VAPID_PUBLIC_KEY'); const envPriv = cfg.get('VAPID_PRIVATE_KEY');
  if (envPub && envPriv) {
    const pub = fromB64url(envPub);
    vapidCache = { publicKey: envPub, privateJwk: { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: envPriv } };
    return vapidCache;
  }
  const stored = db.kvGet('vapid');
  if (stored) return (vapidCache = JSON.parse(stored));
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = { publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  db.kvSet('vapid', JSON.stringify(keys));
  return (vapidCache = keys);
}
async function vapidPublicKey() { return (await vapidKeys()).publicKey; }

async function vapidJwt(audience) {
  const { privateJwk } = await vapidKeys();
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: cfg.get('VAPID_SUBJECT', 'mailto:admin@example.invalid') })));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function hkdf(secret, salt, info, bytes) {
  const k = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}
// تشفير الحمولة للمتصفح (RFC 8291)
async function encryptPayload(p256dhB64, authB64, text) {
  const uaPub = fromB64url(p256dhB64); const auth = fromB64url(authB64);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(ecdh, auth, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

// يُرجع {status}؛ يرمي خطأ فيه statusCode عند الفشل (404/410 = اشتراك منتهٍ)
async function sendWebPush(sub, payloadText, { urgent = false } = {}) {
  const url = new URL(sub.endpoint);
  const [jwt, { publicKey }, body] = await Promise.all([vapidJwt(url.origin), vapidKeys(), encryptPayload(sub.keys.p256dh, sub.keys.auth, payloadText)]);
  const res = await fetch(sub.endpoint, {
    method: 'POST', body,
    headers: { Authorization: `vapid t=${jwt}, k=${publicKey}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: urgent ? 'high' : 'normal' },
  });
  if (!res.ok) { const e = new Error(`push ${res.status}`); e.statusCode = res.status; throw e; }
  return { status: res.status };
}

module.exports = { vapidPublicKey, sendWebPush, encryptPayload };
