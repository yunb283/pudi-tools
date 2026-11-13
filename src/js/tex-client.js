const WORKER_URL = new URL('tex-worker.js', import.meta.url);

// Keep at most one pending preview. An export has its own slot so changing the
// preview controls cannot replace the exact parameters captured at export time.
export function makeTexClient({ kind, compute, metricsOf, apply }) {
  let worker = null;
  let broken = false;
  let image = null;
  let nextId = 1;
  let loading = null;
  let running = null;
  let preview = null;
  let exporting = null;

  function fallbackMetrics() {
    try {
      return metricsOf?.(image) ?? null;
    } catch {
      return null;
    }
  }

  function finish(job, result) {
    if (!job.exact) apply(result);
    job.done(result);
  }

  function pump() {
    if (running || loading || !image) return;
    const job = exporting || preview;
    if (!job) return;
    if (job.exact) exporting = null;
    else preview = null;
    if (worker) {
      running = job;
      post({ type: 'run', id: job.id, kind, opts: job.opts });
      return;
    }

    const t0 = performance.now();
    let result;
    try {
      const out = compute(image, job.opts);
      result = { ok: true, opts: job.opts, ms: performance.now() - t0, ...out };
    } catch (error) {
      result = { ok: false, opts: job.opts, message: String(error?.message ?? error) };
    }
    finish(job, result);
    pump();
  }

  function giveUp() {
    worker?.terminate();
    worker = null;
    broken = true;
    if (loading) {
      const job = loading;
      loading = null;
      job.done(fallbackMetrics());
    }
    if (running) {
      const job = running;
      running = null;
      if (job.exact) exporting = job;
      else if (preview) job.done(null);
      else preview = job;
    }
    pump();
  }

  function post(message, transfer) {
    try {
      worker.postMessage(message, transfer || []);
    } catch {
      giveUp();
    }
  }

  function ensureWorker() {
    if (worker || broken) return;
    try {
      const active = new Worker(WORKER_URL, { type: 'module' });
      worker = active;
      active.onmessage = ({ data: m }) => {
        if (worker !== active) return;
        if (m.type === 'loaded' && m.id === loading?.id) {
          const job = loading;
          loading = null;
          job.done(m.metrics);
          pump();
        } else if (m.id === running?.id) {
          const job = running;
          running = null;
          finish(job, { ...m, ok: m.type === 'result', opts: job.opts });
          pump();
        }
      };
      active.onerror = (event) => {
        event.preventDefault?.();
        if (worker === active) giveUp();
      };
      active.onmessageerror = () => {
        if (worker === active) giveUp();
      };
    } catch {
      broken = true;
    }
  }

  function reset(img) {
    image = img;
    for (const job of [loading, running, preview, exporting]) job?.done(null);
    loading = running = preview = exporting = null;
  }

  return {
    load(img) {
      reset(img);
      ensureWorker();
      if (!worker) return Promise.resolve(fallbackMetrics());
      const copy = new Uint8ClampedArray(img.data);
      const id = nextId++;
      return new Promise((done) => {
        loading = { id, done };
        post({ type: 'load', id, kind, width: img.width, height: img.height, data: copy }, [copy.buffer]);
      });
    },

    unload() {
      reset(null);
      if (worker) post({ type: 'load', id: nextId++ });
    },

    request(opts, { exact = false } = {}) {
      if (!image) return Promise.resolve(null);
      return new Promise((done) => {
        const job = { id: nextId++, opts, done, exact };
        if (exact) {
          exporting?.done(null);
          exporting = job;
        } else {
          preview?.done(null);
          preview = job;
        }
        pump();
      });
    },
  };
}
