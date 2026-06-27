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

export interface GiftRecipientDefaultsInput {
  childName: string;
  occasion?: string | null;
  supportingCharacters?: Array<{ name?: string | null; relationship?: string | null; role?: string | null }> | null;
  explicitGiftRecipientName?: string | null;
}

const DAD_RELATION_RE = /\b(dad|father|daddy|papa)\b/i;

/**
 * Checkout gift defaults: the book is for the child/hero unless the buyer
 * explicitly names a gift recipient. A Dad/Father supporting character is story
 * context for Father's Day, not the shipment/gift recipient by default.
 */
export function defaultGiftRecipientName(input: GiftRecipientDefaultsInput): string {
  const explicit = (input.explicitGiftRecipientName ?? '').trim();
  if (explicit) return explicit;

  const childName = (input.childName ?? '').trim();
  const supportingCharacters = Array.isArray(input.supportingCharacters) ? input.supportingCharacters : [];
  const nonDadNamedCharacter = supportingCharacters.find((character) => {
    const relationText = `${character.relationship ?? ''} ${character.role ?? ''}`;
    const name = (character.name ?? '').trim();
    return name && !DAD_RELATION_RE.test(relationText) && !DAD_RELATION_RE.test(name);
  });

  // Keep the child as the safe default even when all supporting characters are
  // Dad/Father. If no child name exists yet, avoid auto-selecting Dad; leave blank.
  return childName || nonDadNamedCharacter?.name?.trim() || '';
}
