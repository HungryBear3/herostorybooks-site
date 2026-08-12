import type { BookFormat } from './orders.ts';

const PRODUCT_ENV_BY_FORMAT: Record<BookFormat, string> = {
  digital: 'STRIPE_PRODUCT_DIGITAL_ID',
  classic: 'STRIPE_PRODUCT_CLASSIC_ID',
  premium: 'STRIPE_PRODUCT_PREMIUM_ID',
};

function sanitizeProductId(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\\n/g, '')
    .replace(/[\r\n]/g, '')
    .trim();
}

export function getRequiredStripeProductId(format: BookFormat): string {
  const envName = PRODUCT_ENV_BY_FORMAT[format];
  const value = sanitizeProductId(process.env[envName]);

  if (!value) {
    throw new Error(`Missing stable Stripe Product binding for ${format}: ${envName}`);
  }
  if (!/^prod_[A-Za-z0-9]+$/.test(value)) {
    throw new Error(`Invalid Stripe Product ID for ${format}: ${envName}`);
  }
  return value;
}
