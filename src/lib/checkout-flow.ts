export const CHECKOUT_SECTION_ORDER = [
  'theme',
  'child-details',
  'format',
  'email',
  'photo',
  'order-summary',
] as const;

export const PRINT_PREVIEW_PROMISE =
  'Print books include a digital preview first, so you can approve everything before it prints.';

export const PHOTO_UPLOAD_HELP =
  'No photo yet? Start now and add a photo later before you place the order. Large phone photos are automatically reduced when we can.';

// ── Required-field gating for checkout submit ────────────────────────────────
//
// Adventure is required before checkout can continue. The UI mirrors this by
// disabling the sticky CTA and surfacing the missing-field reason via
// `missingRequiredField`.

export interface CheckoutRequiredFields {
  theme: string;
  childName: string;
  email: string;
}

export type MissingCheckoutField = 'adventure' | 'name' | 'email' | null;

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function missingRequiredField(fields: CheckoutRequiredFields): MissingCheckoutField {
  if (!fields.theme) return 'adventure';
  if (!fields.childName.trim()) return 'name';
  if (!fields.email.trim()) return 'email';
  return null;
}

export function canSubmitCheckoutForm(fields: CheckoutRequiredFields): boolean {
  return missingRequiredField(fields) === null;
}

/**
 * Adventure selection is radio-style: clicking the currently-selected card
 * must NOT deselect it. Clicking a different card switches selection.
 */
export function selectAdventureValue(clickedId: string, currentSelection: string): string {
  if (!clickedId) return currentSelection;
  return clickedId;
}
