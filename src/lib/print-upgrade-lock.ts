/**
 * Customer at-cost print upgrade — lock LIVENESS.
 *
 * `printUpgradeLock` is the durable record of the one Stripe Checkout Session
 * a quote may be paid through. Three callers must agree on when that lock can
 * still produce a payment, because each of them would otherwise either strand
 * the customer (blocking forever) or open a second payable Session:
 *
 *   - `openPrintUpgradeCheckout` (may a different quote open a Session?)
 *   - `quotePrintUpgradeAtCost`   (may the customer re-quote?)
 *   - `prepareCustomerPrintUpgradeOffer` (may the operator re-offer?)
 *
 * A lock is LIVE while a payable Session may exist for it:
 *   - `open`:         the Session was bound and has not reached `expires_at`;
 *   - `provisioning`: the provider create was entered and its outcome may be
 *                     unknown (timeout, 5xx). The Session, if it exists, was
 *                     created with `expires_at` mirrored from the lock, so once
 *                     the lock's `expiresAt` passes no Session from it can be
 *                     paid any more and the lock stops blocking.
 *
 * `expired` and `paid` locks are never live. A `checkout.session.expired`
 * webhook ends liveness early; this module makes sure its absence (an
 * unsubscribed endpoint, a lost delivery, a provider failure that never
 * created a Session) is bounded by the Session TTL instead of permanent.
 */
import type { PrintUpgradeLockV1 } from './orders.ts';

export function printUpgradeLockExpiresAtMs(lock: PrintUpgradeLockV1): number {
  return Date.parse(lock.expiresAt);
}

/** True while a payable Stripe Session may exist for this lock. */
export function isPrintUpgradeLockLive(lock: PrintUpgradeLockV1 | null | undefined, nowMs: number): boolean {
  if (!lock) return false;
  if (lock.status !== 'open' && lock.status !== 'provisioning') return false;
  const expiresAtMs = printUpgradeLockExpiresAtMs(lock);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}
