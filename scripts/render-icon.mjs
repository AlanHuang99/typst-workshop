// Renders media/icon.svg to the 128×128 marketplace icon media/icon.png with Playwright's Chromium, so that the PNG can be regenerated from its source.
// Usage: npm run icon (needs Playwright's Chromium: npx playwright install chromium)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'media', 'icon.svg'), 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>html, body { margin: 0; background: transparent; } svg { display: block; }</style></head><body>${svg}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  await writeFile(path.join(root, 'media', 'icon.png'), png);
  console.log(`wrote media/icon.png (${png.length} bytes)`);
} finally {
  await browser.close();
}
