import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/unit/vscode-stub.ts', import.meta.url)),
    },
  },
});
