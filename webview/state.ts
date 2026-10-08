// Webview state: saved with vscode.setState so VS Code can restore the tab after a restart.
import type { FromViewer, ViewerState } from '../src/viewer/messages';

/** The object returned by acquireVsCodeApi() in a webview. */
export interface VsCodeApi {
  postMessage(message: FromViewer): void;
  getState(): unknown;
  setState(state: ViewerState): void;
}

const SAVE_DELAY_MS = 200;

let pending: Partial<ViewerState> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Merges `partial` into the saved state (a new `pdfPath` starts a fresh one); writes happen at most once per 200 ms. */
export function saveState(api: VsCodeApi, partial: Partial<ViewerState>): void {
  pending = { ...pending, ...partial };
  timer ??= setTimeout(() => {
    timer = undefined;
    const saved = initialState(api);
    const current = pending?.pdfPath === undefined || pending.pdfPath === saved?.pdfPath ? saved : undefined;
    const next: ViewerState = { ...current, ...pending, pdfPath: pending?.pdfPath ?? current?.pdfPath ?? '' };
    pending = undefined;
    api.setState(next);
  }, SAVE_DELAY_MS);
}

/** The state VS Code handed to this webview (or the last one saved), if it has the expected shape. */
export function initialState(api: VsCodeApi): ViewerState | undefined {
  const state = api.getState();
  if (!state || typeof state !== 'object' || typeof (state as ViewerState).pdfPath !== 'string') return undefined;
  return state as ViewerState;
}
