// Print a readable status snapshot for one HSB order.
//
// Usage:
//   node --experimental-strip-types scripts/order-status.ts <orderId>          # human-readable text
//   node --experimental-strip-types scripts/order-status.ts <orderId> --json   # machine-readable JSON
//
// Reads from the same store the live app uses (Vercel Blob in prod-like envs;
// HSB_ORDER_STORE_DIR / tmp fallback in local dev). Set BLOB_READ_WRITE_TOKEN
// to point at the production store; otherwise it reads local-only.

import { getOrder } from '../src/lib/orders.ts';
import {
  buildOrderDiagnostics,
  formatDiagnosticsSummary,
} from '../src/lib/order-diagnostics.ts';

async function main() {
  const orderId = process.argv[2];
  const wantJson = process.argv.includes('--json');

  if (!orderId || orderId.startsWith('--')) {
    console.error('Usage: node --experimental-strip-types scripts/order-status.ts <orderId> [--json]');
    process.exit(2);
  }

  const order = await getOrder(orderId);
  if (!order) {
    console.error(`Order ${orderId} not found in the configured store.`);
    process.exit(1);
  }

  const diag = buildOrderDiagnostics(order);

  if (wantJson) {
    console.log(JSON.stringify(diag, null, 2));
    return;
  }

  console.log(formatDiagnosticsSummary(diag));
  console.log('');
  console.log('Checks:');
  for (const c of diag.checks) {
    const icon =
      c.severity === 'ok' ? '[OK]  ' :
      c.severity === 'fail' ? '[FAIL]' :
      c.severity === 'warn' ? '[WARN]' : '[INFO]';
    console.log(`  ${icon} ${c.label} — ${c.detail}`);
  }
  if (diag.review.recentEvents.length > 0) {
    console.log('');
    console.log(`Recent audit events (${diag.review.recentEvents.length} of ${diag.review.auditEventCount}):`);
    for (const e of diag.review.recentEvents) {
      const reason = e.reason ? ` (${e.reason})` : '';
      const page = e.pageIndex != null ? ` page ${e.pageIndex + 1}` : '';
      console.log(`  ${e.at} · ${e.type}${page}${reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
