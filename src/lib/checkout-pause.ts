import { buildCapacityDashboardSummary } from './capacity-dashboard.ts';
import type { OrderRecord } from './orders.ts';

export const CHECKOUT_PAUSED_CODE = 'checkout_paused';

export const CHECKOUT_PAUSED_MESSAGE =
  'Checkout is paused for today because our proof-review queue is full. Please check back tomorrow or contact support@herostorybooks.com if you already placed an order.';

export function isCheckoutPaused(value = process.env.HSB_CHECKOUT_PAUSED): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

export function isCheckoutCapacityFull(orders: OrderRecord[], now = new Date()): boolean {
  const summary = buildCapacityDashboardSummary(orders, { now });
  return summary.paidOrdersToday >= summary.dailyPaidCeiling;
}
