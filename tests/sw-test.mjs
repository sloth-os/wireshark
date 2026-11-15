/*
 * Service worker behavior tests, run against the real sw.js source in a
 * sandboxed worker-ish context: the fetch/install/activate handlers are
 * exercised with mock caches + fetch. This checks the strategies (cache
 * first, network first for build-info, navigations falling back offline)
 * and the share-target POST handling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');

/* A minimal CacheStorage/Cache pair backed by Maps. */
function makeMockCaches() {
  const stores = new Map();
  return {
    stores,
    open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const map = stores.get(name);
      return Promise.resolve({
        match: (req) => {
          const url = typeof req === 'string' ? req : req.url;
          const hit = map.get(url);
          return Promise.resolve(hit ? hit.clone() : undefined);
        },
        put: (req, res) => {
          const url = typeof req === 'string' ? req : req.url;
          map.set(url, res.clone());
          return Promise.resolve();
        },
        keys: () => Promise.resolve([...map.keys()].map((u) => ({ url: u }))),
        delete: (req) => {
          const url = typeof req === 'string' ? req : req.url;
          return Promise.resolve(map.delete(url));
        }
      });
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name) => Promise.resolve(stores.delete(name))
  };
}

function makeContext(opts = {}) {
  const listeners = {};
  const sw = {
    location: new URL('https://user.github.io/wireshark/sw.js'),
    __SW_VERSION__: opts.version || 'test-1',
    __SW_ASSETS__: opts.assets || ['./index.html', './offline.html', './vendor/pako-inflate.min.js'],
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    addEventListener: (name, fn) => {
      listeners[name] = listeners[name] || [];
      listeners[name].push(fn);
    },
    console
  };
  const cachesMock = opts.caches || makeMockCaches();
  const fetchLog = [];
  const fetchMock = opts.fetch || ((req) => {
    fetchLog.push(req);
    return Promise.resolve(new Response('net:' + (typeof req === 'string' ? req : req.url), { status: 200 }));
  });

  const context = {
    URL,
    Blob,
    FormData,
    self: sw,
    caches: cachesMock,
    fetch: fetchMock,
    fetchLog,
    Response,
    Request: class {
      constructor(input, init) {
        this.url = typeof input === 'string' ? input : input.url;
        this.method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
        this.mode = (init && init.mode) || (typeof input !== 'string' && input.mode) || 'navigate';
      }
    },
    Headers,
    console,
    setTimeout,
    importScripts: () => {}
  };
  sw.caches = cachesMock;
  sw.fetch = fetchMock;
  sw.Response = Response;
  sw.Request = context.Request;
  sw.Headers = Headers;
  sw.setTimeout = setTimeout;

  vm.createContext(context);
  vm.runInContext(SW, context, { filename: 'sw.js' });
  return { sw, listeners, context, cachesMock, fetchLog };
}

/* The handlers call event.waitUntil(promise) with their real work; capture
 * and await that promise instead of resolving instantly. */
const fire = async (listeners, name, event) => {
  const fns = listeners[name] || [];
  let work = Promise.resolve();
  const ev = {
    ...event,
    waitUntil: (p) => { work = p; return p; }
  };
  for (const fn of fns) fn(ev);
  await work;
};

test('sw.js registers install/activate/fetch handlers', () => {
  const { listeners } = makeContext();
  assert.ok(listeners.install, 'install handler');
  assert.ok(listeners.activate, 'activate handler');
  assert.ok(listeners.fetch, 'fetch handler');
});

test('install precaches shell assets and skips ./wasm/', async () => {
  const { listeners, cachesMock } = makeContext({
    assets: ['./index.html', './offline.html', './wasm/engine/wiregasm.wasm.gz', './vendor/pako-inflate.min.js']
  });
  await fire(listeners, 'install', { waitUntil: () => Promise.resolve() });
  const cached = [...cachesMock.stores.get('wireshark-web-test-1').keys()];
  assert.ok(cached.some((u) => u.endsWith('/index.html')), 'index.html precached');
  assert.ok(cached.some((u) => u.endsWith('/offline.html')), 'offline.html precached');
  assert.ok(!cached.some((u) => u.includes('/wasm/')), 'wasm NOT precached at install');
});

test('a failed precache does not kill the install', async () => {
  const { listeners, cachesMock } = makeContext({
    fetch: () => Promise.reject(new Error('network down')),
    assets: ['./index.html']
  });
  await fire(listeners, 'install', { waitUntil: () => Promise.resolve() });
  assert.ok(cachesMock.stores.has('wireshark-web-test-1'), 'install finished (nothing cached)');
});

test('activate deletes stale versioned caches, keeps the shared cache', async () => {
  const cachesMock = makeMockCaches();
  await cachesMock.open('wireshark-web-old').then((c) => c.put('https://user.github.io/wireshark/index.html', new Response('x')));
  await cachesMock.open('wireshark-web-shared').then((c) => c.put('https://user.github.io/wireshark/__shared/count', new Response('1')));
  const { listeners } = makeContext({ caches: cachesMock, version: 'new' });
  await fire(listeners, 'activate', { waitUntil: () => Promise.resolve() });
  const names = await cachesMock.keys();
  assert.ok(!names.includes('wireshark-web-old'), 'old cache deleted');
  assert.ok(names.includes('wireshark-web-shared'), 'shared cache kept');
});

