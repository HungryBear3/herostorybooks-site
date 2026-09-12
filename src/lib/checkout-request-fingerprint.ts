import crypto from 'node:crypto';

import { CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS } from './checkout-direct-order-request.ts';
import type { FinalizedSelectionEntry } from './checkout-intake.ts';
import type { OrderRecord } from './orders.ts';

export interface CheckoutFingerprintFormLike {
  entries(): Iterable<[string, unknown]>;
}

/**
 * Browser authority and attribution fields do not describe the purchased
 * book. They must not split one semantic checkout into multiple durable order
 * identities when Private Browsing gives concurrent tabs different attempts.
 */
export const CHECKOUT_INTENT_FINGERPRINT_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  ...CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS,
  'checkoutAttemptId',
  'gaClientId',
  'cohort',
  'invite',
  'referralCode',
]);

export type DirectMediaSemanticEntry = Pick<FinalizedSelectionEntry,
  | 'category'
  | 'familyCharacterIndex'
  | 'guidedStillIndex'
  | 'mimeType'
  | 'size'
  | 'etag'
  | 'voiceSource'
>;

export interface CheckoutIntentMediaEntry {
  category: string;
  file: File;
}

async function fingerprintForm(
  form: CheckoutFingerprintFormLike,
  excludedFields: ReadonlySet<string>,
  opts: { directMedia?: readonly DirectMediaSemanticEntry[] } = {},
): Promise<string> {
  const entries: string[] = [];
  for (const [key, value] of form.entries()) {
    if (excludedFields.has(key)) continue;
    if (key === 'checkoutIntake' && opts.directMedia) continue;
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
  if (opts.directMedia) {
    const media = opts.directMedia.map((entry) => ({
      category: entry.category,
      familyCharacterIndex: entry.familyCharacterIndex,
      guidedStillIndex: entry.guidedStillIndex,
      mimeType: entry.mimeType,
      size: entry.size,
      etag: entry.etag,
      voiceSource: entry.voiceSource,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    entries.push(JSON.stringify(['checkoutIntake', 'validated-media', media]));
  }
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

/**
 * Deterministic checkout identity. Bearer capability fields are deliberately
 * excluded: they authorize access but are not part of what the buyer ordered.
 */
export async function checkoutRequestFingerprint(form: CheckoutFingerprintFormLike): Promise<string> {
  return fingerprintForm(form, CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
  }
  // JSON.parse accepts overflowing numbers; JSON.stringify would erase them as null.
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite appearance value');
  return value;
}

function canonicalAppearanceOptions(raw: string | undefined): string | undefined {
  if (raw === undefined) return raw;
  try {
    return JSON.stringify(canonicalJsonValue(JSON.parse(raw)));
  } catch {
    // Invalid legacy JSON remains byte-distinct, never an empty/default identity.
    return raw;
  }
}

function normalizedPayableContract(order: OrderRecord): Record<string, unknown> {
  return {
    childName: order.childName,
    heroName: order.heroName,
    heroType: order.heroType,
    heroAgeOrStage: order.heroAgeOrStage,
    recipientName: order.recipientName,
    recipientRelationship: order.recipientRelationship,
    storyPerspective: order.storyPerspective,
    heroPhotoFocusLabel: order.heroPhotoFocusLabel,
    heroPhotoCropHint: order.heroPhotoCropHint,
    childAge: order.childAge,
    childPronouns: order.childPronouns,
    theme: order.theme,
    lesson: order.lesson,
    occasion: order.occasion,
    giftMessage: order.giftMessage,
    characterNotes: order.characterNotes,
    customStoryText: order.customStoryText,
    familyCharacters: order.familyCharacters,
    appearanceOptions: canonicalAppearanceOptions(order.appearanceOptions),
    bookFormat: order.bookFormat,
    formatLabel: order.formatLabel,
    priceCents: order.priceCents,
    email: order.email,
    photoFileName: order.photoFileName,
    voiceSource: order.voiceSource,
    documentSource: order.documentSource,
    customStoryBrief: order.customStoryBrief,
    customStoryValidation: order.customStoryValidation,
  };
}

/** Stable identity for the normalized payable contract, independent of browser authority. */
export async function checkoutIntentFingerprint(
  order: OrderRecord,
  opts: {
    media?: readonly CheckoutIntentMediaEntry[];
    directMedia?: readonly DirectMediaSemanticEntry[];
  } = {},
): Promise<string> {
  const entries = [JSON.stringify(['order', 'normalized-payable-contract', normalizedPayableContract(order)])];
  for (const entry of opts.media ?? []) {
    const bytes = Buffer.from(await entry.file.arrayBuffer());
    entries.push(JSON.stringify([
      'media',
      entry.category,
      entry.file.type,
      entry.file.size,
      crypto.createHash('sha256').update(bytes).digest('hex'),
    ]));
  }
  if (opts.directMedia) {
    const media = opts.directMedia.map((entry) => ({
      category: entry.category,
      familyCharacterIndex: entry.familyCharacterIndex,
      guidedStillIndex: entry.guidedStillIndex,
      mimeType: entry.mimeType,
      size: entry.size,
      etag: entry.etag,
      voiceSource: entry.voiceSource,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    entries.push(JSON.stringify(['checkoutIntake', 'validated-media', media]));
  }
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}
