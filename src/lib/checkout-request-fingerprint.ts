import crypto from 'node:crypto';

import { CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS } from './checkout-direct-order-request.ts';

export interface CheckoutFingerprintFormLike {
  entries(): Iterable<[string, unknown]>;
}

/**
 * Deterministic checkout identity. Bearer capability fields are deliberately
 * excluded: they authorize access but are not part of what the buyer ordered.
 */
export async function checkoutRequestFingerprint(form: CheckoutFingerprintFormLike): Promise<string> {
  const entries: string[] = [];
  for (const [key, value] of form.entries()) {
    if (CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS.has(key)) continue;
    if (typeof File !== 'undefined' && value instanceof File) {
      const bytes = Buffer.from(await value.arrayBuffer());
      entries.push(JSON.stringify([
        key,
        'file',
        value.name,
        value.type,
        value.size,
        crypto.createHash('sha256').update(bytes).digest('hex'),
      ]));
    } else if (typeof value === 'string') {
      entries.push(JSON.stringify([key, 'text', value]));
    } else {
      entries.push(JSON.stringify([key, 'other', String(value)]));
    }
  }
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}
