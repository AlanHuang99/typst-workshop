// Toolbar of the PDF tab: page box with `/ N`, zoom out, zoom presets, zoom in, find and the dark-mode toggle.
import { el, icon } from './dom';
import type { View } from './view';

export interface ToolbarActions {
  goToPage(page: number): void;
  zoomIn(): void;
  zoomOut(): void;
  setZoom(value: string): void;
  toggleFind(): void;
  toggleInvert(): void;
  /** Gives the keyboard back to the document after the page box or the zoom box was used. */
  focusDocument(): void;
}

export interface Toolbar {
  setInverted(inverted: boolean): void;
}

const ZOOM_OPTIONS: [value: string, label: string][] = [
  ['auto', 'Automatic'],
  ['page-width', 'Page Width'],
  ['page-fit', 'Page Fit'],
  ['page-actual', 'Actual Size'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
  ['4', '400%'],
];

/** Fills #toolbar and keeps it in step with the viewer. */
export function buildToolbar(view: View, actions: ToolbarActions): Toolbar {
  const toolbar = document.getElementById('toolbar')!;
  const pageNumber = el('input', { id: 'pageNumber', title: 'Page', attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Page' } });
  pageNumber.value = '1';
  const pageCount = el('span', { id: 'pageCount', text: '/ 0' });
  const zoomOut = button('zoomOut', 'Zoom Out (Ctrl+-)', icon(['M3.5 8h9']));
  const zoomIn = button('zoomIn', 'Zoom In (Ctrl++)', icon(['M3.5 8h9', 'M8 3.5v9']));
  const zoomSelect = el('select', { id: 'zoomSelect', title: 'Zoom', attrs: { 'aria-label': 'Zoom' } });
  for (const [value, label] of ZOOM_OPTIONS) zoomSelect.append(new Option(label, value));
  // Shows a zoom that is not in the list (after zooming in or out).
  const custom = new Option('', 'custom');
  custom.hidden = true;
  custom.disabled = true;
  zoomSelect.append(custom);
  const find = button('findButton', 'Find (Ctrl+F)', icon(['M6.8 2.8a4 4 0 1 0 0 8a4 4 0 1 0 0-8', 'M9.7 9.7l3.8 3.8']));
  const invert = button('invertButton', 'Invert Page Colours', icon(['M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11'], ['M8 2.5a5.5 5.5 0 0 1 0 11z']));
  invert.setAttribute('aria-pressed', 'false');
  toolbar.replaceChildren(
    el('div', { className: 'tw-group' }, [pageNumber, pageCount]),
    el('div', { className: 'tw-group' }, [zoomOut, zoomSelect, zoomIn]),
    el('div', { className: 'tw-spacer' }),
    el('div', { className: 'tw-group' }, [find, invert]),
  );

  const showPage = (): void => {
    pageNumber.value = String(view.pdfViewer.currentPageNumber || 1);
  };
  pageNumber.addEventListener('focus', () => pageNumber.select());
  pageNumber.addEventListener('blur', showPage);
  pageNumber.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    const page = Number(pageNumber.value.trim());
    if (e.key === 'Enter' && Number.isInteger(page) && page >= 1 && page <= view.pdfViewer.pagesCount) actions.goToPage(page);
    showPage();
    actions.focusDocument();
  });

  zoomOut.addEventListener('click', () => actions.zoomOut());
  zoomIn.addEventListener('click', () => actions.zoomIn());
  zoomSelect.addEventListener('change', () => {
    if (zoomSelect.value !== 'custom') actions.setZoom(zoomSelect.value);
    actions.focusDocument();
  });
  find.addEventListener('click', () => actions.toggleFind());
  invert.addEventListener('click', () => actions.toggleInvert());

  view.eventBus.on('pagesinit', () => {
    pageCount.textContent = `/ ${view.pdfViewer.pagesCount}`;
    showPage();
  });
  view.eventBus.on('pagechanging', (e: { pageNumber: number }) => {
    if (document.activeElement !== pageNumber) pageNumber.value = String(e.pageNumber);
  });
  view.eventBus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
    const value = e.presetValue ?? ZOOM_OPTIONS.find(([v]) => /^[0-9.]+$/.test(v) && Math.abs(parseFloat(v) - e.scale) < 1e-6)?.[0];
    if (value && ZOOM_OPTIONS.some(([v]) => v === value)) {
      zoomSelect.value = value;
    } else {
      custom.textContent = `${Math.round(e.scale * 100)}%`;
      zoomSelect.value = 'custom';
    }
  });

  return {
    setInverted(inverted: boolean): void {
      invert.setAttribute('aria-pressed', String(inverted));
    },
  };
}

function button(id: string, title: string, content: SVGSVGElement): HTMLButtonElement {
  return el('button', { id, className: 'tw-button', title, attrs: { type: 'button', 'aria-label': title } }, [content]);
}
