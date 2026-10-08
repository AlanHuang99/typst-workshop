// Bundles the extension (Node, CommonJS) and the PDF tab (browser, ES module), and copies the pdf.js assets the tab loads at runtime.
// Usage: node esbuild.mjs [--watch] [--tests]
import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
  logLevel: 'info',
};

const webview = {
  entryPoints: ['webview/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  outfile: 'dist/webview/viewer.js',
  sourcemap: true,
  logLevel: 'info',
};

async function extensionTestEntries() {
  const dir = 'test/extension';
  const files = (await readdir(dir)).filter((f) => f === 'index.ts' || f.endsWith('.test.ts'));
  return files.map((f) => path.join(dir, f));
}

async function copyAssets() {
  await mkdir('dist/webview', { recursive: true });
  await cp('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'dist/webview/pdf.worker.mjs');
  await cp('node_modules/pdfjs-dist/web/pdf_viewer.css', 'dist/webview/pdf_viewer.css');
  await cp('node_modules/pdfjs-dist/web/images', 'dist/webview/images', { recursive: true });
  await cp('webview/viewer.css', 'dist/webview/viewer.css');
}

const configs = [extension, webview];
if (tests) {
  // test/extension/index.ts loads every *.test.js in this folder, so a bundle of a renamed or removed test must not stay behind.
  await rm('dist/test/extension', { recursive: true, force: true });
  configs.push({
    entryPoints: await extensionTestEntries(),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'mocha'],
    outdir: 'dist/test/extension',
    sourcemap: true,
    logLevel: 'info',
  });
}

if (watch) {
  await copyAssets();
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  await copyAssets();
}
