import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/viewer',
  timeout: 30000,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './test/viewer/global-setup.ts',
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
