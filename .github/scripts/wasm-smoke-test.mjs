// Smoke-test the staged wiregasm engine under Node before it is deployed:
// boots the module, initializes the dissectors, dissects a synthetic pcap,
// and round-trips the APIs the site uses (frames, tree, filter, follow, tap,
// iograph, download). Exits non-zero on the first failure.
//
// Usage: node wasm-smoke-test.mjs <engine-dir> [<out-dir>]
//<engine-dir>  where wiregasm.js/.wasm.gz/.data.gz are staged (e.g. wasm/engine)
//   <out-dir>     optional directory for diagnostics (defaults to <engine-dir>)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('usage: node wasm-smoke-test.mjs <engine-dir>');
  process.exit(2);
}

const engineDir = path.resolve(args[0]);
const loaderPath = path.join(engineDir, 'wiregasm.js');
const wasmPath = path.join(engineDir, 'wiregasm.wasm.gz');
const dataPath = path.join(engineDir, 'wiregasm.data.gz');

for (const f of [loaderPath, wasmPath, dataPath]) {
  if (!fs.existsSync(f)) {
    console.error(`wasm-smoke-test: missing ${path.relative(process.cwd(), f)}`);
    process.exit(1);
  }
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/* A small valid pcap: one Ethernet/IPv4/UDP packet with payload. */
function makePcap() {
  const PL = 12;
  const PKT = 14 + 20 + 8 + PL;
  const b = new Uint8Array(24 + 16 + PKT);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0xa1b2c3d4, false); // magic, LE, usec
  dv.setUint16(4, 2, false); dv.setUint16(6, 4, false);
  dv.setUint32(8, 0, false); dv.setUint32(12, 0, false);
  dv.setUint32(16, 65535, false); dv.setUint32(20, 1, false);
  let o = 24;
  dv.setUint32(o, 1731674000, false); dv.setUint32(o + 4, 0, false);
  dv.setUint32(o + 8, PKT, false); dv.setUint32(o + 12, PKT, false);
  o += 16;
  b.set([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 8, 0], o); o += 14; // eth
  b[o] = 0x45; dv.setUint16(o + 2, 20 + 8 + PL, false);
  b[o + 8] = 64; b[o + 9] = 17;
  b[o + 12] = 10; b[o + 13] = 0; b[o + 14] = 0; b[o + 15] = 1;
  b[o + 16] = 10; b[o + 17] = 0; b[o + 18] = 0; b[o + 19] = 2;
  o += 20;
  dv.setUint16(o, 5353, false); dv.setUint16(o + 2, 5353, false);
  dv.setUint16(o + 4, 8 + PL, false); dv.setUint16(o + 6, 0, false);
  o += 8;
  b.set(Array.from('smoke-test!!', (c) => c.charCodeAt(0)), o);
  return b;
}

function vec2array(v) {
  const out = [];
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  v.delete();
  return out;
}

