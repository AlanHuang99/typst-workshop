// PDF tab (dist/webview/viewer.js) in headless Chromium: test/viewer/harness.html stubs the VS Code webview API, messages are posted with window.postMessage, and the fixture PDFs come from test/viewer/global-setup.ts.
import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ViewerConfig } from '../../src/viewer/messages';

const origin = process.env.TW_VIEWER_ORIGIN ?? '';
const harnessUrl = `${origin}/test/viewer/harness.html`;
const defaults: ViewerConfig = { zoom: 'page-width', scrollMode: 'vertical', spreadMode: 'none', invertMode: 'never', invert: 0.9, syncKeybinding: 'ctrl-click', indicator: 'circle' };
const pageCounts: Record<string, number> = { boxes: 3, long: 200, links: 3 };

// Every test also fails on uncaught page errors and on Content-Security-Policy violations.
const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await use(page);
    expect(errors).toEqual([]);
    if (!page.isClosed() && page.url().startsWith(origin)) {
      expect(await page.evaluate(() => (window as any).__cspViolations ?? [])).toEqual([]);
    }
  },
});

const base64 = new Map<string, string>();
/** Fixture PDF bytes; `send` turns them into a Uint8Array inside the page. */
function pdf(name: string): { __base64: string } {
  if (!base64.has(name)) base64.set(name, readFileSync(path.join(process.env.TW_VIEWER_FIXTURES ?? '', `${name}.pdf`)).toString('base64'));
  return { __base64: base64.get(name)! };
}

async function send(page: Page, message: object): Promise<void> {
  await sendAll(page, [message]);
}

/**
 * Posts the messages one after another within one task of the page, and returns once the page has dispatched them all. The tab's listener was registered first, so its synchronous handling (all of a `config`, the start of a `load`) is done by then.
 */
async function sendAll(page: Page, messages: object[]): Promise<void> {
  await page.evaluate(async (list: any[]) => {
    const dispatched = new Promise<void>((resolve) => {
      let left = list.length;
      const onMessage = (): void => {
        if (--left > 0) return;
        window.removeEventListener('message', onMessage);
        resolve();
      };
      window.addEventListener('message', onMessage);
    });
    for (const m of list) {
      if (m.data && typeof m.data.__base64 === 'string') {
        const raw = atob(m.data.__base64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        m.data = bytes;
      }
      window.postMessage(m, '*');
    }
    await dispatched;
  }, messages);
}

async function posted(page: Page, type: string): Promise<any[]> {
  return page.evaluate((t) => ((window as any).__posted ?? []).filter((m: any) => m.type === t), type);
}

/** The `log` messages that are warnings or errors; info lines report the documents shown. */
async function problems(page: Page): Promise<any[]> {
  return (await posted(page, 'log')).filter((m) => m.level !== 'info');
}

/** The last warning or error the tab logged, once there is one. */
async function lastProblem(page: Page): Promise<any> {
  await expect.poll(async () => (await problems(page)).length).toBeGreaterThan(0);
  return (await problems(page)).at(-1);
}

/** The info lines that report a shown document, oldest first. */
async function shownLines(page: Page): Promise<string[]> {
  return (await posted(page, 'log')).filter((m) => m.level === 'info' && m.message.startsWith('Showing ')).map((m) => m.message);
}

/** CSS border width of a `.page` element (pdf.js draws pages inside a transparent border). */
async function pageBorder(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.page')!).borderLeftWidth));
}

/** CSS pixels per PDF point at the current zoom. */
async function cssPerPoint(page: Page): Promise<number> {
  return (await page.evaluate(() => (window as any).__app.view.pdfViewer.currentScale)) * 96 / 72;
}

/** Viewport coordinates of a point given in page frame coordinates (pt from the top-left corner of the page). */
async function framePoint(page: Page, pageNumber: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator(`.page[data-page-number="${pageNumber}"]`).boundingBox())!;
  const border = await pageBorder(page);
  const s = await cssPerPoint(page);
  return { x: box.x + border + x * s, y: box.y + border + y * s };
}

/**
 * Chromium reports mouse positions in whole CSS pixels (a click at x = 586.67 arrives as 586), so tests click on the pixel nearest to a target and expect the PDF point of that pixel: the page's drawing area (inside the border) spans the page's width × height in pt, origin bottom-left.
 */
async function pixelNear(page: Page, pageNumber: number, size: { width: number; height: number }, clientX: number, clientY: number): Promise<{ x: number; y: number; pdfX: number; pdfY: number }> {
  const box = (await page.locator(`.page[data-page-number="${pageNumber}"]`).boundingBox())!;
  const border = await pageBorder(page);
  const x = Math.round(clientX);
  const y = Math.round(clientY);
  return { x, y, pdfX: ((x - box.x - border) * size.width) / (box.width - 2 * border), pdfY: size.height - ((y - box.y - border) * size.height) / (box.height - 2 * border) };
}

const BOXES_PAGE = { width: 300, height: 400 };

/** Click with Ctrl held, Cmd on macOS, where Ctrl+click opens the context menu instead of clicking (page.mouse.click has no modifiers option). */
async function ctrlClick(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(x, y);
  await page.keyboard.up('ControlOrMeta');
}

/** Makes the page report macOS or another platform; call it before the page loads. The tab reads the platform from `navigator`, so the tests do not depend on the machine they run on. */
async function usePlatform(page: Page, platform: 'mac' | 'other'): Promise<void> {
  await page.addInitScript((mac: boolean) => {
    Object.defineProperty(navigator, 'platform', { value: mac ? 'MacIntel' : 'Linux x86_64', configurable: true });
    Object.defineProperty(navigator, 'userAgentData', { value: { platform: mac ? 'macOS' : 'Linux', mobile: false, brands: [] }, configurable: true });
  }, platform === 'mac');
}

/** A secondary click with the keys held: the page receives `contextmenu`, which is also how macOS reports Ctrl+click. */
async function secondaryClick(page: Page, x: number, y: number, keys: string[] = []): Promise<void> {
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.click(x, y, { button: 'right' });
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
}

/** How many context menus VS Code's webview host would have opened (the harness stands in for its listener). */
async function hostMenus(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__hostContextMenus.length);
}

async function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.getElementById('viewerContainer')!.scrollTop);
}

async function scrollLeft(page: Page): Promise<number> {
  return page.evaluate(() => document.getElementById('viewerContainer')!.scrollLeft);
}

async function scrollMode(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__app.view.pdfViewer.scrollMode);
}

