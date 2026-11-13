/**
 * Delivery contact for standard-lane printed books.
 *
 * The print provider (Lulu) requires a recipient name and a phone number on
 * every shipment. For a standard print order both are collected ONCE, by
 * Stripe hosted Checkout: the shipping address through
 * `shipping_address_collection` and the phone through
 * `phone_number_collection`. The signed webhook copies them onto the order's
 * `ShippingAddress`; nothing downstream may invent them. (The expedited lane
 * keeps its contact in the private shipping draft and is not read here.)
 *
 * Stripe has presented the shipping details in two shapes: the current
 * `collected_information.shipping_details` (name + address; the phone lives
 * on `customer_details.phone`) and the legacy top-level `shipping_details`
 * (name + address + optional phone). Exactly one shape is chosen and its
 * phone is never paired with the other shape's address.
 *
 * Privacy: these values are personal data. They belong on the order record
 * only — never in Session metadata, URLs, analytics, audit meta, or log lines.
 */
import type { ShippingAddress } from './orders.ts';

interface StripeAddressLike {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/** The subset of a Stripe Checkout Session this module reads. */
export interface StripeDeliverySessionLike {
  customer_details?: { name?: string | null; phone?: string | null; email?: string | null } | null;
  collected_information?: {
    shipping_details?: { name?: string | null; address?: StripeAddressLike | null } | null;
  } | null;
  /** Legacy API shape; also carried the phone when one was collected. */
  shipping_details?: { name?: string | null; phone?: string | null; address?: StripeAddressLike | null } | null;
}

export type PrintDeliveryContactRefusal = 'shipping_address_missing' | 'shipping_contact_missing';

/**
 * A dialable phone or null. Stripe returns E.164 (`+13125550100`); operators
 * and the legacy shape may carry separators. Separators are dropped, a leading
 * `+` is kept, 7–15 digits are required, and an all-zero number — the old
 * placeholder — is never a contact.
 */
export function normalizeDeliveryPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Stripe supplies E.164; legacy/operator values may add ordinary dialling
  // separators, but letters or any other annotation are not a phone number.
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (/^0+$/.test(digits)) return null;
  return `${plus}${digits}`;
}

export function normalizeDeliveryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

/**
 * The shipping address a completed Session carries, with recipient name and
 * phone when Stripe collected them. Returns undefined when there is no
 * shipping address at all (digital orders, or a Session that never asked).
 * A missing or unusable phone is recorded as null, never substituted.
 */
export function extractStripeShippingAddress(session: StripeDeliverySessionLike): ShippingAddress | undefined {
  const current = session.collected_information?.shipping_details ?? null;
  const legacy = session.shipping_details ?? null;
  const usesCurrentShape = Boolean(current?.address);
  const details = usesCurrentShape ? current : legacy?.address ? legacy : null;
  const addr = details?.address;
  if (!addr) return undefined;
  // Current address: only the current Session-level phone. Legacy address:
  // its own phone first. A legacy phone never travels with a current address.
  const phone = usesCurrentShape
    ? normalizeDeliveryPhone(session.customer_details?.phone)
    : normalizeDeliveryPhone(legacy?.phone) ?? normalizeDeliveryPhone(session.customer_details?.phone);
  const name = normalizeDeliveryName(details?.name) ?? normalizeDeliveryName(session.customer_details?.name);
  return {
    line1: addr.line1 ?? '',
    line2: addr.line2 ?? null,
    city: addr.city ?? '',
    state: addr.state ?? '',
    zip: addr.postal_code ?? '',
    country: addr.country ?? '',
    name,
    phone,
  };
}

/** Why a print shipment cannot be handed to the provider, or null when it can. */
export function printDeliveryContactRefusal(address: ShippingAddress | null | undefined): PrintDeliveryContactRefusal | null {
  if (!address) return 'shipping_address_missing';
  if (!normalizeDeliveryName(address.name) || !normalizeDeliveryPhone(address.phone)) return 'shipping_contact_missing';
  return null;
}

/** The destination and the exact recipient contact the provider is given. Throws the refusal code. */
export function requirePrintDeliveryContact(
  address: ShippingAddress | null | undefined,
): { address: ShippingAddress; name: string; phone: string } {
  const refusal = printDeliveryContactRefusal(address);
  if (refusal || !address) throw new Error(`Refusing print: ${refusal ?? 'shipping_address_missing'}`);
  return { address, name: normalizeDeliveryName(address.name)!, phone: normalizeDeliveryPhone(address.phone)! };
}
