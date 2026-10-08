// DOM of the PDF tab, built inside #app: the toolbar, the find bar and the scrolling container that holds the pdf.js viewer.

export interface Layout {
  app: HTMLElement;
  toolbar: HTMLDivElement;
  findbar: HTMLDivElement;
  /** #viewerContainer: the absolutely positioned scroll container pdf.js requires. */
  container: HTMLDivElement;
  /** #viewer: the element pdf.js fills with pages. */
  viewer: HTMLDivElement;
}

interface Props {
  id?: string;
  className?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

/** Creates an element with the given properties and children. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.id) node.id = props.id;
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A 16×16 icon drawn with the current text colour from SVG path data. */
export function icon(paths: string[], filled: string[] = []): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.3');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
  }
  for (const d of filled) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

/** Builds the tab's layout inside #app (created if the page has none). */
export function buildLayout(): Layout {
  const app = document.getElementById('app') ?? document.body.appendChild(el('div', { id: 'app' }));
  const toolbar = el('div', { id: 'toolbar', attrs: { role: 'toolbar' } });
  const findbar = el('div', { id: 'findbar', attrs: { role: 'search' } });
  findbar.hidden = true;
  const viewer = el('div', { id: 'viewer', className: 'pdfViewer' });
  const container = el('div', { id: 'viewerContainer', attrs: { tabindex: '-1' } }, [viewer]);
  app.replaceChildren(toolbar, findbar, container);
  return { app, toolbar, findbar, container, viewer };
}
