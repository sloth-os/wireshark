/*
 * wireshark-web — application shell.
 *
 * Wires the UI to src/engine-client.js (worker RPC) and
 * src/file-handling.js (drop / picker / launchQueue / share target).
 * Framework-free ES module; every asset is same-origin.
 */

'use strict';

import { createEngineClient } from './engine-client.js';
import { initFileHandling, looksLikeCapture } from './file-handling.js';

/* ------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB';
  return (n / 1073741824).toFixed(2) + ' GiB';
}

function fmtTime(rel) {
  const s = Number(rel);
  if (!isFinite(s)) return '—';
  if (s < 1e-6) return (s * 1e9).toFixed(0) + ' ns';
  if (s < 1e-3) return (s * 1e6).toFixed(1) + ' µs';
  if (s < 1) return (s * 1e3).toFixed(2) + ' ms';
  return s.toFixed(6) + ' s';
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

function setStatus(text, cls) {
  const el = $('status-msg');
  el.textContent = text;
  el.className = cls || '';
}

/* ------------------------------------------------------------- state */

const state = {
  engine: null,           /* engine client */
  engineReady: false,
  columns: [],            /* column titles from the engine */
  frames: [],             /* current page of FrameMeta */
  matched: 0,             /* frames matching the filter */
  packetCount: 0,
  selected: 0,            /* frame number of selection */
  filter: '',
  filterOk: true,
  pendingFile: null,      /* file arrived before engine ready */
  busy: false,
  sort: { col: 0, dir: 1 },
  stats: 'conversations',
  followState: { follower: '', filter: '' },
  pageSize: 500
};

/* ------------------------------------------------------------ engine */

async function bootEngine() {
  const overlay = $('progress-overlay');
  const fill = $('progress-fill');
  const stage = $('progress-stage');
  overlay.hidden = false;

  const engine = createEngineClient(new URL('./src/engine-worker.js', document.baseURI).href);
  state.engine = engine;
  engine.setCallbacks({
    onProgress: function (kind, loaded, total) {
      if (kind === 'wasm' || kind === 'data') {
        const pct = total ? Math.min(100, (loaded / total) * 88) : 0; /* 2 assets => 0..88 */
        fill.style.width = pct.toFixed(1) + '%';
        stage.textContent = 'downloading ' + kind + ' — ' + fmtBytes(loaded) + (total ? ' / ' + fmtBytes(total) : '');
      }
    },
    onEngineStatus: function (status) {
      stage.textContent = status;
 fill.style.width = '94%';
    },
    onEngineLog: function (level, text) {
      if (level === 'error') console.error('[engine] ' + text);
      else if (level === 'warn') console.warn('[engine] ' + text);
    },
    onLoaded: function (msg) {
      /* loaded handled through the load() promise too; keep status line fresh */
      setStatus('opened ' + msg.name + ' — ' + fmtNum(msg.summary.packet_count) + ' packets in ' + msg.ms + ' ms', 'ok');
    },
    onLoadError: function (msg) {
      setStatus('could not open capture: ' + msg.error, 'error');
    }
  });

  try {
    fill.style.width = '2%';
    const ready = await engine.init();
    state.engineReady = true;
    state.columns = ready.columns || [];
    fill.style.width = '100%';
    overlay.hidden = true;
    $('welcome-engine').textContent = 'Engine ready — Wireshark ' + ready.version + ' dissectors loaded.';
    $('engine-version').textContent = 'Wireshark ' + ready.version;
    $('about-ws-version').textContent = ready.version;
    buildPacketHeader();
    setStatus('engine ready — open a capture to begin', 'ok');
    if (state.pendingFile) {
      const f = state.pendingFile;
      state.pendingFile = null;
      loadFile(f);
    }
  } catch (err) {
    overlay.hidden = true;
    setStatus('engine failed to load: ' + (err && err.message || err), 'error');
    console.error(err);
  }

  /* build info (network-first via sw) */
  try {
    const res = await fetch(new URL('./build-info.json', document.baseURI), { cache: 'no-store' });
    if (res.ok) {
      const info = await res.json();
      $('about-engine').textContent = info.version || 'wiregasm';
      $('about-build').textContent = (info.builtAt || '') + (info.wiregasm ? ' · wiregasm ' + info.wiregasm : '');
    }
  } catch { /* offline or absent: fine */ }
}

