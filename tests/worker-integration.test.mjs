/*
 * Integration test for the real engine path: boots the actual
 * src/engine-worker.js in a Node Worker with the staged wasm engine
 * (wasm/engine/wiregasm.*), loads a capture through the RPC protocol the
 * page uses, and checks the message shapes the UI relies on.
 *
 * Skips (exit 0, one skipped test) when wasm/engine/ is absent — the same
 * condition CI has before the "Download the wiregasm package" step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = path.join(REPO, 'wasm', 'engine');
const WORKER = path.join(REPO, 'src', 'engine-worker.js');
const HAS_ENGINE = ['wiregasm.js', 'wiregasm.wasm.gz', 'wiregasm.data.gz']
  .every((f) => fs.existsSync(path.join(ENGINE_DIR, f)));

/* A 4-packet UDP/IPv4 capture. */
function makePcap() {
  const PL = 12;
  const PKT = 14 + 20 + 8 + PL;
  const N = 4;
  const b = new Uint8Array(24 + N * (16 + PKT));
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0xa1b2c3d4, false);
  dv.setUint16(4, 2, false); dv.setUint16(6, 4, false);
  dv.setUint32(8, 0, false); dv.setUint32(12, 0, false);
  dv.setUint32(16, 65535, false); dv.setUint32(20, 1, false);
  let o = 24;
  for (let i = 0; i < N; i++) {
    dv.setUint32(o, 1731674000 + i, false); dv.setUint32(o + 4, 0, false);
    dv.setUint32(o + 8, PKT, false); dv.setUint32(o + 12, PKT, false);
    o += 16;
    b.set([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 8, 0], o); o += 14;
    b[o] = 0x45; dv.setUint16(o + 2, 20 + 8 + PL, false);
    b[o + 8] = 64; b[o + 9] = 17;
    b[o + 12] = 10; b[o + 13] = 0; b[o + 14] = 0; b[o + 15] = 1;
    b[o + 16] = 10; b[o + 17] = 0; b[o + 18] = 0; b[o + 19] = 2;
    o += 20;
    dv.setUint16(o, 5353, false); dv.setUint16(o + 2, 5353, false);
    dv.setUint16(o + 4, 8 + PL, false); dv.setUint16(o + 6, 0, false);
    o += 8;
    b.set(Array.from('integ pkt %02d'.replace('%02d', String(i).padStart(2, '0')), (c) => c.charCodeAt(0)), o);
    o += PL;
  }
  return b;
}

/*
 * Node's worker_threads understands `importScripts` only inside a classic
 * worker... which Node does not have. The browser worker file is written
 * against importScripts (classic worker, so it works from any static host).
 * For the test we adapt: a tiny shim worker that defines importScripts via
 * dynamic import + a self/postMessage bridge into worker_threads' semantics.
 */
function startWorker() {
  /* Browser semantics: importScripts resolves relative to the worker's own
 * URL (src/engine-worker.js), not the page, and the imported scripts share
 * the worker's global scope (self.pako, self.loadWiregasm). The shim mirrors
 * both: scripts run in THIS context (so their globals land on globalThis),
 * and the worker file itself runs the same way.
 *
 * Node has no fetch for file:, so fetch is mapped to fs reads; the worker
 * fetches its engine assets through it. */
  const shim = `
    const { parentPort, workerData } = require('node:worker_threads');
    const vm = require('node:vm');
    const path = require('node:path');
    const fs = require('node:fs');
    globalThis.self = globalThis;
    // Node keeps module/exports on globalThis (legacy CJS compat); pako's
    // UMD would then attach to module.exports instead of self.pako. A real
    // browser worker has no module/exports — remove them so vendored UMD
    // scripts behave exactly as they do in production.
    delete globalThis.module;
    delete globalThis.exports;
    globalThis.location = new URL('file://' + workerData.workerDir + '/engine-worker.js');
    globalThis.postMessage = (msg) => parentPort.postMessage(msg);
    globalThis.importScripts = (...urls) => {
      for (const u of urls) {
        const abs = path.resolve(workerData.workerDir, u);
        const code = fs.readFileSync(abs, 'utf8');
        // runInThisContext = browser classic-script semantics: var
        // declarations (wiregasm's loadWiregasm) land on the global scope,
        // and pako's UMD sees no module/exports at this scope, so it
        // attaches to self.pako like in a real worker.
        vm.runInThisContext(code, { filename: abs });
      }
    };
    globalThis.fetch = async (url) => {
      const u = new URL(url, globalThis.location);
      if (u.protocol !== 'file:') throw new Error('test fetch only supports file:, got ' + u.href);
      const data = fs.readFileSync(u);
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => String(data.length) },
        body: null,
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      };
    };
    parentPort.on('message', (msg) => {
      globalThis.onmessage && globalThis.onmessage({ data: msg });
    });
    const code = fs.readFileSync(workerData.workerPath, 'utf8');
    vm.runInThisContext(code, { filename: workerData.workerPath });
  `;
  const w = new Worker(shim, {
    eval: true,
    workerData: { workerPath: WORKER, workerDir: path.dirname(WORKER) }
  });
  return w;
}

