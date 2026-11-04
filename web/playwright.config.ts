import { defineConfig, devices } from '@playwright/test'

/**
 * E2E_MODE=mock (default): E2E_BASE_URL → pakai server yang sudah jalan (mis. dev server);
 * default build + preview (mock API di browser).
 * E2E_MODE=real: E2E_BASE_URL wajib — Vite real mode (VITE_API_MODE=real) atau `qatlas server`
 * yang menyajikan build real mode, dengan data `qatlas seed demo`. Lihat scripts/e2e-real.sh.
 */
const real = process.env.E2E_MODE === 'real'
const external = process.env.E2E_BASE_URL
if (real && !external) {
  throw new Error('E2E_MODE=real needs E2E_BASE_URL (a real-mode web server); see scripts/e2e-real.sh')
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Real runs drive a real browser against demo-target: allow more time per test.
  timeout: real ? 240_000 : 60_000,
  expect: { timeout: real ? 15_000 : 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: external ?? 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: external
    ? undefined
    : {
        command: 'npm run build && npm run preview -- --port 4173 --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: true,
        timeout: 180_000,
      },
})
