// The pdf.js viewer of the PDF tab: PDFViewer with its event bus, link service and find controller, document loading, and the view settings (zoom, scroll and spread modes).
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import type { EventBus, PDFFindController, PDFLinkService, PDFPageView, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { ScrollModeName, SpreadModeName, ViewerConfig } from '../src/viewer/messages';
import type { Pdfjs, PdfjsLib } from './pdfjs';

type DocumentParams = Parameters<PdfjsLib['getDocument']>[0];

/** pdf.js ScrollMode values of the `scrollMode` setting's names. */
export const SCROLL_MODES: Readonly<Record<ScrollModeName, number>> = { vertical: 0, horizontal: 1, wrapped: 2, page: 3 };
/** pdf.js SpreadMode values of the `spreadMode` setting's names. */
export const SPREAD_MODES: Readonly<Record<SpreadModeName, number>> = { none: 0, odd: 1, even: 2 };
const ZOOM_PRESETS = new Set(['auto', 'page-width', 'page-fit', 'page-actual']);
/** pdf.js TextLayerMode.ENABLE: a text layer for selection and find. */
const TEXT_LAYER_ENABLE = 1;
/** pdf.js RenderingStates.FINISHED */
const RENDERING_FINISHED = 3;

/** Releases a document in the worker; the worker itself keeps running (it was passed to getDocument). */
function destroyDocument(doc: PDFDocumentProxy): void {
  doc.loadingTask.destroy().catch(() => {});
}

/** The parsed document, once its first page has loaded; a PDF without pages, or whose first page cannot be loaded, is refused like one that fails to parse. */
async function showable(parsed: Promise<PDFDocumentProxy>): Promise<PDFDocumentProxy> {
  const doc = await parsed;
  try {
    if (doc.numPages < 1) throw new Error('The PDF has no pages.');
    await doc.getPage(1).catch((e: unknown) => {
      throw new Error(`Page 1 of the PDF cannot be loaded: ${e instanceof Error ? e.message : String(e)}`);
    });
  } catch (e) {
    destroyDocument(doc);
    throw e;
  }
  return doc;
}

/** True for `auto`, `page-width`, `page-fit`, `page-actual` and positive numbers such as `1.25`. */
export function isZoomValue(value: string): boolean {
  return ZOOM_PRESETS.has(value) || (/^[0-9]*\.?[0-9]+$/.test(value) && parseFloat(value) > 0);
}

export class View {
  readonly container: HTMLDivElement;
  readonly viewerDiv: HTMLDivElement;
  readonly eventBus: EventBus;
  readonly linkService: PDFLinkService;
  readonly findController: PDFFindController;
  readonly pdfViewer: PDFViewer;
  private readonly lib: PdfjsLib;
  private readonly worker: PDFWorker;
  private loadSeq = 0;
  private parsing = 0;
  /** Stops the parse of the newest `loadDocument` call while it is running. */
  private abandonParse: (() => void) | undefined;
  private settled = false;
  /** Completes the `setDocument` call still waiting for its pages. */
  private pendingInit: ((shown: boolean, error?: unknown) => void) | undefined;

  constructor(container: HTMLDivElement, viewerDiv: HTMLDivElement, pdfjs: Pdfjs, onLink: (url: string) => void) {
    const { lib, viewer } = pdfjs;
    this.lib = lib;
    this.container = container;
    this.viewerDiv = viewerDiv;
    this.eventBus = new viewer.EventBus();
    this.linkService = new viewer.PDFLinkService({ eventBus: this.eventBus });
    this.findController = new viewer.PDFFindController({ linkService: this.linkService, eventBus: this.eventBus });
    this.pdfViewer = new viewer.PDFViewer({
      container,
      viewer: viewerDiv,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      textLayerMode: TEXT_LAYER_ENABLE,
      annotationMode: lib.AnnotationMode.ENABLE,
      annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      removePageBorders: false,
      enableAutoLinking: false,
      imageResourcesPath: new URL('./images/', import.meta.url).href,
    });
    this.linkService.setViewer(this.pdfViewer);
    // One worker for every document of this tab; documents are destroyed without stopping it.
    this.worker = lib.PDFWorker.create({ port: lib.GlobalWorkerOptions.workerPort ?? undefined });
    this.installLinks(onLink);
    this.installResize();
  }

  /** True once a document has been handed to the viewer. */
  get hasDocument(): boolean {
    return !!this.pdfViewer.pdfDocument;
  }

  /** True when the current document's pages exist (its `pagesinit` has run). */
  get isSettled(): boolean {
    return this.hasDocument && this.settled;
  }

  get currentScaleValue(): string {
    return this.pdfViewer.currentScaleValue;
  }

  set currentScaleValue(value: string) {
    if (isZoomValue(value)) this.pdfViewer.currentScaleValue = value;
  }

  /** The page view of page `n` (1-based). */
  pageView(n: number): PDFPageView | undefined {
    return this.hasDocument ? (this.pdfViewer.getPageView(n - 1) as PDFPageView | undefined) : undefined;
  }

  /** Number of PDFs being parsed. */
  get loading(): number {
    return this.parsing;
  }

  /** The page views at least partly inside the scroll container. */
  visiblePages(): PDFPageView[] {
    if (!this.hasDocument) return [];
    const visible = this.pdfViewer._getVisiblePages() as { views: { view: PDFPageView }[] };
    return visible.views.map((v) => v.view);
  }

  /** The visible page that comes first in the document (the one at the top-left of the view). */
  firstVisiblePage(): PDFPageView | undefined {
    if (!this.hasDocument) return undefined;
    return (this.pdfViewer._getVisiblePages() as { first?: { view: PDFPageView } }).first?.view;
  }

  /** True once pdf.js has finished drawing the page's canvas. */
  isRendered(pageView: PDFPageView): boolean {
    return pageView.renderingState === RENDERING_FINISHED;
  }

  /** The page's drawing area, inside the border pdf.js puts around each page, in client coordinates. */
  pageArea(pageView: PDFPageView): { left: number; top: number; width: number; height: number } {
    const rect = pageView.div.getBoundingClientRect();
    const style = getComputedStyle(pageView.div);
    const left = parseFloat(style.borderLeftWidth) || 0;
    const top = parseFloat(style.borderTopWidth) || 0;
    const right = parseFloat(style.borderRightWidth) || 0;
    const bottom = parseFloat(style.borderBottomWidth) || 0;
    return { left: rect.left + left, top: rect.top + top, width: rect.width - left - right, height: rect.height - top - bottom };
  }

  /** Converts client coordinates to coordinates in the scroll container's content (those of `scrollTop` and of absolutely positioned children). */
  toContent(clientX: number, clientY: number): [number, number] {
    const { container } = this;
    const rect = container.getBoundingClientRect();
    return [clientX - rect.left - container.clientLeft + container.scrollLeft, clientY - rect.top - container.clientTop + container.scrollTop];
  }

  /**
   * Parses a PDF. Resolves with null when a newer call has started meanwhile (only the newest document is shown; the older parse is stopped at once); rejects when the newest PDF fails to parse.
   */
  async loadDocument(data: Uint8Array): Promise<PDFDocumentProxy | null> {
    const seq = ++this.loadSeq;
    this.abandonParse?.();
    // `isEvalSupported` is set to false although pdf.js 6.4 has no eval code path left and ignores it. WebAssembly is off because the CSP does not allow compiling it.
    const params: DocumentParams & { isEvalSupported: boolean } = { data, worker: this.worker, isEvalSupported: false, useWasm: false };
    const task = this.lib.getDocument(params);
    // A destroyed loading task may never settle, so a superseded call stops waiting for it.
    let superseded!: () => void;
    const abandoned = new Promise<null>((resolve) => (superseded = () => resolve(null)));
    const abandon = (): void => {
      superseded();
      task.destroy().catch(() => {});
    };
    this.abandonParse = abandon;
    const parsed = showable(task.promise);
    parsed.catch(() => {});
    this.parsing++;
    let doc: PDFDocumentProxy | null;
    try {
      doc = await Promise.race([parsed, abandoned]);
    } catch (e) {
      if (seq !== this.loadSeq) return null;
      throw e;
    } finally {
      this.parsing--;
      if (this.abandonParse === abandon) this.abandonParse = undefined;
    }
    if (!doc || seq !== this.loadSeq) {
      if (doc) destroyDocument(doc);
      return null;
    }
    return doc;
  }

  /**
   * Shows `doc` in place of the current document, which is destroyed. `onInit` runs synchronously when the new pages exist (pdf.js `pagesinit`), before pdf.js renders anything, so zoom and scroll position set there are used for the first render.
   * Resolves with true once `onInit` has run, or with false when another `setDocument` call replaced `doc` first.
   */
  setDocument(doc: PDFDocumentProxy, onInit?: () => void): Promise<boolean> {
    this.pendingInit?.(false);
    const previous = this.pdfViewer.pdfDocument;
    this.settled = false;
    return new Promise<boolean>((resolve, reject) => {
      const finish = (shown: boolean, error?: unknown): void => {
        this.eventBus.off('pagesinit', onPagesInit);
        if (this.pendingInit === finish) this.pendingInit = undefined;
        if (error === undefined) resolve(shown);
        else reject(error);
      };
      const onPagesInit = (): void => {
        if (this.pdfViewer.pdfDocument !== doc) return;
        this.settled = true;
        try {
          onInit?.();
          finish(true);
        } catch (e) {
          finish(false, e);
        }
      };
      this.pendingInit = finish;
      this.eventBus.on('pagesinit', onPagesInit);
      this.pdfViewer.setDocument(doc);
      this.linkService.setDocument(doc);
      doc.getPage(1).catch((e: unknown) => {
        if (this.pendingInit === finish) finish(false, e);
      });
      if (previous && previous !== doc) destroyDocument(previous);
    });
  }

  /** Applies the view settings of `config` (zoom first: the mode setters refit preset zooms); with `previous`, only those that changed. Does nothing until the document's pages exist. */
  applyConfig(config: ViewerConfig, previous?: ViewerConfig): void {
    if (!this.isSettled) return;
    if (!previous || previous.zoom !== config.zoom) this.currentScaleValue = config.zoom;
    if (!previous || previous.scrollMode !== config.scrollMode) this.pdfViewer.scrollMode = SCROLL_MODES[config.scrollMode] ?? SCROLL_MODES.vertical;
    if (!previous || previous.spreadMode !== config.spreadMode) this.pdfViewer.spreadMode = SPREAD_MODES[config.spreadMode] ?? SPREAD_MODES.none;
  }

  /**
   * External links go to `onLink` instead of the browser, and no link click reaches VS Code's own handler in the webview host, which would open it. Internal links keep pdf.js's handler, which navigates within the document.
   */
  private installLinks(onLink: (url: string) => void): void {
    const handle = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const link = target?.closest('a[href]');
      if (!(link instanceof HTMLAnchorElement) || !this.container.contains(link)) return;
      e.stopPropagation();
      const href = link.getAttribute('href') ?? '';
      if (href === '' || href.startsWith('#')) return;
      e.preventDefault();
      // The second click of a double-click (`detail` 2) does not open the link again.
      if (e.type === 'click' && e.detail <= 1 && /^(https?|mailto):/i.test(link.href)) onLink(link.href);
    };
    this.container.addEventListener('click', handle);
    this.container.addEventListener('auxclick', handle);
  }

  /** Keeps `auto`, `page-width` and `page-fit` fitted when the tab changes size. */
  private installResize(): void {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const value = this.pdfViewer.currentScaleValue;
        if (!this.isSettled || !value || !ZOOM_PRESETS.has(value) || value === 'page-actual') return;
        if (this.container.clientWidth > 0 && this.container.clientHeight > 0) this.pdfViewer.currentScaleValue = value;
      });
    });
    observer.observe(this.container);
  }
}
