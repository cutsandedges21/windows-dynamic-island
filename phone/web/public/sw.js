// Island on your phone: the service worker. It keeps the app's shell so the Home Screen app
// opens at once (and says "offline" without a network), takes the page itself from the network
// first so a new version arrives on the next open, and shows the PC's notifications (phase 3).
// Plain JavaScript: Vite copies it as is from public/.

const SHELL = 'island-shell-v1';
const ASSETS = 'island-assets-v1';
const KEEP = [SHELL, ASSETS];
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];
/** Hashed files kept at most (old versions' go first). */
const MAX_ASSETS = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The page: the network first (updates), the kept copy when there is none.
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(SHELL).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')).then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed build files never change: the kept copy first.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) {
          await c.put(req, res.clone());
          void trim(c);
        }
        return res;
      }),
    );
    return;
  }

  // Anything else (icons, the manifest): the network, the kept copy when offline.
  event.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || Response.error())));
});

// ---------------------------------------------------------------- notifications (phase 3)

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Island';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' && data.tag ? data.tag : undefined,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { open: typeof data.open === 'string' ? data.open : null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const open = event.notification.data && event.notification.data.open;
  const target = new URL(open ? `./?open=${encodeURIComponent(open)}` : './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const client of list) {
        if (!client.url.startsWith(self.registration.scope)) continue;
        // The app is open already: it shows the card itself.
        if (open) client.postMessage({ open });
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
