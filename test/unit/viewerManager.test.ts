import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryLogger } from '../../src/log';
import { ViewerManager } from '../../src/viewer/manager';
import type { ViewerConfig } from '../../src/viewer/messages';
import { FakeWebviewPanel, Uri, ViewColumn, testHooks } from './vscode-stub';

const config: ViewerConfig = { zoom: 'page-width', scrollMode: 'vertical', spreadMode: 'none', invertMode: 'never', invert: 0.9, syncKeybinding: 'ctrl-click', indicator: 'circle' };
let dir: string;
let pdf: string;
let manager: ViewerManager;
let group: 'right' | 'current';
let log: ReturnType<typeof memoryLogger>;
const onInverse = vi.fn();
const onOpenExternal = vi.fn();
const onDidChangeActive = vi.fn();

beforeEach(() => {
  testHooks.reset();
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-view-'));
  pdf = path.join(dir, 'Ä b', 'main.pdf');
  fs.mkdirSync(path.dirname(pdf));
  fs.writeFileSync(pdf, '%PDF-1.7 first');
  group = 'right';
  log = memoryLogger();
  manager = new ViewerManager({ extensionUri: Uri.file('/ext') as never, logger: log, config: () => config, editorGroup: () => group, onInverse, onOpenExternal, onDidChangeActive });
});

