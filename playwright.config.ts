import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4319', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], channel: process.env.CI ? 'chromium' : 'msedge' },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        channel: process.env.CI ? 'chromium' : 'msedge',
      },
    },
  ],
  webServer: {
    command: 'node dist/cli.js serve --demo',
    url: 'http://127.0.0.1:4319/api/health',
    reuseExistingServer: false,
    env: { QUOTACRAFT_PORT: '4319', QUOTACRAFT_DATA_DIR: `.data/e2e-${Date.now()}` },
    timeout: 20000,
  },
});
