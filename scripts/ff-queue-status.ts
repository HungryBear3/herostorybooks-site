/**
 * Read-only: print the pending HSB manual-review queue (paid orders still at
 * order_received), oldest first, annotated with F&F cohort/invite tags and any
 * customer queue status.
 *
 * READ-ONLY BY DESIGN. It only calls listOrders() (reads the order store). It
 * performs NO order mutation, NO Stripe call, NO email, NO fulfillment, and
 * writes nothing back. Safe to run against production for ops visibility.
 *
 * Usage:
 *   node --experimental-strip-types scripts/ff-queue-status.ts
 *   node --experimental-strip-types scripts/ff-queue-status.ts --json
 *   node --experimental-strip-types scripts/ff-queue-status.ts --cohort=ff-beta
 */

import { listOrders } from '../src/lib/orders.ts';
import { pendingManualQueue, type PendingQueueRow } from '../src/lib/order-queue.ts';

export interface FfQueueOptions {
  json: boolean;
  cohort: string | null;
}

export function parseFfQueueArgs(argv: string[]): FfQueueOptions {
  let json = false;
  let cohort: string | null = null;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--cohort=')) cohort = arg.slice('--cohort='.length).trim().toLowerCase() || null;
  }
  return { json, cohort };
}

export function filterQueue(rows: PendingQueueRow[], cohort: string | null): PendingQueueRow[] {
  if (!cohort) return rows;
  return rows.filter((r) => r.cohort === cohort);
}

export function formatQueueText(rows: PendingQueueRow[]): string {
  const lines = [`HSB pending manual-review queue — ${rows.length} order(s)`, ''];
  if (rows.length === 0) {
    lines.push('No paid orders are waiting at order_received.');
    return `${lines.join('\n')}\n`;
  }
  for (const r of rows) {
    const tags = [r.cohort ? `cohort=${r.cohort}` : null, r.invite ? `invite=${r.invite}` : null]
      .filter(Boolean)
      .join(' ') || 'organic (no F&F tag)';
    lines.push(`#${r.position}  ${r.orderId}  ${r.createdAt}`);
    lines.push(`     ${tags}`);
    lines.push(`     status: ${r.customerQueueStatus ?? 'unset'}${r.manualQueueEnteredAt ? ` · entered ${r.manualQueueEnteredAt}` : ''}`);
    lines.push(`     for: ${r.childName} <${r.email}>`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseFfQueueArgs(process.argv.slice(2));
  const rows = filterQueue(pendingManualQueue(await listOrders()), options.cohort);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ count: rows.length, cohort: options.cohort, rows }, null, 2)}\n`);
  } else {
    process.stdout.write(formatQueueText(rows));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
