import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import base from './playwright.config.ts';

// Local UI geometry only. Inherit the credential-cleared, dotenv-disabled
// production-build harness. These deliberately nonfunctional token-shaped
// fixtures satisfy only the pure configuration parser; they are not accounts,
// credentials or provider qualification. Tests intercept intake/shipping/order.
// Never use this configuration to qualify hosted storage or payment behavior.
//
// One explicit project collects ONLY the primary-layout spec, which the default
// config excludes. Output, report and order store are separate from the default
// run so the two partitions never overwrite each other's evidence.
const webServer = base.webServer as Exclude<typeof base.webServer, unknown[]>;
export default defineConfig({
  ...base,
  workers: 1,
  outputDir: 'test-results-layout',
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-layout' }]]
    : [['list']],
  projects: [
    {
      name: 'layout-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
      testMatch: /checkout-primary-layout\.spec\.ts$/,
    },
  ],
  webServer: {
    ...webServer,
    reuseExistingServer: false,
    env: {
      ...webServer?.env,
      HSB_ORDER_STORE_DIR: path.join(process.cwd(), '.e2e-store-layout'),
      HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      HSB_CHECKOUT_GUARD_MODE: 'durable',
      HSB_BLOB_NAMESPACE: 'layout-local-qa',
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_LAYOUTINTAKE_NotARealCredential',
      HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_LAYOUTGUARD_NotARealCredential',
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_LAYOUTORDER_NotARealCredential',
      HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true',
      HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'true',
    },
  },
});
