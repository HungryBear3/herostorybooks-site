/**
 * Admin orders list.
 *
 * Imports are relative `.ts` specifiers and `next/server.js` rather than the
 * `@/` alias, matching every other route in this repository that is exercised
 * directly by a `node:test` suite (the Stripe webhook, the cron sweeps, the
 * customer order route). Node resolves neither the tsconfig `paths` alias nor
 * the extensionless `next/server` specifier, so the alias form is the reason
 * this boundary had no runtime test; the privacy canary in
 * `tests/admin-order-dto.test.ts` needs one.
 */
import { NextResponse } from 'next/server.js';

import { isAdminAuthedFromRequest } from '../../../../lib/admin-auth.ts';
import { toAdminOrderListItem } from '../../../../lib/admin-order-dto.ts';
import { classifyPaidOrderOpsIssue, isPaidArtifactOpsIssue } from '../../../../lib/order-diagnostics.ts';
import { listOrders } from '../../../../lib/orders.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let orders = await listOrders();
  const url = new URL(request.url);
  if (url.searchParams.get('opsIssue') === 'paid_artifact') {
    orders = orders.filter((order) => {
      const issue = classifyPaidOrderOpsIssue(order);
      return isPaidArtifactOpsIssue(issue);
    });
  }
  // Newest first
  orders.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  // Filtering and sorting run on the full records; only the projection leaves.
  // A raw `{ orders }` here serializes every field the record happens to carry,
  // including any added later — see src/lib/admin-order-dto.ts.
  return NextResponse.json({ orders: orders.map(toAdminOrderListItem) });
}
