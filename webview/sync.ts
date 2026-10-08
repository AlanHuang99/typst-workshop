// Navigation between PDF and source in the tab: the click gesture posts the PDF point under the pointer (`inverse`), and `forward` scrolls to a position and marks it.
import type { PdfRect } from '../src/helper/protocol';
import type { FromViewer, IndicatorStyle, ViewerConfig } from '../src/viewer/messages';
import { currentPosition, type History } from './history';
import { SCROLL_MODES, type View } from './view';

const MARKER_MS = 1200;
/** Where a forward target ends up, as a fraction of the view's height from the top. */
const TARGET_FROM_TOP = 0.4;

/** Whether the page runs on macOS; the webview reports the platform of the client, also over Remote-SSH. */
function isMac(): boolean {
  const { userAgentData, platform } = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /^mac/i.test(userAgentData?.platform || platform || '');
}

/** Posts `inverse` for Ctrl/Cmd+click or double-click (per `syncKeybinding`) on a page. */
export function installInverse(view: View, getConfig: () => ViewerConfig, post: (m: FromViewer) => void): void {
  const lookup = (e: MouseEvent): boolean => {
    const point = pdfPointAt(view, e);
    if (!point) return false;
    post({ type: 'inverse', ...point });
    return true;
  };
  // Capture phase: runs before pdf.js's link handlers, so Ctrl+click on a link looks up the source instead of following the link.
  view.container.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || getConfig().syncKeybinding !== 'ctrl-click') return;
      if (!lookup(e)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  // On macOS, Ctrl+click is a context-menu click: the page gets `contextmenu`, no `click`, and the webview host opens its own menu unless the event is cancelled. There it jumps like Cmd+click and no menu opens.
  view.container.addEventListener(
    'contextmenu',
    (e) => {
      if (!e.ctrlKey || e.metaKey || getConfig().syncKeybinding !== 'ctrl-click' || !isMac()) return;
      if (lookup(e)) e.preventDefault();
    },
    true,
  );
  view.container.addEventListener('dblclick', (e) => {
    if (e.button !== 0 || getConfig().syncKeybinding !== 'double-click') return;
    if (lookup(e)) e.preventDefault();
  });
}

/** The page under the pointer and the pointer's position on it in PDF user space (origin bottom-left, y up). */
export function pdfPointAt(view: View, e: MouseEvent): { page: number; x: number; y: number } | null {
  const target = e.target instanceof Element ? e.target.closest('.page') : null;
  const pageDiv = target && view.viewerDiv.contains(target) ? target : document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList.contains('page') && view.viewerDiv.contains(el));
  if (!(pageDiv instanceof HTMLElement)) return null;
  const page = Number(pageDiv.dataset.pageNumber);
  const pageView = view.pageView(page);
  if (!pageView) return null;
  const area = view.pageArea(pageView);
  if (area.width <= 0 || area.height <= 0) return null;
  const { viewport } = pageView;
  const [x, y] = viewport.convertToPdfPoint(((e.clientX - area.left) * viewport.width) / area.width, ((e.clientY - area.top) * viewport.height) / area.height) as [number, number];
  return { page, x, y };
}

/**
 * Scrolls to the first position (its point about 40 % from the top of the view), records the previous position in `history`, and draws the marker. Returns why nothing was shown, if so.
 */
export function showForward(view: View, positions: PdfRect[], style: IndicatorStyle, history: History): string | undefined {
  const target = positions[0];
  const { pdfViewer, container } = view;
  if (!target) return 'no position to show';
  if (!view.isSettled) return 'no document is shown';
  if (!Number.isInteger(target.page) || target.page < 1 || target.page > pdfViewer.pagesCount) return `page ${target.page} is not in the document (${pdfViewer.pagesCount} pages)`;
  const pageView = view.pageView(target.page);
  if (!pageView) return `page ${target.page} is not available`;
  history.push(currentPosition(view));
  if (pdfViewer.scrollMode === SCROLL_MODES.page) pdfViewer.currentPageNumber = target.page;
  const area = view.pageArea(pageView);
  const [left, top] = view.toContent(area.left, area.top);
  const { viewport } = pageView;
  // PDF point → position in the scroll container's content.
  const place = (x: number, y: number): [number, number] => {
    const [vx, vy] = viewport.convertToViewportPoint(x, y) as [number, number];
    return [left + (vx * area.width) / viewport.width, top + (vy * area.height) / viewport.height];
  };
  const [px, py] = place(target.x, target.y);
  container.scrollTop = py - TARGET_FROM_TOP * container.clientHeight;
  if (px < container.scrollLeft || px > container.scrollLeft + container.clientWidth) container.scrollLeft = px - container.clientWidth / 2;

  if (style === 'none') return undefined;
  for (const old of container.querySelectorAll('.tw-marker')) old.remove();
  const marker = document.createElement('div');
  if (style === 'circle') {
    marker.className = 'tw-marker tw-marker-circle';
    marker.style.left = `${px}px`;
    marker.style.top = `${py}px`;
  } else {
    const [x1, y1] = place(target.left, target.top);
    const [x2, y2] = place(target.right, target.bottom);
    marker.className = 'tw-marker tw-marker-rect';
    marker.style.left = `${Math.min(x1, x2)}px`;
    marker.style.top = `${Math.min(y1, y2)}px`;
    marker.style.width = `${Math.abs(x2 - x1)}px`;
    marker.style.height = `${Math.abs(y2 - y1)}px`;
  }
  container.append(marker);
  // The marker fades out over 1.2 s (viewer.css); the timer also covers a hidden tab, where animations do not run.
  const remove = (): void => marker.remove();
  marker.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, MARKER_MS + 100);
  return undefined;
}