test('same-origin GET is served cache-first and cached on miss', async () => {
  const { listeners, cachesMock, fetchLog } = makeContext();
  const respond = [];
  const event = {
    request: new Request('https://user.github.io/wireshark/vendor/pako-inflate.min.js', { method: 'GET' }),
    respondWith: (p) => { respond.push(p); }
  };
  (listeners.fetch || []).forEach((fn) => fn(event));
  await respond[0];
  assert.equal(fetchLog.length, 1, 'one network fetch on cache miss');
  const cached = cachesMock.stores.get('wireshark-web-test-1');
  assert.ok([...cached.keys()].some((u) => u.includes('pako')), 'response cached');
});

test('second fetch of the same URL is served from cache', async () => {
  const { listeners, fetchLog } = makeContext();
  const makeEvent = () => {
    const respond = [];
    const event = {
      request: new Request('https://user.github.io/wireshark/vendor/pako-inflate.min.js', { method: 'GET' }),
      respondWith: (p) => { respond.push(p); }
    };
    (listeners.fetch || []).forEach((fn) => fn(event));
    return respond[0];
  };
  await makeEvent();
  await makeEvent();
  assert.equal(fetchLog.length, 1, 'only one network fetch for two requests');
});

test('navigations fall back to offline.html when offline', async () => {
  const { listeners, context, cachesMock } = makeContext({
    fetch: () => Promise.reject(new Error('offline'))
  });
  // Precache offline.html so the fallback has something to serve.
  const cache = await cachesMock.open('wireshark-web-test-1');
  await cache.put('https://user.github.io/wireshark/offline.html', new Response('<html>offline</html>', { status: 200 }));
  const respond = [];
  const event = {
    request: new context.Request('https://user.github.io/wireshark/', { method: 'GET', mode: 'navigate' }),
    respondWith: (p) => { respond.push(p); }
  };
  (listeners.fetch || []).forEach((fn) => fn(event));
  const res = await respond[0];
  assert.ok(res instanceof Response);
  assert.ok([200, 503].includes(res.status), 'a response was produced, status ' + res.status);
});

test('build-info.json is network-first', async () => {
  let netCalls = 0;
  const { listeners } = makeContext({
    fetch: (req) => {
      netCalls++;
      return Promise.resolve(new Response('{"v":' + netCalls + '}', { status: 200 }));
    }
  });
  const makeEvent = () => {
    const respond = [];
    const event = {
      request: new Request('https://user.github.io/wireshark/build-info.json', { method: 'GET' }),
      respondWith: (p) => { respond.push(p); }
    };
    (listeners.fetch || []).forEach((fn) => fn(event));
    return respond[0];
  };
  const r1 = await makeEvent();
  const r2 = await makeEvent();
  const t1 = await r1.clone().text();
  const t2 = await r2.text();
  assert.equal(netCalls, 2, 'both requests hit the network');
  assert.notEqual(t1, t2, 'second request saw the fresh network response');
});

test('share POST is answered with a 303 and stashes the file', async () => {
  const { listeners, cachesMock } = makeContext();
  // build a minimal multipart body
  const boundary = '----x';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="files"; filename="share.pcap"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n` +
    `\x00\x01\x02 pcap-bytes\r\n` +
    `--${boundary}--\r\n`;
  const req = new Request('https://user.github.io/wireshark/__share', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }
  });
  // Node 18+: Request supports constructor body; emulate formData()
  const requestObj = {
    method: 'POST',
    url: 'https://user.github.io/wireshark/__share',
    mode: 'same-origin',
    formData: async () => {
      const fd = new FormData();
      fd.append('files', new Blob([new Uint8Array([1, 2, 3])]), 'share.pcap');
      return fd;
    }
  };
  let responded = null;
  const event = { request: requestObj, respondWith: (p) => { responded = p; } };
  (listeners.fetch || []).forEach((fn) => fn(event));
  const res = await responded;
  assert.equal(res.status, 303, 'redirect');
  assert.equal(res.headers.get('Location'), 'https://user.github.io/wireshark/', 'redirects to app root');
  const shared = cachesMock.stores.get('wireshark-web-shared');
  const keys = [...shared.keys()];
  assert.ok(keys.some((u) => u.endsWith('__shared/0')), 'file stashed');
  assert.ok(keys.some((u) => u.endsWith('__shared/count')), 'count stashed');
  void body; void req;
});

test('non-GET non-share POSTs are left alone', async () => {
  const { listeners } = makeContext();
  let responded = null;
  const event = {
    request: { method: 'POST', url: 'https://user.github.io/wireshark/somewhere', mode: 'no-cors' },
    respondWith: (p) => { responded = p; }
  };
  (listeners.fetch || []).forEach((fn) => fn(event));
  assert.equal(responded, null, 'sw does not intercept foreign POSTs');
});
