// pdf.js setup for the PDF tab: the core library is bundled; its worker (dist/webview/pdf.worker.mjs) is fetched and started from a blob URL because the webview's CSP allows workers only from blob: URLs.
import * as pdfjsLib from 'pdfjs-dist';

export type PdfjsLib = typeof import('pdfjs-dist');
export type PdfjsViewer = typeof import('pdfjs-dist/web/pdf_viewer.mjs');
export interface Pdfjs {
  lib: PdfjsLib;
  viewer: PdfjsViewer;
}

/** How long a started worker may take to report that it is ready before pdf.js falls back to the worker URL. */
const WORKER_READY_TIMEOUT_MS = 10000;

/**
 * Loads pdf.js: sets `globalThis.pdfjsLib` (pdf_viewer.mjs reads the core library from it when it is evaluated), then imports the viewer components, and starts the worker.
 * Only `import type` may refer to pdf_viewer.mjs elsewhere: a value import would evaluate it before the global exists.
 * `warn` receives a message when the worker cannot be started from a blob URL.
 */
export async function loadPdfjs(warn: (message: string) => void = console.warn): Promise<Pdfjs> {
  (globalThis as { pdfjsLib?: PdfjsLib }).pdfjsLib = pdfjsLib;
  const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
  await startWorker(pdfjsLib, warn);
  return { lib: pdfjsLib, viewer };
}

async function startWorker(lib: PdfjsLib, warn: (message: string) => void): Promise<void> {
  const url = new URL('./pdf.worker.mjs', import.meta.url);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = new Blob([await response.arrayBuffer()], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl, { type: 'module' });
    try {
      await workerReady(worker);
    } catch (e) {
      worker.terminate();
      throw e;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    lib.GlobalWorkerOptions.workerPort = worker;
  } catch (e) {
    // pdf.js tries a worker from this URL itself and otherwise runs without a worker.
    warn(`The PDF worker could not be started from a blob URL (${e instanceof Error ? e.message : String(e)}); pdf.js falls back to ${url.href}, or to running without a worker.`);
    lib.GlobalWorkerOptions.workerSrc = url.href;
  }
}

/** Resolves on the worker's first message (pdf.worker.mjs sends "ready" when it starts), rejects on an error event or after a timeout. */
function workerReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('the worker did not start')), WORKER_READY_TIMEOUT_MS);
    const onMessage = (): void => finish();
    const onError = (): void => finish(new Error('the worker failed to start'));
    function finish(error?: Error): void {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });
}