afterEach(() => {
  manager.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setTimeout(r, 20));

async function openReady(p = pdf): Promise<FakeWebviewPanel> {
  await manager.open(p);
  const panel = testHooks.panels[testHooks.panels.length - 1];
  panel.webview.send({ type: 'ready' });
  await vi.waitFor(() => expect(panel.webview.posted.some((m) => m.type === 'load')).toBe(true));
  return panel;
}

test('a tab per PDF: title, view type, options, HTML with the bundled assets', async () => {
  const panel = await manager.open(pdf);
  const [fake] = testHooks.panels;
  expect(panel.pdfPath).toBe(pdf);
  expect(fake.viewType).toBe('typst-workshop.pdf');
  expect(fake.title).toBe('main.pdf');
  expect(fake.showOptions).toEqual({ viewColumn: ViewColumn.Beside, preserveFocus: false });
  expect(fake.options).toMatchObject({ enableScripts: true, retainContextWhenHidden: true });
  expect((fake.options as { localResourceRoots: Uri[] }).localResourceRoots.map((u) => u.fsPath)).toEqual(['/ext/dist/webview']);
  const html = fake.webview.html;
  expect(html).toContain('src="vscode-webview://fake/ext/dist/webview/viewer.js"');
  expect(html.indexOf('/ext/dist/webview/pdf_viewer.css')).toBeLessThan(html.indexOf('/ext/dist/webview/viewer.css'));
  expect(html).toContain('connect-src vscode-webview://fake');
  expect(manager.isOpen(pdf)).toBe(true);
  expect(manager.panelsFor(pdf)).toEqual([panel]);
});

test('a new tab carries the icon of the extension', async () => {
  await manager.open(pdf);
  expect(testHooks.panels[0].iconPath?.fsPath).toBe('/ext/media/icon.png');
});

test('the current group setting opens the tab in the active column, unless beside is asked for', async () => {
  group = 'current';
  await manager.open(pdf, { preserveFocus: true });
  expect(testHooks.panels[0].showOptions).toEqual({ viewColumn: ViewColumn.Active, preserveFocus: true });
  testHooks.panels[0].dispose();
  await manager.open(pdf, { preserveFocus: true, beside: true });
  expect(testHooks.panels[1].showOptions).toEqual({ viewColumn: ViewColumn.Beside, preserveFocus: true });
});

test('ready is answered with config, then load (reload false) carrying a plain Uint8Array of the PDF', async () => {
  const panel = await openReady();
  const [first, second] = panel.webview.posted;
  expect(first).toEqual({ type: 'config', config });
  expect(second).toMatchObject({ type: 'load', reload: false, pdfPath: pdf });
  expect(Object.getPrototypeOf(second.data)).toBe(Uint8Array.prototype);
  expect(Buffer.from(second.data).toString()).toBe('%PDF-1.7 first');
});

test('opening a PDF that already has a tab reveals it', async () => {
  const first = await manager.open(pdf);
  const again = await manager.open(pdf, { preserveFocus: true });
  expect(again).toBe(first);
  expect(testHooks.panels).toHaveLength(1);
  expect(testHooks.panels[0].reveals).toEqual([{ column: 2, preserveFocus: true }]);
});

test('reload posts load (reload true) with the new bytes to every ready tab of that PDF only', async () => {
  const a = await openReady();
  const otherPdf = path.join(dir, 'other.pdf');
  fs.writeFileSync(otherPdf, '%PDF other');
  const b = await openReady(otherPdf);
  fs.writeFileSync(pdf, '%PDF-1.7 second');
  await manager.reload(pdf);
  const last = a.webview.posted[a.webview.posted.length - 1];
  expect(last).toMatchObject({ type: 'load', reload: true, pdfPath: pdf });
  expect(Buffer.from(last.data).toString()).toBe('%PDF-1.7 second');
  expect(b.webview.posted.filter((m) => m.type === 'load')).toHaveLength(1);
});

test('a tab that is not ready yet gets the newest PDF when it becomes ready, and a pending forward after it', async () => {
  await manager.open(pdf);
  const panel = testHooks.panels[0];
  await manager.reload(pdf);
  expect(panel.webview.posted).toEqual([]);
  const positions = [{ page: 1, left: 1, bottom: 2, right: 3, top: 4, x: 1, y: 3 }];
  manager.forward(pdf, positions, 'rectangle');
  expect(manager.lastForward).toEqual({ pdf, positions });
  fs.writeFileSync(pdf, '%PDF-1.7 newest');
  panel.webview.send({ type: 'ready' });
  await vi.waitFor(() => expect(panel.webview.posted).toHaveLength(3));
  expect(panel.webview.posted.map((m) => m.type)).toEqual(['config', 'load', 'forward']);
  expect(Buffer.from(panel.webview.posted[1].data).toString()).toBe('%PDF-1.7 newest');
  expect(panel.webview.posted[2]).toEqual({ type: 'forward', positions, indicator: 'rectangle' });
});

test('forward goes to ready tabs at once and is remembered', async () => {
  const panel = await openReady();
  const positions = [{ page: 2, left: 1, bottom: 2, right: 3, top: 4, x: 1, y: 3 }];
  manager.forward(pdf, positions, 'circle');
  expect(panel.webview.posted[panel.webview.posted.length - 1]).toEqual({ type: 'forward', positions, indicator: 'circle' });
  expect(manager.lastForward).toEqual({ pdf, positions });
});

test('pushConfig sends the current config to every ready tab', async () => {
  const panel = await openReady();
  manager.pushConfig();
  expect(panel.webview.posted[panel.webview.posted.length - 1]).toEqual({ type: 'config', config });
});

test('messages from the tab: inverse, external links (http, https, mailto only), log lines; junk is ignored', async () => {
  const panel = await openReady();
  panel.webview.send({ type: 'inverse', page: 2, x: 100.5, y: 200 });
  expect(onInverse).toHaveBeenCalledWith(pdf, { page: 2, x: 100.5, y: 200 }, manager.panelsFor(pdf)[0]);
  panel.webview.send({ type: 'inverse', page: 'x', x: 1, y: 2 });
  panel.webview.send({ type: 'inverse', page: 1, x: Number.NaN, y: 2 });
  expect(onInverse).toHaveBeenCalledTimes(1);
  for (const url of ['https://typst.app/docs', 'http://example.com', 'mailto:someone@example.com']) panel.webview.send({ type: 'openExternal', url });
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'command:workbench.action.quit', 'not a url']) panel.webview.send({ type: 'openExternal', url });
  expect(onOpenExternal.mock.calls.map((c) => c[0])).toEqual(['https://typst.app/docs', 'http://example.com', 'mailto:someone@example.com']);
  panel.webview.send({ type: 'log', level: 'error', message: 'PDF parse failed' });
  panel.webview.send({ type: 'log', level: 'fatal', message: 'x' });
  panel.webview.send(null);
  panel.webview.send({ type: 'unknown' });
  expect(log.lines.filter((l) => l.includes('PDF parse failed'))).toEqual(['error [viewer] PDF parse failed']);
});

