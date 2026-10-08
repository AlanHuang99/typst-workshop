// Entry of the PDF tab bundle (dist/webview/viewer.js): creates the App and passes it the extension's messages.
import { App, errorText } from './app';
import type { VsCodeApi } from './state';
import { checkMessage } from './validate';

declare function acquireVsCodeApi(): VsCodeApi;

const app = new App(acquireVsCodeApi());
// Exposed for the Playwright tests (test/viewer).
(window as unknown as { __app: App }).__app = app;

window.addEventListener('message', (event: MessageEvent) => {
  const message = checkMessage(event.data);
  if (typeof message === 'string') app.log('warn', message);
  else if (message) void app.handle(message);
});
window.addEventListener('error', (event: ErrorEvent) => app.log('error', `Uncaught error: ${event.message}`));
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => app.log('error', `Unhandled rejection: ${errorText(event.reason)}`));
