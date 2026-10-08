// Playwright global setup for the PDF tab tests: compiles the fixture documents with the typst CLI into test-results/fixtures/ and starts the static server (test/viewer/server.mjs) in a child process. Tests read the server origin from TW_VIEWER_ORIGIN and the fixture folder from TW_VIEWER_FIXTURES.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const root = config.configFile ? path.dirname(config.configFile) : process.cwd();
  if (!existsSync(path.join(root, 'dist', 'webview', 'viewer.js'))) {
    throw new Error('dist/webview/viewer.js is missing: run `node esbuild.mjs` first (npm run test:viewer does).');
  }
  const sources = path.join(root, 'test', 'viewer', 'fixtures');
  const out = path.join(root, 'test-results', 'fixtures');
  mkdirSync(out, { recursive: true });
  for (const file of readdirSync(sources).filter((f) => f.endsWith('.typ'))) {
    execFileSync('typst', ['compile', path.join(sources, file), path.join(out, file.replace(/\.typ$/, '.pdf'))], { stdio: 'inherit' });
  }

  // server.mjs prints the harness URL once it listens.
  const server = spawn(process.execPath, [path.join(root, 'test', 'viewer', 'server.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const harness = await new Promise<string>((resolve, reject) => {
    let output = '';
    server.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split('\n').find((l) => l.startsWith('http'));
      if (line) resolve(line.trim());
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`test server exited with code ${code}`)));
  });
  process.env.TW_VIEWER_ORIGIN = new URL(harness).origin;
  process.env.TW_VIEWER_FIXTURES = out;
  return async () => {
    server.kill();
  };
}