test('a failing message handler is logged', async () => {
  await manager.open(pdf);
  const panel = testHooks.panels[0];
  panel.webview.postMessage = async () => {
    throw new Error('webview is gone');
  };
  panel.webview.send({ type: 'ready' });
  await vi.waitFor(() => expect(log.lines.some((l) => l.startsWith('error') && l.includes('webview is gone'))).toBe(true));
});

test('a missing PDF is logged and the tab gets config only', async () => {
  fs.rmSync(pdf);
  await manager.open(pdf);
  const panel = testHooks.panels[0];
  panel.webview.send({ type: 'ready' });
  await flush();
  expect(panel.webview.posted.map((m) => m.type)).toEqual(['config']);
  expect(log.lines.some((l) => l.includes('main.pdf'))).toBe(true);
});

test('a closed tab is forgotten; the active tab is reported', async () => {
  await openReady();
  const panel = testHooks.panels[0];
  panel.setActive(true);
  expect(manager.activePdf()).toBe(pdf);
  expect(onDidChangeActive).toHaveBeenCalled();
  panel.dispose();
  expect(manager.isOpen(pdf)).toBe(false);
  expect(manager.activePdf()).toBeUndefined();
  await manager.reload(pdf);
});

test('the serializer restores a tab from its saved state', async () => {
  const d = manager.registerSerializer();
  const serializer = testHooks.serializers.get('typst-workshop.pdf')!;
  const restored = new FakeWebviewPanel('typst-workshop.pdf', 'main.pdf', {}, {});
  await serializer.deserializeWebviewPanel(restored, { pdfPath: pdf, scrollTop: 120 });
  expect(manager.isOpen(pdf)).toBe(true);
  expect(restored.webview.options).toMatchObject({ enableScripts: true });
  expect(restored.webview.html).toContain('viewer.js');
  restored.webview.send({ type: 'ready' });
  await vi.waitFor(() => expect(restored.webview.posted.map((m) => m.type)).toEqual(['config', 'load']));

  const empty = new FakeWebviewPanel('typst-workshop.pdf', 'x', {}, {});
  await serializer.deserializeWebviewPanel(empty, undefined);
  expect(empty.disposed).toBe(true);
  d.dispose();
  expect(testHooks.serializers.size).toBe(0);
});

test('a restored tab carries the icon of the extension', async () => {
  const d = manager.registerSerializer();
  const restored = new FakeWebviewPanel('typst-workshop.pdf', 'main.pdf', {}, {});
  await testHooks.serializers.get('typst-workshop.pdf')!.deserializeWebviewPanel(restored, { pdfPath: pdf });
  expect(restored.iconPath?.fsPath).toBe('/ext/media/icon.png');
  d.dispose();
});

test('the serializer restores only tabs whose saved PDF path is absolute and ends in .pdf', async () => {
  const onDidRestore = vi.fn();
  const viewers = new ViewerManager({ extensionUri: Uri.file('/ext') as never, logger: log, config: () => config, editorGroup: () => group, onInverse, onOpenExternal, onDidRestore });
  const d = viewers.registerSerializer();
  const serializer = testHooks.serializers.get('typst-workshop.pdf')!;
  for (const pdfPath of ['main.pdf', 'docs/main.pdf', path.join(dir, 'secret.txt'), path.join(dir, 'main.typ'), '/etc/passwd', '', 42]) {
    const panel = new FakeWebviewPanel('typst-workshop.pdf', 'x', {}, {});
    await serializer.deserializeWebviewPanel(panel, { pdfPath });
    expect(panel.disposed, String(pdfPath)).toBe(true);
    expect(panel.webview.html).toBe('');
  }
  expect(onDidRestore).not.toHaveBeenCalled();
  const panel = new FakeWebviewPanel('typst-workshop.pdf', 'main.pdf', {}, {});
  await serializer.deserializeWebviewPanel(panel, { pdfPath: pdf });
  expect(panel.disposed).toBe(false);
  expect(viewers.isOpen(pdf)).toBe(true);
  d.dispose();
  viewers.dispose();
});