/** Waits two animation frames: pdf.js updates the current page in a frame after a scroll event. */
async function afterFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function currentPage(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__app.view.pdfViewer.currentPageNumber);
}

/** Remembers the displayed document, so that `waitForNewDocument` can tell when a reload has replaced it. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => ((window as any).__previousDocument = (window as any).__app.view.pdfViewer.pdfDocument));
}

async function waitForNewDocument(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).__app.view.pdfViewer.pdfDocument !== (window as any).__previousDocument)).toBe(true);
}

/** Waits until no PDF is being parsed. */
async function waitForLoads(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).__app.view.loading)).toBe(0);
}

async function lastPosted(page: Page, type: string): Promise<any> {
  await expect.poll(() => page.evaluate((t) => (window as any).__posted?.some((m: any) => m.type === t), type)).toBe(true);
  return page.evaluate((t) => (window as any).__posted.filter((m: any) => m.type === t).at(-1), type);
}

async function openWith(page: Page, name: string, config: Partial<ViewerConfig>): Promise<void> {
  await page.goto(harnessUrl);
  await expect.poll(() => page.evaluate(() => (window as any).__posted?.some((m: any) => m.type === 'ready'))).toBe(true);
  await send(page, { type: 'config', config: { ...defaults, ...config } });
  await send(page, { type: 'load', data: pdf(name), reload: false, pdfPath: `/x/${name}.pdf` });
  await expect(page.locator('#pageCount')).toHaveText(`/ ${pageCounts[name]}`);
  await expect(page.locator('.page canvas').first()).toBeVisible();
}

test('posts ready, loads a PDF, shows page count, applies config zoom', async ({ page }) => {
  await page.goto(harnessUrl);
  await expect.poll(() => page.evaluate(() => (window as any).__posted?.[0]?.type)).toBe('ready');
  await send(page, { type: 'config', config: { ...defaults, zoom: 'page-actual' } });
  await send(page, { type: 'load', data: pdf('boxes'), reload: false, pdfPath: '/x/boxes.pdf' });
  await expect(page.locator('#pageCount')).toHaveText('/ 3');
  await expect(page.locator('.page[data-page-number="1"] canvas')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-actual');
  expect(await page.evaluate(() => (window as any).__app.view.pdfViewer.currentScale)).toBe(1);
  expect(await page.evaluate(() => (window as any).__posted.filter((m: any) => m.type === 'ready').length)).toBe(1);
});

test('runs pdf.js in a module worker started from a blob URL', async ({ page }) => {
  await openWith(page, 'boxes', {});
  expect(await page.evaluate(() => (globalThis as any).pdfjsLib.GlobalWorkerOptions.workerPort instanceof Worker)).toBe(true);
});

test('loads documents without the blob worker when the worker file cannot be fetched', async ({ page }) => {
  // The worker request made with fetch() fails; pdf.js then falls back to the worker URL, which this CSP (worker-src blob:) refuses, and runs without a worker.
  await page.route('**/dist/webview/pdf.worker.mjs', (route) => (route.request().resourceType() === 'fetch' ? route.abort() : route.continue()));
  await openWith(page, 'boxes', {});
  expect(await page.evaluate(() => (globalThis as any).pdfjsLib.GlobalWorkerOptions.workerPort)).toBeNull();
  expect(await page.evaluate(() => (globalThis as any).pdfjsLib.GlobalWorkerOptions.workerSrc)).toBe(`${origin}/dist/webview/pdf.worker.mjs`);
  expect((await lastProblem(page)).level).toBe('warn');
  const violations: string[] = await page.evaluate(() => (window as any).__cspViolations.splice(0));
  expect(violations.length).toBeGreaterThan(0);
  expect(violations.every((v) => v.startsWith('worker-src'))).toBe(true);
});

test('reload keeps scroll offset and zoom', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: '1.5' });
  await page.evaluate(() => (document.getElementById('viewerContainer')!.scrollTop = 700));
  const before = await scrollTop(page);
  expect(before).toBe(700);
  await markDocument(page);
  await send(page, { type: 'load', data: pdf('boxes'), reload: true, pdfPath: '/x/boxes.pdf' });
  // The visible pages are covered by snapshots while the new document renders.
  await expect(page.locator('.page-loading-mask').first()).toBeAttached();
  await waitForNewDocument(page);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(before - 2);
  expect(Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2);
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  expect(Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('1.5');
});

test('reload snapshots cover the visible pages exactly', async ({ page }) => {
  await openWith(page, 'long', { zoom: 'page-width' });
  // Two pages in view: the end of one and the start of the next.
  await page.evaluate(() => (document.getElementById('viewerContainer')!.scrollTop = 5000));
  await expect.poll(() => page.evaluate(() => {
    const view = (window as any).__app.view;
    const visible = view.visiblePages();
    return visible.length === 2 && visible.every((p: any) => view.isRendered(p));
  })).toBe(true);
  const container = page.locator('#viewerContainer');
  const before = await container.screenshot();
  // The new PDF never finishes parsing, so the snapshots stay; with the pages hidden only they are seen.
  await page.evaluate(() => ((window as any).__app.view.loadDocument = () => new Promise(() => {})));
  await send(page, { type: 'load', data: pdf('long'), reload: true, pdfPath: '/x/long.pdf' });
  await expect(page.locator('.page-loading-mask')).toHaveCount(2);
  await page.evaluate(() => (document.getElementById('viewer')!.style.visibility = 'hidden'));
  expect((await container.screenshot()).equals(before)).toBe(true);
});

/** Sends a reload of `name` and waits until the new document is shown and the snapshots are gone. */
async function reloadAndSettle(page: Page, name: string): Promise<void> {
  await markDocument(page);
  await send(page, { type: 'load', data: pdf(name), reload: true, pdfPath: `/x/${name}.pdf` });
  await waitForNewDocument(page);
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
}

test('reload in page-by-page scroll mode keeps the page and the offset on it', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: '2', scrollMode: 'page' });
  await page.evaluate(() => ((window as any).__app.view.pdfViewer.currentPageNumber = 2));
  await expect.poll(() => currentPage(page)).toBe(2);
  await page.evaluate(() => (document.getElementById('viewerContainer')!.scrollTop = 200));
  await expect.poll(() => scrollTop(page)).toBe(200);
  await reloadAndSettle(page, 'boxes');
  expect(await scrollMode(page)).toBe(3);
  expect(await currentPage(page)).toBe(2);
  expect(Math.abs((await scrollTop(page)) - 200)).toBeLessThanOrEqual(2);
  await expect(page.locator('#viewer .page')).toHaveCount(1);
  await expect(page.locator('.page[data-page-number="2"] canvas')).toBeVisible();
});

