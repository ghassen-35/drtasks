// Service Worker: تثبيت التطبيق (PWA)، تخزين الواجهة مؤقتًا، واستقبال إشعارات Push
const CACHE = 'office-shell-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/icons.js', '/img/logo.png', '/img/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// الواجهة: الشبكة أولًا ثم النسخة المخزنة. بيانات /api لا تُخزَّن أبدًا (بيانات خاصة)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/fonts/'))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'مكتب رجل الأعمال', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'مكتب رجل الأعمال', {
    body: d.body || '', tag: d.tag, icon: '/img/icon-192.png', badge: '/img/icon-192.png', dir: 'rtl', lang: 'ar', data: { link: d.link || '' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = '/' + (e.notification.data && e.notification.data.link || '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(target); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
