/*
 * Checks the extension list the manifest registers against the one the app
 * accepts, and that the share-target endpoint matches what sw.js serves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

test('file_handlers accept extensions the app recognizes', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const fh = manifest.file_handlers[0].accept;
  const registered = new Set(Object.values(fh).flat());

  const fileHandling = read('src/file-handling.js');
  const m = fileHandling.match(/CAPTURE_EXTENSIONS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'CAPTURE_EXTENSIONS found');
  const appExts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

  // every extension the "Open with" registration claims must be recognized
  // by the app when re-opened from OPFS (it uses looksLikeCapture for the
  // folder picker; launched files bypass it, but consistency matters)
  for (const ext of registered) {
    assert.ok(
      appExts.includes(ext),
      `manifest registers ${ext} but the app does not list it`
    );
  }
 // and the flagship formats are both there
  assert.ok(registered.has('.pcap'));
  assert.ok(registered.has('.pcapng'));
});

test('share_target action matches the service worker endpoint', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const sw = read('sw.js');
  assert.equal(manifest.share_target.action, './__share');
  assert.ok(sw.includes("new URL('./__share', self.location)"), 'sw intercepts ./__share');
  assert.ok(sw.includes('__shared/'), 'sw stashes under __shared/');
});

test('app consumes the shared cache the sw writes', () => {
  const sw = read('sw.js');
  const fh = read('src/file-handling.js');
  const cacheName = sw.match(/SHARED_CACHE = '([^']+)'/)[1];
  assert.ok(fh.includes(`'${cacheName}'`), 'file-handling opens the same cache name');
});

test('start_url and scope work under a Pages subpath', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.start_url.startsWith('./'));
  assert.ok(manifest.scope.startsWith('./'));
});