test('reload in horizontal scroll mode keeps both offsets', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: '1.5', scrollMode: 'horizontal' });
  await page.evaluate(() => {
    const container = document.getElementById('viewerContainer')!;
    container.scrollLeft = 500;
    container.scrollTop = 60;
  });
  await expect.poll(() => scrollLeft(page)).toBe(500);
  await expect.poll(() => scrollTop(page)).toBe(60);
  await afterFrames(page);
  const pageBefore = await currentPage(page);
  await reloadAndSettle(page, 'boxes');
  expect(await scrollMode(page)).toBe(1);
  expect(Math.abs((await scrollLeft(page)) - 500)).toBeLessThanOrEqual(2);
  expect(Math.abs((await scrollTop(page)) - 60)).toBeLessThanOrEqual(2);
  expect(await currentPage(page)).toBe(pageBefore);
});

test('reload in wrapped scroll mode keeps the offset', async ({ page }) => {
  await openWith(page, 'long', { zoom: '0.5', scrollMode: 'wrapped' });
  await page.evaluate(() => (document.getElementById('viewerContainer')!.scrollTop = 10000));
  await expect.poll(() => scrollTop(page)).toBe(10000);
  await afterFrames(page);
  const pageBefore = await currentPage(page);
  expect(pageBefore).toBeGreaterThan(30);
  await reloadAndSettle(page, 'long');
  expect(await scrollMode(page)).toBe(2);
  expect(Math.abs((await scrollTop(page)) - 10000)).toBeLessThanOrEqual(2);
  expect(await currentPage(page)).toBe(pageBefore);
});

test('200-page reload keeps position near page 150', async ({ page }) => {
  await openWith(page, 'long', { zoom: 'page-width' });
  await page.evaluate(() => ((window as any).__app.view.pdfViewer.currentPageNumber = 150));
  await expect.poll(() => currentPage(page)).toBe(150);
  const before = await scrollTop(page);
  await markDocument(page);
  await send(page, { type: 'load', data: pdf('long'), reload: true, pdfPath: '/x/long.pdf' });
  await waitForNewDocument(page);
  await expect.poll(() => currentPage(page)).toBe(150);
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  expect(await currentPage(page)).toBe(150);
  expect(Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2);
  await expect(page.locator('.page[data-page-number="150"] canvas')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-width');
});

test('two quick reloads show the newest', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await sendAll(page, [
    { type: 'load', data: pdf('boxes'), reload: true, pdfPath: '/x/boxes.pdf' },
    { type: 'load', data: pdf('long'), reload: true, pdfPath: '/x/boxes.pdf' },
  ]);
  await expect(page.locator('#pageCount')).toHaveText('/ 200');
  await waitForLoads(page);
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  expect(await page.evaluate(() => (window as any).__app.view.pdfViewer.pdfDocument.numPages)).toBe(200);
});

test('only the newest of overlapping loads yields a document, whichever finishes first', async ({ page }) => {
  await openWith(page, 'boxes', {});
  const result = await page.evaluate(async ([older, newer]) => {
    const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const view = (window as any).__app.view;
    const first = view.loadDocument(bytes(older));
    const second = view.loadDocument(bytes(newer));
    const [a, b] = await Promise.all([first, second]);
    const pages = [a?.numPages ?? null, b?.numPages ?? null];
    await b?.loadingTask.destroy();
    return pages;
  }, [pdf('long').__base64, pdf('boxes').__base64]);
  expect(result).toEqual([null, 3]);
});

test('two quick reloads in the other order also show the newest', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await markDocument(page);
  await sendAll(page, [
    { type: 'load', data: pdf('long'), reload: true, pdfPath: '/x/boxes.pdf' },
    { type: 'load', data: pdf('boxes'), reload: true, pdfPath: '/x/boxes.pdf' },
  ]);
  await waitForNewDocument(page);
  await waitForLoads(page);
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('#pageCount')).toHaveText('/ 3');
  expect(await page.evaluate(() => (window as any).__app.view.pdfViewer.pdfDocument.numPages)).toBe(3);
});

// The tab reports each document it shows with one info line, which the extension writes to its log (the extension-host test waits for it).
const ONE_PAGE_PDF = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';

test('a first load and a reload each log one info line for the document shown', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await expect.poll(() => shownLines(page)).toEqual(['Showing boxes.pdf: 3 pages']);
  await reloadAndSettle(page, 'boxes');
  expect(await shownLines(page)).toEqual(['Showing boxes.pdf: 3 pages', 'Showing boxes.pdf: 3 pages']);
  expect(await problems(page)).toEqual([]);
});

test('the info line gives the file name of the path and the page count of the document shown', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await send(page, { type: 'load', data: pdf('long'), reload: true, pdfPath: '/home/user/My Papers/long run.pdf' });
  await expect.poll(() => shownLines(page)).toHaveLength(2);
  await expect(page.locator('#pageCount')).toHaveText('/ 200');
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  await send(page, { type: 'load', data: { __base64: Buffer.from(ONE_PAGE_PDF).toString('base64') }, reload: true, pdfPath: 'C:\\Papers\\one.pdf' });
  await expect.poll(() => shownLines(page)).toHaveLength(3);
  expect(await shownLines(page)).toEqual(['Showing boxes.pdf: 3 pages', 'Showing long run.pdf: 200 pages', 'Showing one.pdf: 1 page']);
});

test('two quick reloads log one info line, for the newest document', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await markDocument(page);
  await sendAll(page, [
    { type: 'load', data: pdf('boxes'), reload: true, pdfPath: '/x/boxes.pdf' },
    { type: 'load', data: pdf('long'), reload: true, pdfPath: '/x/boxes.pdf' },
  ]);
  await waitForNewDocument(page);
  await waitForLoads(page);
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  expect(await shownLines(page)).toEqual(['Showing boxes.pdf: 3 pages', 'Showing boxes.pdf: 200 pages']);
});

test('a PDF that fails to parse logs no info line', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await send(page, { type: 'load', data: { __base64: Buffer.from('not a PDF').toString('base64') }, reload: true, pdfPath: '/x/boxes.pdf' });
  expect((await lastProblem(page)).level).toBe('error');
  expect(await shownLines(page)).toEqual(['Showing boxes.pdf: 3 pages']);
});