async function main() {
  console.log('wasm-smoke-test: booting engine from ' + engineDir);

  const loadWiregasm = (await import(pathToFileURL(loaderPath))).default;
  const wasm = zlib.gunzipSync(fs.readFileSync(wasmPath));
  const data = zlib.gunzipSync(fs.readFileSync(dataPath));

  const lib = await loadWiregasm({
    wasmBinary: wasm.buffer,
    getPreloadedPackage: () => data.buffer,
    print: () => {},
    printErr: () => {}
  });

  check('module instantiated', typeof lib.init === 'function');
  check('init()', lib.init() === true);
  const version = lib.wiresharkVersion();
  check('wiresharkVersion()', /^4\./.test(version), 'got ' + version);
  console.log('  engine reports Wireshark ' + version);

  const columns = vec2array(lib.getColumns());
  check('getColumns()', columns.length >= 6 && columns.includes('Info'), columns.join(','));

  const uploadDir = lib.getUploadDirectory();
  check('getUploadDirectory()', typeof uploadDir === 'string' && uploadDir.length > 0, uploadDir);
  lib.FS.writeFile(uploadDir + '/smoke.pcap', makePcap());

  const session = new lib.DissectSession(uploadDir + '/smoke.pcap');
  const load = session.load();
  check('load()', load.code === 0, load.error);
  check('summary.packet_count', load.summary.packet_count === 1,
    'got ' + load.summary.packet_count);
  check('summary.file_type', /pcap/i.test(load.summary.file_type), load.summary.file_type);

  const frames = session.getFrames('', 0, 100);
  check('getFrames().matched', frames.matched === 1, 'got ' + frames.matched);
  const meta = frames.frames.get(0);
  check('frame columns', meta.columns.size() === columns.length,
    meta.columns.size() + ' vs ' + columns.length);
  const protoCol = meta.columns.get(4);
  check('dissected as UDP-layer', protoCol === 'UDP' || protoCol === 'MDNS', protoCol);

  const filtered = session.getFrames('udp.port == 5353', 0, 100);
  check('display filter matches', filtered.matched === 1, 'got ' + filtered.matched);
  const rejected = session.getFrames('tcp', 0, 100);
  check('display filter rejects', rejected.matched === 0, 'got ' + rejected.matched);

  const frame = session.getFrame(1);
  check('getFrame().tree', frame.tree.size() >= 4, 'got ' + frame.tree.size());
  const eth = frame.tree.get(1);
  check('tree offsets (Ethernet: start 0 len 14)', eth.start === 0 && eth.length === 14,
    `start=${eth.start} len=${eth.length}`);
  const ds = frame.data_sources.get(0);
  const bytes = Buffer.from(ds.data, 'base64');
  check('data_sources base64', bytes.length === 54, 'got ' + bytes.length);
  check('follow candidates', frame.follow.size() >= 1,
    'got ' + frame.follow.size());
  const fc = frame.follow.get(0);
  check('follow candidate pair', fc.get(0) === 'UDP' && /udp\.stream/.test(fc.get(1)),
    fc.get(0) + '|' + fc.get(1));

  const follow = session.follow(fc.get(0), fc.get(1));
  check('follow() payloads', follow.payloads.size() >= 1, 'got ' + follow.payloads.size());

  const cf = lib.checkFilter('udp.port == 5353');
  check('checkFilter(ok)', cf.ok === true);
  const cf2 = lib.checkFilter('bad((');
  check('checkFilter(bad)', cf2.ok === false);

  const convArgs = new lib.MapInput();
  convArgs.set('tap0', 'conv:IPv4');
  const conv = session.tap(convArgs);
  convArgs.delete();
  check('tap conv:IPv4', !conv.error && conv.taps.size() === 1, conv.error);
  const ct = conv.taps.get(0);
  check('conversation rows', ct.convs.size() >= 1, 'got ' + ct.convs.size());

  const eoArgs = new lib.MapInput();
  eoArgs.set('tap0', 'eo:http');
  const eo = session.tap(eoArgs);
  eoArgs.delete();
  check('tap eo:http (empty ok)', !eo.error, eo.error);

  const ioArgs = new lib.MapInput();
  ioArgs.set('interval', '1000');
  ioArgs.set('graph0', 'packets');
  const io = session.iograph(ioArgs);
  ioArgs.delete();
  check('iograph packets', !io.error && io.iograph.size() === 1, io.error);
  const series = io.iograph.get(0);
  check('iograph series data', series.items.size() >= 1, 'got ' + series.items.size());

  session.delete();

  if (failures > 0) {
    console.error(`wasm-smoke-test: FAILED (${failures} check${failures > 1 ? 's' : ''})`);
    process.exit(1);
  }
  console.log('wasm-smoke-test: all checks passed');
}

main().catch((err) => {
  console.error('wasm-smoke-test: crashed — ' + (err && err.stack || err));
  process.exit(1);
});
