// The PDF tab: builds the DOM, starts pdf.js and handles the extension's messages.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfRect } from '../src/helper/protocol';
import type { FromViewer, IndicatorStyle, ToViewer, ViewerConfig, ViewerState } from '../src/viewer/messages';
import { buildLayout, type Layout } from './dom';
import { FindBar } from './find';
import { currentPosition, History } from './history';
import { applyInvert, modeInverts, onInvertChange } from './invert';
import { installKeys } from './keys';
import { loadPdfjs } from './pdfjs';
import { cancelReload, isReloading, isRestorePending, reloadInPlace } from './reload';
import { initialState, saveState, type VsCodeApi } from './state';
import { installInverse, showForward } from './sync';
import { buildToolbar } from './toolbar';
import { checkConfig, DEFAULT_CONFIG } from './validate';
import { View } from './view';

export class App {
  /** The pdf.js viewer; set once pdf.js has loaded (before `ready` is posted). */
  view!: View;
  history!: History;
  private readonly api: VsCodeApi;
  private readonly layout: Layout;
  private readonly init: Promise<void>;
  private config: ViewerConfig = DEFAULT_CONFIG;
  private configReceived = false;
  /** The config whose view settings (zoom, scroll and spread modes) the displayed document last received; later changes are applied as differences. */
  private appliedConfig: ViewerConfig | undefined;
  /** State handed over by VS Code when it restored the tab; used for the first document with the same path. */
  private restored: ViewerState | undefined;
  /** The toolbar toggle's choice for this tab; null follows `invertMode`. */
  private invertOverride: boolean | null = null;
  /** A `forward` that arrived while a document was loading; shown once it is in place. */
  private pendingForward: { positions: PdfRect[]; indicator: IndicatorStyle } | undefined;
  /** The documents already reported with an info line; each is reported once, by whichever load finds it in place first. */
  private readonly reported = new WeakSet<PDFDocumentProxy>();

  constructor(api: VsCodeApi) {
    this.api = api;
    this.layout = buildLayout();
    this.restored = initialState(api);
    this.init = this.setup();
    // A failed start is logged by setup(); later messages report it again through handle().
    this.init.catch(() => {});
  }

  async handle(message: ToViewer): Promise<void> {
    try {
      await this.init;
      switch (message.type) {
        case 'config':
          this.onConfig(message.config);
          break;
        case 'load':
          try {
            await this.onLoad(toBytes(message.data), message.reload, message.pdfPath);
          } finally {
            this.showPendingForward();
          }
          break;
        case 'forward':
          this.pendingForward = { positions: message.positions, indicator: message.indicator };
          this.showPendingForward();
          break;
      }
    } catch (e) {
      this.log('error', `${message.type}: ${errorText(e)}`);
    }
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.post({ type: 'log', level, message });
  }

  private post(message: FromViewer): void {
    this.api.postMessage(message);
  }

  private async setup(): Promise<void> {
    try {
      const pdfjs = await loadPdfjs((message) => this.log('warn', message));
      const view = (this.view = new View(this.layout.container, this.layout.viewer, pdfjs, (url) => this.post({ type: 'openExternal', url })));
      const history = (this.history = new History(view));
      // Internal links record the position they leave (pdf.js calls these PDFHistory methods).
      view.linkService.setHistory({
        pushCurrentPosition: () => history.push(currentPosition(view)),
        push: () => {},
        pushPage: () => {},
        back: () => history.back(),
        forward: () => history.forward(),
      });
      const focusDocument = (): void => view.container.focus({ preventScroll: true });
      const findBar = new FindBar(view, this.layout.findbar, focusDocument);
      const toolbar = buildToolbar(view, {
        // goToPage records the position it leaves through the history above.
        goToPage: (page) => view.linkService.goToPage(page),
        zoomIn: () => view.pdfViewer.increaseScale(),
        zoomOut: () => view.pdfViewer.decreaseScale(),
        setZoom: (value) => (view.currentScaleValue = value),
        toggleFind: () => findBar.toggle(),
        toggleInvert: () => this.toggleInvert(),
        focusDocument,
      });
      onInvertChange((inverted) => toolbar.setInverted(inverted));
      this.applyInversion();
      installInverse(view, () => this.config, (m) => this.post(m));
      installKeys(view, {
        back: () => history.back(),
        forward: () => history.forward(),
        zoomIn: () => view.pdfViewer.increaseScale(),
        zoomOut: () => view.pdfViewer.decreaseScale(),
        zoomReset: () => (view.currentScaleValue = this.config.zoom),
        openFind: () => findBar.open(),
        findOpen: () => findBar.isOpen,
        findNext: (previous) => findBar.next(previous),
        closeFind: () => findBar.close(),
      });
      // Saved for VS Code to hand back when it restores the tab.
      view.container.addEventListener('scroll', () => {
        if (view.isSettled) saveState(this.api, { scrollTop: view.container.scrollTop, scrollLeft: view.container.scrollLeft });
      }, { passive: true });
      view.eventBus.on('scalechanging', () => {
        if (view.isSettled) saveState(this.api, { scale: view.currentScaleValue });
      });
      this.post({ type: 'ready' });
    } catch (e) {
      this.log('error', `The PDF viewer could not start: ${errorText(e)}`);
      throw e;
    }
  }

