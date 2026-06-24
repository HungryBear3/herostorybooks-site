import { get, list, put } from '@vercel/blob';

import { listOrders } from './orders.ts';
import { withBlobNamespace } from './orders.ts';
import {
  HSB_REFERRAL_COOKIE,
  HSB_REFERRAL_COOKIE_MAX_AGE,
  sanitizeReferralCode,
} from './referral-code.ts';
export {
  HSB_REFERRAL_COOKIE,
  HSB_REFERRAL_COOKIE_MAX_AGE,
  sanitizeReferralCode,
} from './referral-code.ts';

export interface ReferralVisitRecord {
  code: string;
  visits: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralStats {
  code: string;
  visits: number;
  conversions: number;
  revenueCents: number;
  profitShareRate: number;
  estimatedEarningsCents: number;
}

export function referralCookieHeaderValue(code: string): string {
  return [
    `${HSB_REFERRAL_COOKIE}=${encodeURIComponent(code)}`,
    `Max-Age=${HSB_REFERRAL_COOKIE_MAX_AGE}`,
    'Path=/',
    'SameSite=Lax',
  ].join('; ');
}

export function getReferralCodeFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const escaped = HSB_REFERRAL_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  if (!match) return null;
  try {
    return sanitizeReferralCode(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function visitPath(code: string): string {
  return withBlobNamespace(`referrals/visits/${code}.json`);
}

export async function recordReferralVisit(code: string): Promise<ReferralVisitRecord | null> {
  const clean = sanitizeReferralCode(code);
  if (!clean || !process.env.BLOB_READ_WRITE_TOKEN) return null;

  const now = new Date().toISOString();
  let existing: ReferralVisitRecord | null = null;
  try {
    const found = await get(visitPath(clean), { access: 'public' });
    if (found?.stream) {
      existing = JSON.parse(await new Response(found.stream).text()) as ReferralVisitRecord;
    }
  } catch {
    existing = null;
  }

  const next: ReferralVisitRecord = {
    code: clean,
    visits: Math.max(0, existing?.visits ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await put(visitPath(clean), JSON.stringify(next, null, 2), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
    allowOverwrite: true,
  });
  return next;
}

export function getReferralProfitShareRate(code: string): number {
  const clean = sanitizeReferralCode(code);
  if (!clean) return 0.2;
  const raw = process.env.HSB_REFERRAL_RATES_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const rate = parsed[clean];
      if (typeof rate === 'number' && rate >= 0 && rate <= 1) return rate;
    } catch {
      // fall back to default
    }
  }
  return 0.2;
}

async function listReferralVisits(): Promise<Record<string, number>> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return {};
  const visits: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = await list({
      prefix: withBlobNamespace('referrals/visits/'),
      cursor,
      limit: 100,
    });
    for (const blob of page.blobs) {
      try {
        const found = await get(blob.pathname, { access: 'public' });
        if (!found?.stream) continue;
        const record = JSON.parse(await new Response(found.stream).text()) as ReferralVisitRecord;
        const code = sanitizeReferralCode(record.code);
        if (code) visits[code] = Math.max(visits[code] ?? 0, record.visits ?? 0);
      } catch {
        // ignore malformed visit records
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return visits;
}

export async function listReferralStats(): Promise<ReferralStats[]> {
  const [orders, visits] = await Promise.all([listOrders(), listReferralVisits()]);
  const byCode = new Map<string, ReferralStats>();

  for (const code of Object.keys(visits)) {
    byCode.set(code, {
      code,
      visits: visits[code],
      conversions: 0,
      revenueCents: 0,
      profitShareRate: getReferralProfitShareRate(code),
      estimatedEarningsCents: 0,
    });
  }

  for (const order of orders) {
    const code = sanitizeReferralCode(order.referralCode);
    if (!code || order.paymentStatus !== 'paid') continue;
    const existing =
      byCode.get(code) ??
      {
        code,
        visits: 0,
        conversions: 0,
        revenueCents: 0,
        profitShareRate: getReferralProfitShareRate(code),
        estimatedEarningsCents: 0,
      };
    existing.conversions += 1;
    existing.revenueCents += Math.max(0, order.priceCents ?? 0);
    existing.estimatedEarningsCents = Math.round(
      existing.revenueCents * existing.profitShareRate,
    );
    byCode.set(code, existing);
  }

  for (const stat of byCode.values()) {
    stat.estimatedEarningsCents = Math.round(stat.revenueCents * stat.profitShareRate);
  }

  return [...byCode.values()].sort((a, b) => b.revenueCents - a.revenueCents);
}

export async function getReferralStats(code: string): Promise<ReferralStats | null> {
  const clean = sanitizeReferralCode(code);
  if (!clean) return null;
  const stats = await listReferralStats();
  return (
    stats.find((s) => s.code === clean) ?? {
      code: clean,
      visits: 0,
      conversions: 0,
      revenueCents: 0,
      profitShareRate: getReferralProfitShareRate(clean),
      estimatedEarningsCents: 0,
    }
  );
}
