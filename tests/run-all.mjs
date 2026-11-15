#!/usr/bin/env node
/*
 * Runs every test suite in this directory and prints one table + totals.
 *
 * Usage (from the repo root, or anywhere):
 *
 *   node tests/run-all.mjs                # everything
 *   node tests/run-all.mjs sw-            # only suites whose name matches
 *   VERBOSE=1 node tests/run-all.mjs      # echo each suite's full output
 *
 * Exit code: 0 if every suite passed or was legitimately SKIPPED (e.g. the
 * wasm build is absent), 1 as soon as one suite fails, times out or crashes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');

// Suites in this repo, run in this order: fast static checks first, the
// SW/browser-contract suites next, the engine-driven ones last (they skip
// when no wasm build exists).
const PORTED = [
  'static-files.test.mjs',
  'manifest.test.mjs',
  'sw-test.mjs',
  'worker-integration.test.mjs',
  'file-handling.test.mjs'
];

const NOT_SUITES = new Set(['run-all.mjs']);

const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 600000);
const VERBOSE = process.env.VERBOSE === '1';

const filters = process.argv.slice(2);

/* ------------------------------------------------------------ suite listing */

function listSuites() {
  const found = new Set(PORTED);
  for (const entry of fs.readdirSync(TESTS_DIR)) {
    if (NOT_SUITES.has(entry)) continue;
    if (entry.endsWith('.test.mjs')) found.add(entry);
  }
  // Keep the PORTED order first, then anything else alphabetically.
  return [...found].sort((a, b) => {
    const ia = PORTED.indexOf(a);
    const ib = PORTED.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/* ------------------------------------------------------------- run one suite */

function runSuite(name) {
  return new Promise((resolve) => {
    const file = path.join(TESTS_DIR, name);
    const child = spawn(process.execPath, ['--test', file], {
      cwd: REPO,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (VERBOSE) process.stdout.write(out);
      // Node's test runner exits 0 on pass, 1 on failure, skipped suites
      // still exit 0; a killed suite reports as timed out.
      if (killed) resolve({ name, status: 'TIMEOUT', out });
      else if (code === 0) resolve({ name, status: 'PASS', out });
      else resolve({ name, status: 'FAIL', out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ name, status: 'CRASH', out: String(err) });
    });
  });
}

/* ------------------------------------------------------------------ main */

const suites = listSuites().filter((name) =>
  filters.length === 0 || filters.some((f) => name.includes(f))
);

if (suites.length === 0) {
  console.log('no test suites matched: ' + filters.join(' '));
  process.exit(0);
}

console.log(`running ${suites.length} suite${suites.length > 1 ? 's' : ''}\n`);
const results = [];
for (const name of suites) {
  const res = await runSuite(name);
  results.push(res);
  if (!VERBOSE) {
       // Node prints "ℹ skipped N" — genuinely skipped when N > 0.
    const m = res.out.match(/ℹ skipped (\d+)/);
    const skippedCount = m ? Number(m[1]) : 0;
    const allSkipped = res.status === 'PASS' && skippedCount > 0 &&
      res.out.includes('ℹ tests ' + skippedCount);
    console.log(`  ${allSkipped ? 'SKIP' : res.status}  ${name}`);
  }
}

const failed = results.filter((r) => r.status !== 'PASS');
console.log('');
for (const r of failed) {
  console.log(`--- ${r.name}: ${r.status} ---`);
  const lines = r.out.split('\n').filter((l) => l.trim());
  for (const l of lines.slice(-40)) console.log('  ' + l);
  console.log('');
}
console.log(`total: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
process.exit(failed.length > 0 ? 1 : 0);
