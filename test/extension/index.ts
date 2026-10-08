// Entry point that @vscode/test-electron loads in the extension host: runs every *.test.js next to it with mocha (tdd interface), in name order. extension.test.js expects a window in which nothing has been built; sidebar.test.js starts and ends with such a window, so either order works.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type MochaType from 'mocha';

// mocha 12 is an ES module around a CommonJS implementation; requiring that implementation keeps this bundle CommonJS.
const Mocha = require('mocha/lib/mocha.cjs') as typeof MochaType;

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) mocha.addFile(path.join(__dirname, file));
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} extension test(s) failed`)) : resolve()));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
