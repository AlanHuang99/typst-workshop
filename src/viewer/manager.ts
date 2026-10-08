import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { InverseParams, PdfRect } from '../helper/protocol';
import type { Logger } from '../log';
import { errorText } from '../util/helpers';
import { makeNonce, viewerHtml } from './html';
import { VIEW_TYPE, type IndicatorStyle, type ToViewer, type ViewerConfig, type ViewerState } from './messages';
import { PdfPanel } from './panel';

export interface ViewerManagerOptions {
  extensionUri: vscode.Uri;
  logger: Logger;
  config(): ViewerConfig;
  editorGroup(): 'right' | 'current';
  /** A Ctrl+click (or double-click) in a tab, in PDF coordinates. */
  onInverse(pdf: string, p: InverseParams, panel: PdfPanel): void;
  /** An external link clicked in a tab (http, https or mailto). */
  onOpenExternal(url: string): void;
  /** A tab became active or inactive, or was opened or closed. */
  onDidChangeActive?(): void;
  /** VS Code restored a tab of this PDF (after a window reload or a restart). */
  onDidRestore?(pdf: string): void;
  /** Reads a PDF (default: from disk); tests replace it to order reads. */
  readPdf?(pdf: string): Promise<Uint8Array | undefined>;
}

interface Tab {
  panel: PdfPanel;
  /** The page posted `ready`; messages before that would be lost. */
  ready: boolean;
  /** The sequence number of the last document posted to the page (0: none yet). */
  shown: number;
  /** The page became ready while its PDF was being built; the build's end loads it. */
  waiting: boolean;
  /** A forward lookup that arrived before the page had a document. */
  pendingForward?: ToViewer;
  subscriptions: vscode.Disposable[];
}

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function isAllowedUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Webview state worth restoring: the path of a PDF, absolute and ending in `.pdf`; the tab reads and shows that file. */
function isViewerState(value: unknown): value is ViewerState {
  if (typeof value !== 'object' || value === null) return false;
  const pdfPath = (value as ViewerState).pdfPath;
  return typeof pdfPath === 'string' && path.isAbsolute(pdfPath) && pdfPath.endsWith('.pdf');
}

/**
 * The PDF tabs: one webview panel per PDF path, restored after a restart by the panel serializer. A tab that posts `ready` gets the config and then the PDF bytes; rebuilt PDFs go to every tab of that path.
 *
 * Every read of a PDF takes the next sequence number of that path, and a page never gets a document older than the one it shows, so a slow read for an older build cannot overwrite a newer one. A page that becomes ready while its PDF is being built waits for that build and gets exactly one document.
 */
export class ViewerManager implements vscode.Disposable {
  /** The last forward lookup posted (used by the integration tests). */
  lastForward?: { pdf: string; positions: PdfRect[] };
  private readonly tabs = new Set<Tab>();
  private readonly reads = new Map<string, number>();
  private readonly builds = new Map<string, number>();

  constructor(private readonly o: ViewerManagerOptions) {}