for (const holdRender of [false, true]) {
  test(`a reload sent while the previous reload sets up its document${holdRender ? ' (first document not yet rendered)' : ''}`, async ({ page }) => {
    await openWith(page, 'boxes', { zoom: '1.5' });
    await page.evaluate(() => (document.getElementById('viewerContainer')!.scrollTop = 300));
    await page.evaluate(({ b64, holdRender }) => {
      const w = window as any;
      const app = w.__app;
      const view = app.view;
      const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const isRendered = view.isRendered.bind(view);
      w.__rendered = () => view.visiblePages().every((p: any) => isRendered(p));
      // reload.ts watches the rendering with pagerendered listeners that call view.isRendered; count them (the event bus object itself is not extensible).
      const proto = Object.getPrototypeOf(view.eventBus);
      const { on, off } = proto;
      const live = new Set<Function>();
      w.__watchers = { added: 0, live };
      w.__restoreBus = () => Object.assign(proto, { on, off });
      proto.on = function (name: string, fn: Function, options?: object) {
        if (name === 'pagerendered' && String(fn).includes('isRendered')) {
          w.__watchers.added++;
          live.add(fn);
        }
        return on.call(this, name, fn, options);
      };
      proto.off = function (name: string, fn: Function, options?: object) {
        if (name === 'pagerendered') live.delete(fn);
        return off.call(this, name, fn, options);
      };
      // Records the moment the snapshots start to fade.
      w.__fade = null;
      new MutationObserver(() => {
        if (w.__fade === null && document.querySelector('.page-loading-mask.remove')) w.__fade = { newest: view.pdfViewer.pdfDocument === w.__secondDocument, rendered: w.__rendered() };
      }).observe(view.container, { subtree: true, attributes: true, attributeFilter: ['class'] });
      // The second PDF is parsed only when the test releases it.
      const load = view.loadDocument.bind(view);
      let loads = 0;
      const held = new Promise((resolve) => (w.__releaseSecond = resolve));
      view.loadDocument = async (data: Uint8Array) => {
        if (++loads === 2) await held;
        return load(data);
      };
      // The second load arrives while the first reload's document waits for its pages.
      const set = view.setDocument.bind(view);
      let sets = 0;
      if (holdRender) view.isRendered = () => false;
      view.setDocument = (doc: any, onInit: any) => {
        const n = ++sets;
        const shown = set(doc, onInit);
        if (n === 1) {
          app.handle({ type: 'load', data: bytes(b64), reload: true, pdfPath: '/x/boxes.pdf' });
          shown.then(() => (w.__firstShown = true));
        } else {
          w.__secondDocument = doc;
          if (holdRender) shown.then(() => (view.isRendered = isRendered));
        }
        return shown;
      };
      app.handle({ type: 'load', data: bytes(b64), reload: true, pdfPath: '/x/boxes.pdf' });
    }, { b64: pdf('boxes').__base64, holdRender });
    await expect.poll(() => page.evaluate(() => (window as any).__firstShown === true)).toBe(true);
    // The first document renders under the snapshots, which stay while the newest PDF is pending.
    await expect.poll(() => page.evaluate(() => (window as any).__rendered())).toBe(true);
    await expect(page.locator('.page-loading-mask:not(.remove)')).not.toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__fade)).toBeNull();
    // A setting changed meanwhile applies to the newest document.
    await send(page, { type: 'config', config: { ...defaults, zoom: '2' } });
    await page.evaluate(() => (window as any).__releaseSecond());
    await expect.poll(() => page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('2');
    await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
    expect(await page.evaluate(() => (window as any).__fade)).toEqual({ newest: true, rendered: true });
    const watchers = await page.evaluate(() => {
      const w = (window as any).__watchers;
      (window as any).__restoreBus();
      return { added: w.added, live: w.live.size };
    });
    expect(watchers.added).toBeGreaterThan(0);
    expect(watchers.live).toBe(0);
    expect(await problems(page)).toEqual([]);
  });
}

test('a superseded PDF stops loading at once', async ({ page }) => {
  await openWith(page, 'boxes', {});
  const result = await page.evaluate(async ([older, newer]) => {
    const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const view = (window as any).__app.view;
    let settled = false;
    const first = view.loadDocument(bytes(older)).then((doc: any) => {
      settled = true;
      return doc;
    });
    const second = view.loadDocument(bytes(newer));
    // The older parse is abandoned when the newer one starts: its call settles within microtasks, before any message from the worker (a task) can arrive.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const abandonedAtOnce = settled;
    const [a, b] = await Promise.all([first, second]);
    const pages = [a?.numPages ?? null, b?.numPages ?? null];
    await b?.loadingTask.destroy();
    return { abandonedAtOnce, pages, loading: view.loading };
  }, [pdf('long').__base64, pdf('boxes').__base64]);
  expect(result).toEqual({ abandonedAtOnce: true, pages: [null, 3], loading: 0 });
});

test('settings changed during a reload apply to the reloaded document', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: '1.5' });
  await markDocument(page);
  await sendAll(page, [
    { type: 'load', data: pdf('boxes'), reload: true, pdfPath: '/x/boxes.pdf' },
    { type: 'config', config: { ...defaults, zoom: '2', scrollMode: 'page' } },
  ]);
  await waitForNewDocument(page);
  await expect.poll(() => page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('2');
  await expect.poll(() => page.evaluate(() => (window as any).__app.view.pdfViewer.scrollMode)).toBe(3);
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  expect(await problems(page)).toEqual([]);
});

test('a PDF that fails to parse leaves the current document and logs an error', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await markDocument(page);
  await send(page, { type: 'load', data: { __base64: Buffer.from('not a PDF').toString('base64') }, reload: true, pdfPath: '/x/boxes.pdf' });
  const log = await lastProblem(page);
  expect(log.level).toBe('error');
  await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
  expect(await page.evaluate(() => (window as any).__app.view.pdfViewer.pdfDocument === (window as any).__previousDocument)).toBe(true);
  await expect(page.locator('#pageCount')).toHaveText('/ 3');
  await expect(page.locator('.page[data-page-number="1"] canvas')).toBeVisible();
});

// PDFs that parse but cannot be shown: pdf.js reports 0 pages for the first and fails to load page 1 of the second.
const UNSHOWABLE_PDFS: [string, string][] = [
  ['no pages', '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'],
  ['a first page that cannot be loaded', '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 1 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'],
];

