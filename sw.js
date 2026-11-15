/*
 * wireshark-web — service worker.
 *
 * Offline-first app shell for GitHub Pages:
 *
 * 1. INSTALL precaches the small shell assets listed in the generated
 *    sw-manifest.js (written by CI: node .github/scripts/generate-sw-manifest.mjs
 *    <site-dir>). One flaky fetch skips that asset; it never kills the
 *    install. The ~21 MB engine under ./wasm/ is deliberately NOT an
 *    install asset: the first engine start fetches it through the normal
 *    cache-first path and caches it then — offline analysis works from the
 *    first visit that ever started the engine once.
 *
 * 2. FETCH serves same-origin GETs cache-first (so the second + offline
 *    visits are fully local), navigations fall back to ./offline.html, and
 *    build-info.json is network-first so the UI can show a fresh version.
 *
 * 3. SHARE TARGET: the manifest points share POSTs at ./__share; the
 *    multipart files are stashed in a dedicated fixed-name cache (they must
 *    survive app-shell cache rotations) and the POST is answered with a 303
 *    redirect to ./ so the browser lands on the app, which consumes them.
 *
 * No cross-origin isolation tricks here: the wiregasm engine is
 * single-threaded (no SharedArrayBuffer), so no COOP/COEP headers are
 * needed and the site works from any host as-is.
 *
 * Every URL is relative to this script's own location, so the site works
 * from any GitHub Pages subpath and a local static server. No external
 * resources are ever requested.
 */

'use strict';

try {
  importScripts('./sw-manifest.js');
} catch (err) {
  console.warn('[sw] sw-manifest.js unavailable, running without a precache list: ' + (err && err.message ? err.message : err));
}

var CACHE = 'wireshark-web-' + (self.__SW_VERSION__ || 'dev');
/* Files from the share_target land here: fixed name, survives rotations. */
var SHARED_CACHE = 'wireshark-web-shared';
var ASSETS = Array.isArray(self.__SW_ASSETS__) ? self.__SW_ASSETS__.slice() : [];

var ASSET_URLS = ASSETS.map(function (entry) {
  return new URL(entry, self.location).href;
});
/* The engine (~21 MB gz) is not an install asset (see header): deferred to
 * the runtime cache-first path. Anything under ./wasm/ is deferred. */
var SHELL_URLS = ASSET_URLS.filter(function (url) {
  return !new URL(url).pathname.split('/').includes('wasm');
});
var INDEX_URL = new URL('./index.html', self.location).href;
var OFFLINE_URL = new URL('./offline.html', self.location).href;
var SHARE_URL = new URL('./__share', self.location);

var OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="color-scheme" content="dark light"><title>Offline</title></head>' +
  '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
  'min-height:100vh;font:16px/1.5 system-ui,sans-serif;background:#0e1420;color:#dbe4f0">' +
  '<main style="max-width:34rem;margin:1.5rem;padding:2rem;text-align:center">' +
  '<h1 style="font-size:1.3rem">You are offline</h1>' +
  '<p>You are offline and this page was not cached.</p>' +
  '<p><button type="button" onclick="location.reload()" ' +
  'style="font:inherit;padding:.5rem 1rem;cursor:pointer">Retry</button></p>' +
  '</main></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function isHttp(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function requestUrl(request) {
  try {
    return new URL(typeof request === 'string' ? request : request.url);
  } catch (err) {
    return null;
  }
}

/* ---------------------------------------------------------------- install */

/* One asset, one retry: a network hiccup costs one extra request, never the
 * install. Non-ok responses are tolerated (filled at runtime). */
