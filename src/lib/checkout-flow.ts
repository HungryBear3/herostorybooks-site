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
// Launch spec requires explicit values for: theme (adventure), childName,
// email, skinTone, hairStyle. "Prefer AI to decide" is not allowed for
// skin tone or hair on launch orders. Both UI and the /api/order server
// route validate against this same shape so the contract cannot drift.

export interface CheckoutRequiredFields {
  theme: string;
  childName: string;
  email: string;
  skinTone: string;
  hairStyle: string;
}

export type MissingCheckoutField =
  | 'adventure'
  | 'name'
  | 'email'
  | 'skin_tone'
  | 'hair_style'
  | null;

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function missingRequiredField(fields: CheckoutRequiredFields): MissingCheckoutField {
  if (!fields.theme) return 'adventure';
  if (!fields.childName.trim()) return 'name';
  if (!fields.email.trim()) return 'email';
  if (!fields.skinTone.trim()) return 'skin_tone';
  if (!fields.hairStyle.trim()) return 'hair_style';
  return null;
}

export function canSubmitCheckoutForm(fields: CheckoutRequiredFields): boolean {
  return missingRequiredField(fields) === null;
}

/** Stable error code per missing field — clients map them to UI copy
 *  without parsing free-form messages. */
export function missingFieldErrorCode(missing: MissingCheckoutField): string | null {
  switch (missing) {
    case 'adventure':  return 'theme_required';
    case 'name':       return 'child_name_required';
    case 'email':      return 'email_required';
    case 'skin_tone':  return 'skin_tone_required';
    case 'hair_style': return 'hair_style_required';
    default:           return null;
  }
}

/**
 * Adventure selection is radio-style: clicking the currently-selected card
 * must NOT deselect it. Clicking a different card switches selection.
 */
export function selectAdventureValue(clickedId: string, currentSelection: string): string {
  if (!clickedId) return currentSelection;
  return clickedId;
}
