// Keyboard shortcuts of the PDF tab. Handled keys are stopped here, so VS Code's webview host does not also act on them (for example Ctrl+= as window zoom or Alt+← as Go Back).
import type { View } from './view';

export interface KeyActions {
  back(): void;
  forward(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Back to the zoom of the settings. */
  zoomReset(): void;
  openFind(): void;
  /** False while the find bar is closed. */
  findOpen(): boolean;
  findNext(previous: boolean): void;
  closeFind(): void;
}

/** True for elements that take text input, where plain keys such as Backspace keep their usual meaning. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/**
 * Ctrl/Cmd with + or =, -, 0: zoom in, out, back to the setting; Ctrl/Cmd+F: find; Enter / Shift+Enter: next and previous match while the find bar is open; Escape: close find; Alt+← or Backspace: back; Alt+→ or Shift+Backspace: forward; Home and End: first and last page.
 */
export function installKeys(view: View, actions: KeyActions): void {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const action = actionFor(e, view, actions);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  });
}

function actionFor(e: KeyboardEvent, view: View, actions: KeyActions): (() => void) | undefined {
  const editable = isEditable(e.target);
  const command = (e.ctrlKey || e.metaKey) && !e.altKey;
  if (command) {
    switch (e.key) {
      case '+':
      case '=':
        return actions.zoomIn;
      case '-':
      case '_':
        return actions.zoomOut;
      case '0':
        return actions.zoomReset;
      case 'f':
      case 'F':
        return e.shiftKey ? undefined : actions.openFind;
    }
    return undefined;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (e.key === 'ArrowLeft') return actions.back;
    if (e.key === 'ArrowRight') return actions.forward;
    return undefined;
  }
  if (e.altKey || e.ctrlKey || e.metaKey) return undefined;
  if (e.key === 'Escape' && actions.findOpen()) return actions.closeFind;
  if (editable) return undefined;
  switch (e.key) {
    case 'Enter':
      return actions.findOpen() && !(e.target instanceof HTMLButtonElement) ? () => actions.findNext(e.shiftKey) : undefined;
    case 'Backspace':
      return e.shiftKey ? actions.forward : actions.back;
    case 'Home':
      return e.shiftKey || !view.hasDocument ? undefined : () => (view.pdfViewer.currentPageNumber = 1);
    case 'End':
      return e.shiftKey || !view.hasDocument ? undefined : () => (view.pdfViewer.currentPageNumber = view.pdfViewer.pagesCount);
  }
  return undefined;
}