async function precacheOne(cache, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (response && response.ok && response.status !== 206) {
        await cache.put(url, response);
        return true;
      }
    } catch (err) {
      /* retried below (or given up on) */
    }
    if (attempt === 0) {
      try { await new Promise(function (r) { setTimeout(r, 250); }); } catch { /* retry at once */ }
    }
  }
  console.warn('[sw] precache miss: ' + url + ' (will be filled at runtime)');
  return false;
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function () {
      if (SHELL_URLS.length === 0) {
        console.warn('[sw] __SW_ASSETS__ is missing or empty — nothing precached');
      } else {
        const cache = await caches.open(CACHE);
        let ok = 0;
        /* Sequential: a burst of parallel fetches on a slow radio starves the
       * page's own requests. */
        for (const url of SHELL_URLS) {
          if (await precacheOne(cache, url)) ok++;
        }
        console.log('[sw] precached ' + ok + '/' + SHELL_URLS.length + ' shell assets into ' + CACHE);
      }
      await self.skipWaiting();
    })()
  );
});

/* --------------------------------------------------------------- activate */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(function (key) { return key !== CACHE && key !== SHARED_CACHE; })
          .map(function (key) { return caches.delete(key); })
      );
      await self.clients.claim();
    })()
  );
});

/* ------------------------------------------------------------------ fetch */

/* Navigations: cache-first (the exact request, then ./index.html), then the
 * network without caching, then ./offline.html from the cache. */
async function navigationResponse(request) {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    const index = await cache.match(INDEX_URL, { ignoreSearch: true });
    if (index) return index;
  } catch (err) {
    /* cache unavailable — network below */
  }

  try {
    return await fetch(request);
  } catch (err) {
    let offline = null;
    try {
      const cache = await caches.open(CACHE);
      offline = await cache.match(OFFLINE_URL, { ignoreSearch: true });
    } catch (err2) {
      offline = null;
    }
    return offline || offlineResponse();
  }
}

/* build-info.json: network-first so the UI shows the fresh build, cached for offline. */
async function networkFirstResponse(request) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
  if (response && response.ok && response.status !== 206) {
    try {
      await cache.put(request, response.clone());
    } catch (err) {
      /* non-fatal */
    }
  }
  return response;
}

/* Everything else same-origin: cache-first, then network (cached on success).
 * This is the path the engine's .gz assets take on first boot. */
async function cacheFirstResponse(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;

  const response = await fetch(request);
  if (response && response.ok && response.status !== 206 && response.type !== 'opaque') {
    try {
      await cache.put(request, response.clone());
    } catch (err) {
      /* non-fatal */
    }
  }
  return response;
}

/* ----------------------------------------------------------- share target */

/* Android share sheet: stash the shared files under synthetic URLs (the real
 * name travels in a header) for the app to consume on the next load, and
 * answer with a 303 — a 200 would leave a blank page whose reload re-POSTs. */
async function handleSharePost(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(function (v) { return v instanceof Blob; });
    const cache = await caches.open(SHARED_CACHE);
    /* Clear leftovers from a previous, never-consumed share first. */
    const stale = await cache.keys();
    await Promise.all(stale.map(function (key) { return cache.delete(key); }));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await cache.put(
        new URL('./__shared/' + i, self.location).href,
        new Response(file, {
          headers: {
            'X-File-Name': encodeURIComponent(file.name || ('file' + i)),
            'Content-Type': file.type || 'application/octet-stream'
          }
        })
      );
    }
    await cache.put(
      new URL('./__shared/count', self.location).href,
      new Response(String(files.length), {
        headers: { 'Content-Type': 'text/plain' }
      })
    );
  } catch (err) {
    console.warn('[sw] share-target handling failed: ' + (err && err.message ? err.message : err));
  }
  return new Response(null, {
    status: 303,
    headers: { Location: new URL('./', self.location).href }
  });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (!request || (request.method !== 'GET' && request.method !== 'POST')) return;

  const url = requestUrl(request);
  if (!url || !isHttp(url)) return; /* data:, blob:, ... — untouched */

  if (request.method === 'POST') {
    if (url.origin === SHARE_URL.origin && url.pathname === SHARE_URL.pathname) {
      event.respondWith(handleSharePost(request));
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    /* Cross-origin: plain fetch, never cached (there should be none). */
    event.respondWith(fetch(request));
    return;
  }

  if (url.pathname.endsWith('/build-info.json')) {
    event.respondWith(networkFirstResponse(request));
    return;
  }

  event.respondWith(cacheFirstResponse(request));
});