for (const [name, text] of UNSHOWABLE_PDFS) {
  test(`a PDF with ${name} leaves the current document and logs an error`, async ({ page }) => {
    await openWith(page, 'boxes', {});
    await markDocument(page);
    await send(page, { type: 'load', data: { __base64: Buffer.from(text).toString('base64') }, reload: true, pdfPath: '/x/boxes.pdf' });
    const log = await lastProblem(page);
    expect(log.level).toBe('error');
    await expect(page.locator('.page-loading-mask')).toHaveCount(0, { timeout: 3000 });
    expect(await page.evaluate(() => (window as any).__app.view.pdfViewer.pdfDocument === (window as any).__previousDocument)).toBe(true);
    await expect(page.locator('#pageCount')).toHaveText('/ 3');
    await expect(page.locator('.page[data-page-number="1"] canvas')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__app.view.isSettled)).toBe(true);
  });
}

// boxes: page 1 is 300×400 pt with a red square at frame (100, 100)–(120, 120) and a link to https://example.com at frame (50, 300).

test('ctrl+click posts PDF coordinates', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  const box = await page.locator('.page[data-page-number="1"]').boundingBox();
  const s = (await page.evaluate(() => (window as any).__app.view.pdfViewer.currentScale)) * 96 / 72;
  const border = await pageBorder(page);
  const p = await pixelNear(page, 1, BOXES_PAGE, box!.x + border + 110 * s, box!.y + border + 110 * s);
  await ctrlClick(page, p.x, p.y);
  const m = await lastPosted(page, 'inverse');
  expect(m.page).toBe(1);
  expect(m.x).toBeCloseTo(110, 0);
  expect(m.y).toBeCloseTo(290, 0);
  expect(m.x).toBeCloseTo(p.pdfX, 2);
  expect(m.y).toBeCloseTo(p.pdfY, 2);
});

test('ctrl+click converts with the zoom and on later pages', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: '2' });
  await page.evaluate(() => ((window as any).__app.view.pdfViewer.currentPageNumber = 2));
  const target = await framePoint(page, 2, 30, 50);
  const p = await pixelNear(page, 2, BOXES_PAGE, target.x, target.y);
  await ctrlClick(page, p.x, p.y);
  const m = await lastPosted(page, 'inverse');
  expect(m.page).toBe(2);
  expect(m.x).toBeCloseTo(30, 0);
  expect(m.y).toBeCloseTo(350, 0);
  expect(m.x).toBeCloseTo(p.pdfX, 2);
  expect(m.y).toBeCloseTo(p.pdfY, 2);
});

test('plain click does nothing; double-click mode', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  const target = await framePoint(page, 1, 110, 110);
  const p = await pixelNear(page, 1, BOXES_PAGE, target.x, target.y);
  await page.mouse.click(p.x, p.y);
  expect(await posted(page, 'inverse')).toEqual([]);
  await send(page, { type: 'config', config: { ...defaults, zoom: 'page-actual', syncKeybinding: 'double-click' } });
  await ctrlClick(page, p.x, p.y);
  expect(await posted(page, 'inverse')).toEqual([]);
  await page.mouse.dblclick(p.x, p.y);
  const m = await lastPosted(page, 'inverse');
  expect(m.page).toBe(1);
  expect(m.x).toBeCloseTo(110, 0);
  expect(m.y).toBeCloseTo(290, 0);
  expect(m.x).toBeCloseTo(p.pdfX, 2);
  expect(m.y).toBeCloseTo(p.pdfY, 2);
  expect(await posted(page, 'inverse')).toHaveLength(1);
});

test('ctrl+click on a link does inverse instead of opening it', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  const link = page.locator('.annotationLayer a[href^="https://example.com"]');
  await expect(link).toBeAttached();
  const box = (await link.boundingBox())!;
  const p = await pixelNear(page, 1, BOXES_PAGE, box.x + box.width / 2, box.y + box.height / 2);
  await ctrlClick(page, p.x, p.y);
  const m = await lastPosted(page, 'inverse');
  expect(m.page).toBe(1);
  expect(m.x).toBeCloseTo(p.pdfX, 2);
  expect(m.y).toBeCloseTo(p.pdfY, 2);
  // The link text starts at frame (50, 300), that is PDF (50, 100), and runs right and down from there.
  expect(m.x).toBeGreaterThan(50);
  expect(m.y).toBeLessThan(100);
  expect(await posted(page, 'openExternal')).toEqual([]);
  expect(page.url()).toBe(harnessUrl);
});

test('plain click on an external link posts openExternal', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  await page.locator('.annotationLayer a[href^="https://example.com"]').click();
  const m = await lastPosted(page, 'openExternal');
  expect(m.url).toBe('https://example.com/');
  expect(await posted(page, 'openExternal')).toHaveLength(1);
  expect(await posted(page, 'inverse')).toEqual([]);
  expect(page.url()).toBe(harnessUrl);
});

test('double-click mode: a double-click on an external link opens it once and looks up the source', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual', syncKeybinding: 'double-click' });
  const box = (await page.locator('.annotationLayer a[href^="https://example.com"]').boundingBox())!;
  const p = await pixelNear(page, 1, BOXES_PAGE, box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.dblclick(p.x, p.y);
  const m = await lastPosted(page, 'inverse');
  expect(m.page).toBe(1);
  expect(m.x).toBeCloseTo(p.pdfX, 2);
  expect(m.y).toBeCloseTo(p.pdfY, 2);
  expect(await posted(page, 'inverse')).toHaveLength(1);
  expect(await posted(page, 'openExternal')).toEqual([{ type: 'openExternal', url: 'https://example.com/' }]);
  expect(page.url()).toBe(harnessUrl);
});

test('macOS: ctrl+click arrives as contextmenu, looks up the source like cmd+click and opens no host menu', async ({ page }) => {
  await usePlatform(page, 'mac');
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  const target = await framePoint(page, 1, 110, 110);
  const p = await pixelNear(page, 1, BOXES_PAGE, target.x, target.y);
  await ctrlClick(page, p.x, p.y);
  const click = await lastPosted(page, 'inverse');
  expect(await hostMenus(page)).toBe(0);
  await secondaryClick(page, p.x, p.y, ['Control']);
  await expect.poll(async () => (await posted(page, 'inverse')).length).toBe(2);
  const [, menu] = await posted(page, 'inverse');
  expect(menu).toEqual(click);
  expect(menu.page).toBe(1);
  expect(menu.x).toBeCloseTo(110, 0);
  expect(menu.y).toBeCloseTo(290, 0);
  expect(menu.x).toBeCloseTo(p.pdfX, 2);
  expect(menu.y).toBeCloseTo(p.pdfY, 2);
  expect(await hostMenus(page)).toBe(0);
});

