// Dark-mode inversion of the page canvases: `invert(<amount>) hue-rotate(180deg)` when the mode (setting `view.pdf.invertMode`) is `always`, or `auto` with a dark VS Code theme; the toolbar toggle overrides the mode for this tab.
import type { InvertMode } from '../src/viewer/messages';

interface Settings {
  root: HTMLElement;
  mode: InvertMode;
  amount: number;
  override: boolean | null;
}

let settings: Settings | undefined;
let observer: MutationObserver | undefined;
const listeners: ((inverted: boolean) => void)[] = [];

/** True for a dark VS Code theme: body class `vscode-dark`, or `vscode-high-contrast` without `vscode-high-contrast-light` (a high-contrast light theme carries both). */
export function darkTheme(): boolean {
  const classes = document.body.classList;
  return classes.contains('vscode-dark') || (classes.contains('vscode-high-contrast') && !classes.contains('vscode-high-contrast-light'));
}

/** Whether `mode` alone inverts the pages under the current theme. */
export function modeInverts(mode: InvertMode): boolean {
  return mode === 'always' || (mode === 'auto' && darkTheme());
}

/**
 * Sets the filter of the page canvases under `root` (through the `--tw-page-filter` property, which viewer.css applies to `.page canvas` and to reload snapshots) and keeps it in step with the body's theme class. Returns whether the pages are inverted.
 */
export function applyInvert(root: HTMLElement, mode: InvertMode, amount: number, override: boolean | null): boolean {
  settings = { root, mode, amount, override };
  if (!observer) {
    observer = new MutationObserver(() => {
      if (settings) update(settings);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  return update(settings);
}

/** Calls `listener` with the new state whenever the inversion is applied, including after a theme change. */
export function onInvertChange(listener: (inverted: boolean) => void): void {
  listeners.push(listener);
}

function update({ root, mode, amount, override }: Settings): boolean {
  const inverted = override ?? modeInverts(mode);
  const strength = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0.9;
  root.style.setProperty('--tw-page-filter', inverted ? `invert(${strength}) hue-rotate(180deg)` : 'none');
  root.classList.toggle('tw-inverted', inverted);
  for (const listener of listeners) listener(inverted);
  return inverted;
}
