// Rebuild a single existing print order through the corrected
// (slice 1 + slice 2) print pipeline.
//
// Usage:
//   node --experimental-strip-types scripts/rebuild-print-order.ts <orderId>
//   node --experimental-strip-types scripts/rebuild-print-order.ts <orderId> --dry-run
//
// Operates against the same order store the live app uses. Set
// BLOB_READ_WRITE_TOKEN to point at the production blob; otherwise
// reads/writes the local-only filesystem fallback.
//
// Refuses to rebuild orders that are already submitted to Lulu, in
// production, shipped, refunded, or non-print. Always print the
// structured plan before mutating anything; --dry-run stops there.

import { rebuildPrintOrder } from '../src/lib/rebuild-print-order.ts';

async function main() {
  const orderId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!orderId || orderId.startsWith('--')) {
    console.error(
      'Usage: node --experimental-strip-types scripts/rebuild-print-order.ts <orderId> [--dry-run]',
    );
    process.exit(2);
  }

  const result = await rebuildPrintOrder(orderId, { dryRun });

  if (result.ok === false) {
    console.error(`[rebuild-print-order] REFUSED: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
    process.exit(1);
  }

  console.log('[rebuild-print-order] PLAN');
  console.log(JSON.stringify(result.plan, null, 2));

  if (result.dryRun) {
    console.log('[rebuild-print-order] dry-run — no changes persisted.');
    return;
  }

  console.log('[rebuild-print-order] DONE');
  console.log(JSON.stringify(result.result, null, 2));
}

main().catch((err) => {
  console.error('[rebuild-print-order] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