test('not macOS: a contextmenu with ctrl held posts nothing and the host menu opens', async ({ page }) => {
  await usePlatform(page, 'other');
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  const target = await framePoint(page, 1, 110, 110);
  const p = await pixelNear(page, 1, BOXES_PAGE, target.x, target.y);
  await secondaryClick(page, p.x, p.y, ['Control']);
  await expect.poll(() => hostMenus(page)).toBe(1);
  expect(await posted(page, 'inverse')).toEqual([]);
});

test('macOS: a plain right click, ctrl+cmd, a point outside the pages and double-click mode post nothing and keep the host menu', async ({ page }) => {
  await usePlatform(page, 'mac');
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  const target = await framePoint(page, 1, 110, 110);
  const p = await pixelNear(page, 1, BOXES_PAGE, target.x, target.y);
  await secondaryClick(page, p.x, p.y);
  await secondaryClick(page, p.x, p.y, ['Control', 'Meta']);
  const view = (await page.locator('#viewerContainer').boundingBox())!;
  await secondaryClick(page, Math.round(view.x + view.width - 60), Math.round(view.y + 100), ['Control']);
  await expect.poll(() => hostMenus(page)).toBe(3);
  await send(page, { type: 'config', config: { ...defaults, zoom: 'page-actual', syncKeybinding: 'double-click' } });
  await secondaryClick(page, p.x, p.y, ['Control']);
  await expect.poll(() => hostMenus(page)).toBe(4);
  expect(await posted(page, 'inverse')).toEqual([]);
});

test('forward scrolls to page 3 and shows the circle marker, then removes it', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  await send(page, { type: 'forward', indicator: 'circle', positions: [{ page: 3, left: 10, bottom: 370, right: 60, top: 390, x: 12, y: 380 }] });
  await expect.poll(() => currentPage(page)).toBe(3);
  await expect(page.locator('.tw-marker-circle')).toHaveCount(1);
  // The ring is centred on (12, 380), which sits about 40 % from the top of the view.
  const expected = await framePoint(page, 3, 12, 400 - 380);
  const ring = (await page.locator('.tw-marker-circle').boundingBox())!;
  expect(Math.abs(ring.x + ring.width / 2 - expected.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(ring.y + ring.height / 2 - expected.y)).toBeLessThanOrEqual(1);
  const view = (await page.locator('#viewerContainer').boundingBox())!;
  expect((expected.y - view.y) / view.height).toBeCloseTo(0.4, 1);
  await expect(page.locator('.tw-marker-circle')).toHaveCount(0, { timeout: 3000 });
});

test('rectangle marker and back/forward history', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual', indicator: 'rectangle' });
  await send(page, { type: 'forward', indicator: 'rectangle', positions: [{ page: 3, left: 10, bottom: 370, right: 60, top: 390, x: 12, y: 380 }] });
  await expect.poll(() => currentPage(page)).toBe(3);
  await expect(page.locator('.tw-marker-rect')).toHaveCount(1);
  await expect(page.locator('.tw-marker-circle')).toHaveCount(0);
  // The box covers the rectangle: frame (10, 10)–(60, 30) on page 3.
  const corner = await framePoint(page, 3, 10, 10);
  const s = await cssPerPoint(page);
  const rect = (await page.locator('.tw-marker-rect').boundingBox())!;
  expect(Math.abs(rect.x - corner.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(rect.y - corner.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(rect.width - 50 * s)).toBeLessThanOrEqual(1);
  expect(Math.abs(rect.height - 20 * s)).toBeLessThanOrEqual(1);
  const atTarget = await scrollTop(page);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => currentPage(page)).toBe(1);
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => currentPage(page)).toBe(3);
  expect(Math.abs((await scrollTop(page)) - atTarget)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Backspace');
  await expect.poll(() => currentPage(page)).toBe(1);
  await page.keyboard.press('Shift+Backspace');
  await expect.poll(() => currentPage(page)).toBe(3);
  await expect(page.locator('.tw-marker-rect')).toHaveCount(0, { timeout: 3000 });
});

test('indicator none scrolls without a marker', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  await send(page, { type: 'forward', indicator: 'none', positions: [{ page: 3, left: 10, bottom: 370, right: 60, top: 390, x: 12, y: 380 }] });
  await expect.poll(() => currentPage(page)).toBe(3);
  await expect(page.locator('.tw-marker')).toHaveCount(0);
});

test('a forward to a page that does not exist logs a warning and changes nothing', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  await page.evaluate(() => (document.getElementById('viewerContainer')!.scrollTop = 200));
  await expect.poll(() => scrollTop(page)).toBe(200);
  await send(page, { type: 'forward', indicator: 'circle', positions: [{ page: 9, left: 10, bottom: 370, right: 60, top: 390, x: 12, y: 380 }] });
  const log = await lastProblem(page);
  expect(log.level).toBe('warn');
  expect(log.message).toContain('page 9');
  expect(await scrollTop(page)).toBe(200);
  expect(await currentPage(page)).toBe(1);
  await expect(page.locator('.tw-marker')).toHaveCount(0);
  // No position was recorded in the history.
  await page.keyboard.press('Alt+ArrowLeft');
  expect(await scrollTop(page)).toBe(200);
});

test('forward sent with a load is shown once the document is in place', async ({ page }) => {
  await page.goto(harnessUrl);
  await expect.poll(() => page.evaluate(() => (window as any).__posted?.some((m: any) => m.type === 'ready'))).toBe(true);
  await sendAll(page, [
    { type: 'config', config: { ...defaults, zoom: 'page-actual' } },
    { type: 'load', data: pdf('boxes'), reload: false, pdfPath: '/x/boxes.pdf' },
    { type: 'forward', indicator: 'circle', positions: [{ page: 3, left: 10, bottom: 370, right: 60, top: 390, x: 12, y: 380 }] },
  ]);
  await expect.poll(() => currentPage(page)).toBe(3);
  await expect(page.locator('.tw-marker-circle')).toHaveCount(1);
});

test('an internal link navigates and records history', async ({ page }) => {
  await openWith(page, 'links', { zoom: 'page-actual' });
  const link = page.locator('.annotationLayer a[href^="#"]');
  await link.click();
  await expect.poll(() => currentPage(page)).toBe(3);
  expect(await posted(page, 'openExternal')).toEqual([]);
  expect(page.url()).toBe(harnessUrl);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => currentPage(page)).toBe(1);
});