/* ------------------------------------------------------------- loading */

async function loadFile(file) {
  if (!state.engineReady) {
    state.pendingFile = file;
    setStatus('engine still loading — the capture will open when it is ready');
    return;
  }
  state.busy = true;
  setStatus('dissecting ' + file.name + '…');
  try {
    const msg = await state.engine.load(file);
    state.busy = false;
    if (msg.type === 'load-error') {
      setStatus('could not open ' + file.name + ': ' + msg.error, 'error');
      return;
    }
    /* msg.type === 'loaded' */
    const s = msg.summary;
    state.packetCount = s.packet_count;
    state.selected = 0;
    state.filter = '';
    $('filter-input').value = '';
    updateFilterStatus({ ok: true, error: '' });
    $('welcome').hidden = true;
    $('analyzer').hidden = false;
    $('capture-summary').textContent =
      msg.name + ' — ' + s.file_type + ', ' + fmtNum(s.packet_count) + ' packets, ' + fmtBytes(s.file_length);
    await refreshFrames(0);
    selectFrame(1, true);
    /* stats depend on the capture */
    state.followState = { follower: '', filter: '' };
    renderStats();
  } catch (err) {
    state.busy = false;
    setStatus('failed: ' + (err && err.message || err), 'error');
  }
}

/* ------------------------------------------------------- packet list */