test('a restored tab is reported with its PDF, so that the PDF can be built', async () => {
  const onDidRestore = vi.fn();
  const viewers = new ViewerManager({ extensionUri: Uri.file('/ext') as never, logger: log, config: () => config, editorGroup: () => group, onInverse, onOpenExternal, onDidRestore });
  const d = viewers.registerSerializer();
  const serializer = testHooks.serializers.get('typst-workshop.pdf')!;
  await serializer.deserializeWebviewPanel(new FakeWebviewPanel('typst-workshop.pdf', 'main.pdf', {}, {}), { pdfPath: pdf });
  expect(onDidRestore).toHaveBeenCalledWith(pdf);
  await serializer.deserializeWebviewPanel(new FakeWebviewPanel('typst-workshop.pdf', 'x', {}, {}), undefined);
  expect(onDidRestore).toHaveBeenCalledTimes(1);
  d.dispose();
  viewers.dispose();
});

describe('loads are ordered by build', () => {
  /** A PDF reader whose reads the test completes in any order. */
  function controlledReads() {
    const reads: { pdf: string; finish(text: string | undefined): Promise<void> }[] = [];
    const readPdf = (p: string) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        reads.push({
          pdf: p,
          finish: async (text) => {
            resolve(text === undefined ? undefined : new Uint8Array(Buffer.from(text)));
            await flush();
          },
        });
      });
    return { reads, readPdf };
  }

  let reads: ReturnType<typeof controlledReads>['reads'];
  let viewers: ViewerManager;
  const loads = (panel: FakeWebviewPanel) => panel.webview.posted.filter((m) => m.type === 'load').map((m) => `${Buffer.from(m.data).toString()}${m.reload ? ' (reload)' : ''}`);

  beforeEach(() => {
    const c = controlledReads();
    reads = c.reads;
    viewers = new ViewerManager({ extensionUri: Uri.file('/ext') as never, logger: log, config: () => config, editorGroup: () => group, onInverse, onOpenExternal, readPdf: c.readPdf });
  });
  afterEach(() => viewers.dispose());

  async function readyTab(): Promise<FakeWebviewPanel> {
    await viewers.open(pdf);
    const panel = testHooks.panels[testHooks.panels.length - 1];
    panel.webview.send({ type: 'ready' });
    await flush();
    return panel;
  }

  test('a load read for an older build is dropped once a newer one has been posted', async () => {
    const panel = await readyTab();
    await reads[0].finish('v1');
    viewers.buildStarted(pdf);
    const second = viewers.buildFinished(pdf, true);
    viewers.buildStarted(pdf);
    const third = viewers.buildFinished(pdf, true);
    expect(reads).toHaveLength(3);
    await reads[2].finish('v3');
    await reads[1].finish('v2');
    await Promise.all([second, third]);
    expect(loads(panel)).toEqual(['v1', 'v3 (reload)']);
  });

  test('a tab that becomes ready during a build receives exactly one load, from that build', async () => {
    viewers.buildStarted(pdf);
    const panel = await readyTab();
    expect(panel.webview.posted.map((m) => m.type)).toEqual(['config']);
    expect(reads).toHaveLength(0);
    const finished = viewers.buildFinished(pdf, true);
    await reads[0].finish('new');
    await finished;
    expect(loads(panel)).toEqual(['new']);
  });

  test('a tab that becomes ready during a failed build gets the PDF on disk once', async () => {
    viewers.buildStarted(pdf);
    const panel = await readyTab();
    const finished = viewers.buildFinished(pdf, false);
    await reads[0].finish('previous');
    await finished;
    expect(loads(panel)).toEqual(['previous']);
  });

  test('a ready tab whose first read is overtaken by a build gets only the newer PDF', async () => {
    const panel = await readyTab();
    viewers.buildStarted(pdf);
    const finished = viewers.buildFinished(pdf, true);
    await reads[1].finish('new');
    await reads[0].finish('old');
    await finished;
    expect(loads(panel)).toEqual(['new']);
  });

  test('a forward waits for the tab’s first document', async () => {
    viewers.buildStarted(pdf);
    const panel = await readyTab();
    const positions = [{ page: 1, left: 1, bottom: 2, right: 3, top: 4, x: 1, y: 3 }];
    viewers.forward(pdf, positions, 'circle');
    expect(panel.webview.posted.map((m) => m.type)).toEqual(['config']);
    const finished = viewers.buildFinished(pdf, true);
    await reads[0].finish('new');
    await finished;
    expect(panel.webview.posted.map((m) => m.type)).toEqual(['config', 'load', 'forward']);
  });
});