async function scale(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__app.view.pdfViewer.currentScale);
}

async function canvasFilter(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.page canvas')!).filter);
}

test('zoom buttons and ctrl+= / ctrl+- / ctrl+0', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  expect(await scale(page)).toBe(1);
  await expect(page.locator('#zoomSelect')).toHaveValue('page-actual');
  // pdf.js zoom steps: 1 → 1.1 → 1.3.
  await page.click('#zoomIn');
  await expect.poll(() => scale(page)).toBeCloseTo(1.1, 5);
  await expect(page.locator('#zoomSelect option:checked')).toHaveText('110%');
  await page.click('#zoomOut');
  await expect.poll(() => scale(page)).toBeCloseTo(1, 5);
  await page.keyboard.press('Control+Equal');
  await expect.poll(() => scale(page)).toBeCloseTo(1.1, 5);
  await page.keyboard.press('Control+Shift+Equal');
  await expect.poll(() => scale(page)).toBeCloseTo(1.3, 5);
  await page.keyboard.press('Control+Minus');
  await expect.poll(() => scale(page)).toBeCloseTo(1.1, 5);
  await expect.poll(() => page.evaluate(() => (window as any).__state?.scale)).toBe('1.1');
  await page.keyboard.press('Control+Digit0');
  await expect.poll(() => page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-actual');
  expect(await scale(page)).toBe(1);
  await expect(page.locator('#zoomSelect')).toHaveValue('page-actual');
});

test('zoom box applies presets and percentages', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  const labels = await page.locator('#zoomSelect option:not([hidden])').allTextContents();
  expect(labels).toEqual(['Automatic', 'Page Width', 'Page Fit', 'Actual Size', '50%', '75%', '100%', '125%', '150%', '200%', '300%', '400%']);
  await page.selectOption('#zoomSelect', '2');
  await expect.poll(() => scale(page)).toBe(2);
  await page.selectOption('#zoomSelect', 'page-width');
  await expect.poll(() => page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-width');
  // Page width: the page (300 pt) fills the container width less pdf.js's 40 px allowance for borders and scroll bar.
  const width = await page.evaluate(() => document.getElementById('viewerContainer')!.clientWidth);
  expect(await scale(page)).toBeCloseTo((width - 40) / (300 * 96 / 72), 2);
});

test('page box jumps and records history', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await page.locator('#pageNumber').fill('3');
  await page.locator('#pageNumber').press('Enter');
  await expect.poll(() => currentPage(page)).toBe(3);
  await expect(page.locator('#pageNumber')).toHaveValue('3');
  await page.keyboard.press('Backspace');
  await expect.poll(() => currentPage(page)).toBe(1);
  await expect(page.locator('#pageNumber')).toHaveValue('1');
  // A number outside the document leaves the page and puts the current number back.
  await page.locator('#pageNumber').fill('9');
  await page.locator('#pageNumber').press('Enter');
  await expect(page.locator('#pageNumber')).toHaveValue('1');
  expect(await currentPage(page)).toBe(1);
  await page.keyboard.press('End');
  await expect.poll(() => currentPage(page)).toBe(3);
  await page.keyboard.press('Home');
  await expect.poll(() => currentPage(page)).toBe(1);
});

test('find highlights matches and counts them', async ({ page }) => {
  await openWith(page, 'boxes', {});
  await page.keyboard.press('Control+f');
  await expect(page.locator('#findbar')).toBeVisible();
  await expect(page.locator('#findInput')).toBeFocused();
  await page.locator('#findInput').fill('page');
  await expect(page.locator('#findCount')).toHaveText(/2/);
  // "Second page." and "Third page.": the first match is selected and shown.
  await expect(page.locator('#findCount')).toHaveText('1 of 2');
  await expect.poll(() => currentPage(page)).toBe(2);
  await expect(page.locator('.page[data-page-number="2"] .textLayer .highlight.selected')).toHaveCount(1);
  await page.locator('#findInput').press('Enter');
  await expect(page.locator('#findCount')).toHaveText('2 of 2');
  await expect.poll(() => currentPage(page)).toBe(3);
  await page.locator('#findInput').press('Shift+Enter');
  await expect(page.locator('#findCount')).toHaveText('1 of 2');
  await page.locator('#findInput').fill('PAGE');
  await expect(page.locator('#findCount')).toHaveText('1 of 2');
  await page.locator('#findInput').fill('nowhere');
  await expect(page.locator('#findCount')).toHaveText('No matches');
  await page.locator('#findInput').press('Escape');
  await expect(page.locator('#findbar')).toBeHidden();
  await expect(page.locator('.textLayer .highlight')).toHaveCount(0);
  await page.click('#findButton');
  await expect(page.locator('#findbar')).toBeVisible();
  await expect(page.locator('#findInput')).toBeFocused();
});

test('inversion follows the mode and the body class', async ({ page }) => {
  await openWith(page, 'boxes', { invertMode: 'auto', invert: 0.9 });
  expect(await canvasFilter(page)).toBe('none');
  await page.evaluate(() => document.body.classList.add('vscode-dark'));
  await expect.poll(() => canvasFilter(page)).toContain('invert(0.9)');
  await page.click('#invertButton');
  await expect.poll(() => canvasFilter(page)).toBe('none');
  await expect.poll(() => page.evaluate(() => (window as any).__state?.invertOverride)).toBe(false);
  await page.click('#invertButton');
  await expect.poll(() => canvasFilter(page)).toContain('invert(0.9)');
  // A high-contrast light theme carries both high-contrast classes (VS Code 1.138); it is not dark.
  await page.evaluate(() => {
    document.body.classList.remove('vscode-dark');
    document.body.classList.add('vscode-high-contrast', 'vscode-high-contrast-light');
  });
  await expect.poll(() => canvasFilter(page)).toBe('none');
  await page.evaluate(() => document.body.classList.remove('vscode-high-contrast-light'));
  await expect.poll(() => canvasFilter(page)).toContain('invert(0.9)');
  await send(page, { type: 'config', config: { ...defaults, invertMode: 'always', invert: 0.5 } });
  await page.evaluate(() => document.body.classList.remove('vscode-high-contrast'));
  await expect.poll(() => canvasFilter(page)).toBe('invert(0.5) hue-rotate(180deg)');
  await send(page, { type: 'config', config: { ...defaults, invertMode: 'never', invert: 0.5 } });
  await expect.poll(() => canvasFilter(page)).toBe('none');
});

