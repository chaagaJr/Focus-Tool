// Focus service worker: makes the app open instantly (and offline),
// shows reminder notifications, and handles their Done / Snooze buttons.
//
// When you change any app file, bump VERSION so phones and PCs pick up the new copy.
const VERSION = 'focus-v3';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'shared.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/badge-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'focus-config') await caches.delete(k);
    await self.clients.claim();
  })());
});

// Open from the cache straight away, refresh the cache in the background.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
    try {
      return await fresh;
    } catch {
      if (req.mode === 'navigate') return (await cache.match('index.html')) || (await cache.match('./'));
      return Response.error();
    }
  })());
});

/* ---------- Notifications ---------- */

async function notifyClients(msg) {
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(msg);
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const show = self.registration.showNotification(d.title || 'Focus', {
    body: d.body || '',
    tag: d.tag || 'focus',
    renotify: true,
    requireInteraction: d.type === 'nag' || d.type === 'batch',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    timestamp: Date.now(),
    data: { url: d.url || './', id: d.id || null },
    // Buttons show on Windows/Android; iPhone opens the app when you tap instead.
    actions: d.id ? [{ action: 'done', title: 'Done' }, { action: 'snooze', title: 'Snooze 1 hour' }] : [],
  });
  const extras = (async () => {
    try {
      if (typeof d.badge === 'number' && self.navigator.setAppBadge) {
        if (d.badge > 0) await self.navigator.setAppBadge(d.badge); else await self.navigator.clearAppBadge();
      }
      await notifyClients({ type: 'refresh' });
    } catch { /* optional extras */ }
  })();
  e.waitUntil(Promise.all([show, extras]));
});

async function callApi(body) {
  try {
    const cache = await caches.open('focus-config');
    const saved = await cache.match(new URL('./__config', self.registration.scope));
    if (!saved) return false;
    const { url, key } = await saved.json();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-focus-key': key },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const { url, id } = n.data || {};
  n.close();
  e.waitUntil((async () => {
    if (id && (e.action === 'done' || e.action === 'snooze')) {
      const ok = await callApi(e.action === 'done'
        ? { action: 'complete', id }
        : { action: 'snooze', id, minutes: 60 });
      if (ok) { await notifyClients({ type: 'refresh' }); return; }
      // Couldn't reach the server: fall through and open the app instead.
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      open.postMessage(id ? { type: 'open', id } : { type: 'open-url', url: url || './' });
      return;
    }
    await self.clients.openWindow(new URL(url || './', self.registration.scope).href);
  })());
});

self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const sub = e.newSubscription
      || (e.oldSubscription && (await self.registration.pushManager.subscribe(e.oldSubscription.options)));
    if (sub) await callApi({ action: 'subscribe', subscription: sub.toJSON(), device: 'Renewed device' });
  })().catch(() => {}));
});