function rpc(w, type, payload, wantType, seq) {
  return new Promise((resolve, reject) => {
    const onMessage = (msg) => {
      if (msg.type === wantType && (seq == null || msg.seq === seq)) {
        w.off('message', onMessage);
        resolve(msg);
      }
    };
    w.on('message', onMessage);
    w.postMessage(Object.assign({ type, seq: seq || 1 }, payload || {}));
    setTimeout(() => {
      w.off('message', onMessage);
      reject(new Error('timeout waiting for ' + wantType));
    }, 120000);
  });
}

test('engine worker: boot, dissect, RPC shapes', { skip: !HAS_ENGINE }, async () => {
  const w = startWorker();
  try {
    /* boot: progress events then engine-ready */
    const ready = await rpc(w, 'engine-init', {}, 'engine-ready');
    assert.match(ready.version, /^4\./, 'Wireshark version reported');
    assert.ok(Array.isArray(ready.columns) && ready.columns.length >= 6, 'columns array');
    assert.ok(ready.columns.includes('Info'));

    /* load a capture: a REAL File (clones across worker_threads, and the
     * worker only calls .arrayBuffer() on it — exactly what a browser File
     * gives it). */
    const file = new File([makePcap()], 'integ.pcap', { type: 'application/vnd.tcpdump.pcap' });
    const loaded = await rpc(w, 'load', { file }, 'loaded');
    assert.equal(loaded.summary.packet_count, 4);
    assert.match(loaded.summary.file_type, /pcap/i);

    /* frames page */
    const frames = await rpc(w, 'frames', { filter: '', skip: 0, limit: 100 }, 'frames', 2);
    assert.equal(frames.matched, 4);
    assert.equal(frames.frames.length, 4);
    const f0 = frames.frames[0];
    assert.equal(typeof f0.number, 'number');
    assert.ok(Array.isArray(f0.columns) && f0.columns.length >= 6, 'columns per frame');
    assert.ok(f0.columns.some((c) => /UDP|MDNS/.test(c)), 'dissected columns');

    /* filtered frames */
    const filtered = await rpc(w, 'frames', { filter: 'udp.port == 5353', skip: 0, limit: 100 }, 'frames', 3);
    assert.equal(filtered.matched, 4);

    /* single frame detail */
    const detail = await rpc(w, 'frame', { number: 1 }, 'frame', 4);
    const frame = detail.frame;
    assert.ok(Array.isArray(frame.tree) && frame.tree.length >= 4, 'tree root levels');
    const eth = frame.tree[1];
    assert.equal(eth.start, 0);
    assert.equal(eth.length, 14);
    assert.match(eth.label, /Ethernet/);
    assert.ok(frame.data_sources.length >= 1, 'data source present');
    assert.equal(typeof frame.data_sources[0].data, 'string', 'base64 payload');
    const bytes = Buffer.from(frame.data_sources[0].data, 'base64');
    assert.equal(bytes.length, 54);
    assert.ok(Array.isArray(frame.follow) && frame.follow.length >= 1, 'follow candidates');

    /* checkFilter */
    const ok = await rpc(w, 'check-filter', { filter: 'udp' }, 'filter-check', 5);
    assert.equal(ok.ok, true);
    const bad = await rpc(w, 'check-filter', { filter: 'nope(' }, 'filter-check', 6);
    assert.equal(bad.ok, false);
    assert.ok(bad.error.length > 0, 'error text');

    /* follow */
    const follow = await rpc(w, 'follow', { follower: frame.follow[0][0], filter: frame.follow[0][1] }, 'follow', 7);
    assert.ok(Array.isArray(follow.follow.payloads));
    assert.equal(typeof follow.follow.shost, 'string');

    /* tap conversations */
    const tap = await rpc(w, 'tap', { taps: { tap0: 'conv:IPv4' } }, 'tap', 8);
    assert.ok(!tap.error, 'tap ok: ' + tap.error);
    assert.equal(tap.taps.length, 1);
    assert.ok(tap.taps[0].convs.length >= 1, 'conversation rows');
    const conv = tap.taps[0].convs[0];
    assert.equal(conv.saddr, '10.0.0.1');
    assert.equal(conv.daddr, '10.0.0.2');

    /* iograph */
    const io = await rpc(w, 'iograph', { input: { interval: '1000', graph0: 'packets' } }, 'iograph', 9);
    assert.ok(!io.error, 'iograph ok: ' + io.error);
    assert.equal(io.iograph.length, 1);
    assert.ok(io.iograph[0].items.length >= 1);
  } finally {
    await w.terminate();
  }
});

test('engine worker reports load errors gracefully', { skip: !HAS_ENGINE }, async () => {
  const w = startWorker();
  try {
    await rpc(w, 'engine-init', {}, 'engine-ready');
    /* 8 zero bytes: a pcap-shaped header with a zero magic — wiretap
     * refuses it (4 arbitrary bytes would be sniffed as a raw-IP capture,
     * which is a successful open, not an error). */
    const bad = await rpc(w, 'load', {
      file: new File([new Uint8Array(8)], 'bad.pcap')
    }, 'load-error');
    assert.ok(bad.error.length > 0, 'error message present');
    /* and the worker still answers frames afterwards (no dead session) */
    const frames = await rpc(w, 'frames', { filter: '', skip: 0, limit: 10 }, 'frames', 2);
    assert.equal(frames.error, 'no capture loaded');
    assert.equal(frames.frames.length, 0);
  } finally {
    await w.terminate();
  }
});