async function refreshFrames(scrollTop) {
  const msg = await state.engine.frames(state.filter, 0, state.pageSize);
  if (msg.error) {
    setStatus('frames: ' + msg.error, 'error');
    return;
  }
  state.frames = msg.frames;
  state.matched = msg.matched;
  $('frames-shown').textContent = fmtNum(msg.frames.length) + ' / ' + fmtNum(msg.matched);
  const body = $('packet-body');
  body.textContent = '';

  const frag = document.createDocumentFragment();
  for (const f of msg.frames) {
    const tr = document.createElement('tr');
    tr.dataset.frame = f.number;
    const cols = f.columns;
    for (let i = 0; i < cols.length; i++) {
      const td = document.createElement('td');
      if (i === 0) {
        td.className = 'no';
        td.textContent = cols[0];
      } else {
        td.textContent = cols[i] || '';
        td.title = cols[i] || '';
      }
      tr.appendChild(td);
    }
    if (f.marked) tr.classList.add('marked');
    if (f.comments) tr.classList.add('commented');
    tr.addEventListener('click', () => selectFrame(f.number, false));
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  if (scrollTop != null) $('packet-table-wrap').scrollTop = scrollTop;
}

function buildPacketHeader() {
  const row = $('packet-head-row');
  row.textContent = '';
  const titles = state.columns.length ? state.columns : ['No.', 'Time', 'Source', 'Destination', 'Protocol', 'Length', 'Info'];
  titles.forEach(function (title, i) {
    const th = document.createElement('th');
    th.textContent = title;
    th.dataset.col = String(i);
    if (i === state.sort.col) th.classList.add('sorted-' + (state.sort.dir === 1 ? 'asc' : 'desc'));
    th.addEventListener('click', function () {
      if (state.sort.col === i) state.sort.dir *= -1;
      else { state.sort.col = i; state.sort.dir = 1; }
      sortRows();
    });
    row.appendChild(th);
  });
}

/* Sort the currently loaded frame rows in place (string/number aware). */
function sortRows() {
  const rows = Array.from($('packet-body').children);
  const col = state.sort.col;
  const dir = state.sort.dir;
  const numeric = col === 0 || state.columns[col] === 'Length';
  rows.sort(function (a, b) {
    const ca = a.children[col] ? a.children[col].textContent : '';
    const cb = b.children[col] ? b.children[col].textContent : '';
    if (numeric) return (parseFloat(ca) - parseFloat(cb)) * dir;
    return ca.localeCompare(cb) * dir;
  });
  const body = $('packet-body');
  for (const r of rows) body.appendChild(r);
  buildPacketHeader();
  const sel = body.querySelector('tr.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function selectFrame(number, scroll) {
  if (!number) return;
  state.selected = number;
  const rows = $('packet-body').children;
  for (const tr of rows) {
    tr.classList.toggle('selected', Number(tr.dataset.frame) === number);
  }
  if (scroll) {
    const sel = $('packet-body').querySelector('tr[data-frame="' + number + '"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  try {
    const msg = await state.engine.frame(number);
    if (msg.error) { setStatus('frame: ' + msg.error, 'error'); return; }
    renderTree(msg.frame);
    renderHex(msg.frame);
    setStatus('frame ' + number + ' of ' + fmtNum(state.matched) + (state.filter ? ' (filtered from ' + fmtNum(state.packetCount) + ')' : ''));
  } catch (err) {
    setStatus('frame: ' + (err && err.message || err), 'error');
  }
}

/* ------------------------------------------------------ protocol tree */

function renderTree(frame) {
  const host = $('proto-tree');
  host.textContent = '';
  const root = document.createElement('ul');
  for (const node of frame.tree) root.appendChild(treeNodeLi(node));
  host.appendChild(root);
}

function treeNodeLi(node) {
  const li = document.createElement('li');
  const hasChildren = node.tree && node.tree.length;
  li.className = hasChildren ? '' : 'leaf';
  if (node.severity) li.classList.add('severity-' + node.severity);

  const row = document.createElement('span');
  row.className = 'row';
  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = ' ';
  row.appendChild(twisty);

  const label = document.createElement('span');
  label.className = 'label' + (node.type === 'proto' ? ' label-proto' : '');
  label.textContent = node.label;
  row.appendChild(label);

  if (node.filter) {
    const apply = document.createElement('button');
    apply.className = 'apply-filter';
    apply.type = 'button';
    apply.title = 'Use as display filter: ' + node.filter;
    apply.textContent = node.type === 'proto' || !node.type ? '== ' + node.filter : '= ' + node.filter;
    apply.addEventListener('click', function (e) {
      e.stopPropagation();
      setFilter(node.type === 'proto' || !node.type ? node.filter : node.filter);
    });
    row.appendChild(apply);
    const hint = document.createElement('span');
    hint.className = 'filter-hint';
    hint.textContent = node.filter;
    row.appendChild(hint);
  }

  row.addEventListener('click', function () {
    document.querySelectorAll('#proto-tree .row.selected').forEach(function (r) { r.classList.remove('selected'); });
    row.classList.add('selected');
    highlightHex(node.start, node.length, node.data_source_idx || 0);
  });
  li.appendChild(row);

  if (hasChildren) {
    twisty.addEventListener('click', function (e) {
      e.stopPropagation();
      li.classList.toggle('collapsed');
    });
    /* depth-limit: auto-collapse below depth 2 to keep the tree readable */
    const ul = document.createElement('ul');
    for (const child of node.tree) ul.appendChild(treeNodeLi(child));
    li.appendChild(ul);
  }
  return li;
}

/* ------------------------------------------------------------- hex view */

function renderHex(frame) {
  const host = $('hex-view');
  host.textContent = '';
  frame.data_sources.forEach(function (ds, idx) {
    if (frame.data_sources.length > 1) {
      const h = document.createElement('div');
      h.className = 'ds-name';
      h.textContent = ds.name;
      host.appendChild(h);
    }
    const bytes = base64ToBytes(ds.data);
    host.appendChild(hexBlock(bytes, 'ds' + idx));
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/*16 bytes per line: offset, hex, ascii. Bytes in [start, start+len) get<b>. */
function hexBlock(bytes, dsId) {
  const wrap = document.createElement('div');
  wrap.className = 'hexblock';
  wrap.dataset.ds = dsId;
  for (let off = 0; off < bytes.length; off += 16) {
    const line = document.createElement('div');
    const o = document.createElement('span');
    o.className = 'offset';
    o.textContent = off.toString(16).padStart(4, '0');
    line.appendChild(o);

    const hexSpan = document.createElement('span');
    hexSpan.className = 'hexbytes';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      const b = bytes[off + i];
      if (b == null) {
        hexSpan.appendChild(document.createTextNode('  '));
        hexSpan.appendChild(document.createTextNode(i === 7 ? '  ' : ' '));
        ascii += ' ';
        continue;
      }
      const t = document.createElement('span');
      t.textContent = b.toString(16).padStart(2, '0');
      t.dataset.off = String(off + i);
      hexSpan.appendChild(t);
      hexSpan.appendChild(document.createTextNode(i === 7 ? '  ' : ' '));
      ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
    }
    line.appendChild(hexSpan);

    const a = document.createElement('span');
    a.className = 'ascii';
    a.textContent = ascii;
    line.appendChild(a);
    wrap.appendChild(line);
  }
  return wrap;
}

function highlightHex(start, length, dsIdx) {
  /* clear previous highlights in all blocks */
  document.querySelectorAll('#hex-view b').forEach(function (b) {
    const parent = b.parentNode;
    parent.replaceChild(document.createTextNode(b.textContent), b);
    parent.normalize();
  });
  if (!length) return;
  const block = document.querySelector('#hex-view .hexblock[data-ds="ds' + (dsIdx || 0) + '"]');
  if (!block) return;
  for (let off = start; off < start + length; off++) {
    const t = block.querySelector('span[data-off="' + off + '"]');
    if (!t) continue;
    const b = document.createElement('b');
    b.textContent = t.textContent;
    t.replaceWith(b);
  }
  const first = block.querySelector('b');
  if (first && first.parentElement) {
    const line = first.parentElement;
    line.scrollIntoView({ block: 'nearest' });
  }
}

/* ------------------------------------------------------------- filter */

let filterTimer = null;

function setFilter(text) {
  $('filter-input').value = text;
  applyFilter();
}

async function updateFilterStatus(check) {
  const el = $('filter-status');
  if (!check.filter) {
    el.textContent = '';
    el.className = 'filter-status';
    $('filter-input').classList.remove('invalid');
    return;
  }
  const res = await state.engine.checkFilter(check.filter);
  if ($('filter-input').value !== check.filter) return; /* stale */
  if (res.ok) {
    el.textContent = '✓';
    el.className = 'filter-status ok';
    $('filter-input').classList.remove('invalid');
  } else {
    el.textContent = '✗';
    el.className = 'filter-status err';
    $('filter-input').classList.add('invalid');
    el.title = res.error || 'invalid filter';
  }
  state.filterOk = res.ok;
}

async function applyFilter() {
  const text = $('filter-input').value.trim();
  const check = await state.engine.checkFilter(text);
  if (!check.ok && text) {
    state.filterOk = false;
    setStatus('invalid filter: ' + check.error, 'error');
    return;
  }
  state.filterOk = true;
  state.filter = text;
  await refreshFrames(0);
  selectFrame(state.frames.length ? state.frames[0].number : 0, true);
  setStatus(text
    ? 'filter applied — ' + fmtNum(state.matched) + ' of ' + fmtNum(state.packetCount) + ' packets'
    : 'showing all ' + fmtNum(state.packetCount) + ' packets', 'ok');
}

/* ----------------------------------------------------------- statistics */

const TAP_PROTO_NAMES = {
  conversations: ['IPv4', 'Ethernet', 'TCP', 'UDP', 'IPv6'],
  endpoints: ['IPv4', 'Ethernet', 'TCP', 'UDP', 'IPv6']
};

async function renderStats() {
  const body = $('stats-body');
  const tab = state.stats;
  body.textContent = '';
  if (!state.engineReady || !state.frames.length) {
    body.innerHTML = '<p class="empty">Open a capture to see statistics.</p>';
    return;
  }

  try {
    if (tab === 'conversations' || tab === 'endpoints') {
      await renderConversations(body, tab);
    } else if (tab === 'follow') {
      await renderFollow(body);
    } else if (tab === 'iograph') {
      await renderIograph(body);
    } else if (tab === 'objects') {
      await renderExportObjects(body);
    }
  } catch (err) {
    body.innerHTML = '<p class="empty">' + escapeHtml(String(err && err.message || err)) + '</p>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

async function renderConversations(body, kind) {
  /* try the tap for a few common protocols; show whichever has data */
  const taps = {};
  taps.tap0 = (kind === 'conversations' ? 'conv:' : 'endpt:') + 'IPv4';
  const msg = await state.engine.tap(taps);
  if (msg.error || !msg.taps.length || !msg.taps[0].convs) {
    body.innerHTML = '<p class="empty">' + escapeHtml(msg.error || 'no data') + '</p>';
    return;
  }
  const tap = msg.taps[0];
  const rows = kind === 'conversations' ? tap.convs : tap.hosts;
  if (!rows || !rows.length) {
    body.innerHTML = '<p class="empty">No ' + kind + ' found.</p>';
    return;
  }
  const table = document.createElement('table');
  const isConv = kind === 'conversations';
  const head = isConv
    ? ['Source', 'Destination', 'Port ⇄', 'Frames', 'Bytes', 'Start', 'Stop']
    : ['Host', 'Port', 'Frames', 'Bytes'];
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = h;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.title = 'Click to filter: ' + r.filter;
    const cells = isConv
      ? [r.saddr, r.daddr, (r.sport || '') + ' ⇄ ' + (r.dport || ''), fmtNum(r.txf + r.rxf), fmtBytes(r.txb + r.rxb), fmtTime(r.start), fmtTime(r.stop)]
      : [r.host, r.port || '—', fmtNum(r.txf + r.rxf), fmtBytes(r.txb + r.rxb)];
    cells.forEach(function (c) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    });
    tr.addEventListener('click', function () {
      if (r.filter) setFilter(r.filter);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

async function renderFollow(body) {
  /* follower picker from the selected frame's follow candidates */
  const frameMsg = await state.engine.frame(state.selected || (state.frames[0] && state.frames[0].number) || 1);
  const candidates = (frameMsg.frame && frameMsg.frame.follow) || [];
  if (!candidates.length) {
    body.innerHTML = '<p class="empty">No followable stream in this frame.</p>';
    return;
  }

  const controls = document.createElement('div');
  controls.className = 'follow-controls';
  const sel = document.createElement('select');
  candidates.forEach(function (c, i) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = c[0] + ' (' + c[1] + ')';
    sel.appendChild(o);
  });
  sel.value = '0';
  const followBtn = document.createElement('button');
  followBtn.className = 'btn btn-small';
  followBtn.textContent = 'Follow';
  const modeLabel = document.createElement('label');
  const mode = document.createElement('input');
  mode.type = 'checkbox';
  modeLabel.appendChild(mode);
  modeLabel.appendChild(document.createTextNode(' raw (hex)'));
  controls.appendChild(sel);
  controls.appendChild(mode);
  controls.appendChild(modeLabel);
  controls.appendChild(followBtn);
  body.appendChild(controls);

  const out = document.createElement('div');
  out.id = 'follow-output';
  body.appendChild(out);

  async function doFollow() {
    const c = candidates[Number(sel.value)] || candidates[0];
    const res = await state.engine.follow(c[0], c[1]);
    if (res.error) { out.textContent = res.error; return; }
    const f = res.follow;
    out.textContent = '';
    const head = document.createElement('div');
    head.textContent =
      'Stream: ' + f.shost + ':' + f.sport + ' ⇄ ' + f.chost + ':' + f.cport +
      '   (' + fmtBytes(f.sbytes) + ' ⇄ ' + fmtBytes(f.cbytes) + ')';
    head.style.marginBottom = '0.5rem';
    out.appendChild(head);
    for (const p of f.payloads) {
      const span = document.createElement('span');
      span.className = p.server ? 'srv' : 'cli';
      const bytes = base64ToBytes(p.data);
      if (mode.checked) {
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0') + (i % 16 === 15 ? '\n' : ' ');
        span.textContent = hex + '\n';
      } else {
        let text = '';
        for (const b of bytes) text += (b >= 32 && b < 127) || b === 10 || b === 13 || b === 9 ? String.fromCharCode(b) : '.';
        span.textContent = text;
      }
      out.appendChild(span);
    }
    if (!f.payloads.length) out.appendChild(document.createTextNode('(no payload)'));
  }

  followBtn.addEventListener('click', doFollow);
  mode.addEventListener('change', doFollow);
  doFollow();
}

async function renderIograph(body) {
  const wrap = document.createElement('div');
  wrap.className = 'graph-wrap';
  const msg = await state.engine.iograph({ interval: '1000', graph0: 'packets' });
  if (msg.error) {
    body.innerHTML = '<p class="empty">' + escapeHtml(msg.error) + '</p>';
    return;
  }
  const items = (msg.iograph[0] && msg.iograph[0].items) || [];
  if (!items.length) { body.innerHTML = '<p class="empty">No graph data.</p>'; return; }
  const max = Math.max.apply(null, items);
  const W = 600, H = 160, padL = 34, padB = 18;
  const n = items.length;
  const x = (i) => padL + (i / Math.max(1, n - 1)) * (W - padL - 8);
  const y = (v) => H - padB - (v / (max || 1)) * (H - padB - 10);
  let path = '';
  items.forEach(function (v, i) { path += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; });
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="packets per second">' +
    '<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - 8) + '" y2="' + (H - padB) + '" stroke="currentColor" opacity="0.3"/>' +
    '<line x1="' + padL + '" y1="10" x2="' + padL + '" y2="' + (H - padB) + '" stroke="currentColor" opacity="0.3"/>' +
    '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="1.5"/>' +
    '<text class="axis" x="' + (padL - 4) + '" y="14" text-anchor="end">' + max + '</text>' +
    '<text class="axis" x="' + (padL - 4) + '" y="' + (H - padB) + '" text-anchor="end">0</text>' +
    '<text class="axis" x="' + W / 2 + '" y="' + (H - 4) + '" text-anchor="middle">seconds →</text>' +
    '</svg>';
  wrap.innerHTML = svg;
  body.appendChild(wrap);
}

async function renderExportObjects(body) {
  const msg = await state.engine.tap({ tap0: 'eo:http' });
  const objects = (msg.taps.length && msg.taps[0].objects) || [];
  if (!objects.length) {
    body.innerHTML = '<p class="empty">No HTTP objects found in this capture.</p>';
    return;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  ['Packet', 'Host', 'Type', 'Filename', 'Size', ''].forEach(function (h) {
    const th = document.createElement('th');
    th.textContent = h;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const o of objects) {
    const tr = document.createElement('tr');
    [String(o.pkt), o.hostname || '', o.type || '', o.filename || '', fmtBytes(o.len)].forEach(function (c) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    });
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = 'Save';
    btn.addEventListener('click', async function () {
      const dl = await state.engine.download(o._download);
      if (dl.error || !dl.download) { setStatus('download: ' + (dl.error || 'failed'), 'error'); return; }
      const bytes = base64ToBytes(dl.download.data);
      const blob = new Blob([bytes], { type: dl.download.mime || 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = dl.download.file || o.filename || 'object.bin';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    });
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

/* --------------------------------------------------------------- UI wire */

function wireUI() {
  /* open buttons */
  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('btn-open-2').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });

  /* native picker (Chromium only) */
  if (window.showOpenFilePicker) $('btn-pick').hidden = false;
  $('btn-pick').addEventListener('click', async function () {
    try {
      const ok = await fileHandling.pickFile();
      if (!ok) $('file-input').click();
    } catch { $('file-input').click(); }
  });

  /* drag & drop everywhere */
  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      e.preventDefault();
      const dz = $('dropzone');
      if (dz) dz.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      e.preventDefault();
      const dz = $('dropzone');
      if (dz) dz.classList.remove('dragging');
      document.body.style.outline = '';
    });
  });
  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    /* prefer capture-looking files */
    const cap = files.find(function (f) { return looksLikeCapture(f.name); });
    loadFile(cap || files[0]);
  });

  /* filter */
  $('filter-input').addEventListener('input', function (e) {
    clearTimeout(filterTimer);
    const v = e.target.value;
    filterTimer = setTimeout(function () { updateFilterStatus({ filter: v }); }, 350);
  });
  $('filter-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); applyFilter(); }
  });
  $('filter-apply').addEventListener('click', applyFilter);
  $('filter-clear').addEventListener('click', function () { setFilter(''); });

  /* frame navigation */
  $('btn-prev').addEventListener('click', () => stepFrame(-1));
  $('btn-next').addEventListener('click', () => stepFrame(1));
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowUp') { e.preventDefault(); stepFrame(-1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); stepFrame(1); }
  });

  /* detail tabs */
  $('tab-tree').addEventListener('click', () => switchDetail('tree'));
  $('tab-hex').addEventListener('click', () => switchDetail('hex'));

  /* stats tabs */
  document.querySelectorAll('.stats-tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.stats-tabs button').forEach(function (b) { b.setAttribute('aria-selected', 'false'); });
      btn.setAttribute('aria-selected', 'true');
      state.stats = btn.dataset.stats;
      renderStats();
    });
  });

  /* about */
  $('btn-about').addEventListener('click', () => $('about').showModal());
  $('about-close').addEventListener('click', () => $('about').close());

  /* demo capture: generated in-page, dissected like a real file */
  $('btn-demo').addEventListener('click', function () {
    const pcap = makeDemoCapture();
    loadFile(new File([pcap], 'demo-dhcp.pcap', { type: 'application/vnd.tcpdump.pcap' }));
  });

  /* network status pill */
  function updateNet() {
    const el = $('net-status');
    if (navigator.onLine) {
      el.textContent = 'online';
      el.className = 'pill good';
    } else {
      el.textContent = 'offline';
      el.className = 'pill warn';
    }
  }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  /* service worker */
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(new URL('./sw.js', document.baseURI).href)
      .then(function (reg) {
        $('sw-hint').textContent = reg ? 'offline-ready' : '';
      })
      .catch(function (err) {
        console.warn('service worker failed: ' + (err && err.message || err));
      });
  }
}