  private onConfig(received: ViewerConfig): void {
    const { config, invalid } = checkConfig(received);
    if (invalid.length > 0) this.log('warn', `config: invalid values for ${invalid.join(', ')}; the defaults are used for them.`);
    const previous = this.configReceived ? this.config : undefined;
    this.config = config;
    this.configReceived = true;
    this.applyViewConfig();
    // A changed inversion mode takes effect even where the toggle was used; a changed strength keeps the toggle's choice.
    if (previous && previous.invertMode !== config.invertMode) this.setInvertOverride(null);
    this.applyInversion();
  }

  /** Applies view settings that changed since the displayed document last received them; while a document is being set up or a reload is about to restore its position, they wait for it. */
  private applyViewConfig(): void {
    if (!this.view.isSettled || isRestorePending(this.view)) return;
    this.view.applyConfig(this.config, this.appliedConfig);
    this.appliedConfig = this.config;
  }

  /** A rebuild (`reload`) keeps the position of the displayed document; a first load uses the config, or the state VS Code restored. */
  private async onLoad(data: Uint8Array, reload: boolean, pdfPath: string): Promise<void> {
    saveState(this.api, { pdfPath });
    if (reload && (this.view.isSettled || isReloading(this.view))) {
      try {
        await reloadInPlace(this.view, data);
      } finally {
        // Settings that changed during the reload.
        this.applyViewConfig();
      }
      this.reportShown(pdfPath);
      return;
    }
    cancelReload(this.view);
    const doc = await this.view.loadDocument(data);
    if (!doc) return;
    const restored = this.restored?.pdfPath === pdfPath ? this.restored : undefined;
    this.restored = undefined;
    if (restored?.invertOverride !== undefined) {
      this.setInvertOverride(restored.invertOverride);
      this.applyInversion();
    }
    await this.view.setDocument(doc, () => {
      this.view.applyConfig({ ...this.config, zoom: restored?.scale ?? this.config.zoom });
      this.appliedConfig = this.config;
      if (restored?.scrollTop !== undefined) this.view.container.scrollTop = restored.scrollTop;
      if (restored?.scrollLeft !== undefined) this.view.container.scrollLeft = restored.scrollLeft;
    });
    this.reportShown(pdfPath);
  }

  /** Posts one info line for the document in place, once its pages exist. A load that was superseded, or whose document a newer load is still setting up, posts nothing; the newer load reports it. */
  private reportShown(pdfPath: string): void {
    const doc = this.view.pdfViewer.pdfDocument;
    if (!doc || !this.view.isSettled || this.reported.has(doc)) return;
    this.reported.add(doc);
    const pages = doc.numPages;
    this.log('info', `Showing ${fileName(pdfPath)}: ${pages} ${pages === 1 ? 'page' : 'pages'}`);
  }

  /** Shows the pending `forward` unless a document is still being loaded or set up. */
  private showPendingForward(): void {
    const pending = this.pendingForward;
    if (!pending || !this.view.isSettled || this.view.loading > 0) return;
    this.pendingForward = undefined;
    const problem = showForward(this.view, pending.positions, pending.indicator, this.history);
    if (problem) this.log('warn', `forward: ${problem}.`);
  }

  private applyInversion(): boolean {
    return applyInvert(this.layout.app, this.config.invertMode, this.config.invert, this.invertOverride);
  }

  /** The toolbar toggle: flips the inversion for this tab; the override is dropped when it matches what the setting gives. */
  private toggleInvert(): void {
    const inverted = !(this.invertOverride ?? modeInverts(this.config.invertMode));
    this.setInvertOverride(inverted === modeInverts(this.config.invertMode) ? null : inverted);
    this.applyInversion();
  }

  private setInvertOverride(value: boolean | null): void {
    if (this.invertOverride === value) return;
    this.invertOverride = value;
    saveState(this.api, { invertOverride: value });
  }
}

/** The PDF bytes of a `load` message (a Uint8Array from VS Code; an ArrayBuffer or another view is accepted too). */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('the message carries no PDF data');
}

/** The file name of a path from the extension host: the part after the last `/`, or after the last `\` in a Windows path. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
