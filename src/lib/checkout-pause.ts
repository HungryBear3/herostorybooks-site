export const CHECKOUT_PAUSED_CODE = 'checkout_paused';

export const CHECKOUT_PAUSED_MESSAGE =
  'Checkout is temporarily paused while we improve story quality. Please check back shortly or contact support@herostorybooks.com.';

export function isCheckoutPaused(value = process.env.HSB_CHECKOUT_PAUSED): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}
