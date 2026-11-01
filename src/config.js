'use strict';
// إعدادات التشغيل: على Node من process.env، وعلى Cloudflare من متغيرات الـ Worker وأسراره.
// الشيفرة المشتركة لا تقرأ process.env مباشرة حتى تعمل على الاثنين.
let values = {};
const runtime = { origin: null };

function set(obj) {
  values = {};
  for (const [k, v] of Object.entries(obj || {})) if (typeof v === 'string') values[k] = v; // تُهمَل الـ bindings (كائنات)
}
const get = (key, fallback) => (values[key] !== undefined && values[key] !== '' ? values[key] : fallback);
const flag = (key) => ['1', 'true', 'yes'].includes(String(get(key, '')).toLowerCase());

module.exports = { set, get, flag, runtime };
