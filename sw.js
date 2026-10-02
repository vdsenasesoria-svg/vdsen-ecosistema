// VDSEN Service Worker — offline support. T555: cache v13 (+ rest-end notification scheduling); T554: v12 so every device drops the older client build; HTML stays NETWORK-FIRST (the cache is only an offline fallback).
const CACHE = 'vdsen-v13';

// Assets to pre-cache on install (propio HTML)
const PRECACHE = [
  '/vdsen-cliente.html',
  '/cliente',
  '/manifest.json',
  '/assets/vdsen-logo-official.jpg',
  '/assets/exercise-visual-catalog.js',
  '/assets/progression-auto-apply-shadow.js',
  '/assets/progression-magnitude-policy.js',
  '/assets/progression-effective-prescription.js',
  '/assets/progression-application-consumer.js',
  '/assets/exercises/pending-license.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo GET
  if (req.method !== 'GET') return;

  // Peticiones a Firebase Auth/Firestore API → nunca interceptar (el SDK las maneja)
  if (url.hostname.includes('googleapis.com') && url.pathname.includes('/google.firestore')) return;
  if (url.hostname.includes('identitytoolkit.googleapis.com')) return;
  if (url.hostname.includes('securetoken.googleapis.com')) return;
  if (url.hostname.includes('firebaseinstallations.googleapis.com')) return;

  // CDN externos (gstatic, cdnjs, fonts) → cache-first, cae a red si no está
  const isCDN = url.hostname !== self.location.hostname && (
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  );

  if (isCDN) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
    return;
  }

  // HTML propio → network-first, fallback a cache
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ── T555: rest-end notification that works while the page is in the background / frozen ──────────────────────────────────────
// The page posts VDSEN_REST_SCHEDULE {endMs,title,body} when a rest starts (and again when it is adjusted) and VDSEN_REST_CANCEL when it is
// dismissed or the page rings by itself. The worker keeps the event alive until the end time and shows ONE notification (sound + vibration).
// Best effort: browsers may stop an idle worker; the in-page alarm and the visibilitychange catch-up still cover that case.
let _restTid = null, _restResolve = null;
function _restClear() { if (_restTid !== null) { clearTimeout(_restTid); _restTid = null; } if (_restResolve) { const r = _restResolve; _restResolve = null; r(); } }
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'VDSEN_REST_CANCEL') { _restClear(); return; }
  if (d.type !== 'VDSEN_REST_SCHEDULE') return;
  _restClear();
  const delay = Math.max(0, Math.min((+d.endMs || 0) - Date.now(), 10 * 60 * 1000));
  e.waitUntil(new Promise(resolve => {
    _restResolve = resolve;
    _restTid = setTimeout(() => {
      _restTid = null; _restResolve = null;
      Promise.resolve(self.registration.showNotification(String(d.title || 'VDSEN — Descanso terminado'), { body: String(d.body || 'Lista la siguiente serie'), tag: 'vdsen-rest-timer', renotify: true, silent: false, vibrate: [200, 100, 200, 100, 400], data: { url: '/cliente' } }))
        .catch(() => {}).then(resolve);
    }, delay);
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => (cs && cs[0] && cs[0].focus) ? cs[0].focus() : self.clients.openWindow('/cliente')));
});
