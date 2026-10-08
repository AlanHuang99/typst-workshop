import { expect, test } from 'vitest';
import { makeNonce, viewerHtml } from '../../src/viewer/html';

test('CSP and module script', () => {
  const h = viewerHtml({ cspSource: 'vscode-res:', nonce: 'N0nce', scriptUri: 'vscode-res:/dist/webview/viewer.js', cssUris: ['a.css', 'b.css'] });
  expect(h).toContain(`script-src 'nonce-N0nce'`);
  expect(h).toContain('worker-src blob:');
  expect(h).toContain('<script type="module" nonce="N0nce" src="vscode-res:/dist/webview/viewer.js"></script>');
  expect(h).not.toContain('unsafe-eval');
});

test('the whole Content-Security-Policy, stylesheets in order, the app element, one script', () => {
  const src = 'https://file+.vscode-resource.vscode-cdn.net';
  const h = viewerHtml({ cspSource: src, nonce: 'abc', scriptUri: 'u/viewer.js', cssUris: ['u/pdf_viewer.css', 'u/viewer.css'] });
  expect(h).toContain(
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; style-src ${src} 'unsafe-inline'; font-src ${src} data: blob:; script-src 'nonce-abc'; worker-src blob:; connect-src ${src}">`,
  );
  expect(h).toContain('<link rel="stylesheet" href="u/pdf_viewer.css">');
  expect(h.indexOf('u/pdf_viewer.css')).toBeLessThan(h.indexOf('u/viewer.css'));
  expect(h).toContain('<div id="app"></div>');
  expect(h.match(/<script/g)).toHaveLength(1);
  expect(h.startsWith('<!DOCTYPE html>')).toBe(true);
});

test('attribute values are escaped', () => {
  const h = viewerHtml({ cspSource: 'x', nonce: 'n', scriptUri: 'a"b<c>&d', cssUris: ['e"f'] });
  expect(h).toContain('src="a&quot;b&lt;c&gt;&amp;d"');
  expect(h).toContain('href="e&quot;f"');
});

test('nonces are fresh and alphanumeric', () => {
  const a = makeNonce();
  expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(makeNonce()).not.toBe(a);
});
