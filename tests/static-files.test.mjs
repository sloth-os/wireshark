/*
 * Static checks over the repo's shipping files: syntax of every script,
 * JSON validity, icon presence, index.html references, no external URLs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(REPO, p));

test('index.html is parseable and references only local assets', () => {
  const html = read('index.html');
  assert.ok(/<!doctype html>/i.test(html), 'doctype');
  // Subresources (script src=, img src=, link href=) must all be local:
  // the app never loads anything cross-origin, which is what makes the
  // offline cache complete. Plain <a href="https://..."> anchors in the
  // About dialog are fine — they only navigate when the user clicks.
  const subresourceRefs = [
    ...html.matchAll(/<(?:script|img|link)\b[^>]*?(?:src|href)="([^"]+)"/gi)
  ].map((m) => m[1]);
  assert.ok(subresourceRefs.length >= 5, 'found subresource refs: ' + subresourceRefs.length);
  for (const ref of subresourceRefs) {
    assert.ok(ref.startsWith('./'), 'subresource must be relative: ' + ref);
  }
  // the referenced files exist
  for (const ref of subresourceRefs.filter((r) => r.startsWith('./'))) {
    assert.ok(exists(ref.slice(2)), 'missing asset: ' + ref);
  }
});

test('manifest.webmanifest is valid and carries file handlers', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  assert.equal(m.display, 'standalone');
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 4);
  for (const icon of m.icons) {
    assert.ok(exists(icon.src.slice(2)), 'icon missing: ' + icon.src);
  }
  assert.ok(m.file_handlers && m.file_handlers.length === 1);
  const accept = m.file_handlers[0].accept;
  const exts = Object.values(accept).flat();
  assert.ok(exts.includes('.pcap') && exts.includes('.pcapng'), 'pcap extensions registered');
  assert.equal(m.file_handlers[0].action, './');
  assert.equal(m.file_handlers[0].launch_type, 'multiple-clients');
  assert.ok(m.share_target && m.share_target.action === './__share');
});

test('all page scripts parse (module + classic)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const exec = promisify(execFile);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsweb-parse-'));
  try {
    for (const f of ['src/app.js', 'src/engine-client.js', 'src/engine-worker.js', 'src/file-handling.js', 'sw.js']) {
      // --check parses as a classic script; ES module sources are staged to
      // a temp .mjs (node rejects --check together with --eval/-e).
      const isModule = ['src/app.js', 'src/engine-client.js', 'src/file-handling.js'].includes(f);
      if (isModule) {
        const staged = path.join(tmp, path.basename(f).replace(/\.js$/, '') + '.mjs');
        fs.writeFileSync(staged, read(f));
        await exec(process.execPath, ['--check', staged]);
      } else {
        await exec(process.execPath, ['--check', f], { cwd: REPO });
      }
      assert.ok(true, f);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('engine worker uses importScripts with correct relative paths', () => {
  const src = read('src/engine-worker.js');
  assert.ok(src.includes("importScripts('../vendor/pako-inflate.min.js')"));
  assert.ok(src.includes("importScripts('../wasm/engine/wiregasm.js')"));
  // never fetches cross-origin
  assert.ok(!/https?:\/\/(?!localhost)/.test(src), 'no external URLs in worker');
});

test('service worker has no external URLs and defers the wasm dir', () => {
  const src = read('sw.js');
  assert.ok(!/https?:\/\/(?!localhost)/.test(src), 'no external URLs');
  assert.ok(src.includes("includes('wasm')"), 'engine assets excluded from install precache');
  assert.ok(src.includes('handleSharePost'), 'share target handled');
  assert.ok(src.includes('offline.html'), 'offline fallback');
});

test('pako is vendored with its license', () => {
  assert.ok(exists('vendor/pako-inflate.min.js'));
  assert.ok(exists('vendor/pako-LICENSE'));
  const src = read('vendor/pako-inflate.min.js');
  assert.ok(src.includes('pako'), 'pako banner');
});

test('icons exist in all needed sizes', () => {
  for (const icon of [
    'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-192.png', 'icons/icon-512.png',
    'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png'
  ]) {
    assert.ok(exists(icon), 'missing ' + icon);
    const buf = fs.readFileSync(path.join(REPO, icon));
    assert.equal(buf[0], 0x89, 'PNG magic in ' + icon);
  }
});

test('workflow files exist and the schedule is weekly', () => {
  const y = read('.github/workflows/publish.yml');
  assert.ok(/cron: '\d+ 4 \* \* 1'/.test(y), 'weekly cron (Monday,04:xx UTC)');
  assert.ok(y.includes('deploy-pages@v4'), 'pages deploy step');
  assert.ok(y.includes('upload-pages-artifact@v3'), 'pages artifact step');
  assert.ok(y.includes('wasm-smoke-test.mjs'), 'smoke test wired');
  assert.ok(y.includes('generate-sw-manifest.mjs'), 'sw manifest wired');
  // engine is pulled from npm, pinned per run
  assert.ok(y.includes('npm pack "@goodtools/wiregasm@$VERSION"'));
});

test('offline.html exists and is standalone', () => {
  const html = read('offline.html');
  assert.ok(/<!doctype html>/i.test(html));
  assert.ok(!/src=|href="(?!#)/.test(html.replace(/<style[\s\S]*<\/style>/, '')), 'no external deps');
});

test('online/offline listeners are on window, never on navigator', () => {
  // Regression: navigator is not an EventTarget — navigator.addEventListener
  // threw a TypeError that killed wireUI() and left the engine stuck on
  // "Engine: loading…" forever. online/offline fire on window.
  for (const f of ['src/app.js', 'src/file-handling.js', 'src/engine-client.js', 'sw.js', 'src/engine-worker.js']) {
    assert.ok(!/navigator\s*\.\s*addEventListener/.test(read(f)), f + ': navigator has no addEventListener');
  }
  const app = read('src/app.js');
  assert.ok(app.includes("window.addEventListener('online'"), 'online listener on window');
  assert.ok(app.includes("window.addEventListener('offline'"), 'offline listener on window');
});

test('makeDemoCapture produces a well-formed 4-packet pcap', () => {
  // Regression: one payload was 13 chars against a fixed 12-byte record
  // length — Uint8Array.set threw RangeError("source array is too long")
  // and the demo button silently did nothing. Extract the function and run
  // it standalone (the app module itself needs a DOM).
  const src = read('src/app.js');
  const m = src.match(/function makeDemoCapture\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'makeDemoCapture found');
  const fn = new Function(m[0] + '; return makeDemoCapture();');
  const b = fn();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(dv.getUint32(0, false), 0xa1b2c3d4, 'pcap magic');
  const PKT = 14 + 20 + 8 + 12;
  assert.equal(b.length, 24 + 4 * (16 + PKT), 'exactly 4 records');
  // walk every record: incl_len == orig_len == PKT, no zero-length payloads
  let o = 24;
  for (let i = 0; i < 4; i++) {
    assert.equal(dv.getUint32(o + 8, false), PKT, 'record ' + i + ' incl_len');
    assert.equal(dv.getUint32(o + 12, false), PKT, 'record ' + i + ' orig_len');
    o += 16 + PKT;
  }
  assert.equal(o, b.length, 'records tile the buffer exactly');
});

test('.gitignore excludes the wasm engine', () => {
  const gi = read('.gitignore');
  assert.ok(/^wasm\/$/m.test(gi));
});