  /** Reveals the tab of the PDF, or opens one beside the editor or in the current group (`view.pdf.tab.editorGroup`); `beside` opens it beside regardless of the setting (forward lookups). */
  async open(pdf: string, options: { preserveFocus?: boolean; beside?: boolean } = {}): Promise<PdfPanel> {
    const preserveFocus = options.preserveFocus ?? false;
    const existing = this.panelsFor(pdf)[0];
    if (existing) {
      existing.reveal(preserveFocus);
      return existing;
    }
    const viewColumn = options.beside || this.o.editorGroup() !== 'current' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    const webviewPanel = vscode.window.createWebviewPanel(VIEW_TYPE, path.basename(pdf), { viewColumn, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.webviewRoot()] });
    this.o.logger.info(`Opened the PDF tab for ${pdf}`);
    return this.attach(webviewPanel, pdf);
  }

  isOpen(pdf: string): boolean {
    return this.panelsFor(pdf).length > 0;
  }

  panelsFor(pdf: string): PdfPanel[] {
    return [...this.tabs].filter((t) => t.panel.pdfPath === pdf).map((t) => t.panel);
  }

  /** The PDF of the active tab, if a PDF tab is the active editor. */
  activePdf(): string | undefined {
    for (const t of this.tabs) if (t.panel.panel.active) return t.panel.pdfPath;
    return undefined;
  }

  /** Posts the rebuilt PDF to every ready tab of that path (tabs that are not ready load it when they are). */
  async reload(pdf: string): Promise<void> {
    const targets = [...this.tabs].filter((t) => t.panel.pdfPath === pdf && t.ready);
    if (targets.length > 0) await this.load(pdf, targets);
  }

  /** A build of the PDF started: pages that become ready now wait for its end. */
  buildStarted(pdf: string): void {
    this.builds.set(pdf, (this.builds.get(pdf) ?? 0) + 1);
  }

  /** A build of the PDF ended: a written PDF goes to every ready tab; otherwise the waiting tabs get the PDF on disk. */
  async buildFinished(pdf: string, written: boolean): Promise<void> {
    const running = (this.builds.get(pdf) ?? 1) - 1;
    if (running > 0) this.builds.set(pdf, running);
    else this.builds.delete(pdf);
    if (written) return this.reload(pdf);
    const waiting = [...this.tabs].filter((t) => t.panel.pdfPath === pdf && t.waiting);
    if (waiting.length > 0) await this.load(pdf, waiting);
  }

  /** Posts a forward lookup's positions to the tabs of the PDF (after their first document). */
  forward(pdf: string, positions: PdfRect[], indicator: IndicatorStyle): void {
    this.lastForward = { pdf, positions };
    const message: ToViewer = { type: 'forward', positions, indicator };
    for (const t of this.tabs) {
      if (t.panel.pdfPath !== pdf) continue;
      if (t.ready && t.shown > 0) this.send(t, message);
      else t.pendingForward = message;
    }
  }

  /** Sends the current view and sync settings to every ready tab. */
  pushConfig(): void {
    const config = this.o.config();
    for (const t of this.tabs) if (t.ready) this.send(t, { type: 'config', config });
  }

  registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (webviewPanel: vscode.WebviewPanel, state: unknown) => {
        if (!isViewerState(state)) {
          webviewPanel.dispose();
          return;
        }
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.webviewRoot()] };
        this.o.logger.info(`Restored the PDF tab for ${state.pdfPath}`);
        this.attach(webviewPanel, state.pdfPath);
        this.o.onDidRestore?.(state.pdfPath);
      },
    });
  }

  /** Stops listening to the tabs; the tabs themselves stay open so that VS Code can restore them. */
  dispose(): void {
    for (const t of this.tabs) for (const s of t.subscriptions) s.dispose();
    this.tabs.clear();
  }

  /** Posts without waiting; a tab that went away meanwhile is only logged. */
  private send(tab: Tab, message: ToViewer): void {
    try {
      Promise.resolve(tab.panel.post(message)).catch((err: unknown) => this.o.logger.warn(`Could not post ${message.type} to the PDF tab: ${errorText(err)}`));
    } catch (err) {
      this.o.logger.warn(`Could not post ${message.type} to the PDF tab: ${errorText(err)}`);
    }
  }

  private webviewRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.o.extensionUri, 'dist', 'webview');
  }

  private attach(webviewPanel: vscode.WebviewPanel, pdf: string): PdfPanel {
    const panel = new PdfPanel(pdf, webviewPanel);
    const tab: Tab = { panel, ready: false, shown: 0, waiting: false, subscriptions: [] };
    this.tabs.add(tab);
    tab.subscriptions.push(
      panel.onMessage((m) => void this.onMessage(tab, m).catch((err: unknown) => this.o.logger.error(`Handling a message from the PDF tab of ${pdf} failed: ${errorText(err)}`))),
      webviewPanel.onDidDispose(() => this.forget(tab)),
      webviewPanel.onDidChangeViewState(() => this.o.onDidChangeActive?.()),
    );
    const webview = webviewPanel.webview;
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.webviewRoot(), name)).toString();
    webview.html = viewerHtml({ cspSource: webview.cspSource, nonce: makeNonce(), scriptUri: asset('viewer.js'), cssUris: [asset('pdf_viewer.css'), asset('viewer.css')] });
    this.o.onDidChangeActive?.();
    return panel;
  }

  private forget(tab: Tab): void {
    for (const s of tab.subscriptions) s.dispose();
    this.tabs.delete(tab);
    this.o.onDidChangeActive?.();
  }

  private async onMessage(tab: Tab, message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    switch (m.type) {
      case 'ready':
        return this.onReady(tab);
      case 'inverse': {
        const { page, x, y } = m;
        if (typeof page === 'number' && Number.isInteger(page) && typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
          this.o.onInverse(tab.panel.pdfPath, { page, x, y }, tab.panel);
        }
        return;
      }
      case 'openExternal':
        if (isAllowedUrl(m.url)) this.o.onOpenExternal(m.url);
        else this.o.logger.warn(`The PDF tab asked to open a link that is not http, https or mailto: ${String(m.url)}`);
        return;
      case 'log': {
        const text = typeof m.message === 'string' ? m.message : '';
        if (m.level === 'info' || m.level === 'warn' || m.level === 'error') this.o.logger[m.level](`[viewer] ${text}`);
        return;
      }
      default:
        return;
    }
  }

  private async onReady(tab: Tab): Promise<void> {
    tab.ready = true;
    tab.shown = 0;
    tab.waiting = false;
    await tab.panel.post({ type: 'config', config: this.o.config() });
    const pdf = tab.panel.pdfPath;
    if (this.builds.has(pdf)) {
      tab.waiting = true;
      return;
    }
    await this.load(pdf, [tab]);
  }

  /** Reads the PDF under the next sequence number of its path and posts it to the tabs that do not show a newer one. */
  private async load(pdf: string, tabs: Tab[]): Promise<void> {
    const seq = (this.reads.get(pdf) ?? 0) + 1;
    this.reads.set(pdf, seq);
    const data = await (this.o.readPdf ?? ((p: string) => this.read(p)))(pdf);
    if (!data) return;
    for (const t of tabs) {
      if (!this.tabs.has(t) || !t.ready || t.shown > seq) continue;
      this.send(t, { type: 'load', data, reload: t.shown > 0, pdfPath: pdf });
      t.shown = seq;
      t.waiting = false;
      const pending = t.pendingForward;
      t.pendingForward = undefined;
      if (pending) this.send(t, pending);
    }
  }

  /** The PDF as a plain Uint8Array (a Node Buffer would be posted as JSON numbers). */
  private async read(pdf: string): Promise<Uint8Array | undefined> {
    try {
      const buffer = await fs.promises.readFile(pdf);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') this.o.logger.info(`${pdf} does not exist yet; the tab shows it after the first build`);
      else this.o.logger.error(`Cannot read ${pdf}: ${errorText(err)}`);
      return undefined;
    }
  }
}
