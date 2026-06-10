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
  "A clear, well-lit photo of your child is required before production starts because it guides the personalized illustrations. Don't have one handy? You can still place the order now and add the photo later; we won't begin the proof until we have one. Large phone photos are automatically reduced when we can.";

// ── Required-field gating for checkout submit ────────────────────────────────
//
// Launch spec requires explicit values for: theme (adventure), childName,
// email, skinTone, hairStyle. "Prefer AI to decide" is not allowed for
// skin tone or hair on launch orders. Pronouns are deliberately not required
// on the buyer path; prose can infer/fallback server-side without asking.
// Both UI and the /api/order server route validate against this same shape so
// the contract cannot drift.

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

export interface CheckoutStepState extends CheckoutRequiredFields {
  photoReady: boolean;
}

export interface CurrentCheckoutStep {
  current: 'Adventure' | 'Hero' | 'Format' | 'Email' | 'Photo' | 'Ready to checkout';
  completedCount: number;
  totalCount: 5;
}

// Exported so the checkout form and tests share ONE email-format rule. This
// mirrors the server's isValidEmail in /api/order so the client gate and the
// server validation cannot drift. Proof-before-print depends on a deliverable
// email, so checkout must require a real address — not just a non-empty string.
export function looksLikeEmail(email: string): boolean {
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

// Submit gate, distinguishing a present-but-malformed email from a missing one
// so the CTA can explain it. `missingRequiredField` stays the server contract
// (non-empty checks) — this layers email FORMAT validation on top for the
// client gate only.
export type CheckoutSubmitBlocker = MissingCheckoutField | 'email_invalid';

export function checkoutSubmitBlocker(fields: CheckoutRequiredFields): CheckoutSubmitBlocker {
  const missing = missingRequiredField(fields);
  if (missing) return missing;
  if (!looksLikeEmail(fields.email)) return 'email_invalid';
  return null;
}

export function canSubmitCheckoutForm(fields: CheckoutRequiredFields): boolean {
  return checkoutSubmitBlocker(fields) === null;
}

/** Human CTA helper copy for any submit blocker, including a malformed email. */
export function checkoutBlockerPrompt(blocker: CheckoutSubmitBlocker): string | null {
  if (blocker === 'email_invalid') {
    return 'Enter a valid email address (like name@example.com) so we can send your proof and book.';
  }
  return missingFieldPrompt(blocker);
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
  if (!looksLikeEmail(fields.email) || !fields.skinTone.trim() || !fields.hairStyle.trim()) {
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
