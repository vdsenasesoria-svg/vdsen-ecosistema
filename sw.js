// VDSEN Service Worker — offline v3
const CACHE = 'vdsen-v3';

const PRECACHE = [
  '/vdsen-cliente.html',
  '/vdsen-coach.html',
  '/cliente',
  '/coach',
  '/manifest.json',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png'
];

// Firebase SDK & Auth endpoints — never intercept (el SDK lo gestiona con IndexedDB)
const FIREBASE_BYPASS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'fcmregistrations.googleapis.com',
  'firebase.googleapis.com',
];

// CDN externos que se cachean on-demand (cache-first)
function isCDNHost(hostname) {
  return (
    hostname.includes('gstatic.com') ||
    hostname.includes('cdnjs.cloudflare.com') ||
    hostname.includes('cdn.tailwindcss.com') ||
    hostname.includes('fonts.googleapis.com') ||
    hostname.includes('fonts.gstatic.com')
  );
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // addAll individual para que un fallo no bloquee todo
      Promise.allSettled(PRECACHE.map(url => c.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Firebase SDK calls: nunca interceptar
  if (FIREBASE_BYPASS.some(h => url.hostname.includes(h))) return;
  // googleapis catch-all para cualquier otro endpoint Firebase
  if (url.hostname.includes('googleapis.com')) return;

  // CDN externos → cache-first, fallback red
  if (isCDNHost(url.hostname)) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.ok) {
            caches.open(CACHE).then(c => c.put(req, res.clone()));
          }
          return res;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // Recursos propios (HTML, iconos, manifest) → network-first, fallback cache
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          caches.open(CACHE).then(c => c.put(req, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
