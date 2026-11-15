/*
 * wireshark-web — engine client (page side).
 *
 * A small promise-based RPC wrapper around src/engine-worker.js. One worker,
 * one capture at a time; every call gets a seq, replies match by (type, seq).
 * Engine-init progress and status callbacks are forwarded while any init()
 * promise is pending.
 */

'use strict';

export function createEngineClient(workerUrl) {
  const worker = new Worker(workerUrl, { type: 'classic' });
  const pending = new Map(); /* seq -> {resolve, reject, type} */
  let seq = 0;

  let onProgress = null;   /* (kind, loaded, total) during asset download */
  let onEngineStatus = null;
  let onEngineLog = null;
  let onLoaded = null;     /* ({name, summary, ms}) when a capture opens */
  let onLoadError = null;

  /* Reply type -> the call type that registered the pending promise. The
   * worker answers some RPCs under a different name than the request
   * ('engine-init' is answered by 'engine-ready'/'engine-error', 'load' by
   * 'loaded'/'load-error', 'check-filter' by 'filter-check', ...). Every
   * reply must map back to its call, or the promise never settles. */
  const CALL_OF_REPLY = {
    'engine-ready': 'engine-init',
    'engine-error': 'engine-init',
    'loaded': 'load',
    'load-error': 'load',
    'filter-check': 'check-filter',
    'filter-complete': 'complete-filter'
  };

  function settle(type, msg) {
    const p = pending.get(msg.seq);
    if (!p || p.type !== type) return;
    pending.delete(msg.seq);
    p.resolve(msg);
  }

  worker.onmessage = function (event) {
    const msg = event.data || {};
    switch (msg.type) {
      case 'engine-progress':
        if (onProgress) onProgress(msg.kind, msg.loaded, msg.total);
        break;
      case 'engine-status':
        if (onEngineStatus) onEngineStatus(msg.status);
        break;
      case 'engine-log':
        if (onEngineLog) onEngineLog(msg.level, msg.text);
        break;
      case 'load-error':
        if (onLoadError) onLoadError(msg);
        settle('load', msg);
        break;
      case 'loaded':
        if (onLoaded) onLoaded(msg);
        settle('load', msg);
        break;
      default:
        settle(CALL_OF_REPLY[msg.type] || msg.type, msg);
    }
  };

  worker.onerror = function (err) {
    /* A classic-worker script error is fatal for the engine; surface it and
     * fail every pending call so the UI reports the failure instead of
     * hanging on "Engine: loading…" forever. */
    const text = 'worker: ' + (err.message || 'unknown worker error');
    if (onEngineLog) onEngineLog('error', text);
    const doomed = [...pending.entries()];
    pending.clear();
    for (const [id, p] of doomed) {
      /* Resolve (never hang) with the error-shaped reply the caller expects. */
      const errorType = p.type === 'engine-init' ? 'engine-error'
        : p.type === 'load' ? 'load-error' : 'error';
      p.resolve({ type: errorType, seq: id, error: text });
    }
  };

  function call(type, payload) {
    return new Promise(function (resolve, reject) {
      const id = ++seq;
      pending.set(id, { type: type, resolve: resolve, reject: reject });
      worker.postMessage(Object.assign({ type: type, seq: id }, payload || {}));
    });
  }

  return {
    worker: worker,
    init: function () {
      return call('engine-init').then(function (msg) {
        if (msg.type === 'engine-error') throw new Error(msg.error);
        return msg; /* {version, columns} */
      });
    },
    load: function (file) {
      return call('load', { file: file });
    },
    frames: function (filter, skip, limit) {
      return call('frames', { filter: filter, skip: skip, limit: limit });
    },
    frame: function (number) {
      return call('frame', { number: number });
    },
    checkFilter: function (filter) {
      return call('check-filter', { filter: filter });
    },
    completeFilter: function (field) {
      return call('complete-filter', { field: field });
    },
    follow: function (follower, filter) {
      return call('follow', { follower: follower, filter: filter });
    },
    tap: function (taps) {
      return call('tap', { taps: taps });
    },
    iograph: function (input) {
      return call('iograph', { input: input });
    },
    download: function (token) {
      return call('download', { token: token });
    },
    setCallbacks: function (cbs) {
      if (cbs.onProgress) onProgress = cbs.onProgress;
      if (cbs.onEngineStatus) onEngineStatus = cbs.onEngineStatus;
      if (cbs.onEngineLog) onEngineLog = cbs.onEngineLog;
      if (cbs.onLoaded) onLoaded = cbs.onLoaded;
      if (cbs.onLoadError) onLoadError = cbs.onLoadError;
    }
  };
}