function switchDetail(which) {
  $('tab-tree').setAttribute('aria-selected', String(which === 'tree'));
  $('tab-hex').setAttribute('aria-selected', String(which === 'hex'));
  $('proto-tree-panel').hidden = which !== 'tree';
  $('hex-panel').hidden = which !== 'hex';
}

function stepFrame(delta) {
  const idx = state.frames.findIndex(function (f) { return f.number === state.selected; });
  let next = idx + delta;
  if (next < 0) next = 0;
  if (next >= state.frames.length) next = state.frames.length - 1;
  const f = state.frames[next];
  if (f) selectFrame(f.number, true);
}

/* -------------------------------------------------- demo capture bytes */

/* A minimal 4-packet UDP/IPv4 capture, so the sample button works offline. */
function makeDemoCapture() {
  const PKT = 14 + 20 + 8 + 12;
  const N = 4;
  const b = new Uint8Array(24 + N * (16 + PKT));
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0xa1b2c3d4, false);
  dv.setUint16(4, 2, false); dv.setUint16(6, 4, false);
  dv.setUint32(8, 0, false); dv.setUint32(12, 0, false);
  dv.setUint32(16, 65535, false); dv.setUint32(20, 1, false);
  let o = 24;
  /* Payloads must be exactly 12 bytes — the record length is fixed at
   * PKT above; a longer payload makes Uint8Array.set throw RangeError. */
  const payloads = [0, 1, 2, 3].map(function (i) {
    return ('demo pkt' + String(i + 1).padStart(4, '0')).slice(0, 12);
  });
  for (let i = 0; i < N; i++) {
    dv.setUint32(o, 1731674000 + i, false); dv.setUint32(o + 4, 0, false);
    dv.setUint32(o + 8, PKT, false); dv.setUint32(o + 12, PKT, false);
    o += 16;
    b.set([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 8, 0], o); o += 14;
    b[o] = 0x45; dv.setUint16(o + 2, 20 + 8 + 12, false);
    dv.setUint16(o + 4, i, false);
    b[o + 6] = 0; b[o + 7] = 0; b[o + 8] = 64; b[o + 9] = 17; dv.setUint16(o + 10, 0, false);
    b[o + 12] = 10; b[o + 13] = 0; b[o + 14] = 0; b[o + 15] = 1;
    b[o + 16] = 10; b[o + 17] = 0; b[o + 18] = 0; b[o + 19] = 2;
    o += 20;
    dv.setUint16(o, 5353, false); dv.setUint16(o + 2, 5353, false);
    dv.setUint16(o + 4, 8 + 12, false); dv.setUint16(o + 6, 0, false);
    o += 8;
    const msg = payloads[i];
    b.set(Array.from(msg, function (c) { return c.charCodeAt(0); }), o);
    o += 12;
  }
  return b;
}

/* -------------------------------------------------------------- boot */

const fileHandling = initFileHandling(function (file, source) {
  if (source === 'launch' || source === 'share') {
    setStatus('received ' + file.name + ' via ' + source + '…');
  }
  loadFile(file);
});

wireUI();
bootEngine();
