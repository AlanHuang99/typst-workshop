// Position history of the PDF tab: positions are recorded before forward jumps, internal links and page-box jumps; back and forward walk them like a browser's history.
import { SCROLL_MODES, type View } from './view';

/** A place in the document: a page and the fractions of its width and height at the top-left corner of the view, so it survives zoom changes and reloads. */
export interface Position {
  page: number;
  x: number;
  y: number;
}

const MAX_ENTRIES = 50;

/** The position at the top-left corner of the view, or null without a document. */
export function currentPosition(view: View): Position | null {
  const pageView = view.firstVisiblePage();
  if (!pageView || !view.isSettled) return null;
  const area = view.pageArea(pageView);
  if (area.width <= 0 || area.height <= 0) return null;
  const [left, top] = view.toContent(area.left, area.top);
  const { scrollLeft, scrollTop } = view.container;
  // The declared type of `id` comes from a base class field initialised to null; page views always have a page number.
  return { page: Number(pageView.id), x: (scrollLeft - left) / area.width, y: (scrollTop - top) / area.height };
}

/** Scrolls so that `position` is at the top-left corner of the view. */
export function goTo(view: View, position: Position): void {
  const { pdfViewer, container } = view;
  if (!view.isSettled) return;
  const page = Math.min(Math.max(1, position.page), pdfViewer.pagesCount);
  if (pdfViewer.scrollMode === SCROLL_MODES.page) pdfViewer.currentPageNumber = page;
  const pageView = view.pageView(page);
  if (!pageView) return;
  const area = view.pageArea(pageView);
  const [left, top] = view.toContent(area.left, area.top);
  container.scrollLeft = left + position.x * area.width;
  container.scrollTop = top + position.y * area.height;
}

export class History {
  private readonly view: View;
  private entries: Position[] = [];
  /** Index of the current place in `entries`; equal to its length while the current place is not recorded. */
  private index = 0;

  constructor(view: View) {
    this.view = view;
  }

  /** Records `position` (where the view was before a jump) and drops the forward entries. */
  push(position: Position | null): void {
    if (!position) return;
    this.entries.length = this.index;
    this.entries.push(position);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.index = this.entries.length;
  }

  back(): void {
    if (this.index === 0) return;
    this.remember();
    this.index--;
    goTo(this.view, this.entries[this.index]!);
  }

  forward(): void {
    if (this.index >= this.entries.length - 1) return;
    this.remember();
    this.index++;
    goTo(this.view, this.entries[this.index]!);
  }

  /** Stores the current place at `index`, so that walking back again returns to it. */
  private remember(): void {
    const here = currentPosition(this.view);
    if (here) this.entries[this.index] = here;
  }
}
