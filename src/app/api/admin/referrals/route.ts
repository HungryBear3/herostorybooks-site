import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { listReferralStats } from '@/lib/referrals';

export const dynamic = 'force-dynamic';

function csvCell(value: string | number): string {
  const raw = String(value);
  if (!/[",\n]/.test(raw)) return raw;
  return `"${raw.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const referrals = await listReferralStats();
  if (url.searchParams.get('format') === 'csv') {
    const header = [
      'code',
      'link',
      'visits',
      'paid_orders',
      'revenue_cents',
      'profit_share_rate',
      'estimated_earnings_cents',
    ];
    const rows = referrals.map((r) => [
      r.code,
      `https://herostorybooks.com/r/${r.code}`,
      r.visits,
      r.conversions,
      r.revenueCents,
      r.profitShareRate,
      r.estimatedEarningsCents,
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map(csvCell).join(','))
      .join('\n');
    return new NextResponse(`${csv}\n`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="hsb-referrals.csv"',
        'cache-control': 'no-store',
      },
    });
  }
  return NextResponse.json({ referrals });
}
