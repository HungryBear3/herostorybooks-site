import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

import { WEBSERVER_HOST, resolveWebServerTimeoutMs } from './tests/e2e/webserver-env.ts';

/**
 * Playwright config for the customer text-placement editor regression suite.
 *
 * Hermetic by construction: the dev server is booted with HSB_ORDER_STORE_DIR
 * pointed at a local throwaway store and with every provider / blob / payment /
 * email credential blanked, so no test can reach a production order, an
 * external service, or a real mailbox.
 */
const PORT = Number(process.env.HSB_E2E_PORT ?? 3178);
export const E2E_STORE_DIR = path.join(process.cwd(), '.e2e-store');

/** Credentials that must never be present in an e2e server process. */
const STRIPPED = Object.fromEntries([
  'BLOB_READ_WRITE_TOKEN', 'HSB_REQUIRE_DURABLE_PERSISTENCE', 'RESEND_API_KEY',
  'OPENAI_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY', 'LULU_CLIENT_KEY',
  'LULU_CLIENT_SECRET', 'STRIPE_SECRET_KEY', 'HSB_STRIPE_SECRET_KEY',
].map((k) => [k, '']));

export default defineConfig({
  testDir: './tests/e2e',
  // Fixtures are per-test and uniquely keyed, so files can run in parallel.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Event/state-based assertions only; this is a backstop, not a timing knob.
  expect: { timeout: 10_000 },
  timeout: 60_000,

  use: {
    baseURL: `http://${WEBSERVER_HOST}:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
      testIgnore: /mobile\.spec\.ts$/,
    },
    {
      // Real mobile emulation: 393x851, touch enabled, no mouse.
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'] },
      testMatch: /mobile\.spec\.ts$/,
    },
  ],

  webServer: {
    // Production build, not `next dev`. The dev server's HMR runtime does not
    // hydrate this app under test (React loads but never attaches), so every
    // interaction would silently no-op. `next start` is also the faithful
    // target: it is what a customer actually receives.
    // -H binds the listening socket to loopback. Without it Next defaults to
    // 0.0.0.0, and the 127.0.0.1 below would only be the address Playwright
    // dials — not a restriction on who else can reach the server.
    command: `npx next build && npx next start -H ${WEBSERVER_HOST} -p ${PORT}`,
    // No dedicated health route in this app — the landing page is the readiness probe.
    url: `http://${WEBSERVER_HOST}:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    // 120s locally; overridable for slower CI runners via
    // HSB_E2E_WEBSERVER_TIMEOUT_MS. Malformed values throw rather than coerce.
    timeout: resolveWebServerTimeoutMs(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...STRIPPED,
      HSB_ORDER_STORE_DIR: E2E_STORE_DIR,
      // Enable media UI only inside this credential-free, disposable sandbox.
      // Checkout navigation tests intercept/forbid order and payment requests.
      HSB_E2E_STORY_MEDIA_ENABLED: 'true',
      // This sandbox exercises the Preview-only primary-hero selector on both
      // the browser and server sides without changing either production default.
      NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA: 'true',
      HSB_PRIMARY_HERO_BETA: 'true',
      // A production build otherwise refuses the local file store and demands a
      // real blob token. This is the opt-out orders.ts documents for tests — it
      // relaxes WHERE orders are stored, never any authorization, lifecycle,
      // freshness, isolation, or bounds rule.
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      // Synthetic local-only reviewer key for runtime auth-boundary tests.
      // It is not a provider credential and never leaves the loopback server.
      FAMILY_REVIEW_ADMIN_KEY: 'e2e-family-review-admin-key',
    },
  },
});
