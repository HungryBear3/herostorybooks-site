import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Local UI geometry only. Inherit the credential-cleared, dotenv-disabled
// production-build harness. These deliberately nonfunctional token-shaped
// fixtures satisfy only the pure configuration parser; they are not accounts,
// credentials or provider qualification. Tests intercept intake/shipping/order.
// Never use this configuration to qualify hosted storage or payment behavior.
const webServer = base.webServer as Exclude<typeof base.webServer, unknown[]>;
export default defineConfig({
  ...base,
  workers: 1,
  webServer: {
    ...webServer,
    reuseExistingServer: false,
    env: {
      ...webServer?.env,
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
