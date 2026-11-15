/*
 * file-handling.js: the pure parts (extension matching, name normalization)
 * plus the launchQueue/share-target wiring against a fake DOM environment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(REPO, 'src', 'file-handling.js'), 'utf8');

/* The module is an ES module (export ...); strip the export keywords and run
 * it in a vm context with a minimal window/document/location. */
const COMMON = SRC
  .replace(/^export /gm, '')
  .replace(/^'use strict';/m, '');

function makeEnv(extra = {}) {
  const received = [];
  const window = {
    location: new URL('https://user.github.io/wireshark/'),
    showOpenFilePicker: undefined,
    showDirectoryPicker: undefined,
    ...extra.window
  };
  const cachesMock = {
    open: async () => ({
      keys: async () => [{ url: 'https://user.github.io/wireshark/__shared/count' }, { url: 'https://user.github.io/wireshark/__shared/0' }],
      match: async (req) => {
        const url = typeof req === 'string' ? req : req.url;
        if (url.endsWith('/__shared/count')) {
          return new Response('1', { headers: { 'Content-Type': 'text/plain' } });
        }
        if (url.endsWith('/__shared/0')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'X-File-Name': encodeURIComponent('shared-capture.pcap'), 'Content-Type': 'application/octet-stream' }
          });
        }
        return undefined;
      },
      delete: async () => true,
      put: async () => {}
    })
  };
  window.caches = window.caches || cachesMock;
  const context = {
    window,
    location: window.location,
    caches: cachesMock,
    console,
    URL,
    Response,
    File: globalThis.File,
    Blob: globalThis.Blob,
    navigator: { storage: {} }
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(COMMON, context, { filename: 'file-handling.js' });
  return { context, received };
}

test('looksLikeCapture recognizes capture extensions', () => {
  const { context } = makeEnv();
  const f = context.looksLikeCapture;
  for (const ok of ['a.pcap', 'b.pcapng', 'c.cap', 'd.pcap.gz', 'e.pcapng.gz', 'f.snoop', 'g.erf', 'h.dmp']) {
    assert.equal(f(ok), true, ok);
  }
  for (const no of ['a.txt', 'b.jpg', 'c.mp4', 'd', 'e.gz']) {
    assert.equal(f(no), false, no);
  }
});

test('initFileHandling delivers launchQueue files', async () => {
  const received = [];
  const fakeFile = new File([new Uint8Array([1, 2, 3, 4])], 'launched.pcap', { type: 'application/octet-stream' });
  let consumer = null;
  const window = {
    launchQueue: {
      setConsumer: (fn) => { consumer = fn; }
    }
  };
  // navigator.storage.getDirectory absent: stashLaunchedHandle no-ops
  const { context } = makeEnv({ window });
  context.navigator = { storage: {} };
  context.initFileHandling((file, source) => received.push({ file, source }));
  assert.ok(consumer, 'consumer registered');
  await consumer({ files: [{ name: 'launched.pcap', getFile: async () => fakeFile }], targetURL: './' });
  assert.equal(received.length, 1);
  assert.equal(received[0].source, 'launch');
  assert.equal(received[0].file.name, 'launched.pcap');
});

test('initFileHandling consumes share-target files from the cache', async () => {
  const received = [];
  const { context } = makeEnv();
  context.initFileHandling((file, source) => received.push({ file, source }));
  // the share consumption runs on module init (async); let microtasks drain
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received.length, 1, 'shared file delivered');
  assert.equal(received[0].source, 'share');
  assert.equal(received[0].file.name, 'shared-capture.pcap');
});

test('pickers are exposed only when the browser has them', async () => {
  const { context } = makeEnv();
  const h = context.initFileHandling(() => {});
  assert.equal(typeof h.pickFile, 'function');
  assert.equal(typeof h.pickFolder, 'function');
  // without window.showOpenFilePicker they report false (caller falls back)
  const r = await h.pickFile();
  assert.equal(r, false);
});
