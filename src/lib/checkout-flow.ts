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

// Promo-code guidance. HSB checkout hands off to Stripe Checkout, which is
// where promo codes are entered (the session sets allow_promotion_codes:
// true — see src/app/api/order/route.ts). Buyers have entered a code on
// this app's form expecting a discount, then paid full price because the
// code must be applied on Stripe's page. This copy tells them exactly where
// and when to apply it, and to stop if the discount is not visible before
// paying. Kept general — no active code names — to avoid implying any code
// is publicly available.
export const PROMO_CODE_HELP =
  'Have a promo code? You will enter it on the secure Stripe payment page (the next step) — type the code and tap Apply before paying so the discount shows in your total. If the discount does not appear before payment, stop and email support@herostorybooks.com instead of paying full price.';

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
  childPronouns: string;
}

export type MissingCheckoutField =
  | 'adventure'
  | 'name'
  | 'email'
  | 'skin_tone'
  | 'hair_style'
  | 'pronouns'
  | null;

export interface CheckoutStepState extends CheckoutRequiredFields {
  photoReady: boolean;
}

export interface CurrentCheckoutStep {
  current: 'Adventure' | 'Hero' | 'Format' | 'Email' | 'Photo' | 'Ready to checkout';
  completedCount: number;
  totalCount: 5;
}

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function missingRequiredField(fields: CheckoutRequiredFields): MissingCheckoutField {
  if (!fields.theme) return 'adventure';
  if (!fields.childName.trim()) return 'name';
  if (!fields.email.trim()) return 'email';
  if (!fields.skinTone.trim()) return 'skin_tone';
  if (!fields.hairStyle.trim()) return 'hair_style';
  if (!fields.childPronouns.trim()) return 'pronouns';
  return null;
}

export function canSubmitCheckoutForm(fields: CheckoutRequiredFields): boolean {
  return missingRequiredField(fields) === null;
}

export function missingFieldPrompt(missing: MissingCheckoutField): string | null {
  switch (missing) {
    case 'adventure':
      return 'Choose an adventure to unlock the next step.';
    case 'name':
      return "Enter your child's name to continue.";
    case 'email':
      return 'Enter your email so we know where to send everything.';
    case 'skin_tone':
      return 'Select a skin tone so the artwork matches your child better.';
    case 'hair_style':
      return 'Select a hair style so the artwork matches your child better.';
    case 'pronouns':
      return 'Select whether the hero is a boy or a girl so the story uses the right pronouns.';
    default:
      return null;
  }
}

export function currentCheckoutStep(fields: CheckoutStepState): CurrentCheckoutStep {
  const completedCount = [
    Boolean(fields.theme),
    Boolean(fields.childName.trim()),
    looksLikeEmail(fields.email),
    Boolean(fields.skinTone.trim()),
    Boolean(fields.hairStyle.trim()),
    Boolean(fields.photoReady),
  ].filter(Boolean).length;

  if (!fields.theme) return { current: 'Adventure', completedCount: 0, totalCount: 5 };
  if (!fields.childName.trim()) return { current: 'Hero', completedCount: 1, totalCount: 5 };
  if (!looksLikeEmail(fields.email) || !fields.skinTone.trim() || !fields.hairStyle.trim() || !fields.childPronouns.trim()) {
    return { current: 'Hero', completedCount: 1, totalCount: 5 };
  }
  if (!fields.photoReady) return { current: 'Photo', completedCount: 4, totalCount: 5 };
  return { current: 'Ready to checkout', completedCount: 5, totalCount: 5 };
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
    case 'pronouns':   return 'pronouns_required';
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
