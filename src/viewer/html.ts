import { randomBytes } from 'node:crypto';

export interface ViewerHtmlOptions {
  /** `webview.cspSource`. */
  cspSource: string;
  nonce: string;
  /** Webview URI of `dist/webview/viewer.js`. */
  scriptUri: string;
  /** Webview URIs of `pdf_viewer.css` and `viewer.css`, in that order. */
  cssUris: string[];
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The Content-Security-Policy of the PDF tab. */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${cspSource} data: blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data: blob:`,
    `script-src 'nonce-${nonce}'`,
    `worker-src blob:`,
    `connect-src ${cspSource}`,
  ].join('; ');
}

/** The PDF tab's page: the policy, the two stylesheets, the `#app` element the tab builds its DOM in, and the module bundle. */
export function viewerHtml(o: ViewerHtmlOptions): string {
  const styles = o.cssUris.map((uri) => `    <link rel="stylesheet" href="${escapeAttribute(uri)}">`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(contentSecurityPolicy(o.cspSource, o.nonce))}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
${styles}
  </head>
  <body>
    <div id="app"></div>
    <script type="module" nonce="${escapeAttribute(o.nonce)}" src="${escapeAttribute(o.scriptUri)}"></script>
  </body>
</html>
`;
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh 32-character alphanumeric nonce. */
export function makeNonce(): string {
  return Array.from(randomBytes(32), (b) => NONCE_CHARS[b % NONCE_CHARS.length]).join('');
}