test('changing only the inversion strength keeps the toolbar choice', async ({ page }) => {
  await openWith(page, 'boxes', { invertMode: 'never', invert: 0.9 });
  await page.click('#invertButton');
  await expect.poll(() => canvasFilter(page)).toBe('invert(0.9) hue-rotate(180deg)');
  await send(page, { type: 'config', config: { ...defaults, invertMode: 'never', invert: 0.6 } });
  await expect.poll(() => canvasFilter(page)).toBe('invert(0.6) hue-rotate(180deg)');
  await expect.poll(() => page.evaluate(() => (window as any).__state?.invertOverride)).toBe(true);
  // A changed mode ends the toolbar choice: auto without a dark theme does not invert.
  await send(page, { type: 'config', config: { ...defaults, invertMode: 'auto', invert: 0.6 } });
  await expect.poll(() => canvasFilter(page)).toBe('none');
  await expect.poll(() => page.evaluate(() => (window as any).__state?.invertOverride)).toBeNull();
});

test('state saved after scroll and used on restore', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: '1.5' });
  await page.evaluate(() => (document.getElementById('viewerContainer')!.scrollTop = 700));
  await expect.poll(() => page.evaluate(() => (window as any).__state?.scrollTop)).toBe(700);
  await page.click('#invertButton');
  await expect.poll(() => page.evaluate(() => (window as any).__state?.invertOverride)).toBe(true);
  const state = await page.evaluate(() => (window as any).__state);
  expect(state).toMatchObject({ pdfPath: '/x/boxes.pdf', scale: '1.5', scrollTop: 700, scrollLeft: 0, invertOverride: true });
  // VS Code restores the tab: the new webview gets the saved state, then config and a first load of the same PDF.
  await page.addInitScript((s) => ((window as any).__state = s), state);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__posted?.some((m: any) => m.type === 'ready'))).toBe(true);
  await send(page, { type: 'config', config: { ...defaults, zoom: 'page-width' } });
  await send(page, { type: 'load', data: pdf('boxes'), reload: false, pdfPath: '/x/boxes.pdf' });
  await expect(page.locator('#pageCount')).toHaveText('/ 3');
  await expect.poll(() => scrollTop(page)).toBe(700);
  expect(await page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('1.5');
  await expect(page.locator('.page canvas').first()).toBeVisible();
  expect(await canvasFilter(page)).toContain('invert(0.9)');
});

test('saved state of another PDF is not applied', async ({ page }) => {
  await page.addInitScript(() => ((window as any).__state = { pdfPath: '/x/other.pdf', scale: '1.5', scrollTop: 700, scrollLeft: 0, invertOverride: true }));
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  expect(await page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-actual');
  expect(await scrollTop(page)).toBeLessThan(700);
  expect(await canvasFilter(page)).toBe('none');
});

test('malformed messages are ignored with a warning and the tab keeps working', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  await sendAll(page, [
    { type: 'config' },
    { type: 'config', config: null },
    { type: 'config', config: 'page-width' },
    { type: 'load', reload: true, pdfPath: '/x/boxes.pdf' },
    { type: 'load', data: 'not bytes', reload: true, pdfPath: '/x/boxes.pdf' },
    { type: 'load', data: pdf('boxes'), reload: 'yes', pdfPath: '/x/boxes.pdf' },
    { type: 'load', data: pdf('boxes'), reload: true },
    { type: 'forward', indicator: 'circle' },
    { type: 'forward', positions: [{ page: 2, left: 0, bottom: 0, right: 1, top: 1, x: 0, y: 0 }], indicator: 'sparkles' },
    { type: 'forward', positions: [{ page: 'two' }], indicator: 'circle' },
  ]);
  const logs = await problems(page);
  expect(logs.filter((m) => m.level === 'warn')).toHaveLength(10);
  expect(logs.filter((m) => m.level !== 'warn')).toEqual([]);
  expect(await currentPage(page)).toBe(1);
  expect(await page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-actual');
  // Ctrl+click still looks up the source, on a link too, and the link is not followed.
  const target = await framePoint(page, 1, 110, 110);
  const p = await pixelNear(page, 1, BOXES_PAGE, target.x, target.y);
  await ctrlClick(page, p.x, p.y);
  await expect.poll(async () => (await posted(page, 'inverse')).length).toBe(1);
  const link = (await page.locator('.annotationLayer a[href^="https://example.com"]').boundingBox())!;
  await ctrlClick(page, link.x + link.width / 2, link.y + link.height / 2);
  await expect.poll(async () => (await posted(page, 'inverse')).length).toBe(2);
  expect(await posted(page, 'openExternal')).toEqual([]);
  // Ctrl+0 and the dark toggle still work, and a following load renders.
  await page.keyboard.press('Control+Digit0');
  await page.click('#invertButton');
  await expect.poll(() => canvasFilter(page)).toContain('invert(0.9)');
  await send(page, { type: 'load', data: pdf('long'), reload: false, pdfPath: '/x/long.pdf' });
  await expect(page.locator('#pageCount')).toHaveText('/ 200');
  await expect(page.locator('.page[data-page-number="1"] canvas')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-actual');
  expect((await problems(page)).filter((m) => m.level !== 'warn')).toEqual([]);
});

test('config values outside the allowed ones fall back to the defaults', async ({ page }) => {
  await openWith(page, 'boxes', { zoom: 'page-actual' });
  await send(page, { type: 'config', config: { zoom: '125%', scrollMode: 'diagonal', spreadMode: 'odd', invertMode: 'sometimes', invert: 'strong', syncKeybinding: 'triple-click', indicator: 'circle' } });
  const warning = (await posted(page, 'log')).at(-1);
  expect(warning.level).toBe('warn');
  for (const field of ['zoom', 'scrollMode', 'invertMode', 'invert', 'syncKeybinding']) expect(warning.message).toContain(field);
  for (const field of ['spreadMode', 'indicator']) expect(warning.message).not.toContain(field);
  await expect.poll(() => page.evaluate(() => (window as any).__app.view.currentScaleValue)).toBe('page-width');
  expect(await page.evaluate(() => [(window as any).__app.view.pdfViewer.scrollMode, (window as any).__app.view.pdfViewer.spreadMode])).toEqual([0, 1]);
  expect(await canvasFilter(page)).toBe('none');
  const target = await framePoint(page, 1, 110, 110);
  const p = await pixelNear(page, 1, BOXES_PAGE, target.x, target.y);
  await ctrlClick(page, p.x, p.y);
  await expect.poll(async () => (await posted(page, 'inverse')).length).toBe(1);
});
