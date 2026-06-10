import { buildCapacityDashboardSummary } from './capacity-dashboard.ts';
import type { OrderRecord } from './orders.ts';

export const CHECKOUT_PAUSED_CODE = 'checkout_paused';

export const CHECKOUT_PAUSED_MESSAGE =
  'Checkout is paused for today because our proof-review queue is full. Please check back tomorrow or contact support@herostorybooks.com if you already placed an order.';

export function isCheckoutPaused(value = process.env.HSB_CHECKOUT_PAUSED): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** Optional public-intake paid-order cap. If configured, this overrides the
 * dashboard default ceiling for the hard checkout block. Bad configured values
 * fail closed by returning 0, while an unset value keeps the dashboard default.
 */
export function parsePublicCheckoutDailyPaidLimit(
  value = process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT,
): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return 0;
  return parsed;
}

export function isCheckoutCapacityFull(orders: OrderRecord[], now = new Date()): boolean {
  const summary = buildCapacityDashboardSummary(orders, { now });
  const configuredLimit = parsePublicCheckoutDailyPaidLimit();
  const dailyPaidCeiling = configuredLimit ?? summary.dailyPaidCeiling;
  return summary.paidOrdersToday >= dailyPaidCeiling;
}
