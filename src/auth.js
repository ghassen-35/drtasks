'use strict';
// كلمات المرور والجلسات والحسابات الأولية — بـ WebCrypto فقط (يعمل على Node وCloudflare Workers)
const db = require('./db');
const cfg = require('./config');
const enc = new TextEncoder();

const hex = (u8) => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function sha256hex(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))); }

// PBKDF2-SHA256. على Cloudflare الحد الأقصى للتكرارات 100,000؛ على Node يمكن رفعه عبر PBKDF2_ITERATIONS
async function pbkdf2(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function hashPassword(pw) {
  const iterations = Number(cfg.get('PBKDF2_ITERATIONS', 100000));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${hex(salt)}$${hex(await pbkdf2(pw, salt, iterations))}`;
}
async function verifyPassword(pw, stored) {
  const [alg, it, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'pbkdf2') return false;
  const got = await pbkdf2(pw, unhex(saltHex), Number(it));
  const want = unhex(hashHex);
  let diff = got.length ^ want.length; // مقارنة بزمن ثابت
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

class SetupError extends Error {}

// إنشاء الحسابين عند أول تشغيل. تُرجع نص بيانات الدخول إن وُلّدت كلمات مرور عشوائية (Node فقط)
async function ensureUsers({ requirePasswords = false } = {}) {
  if (db.get('SELECT COUNT(*) c FROM users').c > 0) return null;
  for (const k of ['OWNER_PASSWORD', 'MANAGER_PASSWORD']) {
    const v = cfg.get(k);
    if (!v && requirePasswords) throw new SetupError(`لم تُضبط ${k} بعد (أضفها كسر في إعدادات Cloudflare)`);
    if (v && v.length < 8) throw new SetupError(`${k} يجب ألا تقل عن 8 أحرف`);
  }
  const ownerPw = cfg.get('OWNER_PASSWORD') || randomToken(6);
  const managerPw = cfg.get('MANAGER_PASSWORD') || randomToken(6);
  const ou = cfg.get('OWNER_USERNAME', 'owner'); const mu = cfg.get('MANAGER_USERNAME', 'manager');
  db.run('INSERT INTO users(username,name,role,email,password_hash) VALUES(?,?,?,?,?)', ou, cfg.get('OWNER_NAME', 'رجل الأعمال'), 'owner', cfg.get('OWNER_EMAIL') || null, await hashPassword(ownerPw));
  db.run('INSERT INTO users(username,name,role,email,password_hash) VALUES(?,?,?,?,?)', mu, cfg.get('MANAGER_NAME', 'مدير المكتب'), 'manager', cfg.get('MANAGER_EMAIL') || null, await hashPassword(managerPw));
  const show = (k, pw) => (cfg.get(k) ? '(كلمة المرور المحددة في الإعدادات)' : pw);
  return {
    text: `بيانات الدخول الأولية (غيّرها بعد أول دخول من صفحة الإعدادات)\n\nرجل الأعمال: ${ou} / ${show('OWNER_PASSWORD', ownerPw)}\nمدير المكتب: ${mu} / ${show('MANAGER_PASSWORD', managerPw)}\n`,
    generated: !cfg.get('OWNER_PASSWORD') || !cfg.get('MANAGER_PASSWORD'),
  };
}

module.exports = { hex, unhex, b64url, randomToken, sha256hex, hashPassword, verifyPassword, ensureUsers, SetupError };
