// Snapshot reload adapted from LaTeX Workshop viewer/components/refresh.ts, MIT
// Reload in place: the visible pages are covered by copies of their canvases, the new document is loaded with the same zoom, scroll and spread modes and scroll offsets, and the copies fade out once the visible pages have rendered (or after 1.5 s).
import { SCROLL_MODES, type View } from './view';

/** What a reload keeps. `page` is used in page-by-page scroll mode, where scroll offsets are relative to the single page shown. */
export interface CapturedState {
  scale: string;
  scrollMode: number;
  spreadMode: number;
  scrollTop: number;
  scrollLeft: number;
  page: number;
}

const MASK_TIMEOUT_MS = 1500;
const FADE_MS = 250;

/** State shared by overlapping `reloadInPlace` calls: one set of snapshots, one captured position. */
interface Reload {
  captured: CapturedState;
  masks: HTMLElement[];
  /** Number of the newest call; only that call may end the restore phase, watch the rendering or end the reload. */
  generation: number;
  /** True until the newest PDF of this reload has been set up with the captured state. */
  restoring: boolean;
  /** Stops waiting for the rendering of the document this reload showed. */
  stopWatching?: () => void;
}

const reloads = new WeakMap<View, Reload>();

export function captureState(view: View): CapturedState {
  const { pdfViewer, container } = view;
  return {
    scale: pdfViewer.currentScaleValue,
    scrollMode: pdfViewer.scrollMode,
    spreadMode: pdfViewer.spreadMode,
    scrollTop: container.scrollTop,
    scrollLeft: container.scrollLeft,
    page: pdfViewer.currentPageNumber,
  };
}

/** Applies a captured state to a document whose pages have just been created; zoom first, then the modes (which refit preset zooms), then the offsets. */
export function restoreState(view: View, state: CapturedState): void {
  const { pdfViewer, container } = view;
  if (state.scale) view.currentScaleValue = state.scale;
  if (pdfViewer.scrollMode !== state.scrollMode) pdfViewer.scrollMode = state.scrollMode;
  if (pdfViewer.spreadMode !== state.spreadMode) pdfViewer.spreadMode = state.spreadMode;
  if (state.scrollMode === SCROLL_MODES.page) pdfViewer.currentPageNumber = Math.min(state.page, pdfViewer.pagesCount);
  container.scrollTop = state.scrollTop;
  container.scrollLeft = state.scrollLeft;
}

/** Covers each visible page with a copy of its canvases, positioned in the scroll container's content so it scrolls with the pages. */
export function addMasks(view: View): HTMLElement[] {
  const masks: HTMLElement[] = [];
  for (const pageView of view.visiblePages()) {
    const wrapper = pageView.div.querySelector('.canvasWrapper');
    const canvases = wrapper ? [...wrapper.querySelectorAll('canvas')].filter((c) => c.width > 0 && c.height > 0) : [];
    if (!wrapper || canvases.length === 0) continue;
    const box = wrapper.getBoundingClientRect();
    const mask = document.createElement('div');
    mask.className = 'page-loading-mask';
    const [left, top] = view.toContent(box.left, box.top);
    place(mask, left, top, box.width, box.height);
    for (const canvas of canvases) {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext('2d')?.drawImage(canvas, 0, 0);
      const rect = canvas.getBoundingClientRect();
      place(copy, rect.left - box.left, rect.top - box.top, rect.width, rect.height);
      copy.style.imageRendering = getComputedStyle(canvas).imageRendering;
      mask.append(copy);
    }
    view.container.append(mask);
    masks.push(mask);
  }
  return masks;
}

/** Fades the masks out over 250 ms, then removes them and releases their canvas memory. */
export function removeMasks(masks: HTMLElement[]): void {
  for (const mask of masks) mask.classList.add('remove');
  setTimeout(() => {
    for (const mask of masks) {
      mask.remove();
      for (const canvas of mask.querySelectorAll('canvas')) canvas.width = canvas.height = 0;
    }
  }, FADE_MS);
}

/** True while a reload of this view has not finished (its masks are still shown). */
export function isReloading(view: View): boolean {
  return reloads.has(view);
}

/** True while a reload is waiting for its PDF: the captured zoom, modes and offsets are still to be applied, so view settings applied now would be overwritten. */
export function isRestorePending(view: View): boolean {
  return reloads.get(view)?.restoring ?? false;
}

/** Ends a pending reload, for a load that does not keep the position. */
export function cancelReload(view: View): void {
  const reload = reloads.get(view);
  if (reload) finish(view, reload);
}

/**
 * Replaces the document with `data`, keeping zoom, modes and scroll offsets. When several reloads overlap, only the newest PDF is shown; the snapshots taken by the first stay until the newest has rendered.
 * Rejects when the newest PDF fails to parse; the current document then stays.
 */
export async function reloadInPlace(view: View, data: Uint8Array): Promise<void> {
  let reload = reloads.get(view);
  if (reload) {
    reload.stopWatching?.();
    if (view.isSettled) reload.captured = captureState(view);
  } else {
    reload = { captured: captureState(view), masks: addMasks(view), generation: 0, restoring: true };
    reloads.set(view, reload);
  }
  const own = reload;
  const generation = ++own.generation;
  own.restoring = true;
  // An older call may still finish setting up its document (a newer load arrived meanwhile); only the newest one ends the reload.
  const newest = (): boolean => reloads.get(view) === own && own.generation === generation;
  let shown: boolean;
  try {
    const doc = await view.loadDocument(data);
    if (!doc) return;
    shown = await view.setDocument(doc, () => restoreState(view, own.captured));
  } catch (e) {
    if (newest()) finish(view, own);
    throw e;
  }
  if (shown && newest()) {
    own.restoring = false;
    watchRendering(view, own);
  }
}

/** Removes the masks once all visible pages have rendered, or after 1.5 s. */
function watchRendering(view: View, reload: Reload): void {
  reload.stopWatching?.();
  const onRendered = (): void => {
    if (view.visiblePages().every((p) => view.isRendered(p))) finish(view, reload);
  };
  const timer = setTimeout(() => finish(view, reload), MASK_TIMEOUT_MS);
  view.eventBus.on('pagerendered', onRendered);
  reload.stopWatching = () => {
    clearTimeout(timer);
    view.eventBus.off('pagerendered', onRendered);
    reload.stopWatching = undefined;
  };
  onRendered();
}

function finish(view: View, reload: Reload): void {
  reload.stopWatching?.();
  if (reloads.get(view) === reload) reloads.delete(view);
  removeMasks(reload.masks);
}

function place(node: HTMLElement, left: number, top: number, width: number, height: number): void {
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
}
