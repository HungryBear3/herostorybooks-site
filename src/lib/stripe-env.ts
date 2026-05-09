function sanitizeStripeEnv(name: string): string | null {
  const value = (process.env[name] ?? '')
    .trim()
    .replace(/\\n/g, '')
    .replace(/[\r\n]/g, '')
    .trim();
  return value || null;
}

export function getOptionalStripeSecretKey(): string | null {
  return sanitizeStripeEnv('STRIPE_SECRET_KEY');
}

export function getRequiredStripeSecretKey(): string {
  const value = getOptionalStripeSecretKey();
  if (!value) {
    throw new Error('STRIPE_SECRET_KEY not set');
  }
  return value;
}

export function getOptionalStripeWebhookSecret(): string | null {
  return sanitizeStripeEnv('STRIPE_WEBHOOK_SECRET');
}

export function getRequiredStripeWebhookSecret(): string {
  const value = getOptionalStripeWebhookSecret();
  if (!value) {
    throw new Error('STRIPE_WEBHOOK_SECRET not set');
  }
  return value;
}
