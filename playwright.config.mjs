import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 2,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:5117',
    channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5117 --strictPort',
    url: 'http://127.0.0.1:5117/tests/workflows.html',
    reuseExistingServer: false,
  },
})
