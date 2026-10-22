// Service worker: app-shell caching, offline downloads and an LRU audio cache.
// Spotify's clients keep an encrypted on-disk cache of tracks with LRU
// eviction and support explicit downloads for offline listening; this is the
// browser equivalent. Audio is cached as whole files and range requests from
// the <audio> element are answered by slicing the cached blob.

const SHELL = 'ainos-shell-v3';
const OFFLINE = 'ainos-offline';
const LRU = 'ainos-lru';
const LRU_LIMIT = 60 * 1024 * 1024; // 60 MB
const META = '/__lru-meta__';
const SHELL_FILES = ['/', '/css/app.css', '/js/app.js', '/js/api.js', '/js/i18n.js', '/js/ui.js', '/js/player.js', '/js/connect.js', '/js/views.js', '/js/markdown.js', '/img/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ainos-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

const keyOf = (url) => new URL(url, self.location.origin).pathname; // drop signature query

async function readMeta() {
  const c = await caches.open(LRU);
  const r = await c.match(META);
  return r ? r.json() : {};
}
async function writeMeta(meta) {
  const c = await caches.open(LRU);
  await c.put(META, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
}

// Meta is read-modify-write; concurrent touches (parallel range requests plus a
// 'cache' message) would otherwise drop entries, leaving cached files that are
// never evicted. Serialize them.
let metaLock = Promise.resolve();
function lruTouch(key, bytes) {
  const run = metaLock.then(() => lruTouchNow(key, bytes));
  metaLock = run.catch(() => {});
  return run;
}

async function lruTouchNow(key, bytes) {
  const meta = await readMeta();
  meta[key] = { bytes: bytes ?? meta[key]?.bytes ?? 0, at: Date.now() };
  let total = Object.values(meta).reduce((s, m) => s + m.bytes, 0);
  const c = await caches.open(LRU);
  for (const [k] of Object.entries(meta).sort((a, b) => a[1].at - b[1].at)) {
    if (total <= LRU_LIMIT) break;
    if (k === key) continue;
    total -= meta[k].bytes;
    delete meta[k];
    await c.delete(k);
  }
  await writeMeta(meta);
}

async function fetchWhole(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new Response(blob, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/wav', 'Content-Length': String(blob.size) } });
}

async function rangeFrom(cached, rangeHeader) {
  const blob = await cached.blob();
  const size = blob.size;
  const type = cached.headers.get('Content-Type') || 'audio/wav';
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' },
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;

  if (url.pathname.startsWith('/media/')) {
    e.respondWith((async () => {
      const key = url.pathname;
      const offline = await (await caches.open(OFFLINE)).match(key);
      if (offline) return rangeFrom(offline, e.request.headers.get('Range'));
      const lru = await (await caches.open(LRU)).match(key);
      if (lru) {
        e.waitUntil(lruTouch(key));
        return rangeFrom(lru, e.request.headers.get('Range'));
      }
      return fetch(e.request);
    })());
    return;
  }

  if (url.pathname.startsWith('/api/')) return; // always live

  // App shell & artwork: network first, cache fallback (so updates show up immediately).
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && (SHELL_FILES.includes(url.pathname) || url.pathname.startsWith('/art/') || url.pathname.startsWith('/docs/'))) {
        const copy = res.clone();
        e.waitUntil(caches.open(SHELL).then((c) => c.put(url.pathname, copy)));
      }
      return res;
    } catch {
      const hit = await caches.match(url.pathname);
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('/');
      throw new Error('offline');
    }
  })());
});

self.addEventListener('message', (e) => {
  const port = e.ports[0];
  const reply = (data) => port && port.postMessage(data);
  const msg = e.data || {};
  e.waitUntil((async () => {
    try {
      if (msg.type === 'download') {
        const key = keyOf(msg.url);
        const c = await caches.open(OFFLINE);
        let res = await c.match(key);
        if (!res) {
          res = await fetchWhole(msg.url);
          await c.put(key, res.clone());
        }
        reply({ ok: true, bytes: Number(res.headers.get('Content-Length')) || 0 });
      } else if (msg.type === 'remove') {
        await (await caches.open(OFFLINE)).delete(keyOf(msg.url));
        reply({ ok: true });
      } else if (msg.type === 'cache') {
        const key = keyOf(msg.url);
        const c = await caches.open(LRU);
        if (!(await c.match(key)) && !(await (await caches.open(OFFLINE)).match(key))) {
          const res = await fetchWhole(msg.url);
          await c.put(key, res.clone());
          await lruTouch(key, Number(res.headers.get('Content-Length')) || 0);
        }
        reply({ ok: true });
      } else if (msg.type === 'stats') {
        const meta = await readMeta();
        const off = await caches.open(OFFLINE);
        let offBytes = 0;
        const keys = await off.keys();
        for (const k of keys) offBytes += Number((await off.match(k)).headers.get('Content-Length')) || 0;
        reply({
          offline: { files: keys.length, bytes: offBytes },
          lru: { files: Object.keys(meta).length, bytes: Object.values(meta).reduce((s, m) => s + m.bytes, 0), limit: LRU_LIMIT },
        });
      } else if (msg.type === 'clear-lru') {
        await caches.delete(LRU);
        reply({ ok: true });
      }
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) });
    }
  })());
});
