import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', timeout: 30000, fullyParallel: false, workers: 1,
  reporter: [['list']], use: { baseURL: 'http://127.0.0.1:4317', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4317/api/schema', reuseExistingServer: false },
});
