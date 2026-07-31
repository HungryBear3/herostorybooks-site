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
  "A clear, well-lit photo helps the illustrations look like them. Without a photo, we'll draw the hero as a storybook character from your description. Large phone photos are automatically reduced when we can.";

// Promo-code guidance. HSB checkout hands off to Stripe Checkout, which is
// where promo codes are entered (the session sets allow_promotion_codes:
// true — see src/app/api/order/route.ts). Buyers have entered a code on
// this app's form expecting a discount, then paid full price because the
// code must be applied on Stripe's page. This copy tells them exactly where
// and when to apply it, and to stop if the discount is not visible before
// paying. Kept general — no active code names — to avoid implying any code
// is publicly available.
export const PROMO_CODE_HELP =
  'Enter promo codes on the next secure Stripe page before payment.';

// ── Required-field gating for checkout submit ────────────────────────────────
//
// Checkout requires theme, childName, email, and one usable hero reference:
// either an uploaded photo or a short written appearance description.
// Pronouns are deliberately not part of buyer checkout; prose can
// infer/fallback server-side without asking. Both UI and the /api/order
// server route validate against this same shape so the contract cannot drift.

export interface CheckoutRequiredFields {
  theme: string;
  childName: string;
  email: string;
  appearanceDescription: string;
  photoReady: boolean;
}

export type MissingCheckoutField =
  | 'adventure'
  | 'name'
  | 'email'
  | 'appearance_description'
  | null;

export interface CheckoutStepState extends CheckoutRequiredFields {}

export type LikenessIntent = 'match' | 'storybook';

export function likenessIntentForPhoto(photoReady: boolean): LikenessIntent {
  return photoReady ? 'match' : 'storybook';
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
  if (!fields.photoReady && !fields.appearanceDescription.trim()) {
    return 'appearance_description';
  }
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
    case 'appearance_description':
      return 'Describe the hero so we can illustrate them without a photo.';
    default:
      return null;
  }
}

export function currentCheckoutStep(fields: CheckoutStepState): CurrentCheckoutStep {
  const appearanceReady = Boolean(fields.photoReady || fields.appearanceDescription.trim());
  const completedCount = [
    Boolean(fields.theme),
    Boolean(fields.childName.trim()),
    looksLikeEmail(fields.email),
    appearanceReady,
    Boolean(fields.photoReady),
  ].filter(Boolean).length;

  if (!fields.theme) return { current: 'Adventure', completedCount: 0, totalCount: 5 };
  if (!fields.childName.trim()) return { current: 'Hero', completedCount: 1, totalCount: 5 };
  if (!looksLikeEmail(fields.email) || !appearanceReady) {
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
    case 'appearance_description': return 'appearance_description_required';
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
