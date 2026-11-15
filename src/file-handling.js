/*
 * wireshark-web — PWA file handling.
 *
 * Every entry point funnels into one callback with a File (or Blob named as
 * one). All of it is feature-detected; where an API is missing the UI keeps
 * the dropzone and the file input.
 *
 *  - drag & drop /<input type=file>         — everywhere
 *  - window.launchQueue (file_handlers)      — "open with" from the OS
 *  - share_target (service worker cache)     — Android share sheet
 *  - showOpenFilePicker / showDirectoryPicker — Chromium native pickers
 *  - storage buckets for launched files      — keeps "open with" working
 *    across restarts without keeping a copy in RAM
 */

'use strict';

/* Capture file extensions Wireshark/wiretap reads (the common ones). */
export const CAPTURE_EXTENSIONS = [
  '.pcap', '.pcapng', '.cap', '.dmp', '.bfr', '.trc', '.enc', '.tr1',
  '.pcapng.gz', '.pcap.gz', '.cap.gz', '.5vw', '.apc', '.atm', '.enc',
  '.erf', '.eyesdn', '.frd', '.ipfix', '.k12', '.log', '.lsap',
  '.mplog', '.nettl', '.out', '.pkts', '.snoop', '.syc', '.tds',
  '.tpc', '.vwr', '.wpp', '.xml', '.json', '.ndjson', '.csc', '.pkt'
];

export function looksLikeCapture(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith('.gz')) return looksLikeCapture(n.slice(0, -3));
  return CAPTURE_EXTENSIONS.some(function (ext) { return n.endsWith(ext) && n.length > ext.length; });
}

/*
 * The Blob from launchQueue / share sheet needs a name; some browsers hand
 * over anonymous blobs. Give it a capture-ish name when it has none.
 */
function namedFile(blob, fallbackName) {
  if (blob instanceof File && blob.name) return blob;
  const name = (blob && blob.name) || fallbackName || 'capture.pcap';
  try {
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
  } catch (err) {
    /* File constructor is universally supported; but never die on it. */
    const f = blob;
    f.name = name;
    return f;
  }
}

export function initFileHandling(onFile, opts) {
  const options = Object.assign({
    launchEl: null, /* element to flash when a launch arrives late */
    workerScope: new URL('.', location.href).pathname
  }, opts || {});

  /* ------------------------------------------------------ launch queue */

  /* "Open with" from the OS (desktop Chrome/Edge). If the engine is not
 * ready yet, app.js queues the file itself; this just hands it over. */
  if ('launchQueue' in window && window.launchQueue) {
    window.launchQueue.setConsumer(function (launchParams) {
      if (!launchParams.files || !launchParams.files.length) return;
      let remaining = launchParams.files.length;
      launchParams.files.forEach(function (handle) {
        /* Persist the handle in an OPFS bucket so the app can re-open it
     * after the launch-time File handle goes stale (e.g. reload). */
        handle.getFile().then(function (file) {
          onFile(namedFile(file, 'launched-capture.pcap'), 'launch');
        }).catch(function (err) {
          console.warn('launchQueue file failed: ' + (err && err.message || err));
        }).finally(function () {
          remaining -= 1;
          if (remaining === 0 && launchParams.targetURL) {
            /* focus/bring-to-front is automatic; nothing else to do. */
          }
        });
        /* Also remember the handle for the OPFS stash below (best effort). */
        stashLaunchedHandle(handle).catch(function () { /* non-fatal */ });
      });
    });
  }

  /* Best-effort persistence of launched handles into a private bucket. */
  async function stashLaunchedHandle(handle) {
    if (!('storage' in navigator) || !navigator.storage.getDirectory) return;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('launched', { create: true });
      /* Keep only the most recent handle: one file is the common case and
     * the stash is a convenience, not a history. */
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'file' && name !== handle.name) await dir.removeEntry(name).catch(function () {});
      }
      const name = (handle.name || 'launched-capture.pcap').replace(/[\/\\]/g, '_');
      const target = await dir.getFileHandle(name, { create: true });
      const src = await handle.getFile();
      const w = await target.createWritable();
      await w.write(src);
      await w.close();
    } catch (err) {
      /* OPFS can be denied (private mode); launching still worked. */
    }
  }

  /* -------------------------------------------------------- share target */

  /* The manifest share_target POSTs to ./__share; sw.js stashes the files
 * in a dedicated cache under ./__shared/<i> and redirects to ./ — on the
 * next load we pick them up here. */
  async function consumeSharedFiles() {
    if (!window.caches) return;
    let cache;
    try {
      cache = await window.caches.open('wireshark-web-shared');
    } catch (err) {
      return;
    }
    const keys = await cache.keys();
    if (!keys.length) return;
    const countKey = keys.find(function (k) { return new URL(k.url).pathname.endsWith('/__shared/count'); });
    let count = 0;
    if (countKey) {
      try {
        const res = await cache.match(countKey);
        count = Number((await res.text()).trim()) || 0;
      } catch (err) { count = 0; }
    }
    const used = [];
    for (let i = 0; i < count; i++) {
      const key = keys.find(function (k) { return new URL(k.url).pathname.endsWith('/__shared/' + i); });
      if (!key) continue;
      try {
        const res = await cache.match(key);
        const blob = await res.blob();
        let name = decodeURIComponent(res.headers.get('X-File-Name') || ('shared-' + i + '.pcap'));
        used.push(key);
        onFile(namedFile(blob, name), 'share');
      } catch (err) {
        /* skip a broken entry, keep the rest */
      }
    }
    /* Entries are consumed: remove them so a reload does not re-open them. */
    for (const k of Array.from(new Set(used.concat(keys)))) {
      cache.delete(k).catch(function () {});
    }
  }

  consumeSharedFiles();

  /* ------------------------------------------------- native file picker */

  /* Only used when the caller wires a button to them. */
  return {
    pickFile: async function () {
      if (!window.showOpenFilePicker) return false;
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'Packet captures',
            accept: {
              'application/vnd.tcpdump.pcap': ['.pcap', '.cap', '.pcapng'],
              'application/octet-stream': CAPTURE_EXTENSIONS
            }
          }]
        });
        const file = await handle.getFile();
        onFile(namedFile(file, 'capture.pcap'), 'picker');
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') return true; /* user cancelled: handled */
        throw err;
      }
    },
    pickFolder: async function () {
      if (!window.showDirectoryPicker) return false;
      try {
        const dir = await window.showDirectoryPicker();
        const files = [];
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'file' && looksLikeCapture(name)) {
            files.push(namedFile(await handle.getFile(), name));
          }
        }
        if (files.length) onFile(files[0], 'folder');
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') return true;
        throw err;
      }
    }
  };
}
