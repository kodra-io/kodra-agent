import { defineConfig, devices } from '@playwright/test';

// Tests run against the production build, so the Content Security Policy is in force. The
// agent's API is mocked in each test (fixtures.ts); the agent side has its own tests.
export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4175/',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4175/',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
