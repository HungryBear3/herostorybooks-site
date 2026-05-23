// Sweep every order in the configured store and report PAID orders that are
// stuck on the way to customer delivery/fulfillment — before they become
// refunds or support tickets. Read-only: it never mutates any order, Stripe,
// Lulu, or blob state.
//
// Usage:
//   node --experimental-strip-types scripts/order-watchdog.ts          # human-readable text
//   node --experimental-strip-types scripts/order-watchdog.ts --json    # machine-readable JSON report
//   node --experimental-strip-types scripts/order-watchdog.ts --fail-only  # only FAIL-severity findings
//
// Store selection mirrors scripts/order-status.ts: it reads from the same
// store the live app uses (Vercel Blob when BLOB_READ_WRITE_TOKEN is set,
// otherwise the HSB_ORDER_STORE_DIR / tmp filesystem fallback). To scan the
// PRODUCTION order store, export BLOB_READ_WRITE_TOKEN (and HSB_BLOB_NAMESPACE
// if the deployment uses one) before running. Without it, this scans the LOCAL
// dev store only — which normally means "0 orders scanned".

import { listOrders } from '../src/lib/orders.ts';
import {
  buildStuckOrderReport,
  formatStuckOrderReport,
  type StuckOrderReport,
} from '../src/lib/order-watchdog.ts';

function storeMode(): string {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const ns = process.env.HSB_BLOB_NAMESPACE?.trim();
    return `Vercel Blob store${ns ? ` (namespace=${ns})` : ' (production namespace)'}`;
  }
  const dir = process.env.HSB_ORDER_STORE_DIR ?? '(tmp fallback)';
  return `local filesystem store at ${dir}`;
}

async function main() {
  const wantJson = process.argv.includes('--json');
  const failOnly = process.argv.includes('--fail-only');

  const orders = await listOrders();
  const report: StuckOrderReport = buildStuckOrderReport(orders);

  // bySeverity.fail is captured before any view filter so the exit code always
  // reflects the true number of FAIL-severity stuck orders.
  const failCount = report.bySeverity.fail;
  if (failOnly) {
    report.findings = report.findings.filter((f) => f.severity === 'fail');
    report.stuck = report.findings.length;
    report.bySeverity = { fail: report.findings.length, warn: 0 };
  }

  if (wantJson) {
    console.log(JSON.stringify({ store: storeMode(), ...report }, null, 2));
  } else {
    console.error(`Reading from: ${storeMode()}`);
    if (orders.length === 0 && !process.env.BLOB_READ_WRITE_TOKEN) {
      console.error(
        'No orders found and BLOB_READ_WRITE_TOKEN is not set — you are scanning the LOCAL dev store. ' +
          'Set BLOB_READ_WRITE_TOKEN (and HSB_BLOB_NAMESPACE if applicable) to scan the production order store.',
      );
    }
    console.log('');
    console.log(formatStuckOrderReport(report));
  }

  // Exit non-zero when any FAIL-severity order is stuck so this can gate a cron
  // / CI check. WARN-only findings still exit 0.
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
});
