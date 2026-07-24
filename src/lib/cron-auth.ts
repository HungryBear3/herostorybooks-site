/**
 * Shared, dependency-free auth for internal scheduled endpoints (Vercel Cron).
 * Kept separate from the route so it is unit-testable without importing
 * `next/server`.
 */
import crypto from 'node:crypto';

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Evaluate a cron/internal request's `Authorization: Bearer <CRON_SECRET>`.
 * Returns `null` when authorized, otherwise the HTTP status to deny with.
 * Fails CLOSED: 503 when `CRON_SECRET` is not configured, 401 on mismatch.
 */
export function evaluateCronAuth(authHeader: string | null, secret: string | undefined): number | null {
  if (!secret) return 503;
  if (!timingSafeEqualStr(authHeader ?? '', `Bearer ${secret}`)) return 401;
  return null;
}
