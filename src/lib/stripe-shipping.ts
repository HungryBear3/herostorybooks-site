import type { ShippingAddress } from './orders';

export interface StripeAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface StripeCheckoutSessionWithShipping {
  shipping_details?: {
    address?: StripeAddress | null;
  } | null;
  collected_information?: {
    shipping_details?: {
      address?: StripeAddress | null;
    } | null;
  } | null;
  customer_details?: {
    address?: StripeAddress | null;
  } | null;
}

export function extractCheckoutShipping(
  session: StripeCheckoutSessionWithShipping,
): ShippingAddress | undefined {
  const addr =
    session.shipping_details?.address ??
    session.collected_information?.shipping_details?.address ??
    session.customer_details?.address;
  if (!addr) return undefined;
  if (!addr.line1 || !addr.city || !addr.state || !addr.postal_code || !addr.country) return undefined;
  return {
    line1: addr.line1 ?? '',
    line2: addr.line2 ?? null,
    city: addr.city ?? '',
    state: addr.state ?? '',
    zip: addr.postal_code ?? '',
    country: addr.country ?? '',
  };
}
