/**
 * Reads a `/api/order` submission and decides — before anything else happens —
 * whether it is the legacy multipart request or a direct private-intake one.
 *
 * WHY THE SHAPE DECIDES, NOT THE FLAG
 * -----------------------------------
 * The two paths bind different media. If the server flag alone selected the
 * path, a browser still posting the legacy shape into a flag-on deployment
 * would be read as "direct with no media" and would cheerfully create an order
 * with no photo; a browser posting the direct shape into a flag-off deployment
 * would be read as legacy and do the same. So the REQUEST decides which
 * contract it is, and the flag only decides whether the direct contract is
 * currently served at all. A direct request into a flag-off deployment is a
 * half-enabled configuration and is refused — never silently downgraded.
 *
 * Everything here is a refusal, never a repair. A selection is a claim about
 * which private objects an order will be permanently bound to; a malformed
 * claim that gets "cleaned up" is a different order than the buyer asked for.
 *
 * The capability is carried in its own field so it can be excluded from the
 * request fingerprint — a secret must not become a hashed input that any later
 * change to fingerprint logging could expose.
 */
import type { CheckoutFinalizeSelection, FamilyCharacterBinding } from './checkout-finalize.ts';
import { INTAKE_CATEGORY_POLICY } from './checkout-intake.ts';

export const DIRECT_INTAKE_FIELD = 'checkoutIntake';
export const DIRECT_INTAKE_CAPABILITY_FIELD = 'checkoutIntakeCapability';

/**
 * Form fields deliberately kept OUT of the checkout request fingerprint.
 *
 * The capability is a bearer secret for the buyer's private media. It is not
 * part of what the buyer ordered, so it does not belong in the identity of
 * what they ordered either.
 */
export const CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  DIRECT_INTAKE_CAPABILITY_FIELD,
]);

const INTAKE_ID_RE = /^intake_[a-f0-9]{32}$/;
const ASSET_ID_RE = /^asset_[a-f0-9]{32}$/;
const FAMILY_CHARACTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Exactly what `finalizeIntakeSelection` accepts — not the route's looser form. */
const CHECKOUT_ATTEMPT_ID_RE = /^[a-f0-9]{32}$/;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{16,1024}$/;

const MAX_FAMILY_CHARACTERS = INTAKE_CATEGORY_POLICY.family_pet_reference.maxSlots;
const MAX_GUIDED_STILLS = INTAKE_CATEGORY_POLICY.guided_still.maxSlots;

const PAYLOAD_KEYS = ['intakeId', 'selection', 'familyCharacterIds'] as const;
const SELECTION_KEYS = [
  'primaryHeroPhotoAssetId', 'familyCharacterAssets', 'guidedStillAssetIds',
  'voiceAssetId', 'documentAssetId',
] as const;
const BINDING_KEYS = ['assetId', 'familyCharacterId'] as const;

export interface DirectIntakeOrderRequest {
  intakeId: string;
  /** In-memory only. Never persisted, logged, or folded into the fingerprint. */
  capability: string;
  checkoutAttemptId: string;
  selection: CheckoutFinalizeSelection;
  /** Stable ids of the family characters as the form currently orders them. */
  familyCharacterIds: string[];
}

export type DirectIntakeOrderRequestParse =
  | { kind: 'legacy' }
  | { kind: 'direct'; request: DirectIntakeOrderRequest }
  | { kind: 'invalid'; code: string };

export interface DirectIntakeFormLike {
  get(name: string): unknown;
  entries(): Iterable<[string, unknown]>;
}

function invalid(code: string): DirectIntakeOrderRequestParse {
  return { kind: 'invalid', code };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Any attached file at all is a refusal, not just the fields we know about.
 *
 * An allow-list of "media fields" would silently start accepting whatever the
 * next feature adds. The direct path's entire reason to exist is that media
 * does not travel on this request.
 */
function carriesRawMedia(form: DirectIntakeFormLike): boolean {
  for (const [, value] of form.entries()) {
    if (typeof File !== 'undefined' && value instanceof File) return true;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  }
  return false;
}

function parseSelection(
  raw: unknown,
  declaredFamilyIds: readonly string[],
): CheckoutFinalizeSelection | null {
  const selection = plainObject(raw);
  if (!selection || !exactKeys(selection, SELECTION_KEYS)) return null;

  const seenAssets = new Set<string>();
  const claim = (value: unknown): string | null => {
    if (typeof value !== 'string' || !ASSET_ID_RE.test(value) || seenAssets.has(value)) return null;
    seenAssets.add(value);
    return value;
  };
  const optional = (value: unknown): string | null | false => {
    if (value === null) return null;
    const claimed = claim(value);
    return claimed ?? false;
  };

  const primaryHeroPhotoAssetId = optional(selection.primaryHeroPhotoAssetId);
  if (primaryHeroPhotoAssetId === false) return null;

  if (!Array.isArray(selection.familyCharacterAssets)
    || selection.familyCharacterAssets.length > MAX_FAMILY_CHARACTERS) return null;
  const declared = new Set(declaredFamilyIds);
  const boundFamilyIds = new Set<string>();
  const familyCharacterAssets: FamilyCharacterBinding[] = [];
  for (const entry of selection.familyCharacterAssets) {
    const binding = plainObject(entry);
    if (!binding || !exactKeys(binding, BINDING_KEYS)) return null;
    const assetId = claim(binding.assetId);
    const familyCharacterId = binding.familyCharacterId;
    if (!assetId
      || typeof familyCharacterId !== 'string'
      || !declared.has(familyCharacterId)
      || boundFamilyIds.has(familyCharacterId)) return null;
    boundFamilyIds.add(familyCharacterId);
    familyCharacterAssets.push({ assetId, familyCharacterId });
  }

  if (!Array.isArray(selection.guidedStillAssetIds)
    || selection.guidedStillAssetIds.length > MAX_GUIDED_STILLS) return null;
  const guidedStillAssetIds: string[] = [];
  for (const value of selection.guidedStillAssetIds) {
    const assetId = claim(value);
    if (!assetId) return null;
    guidedStillAssetIds.push(assetId);
  }

  const voiceAssetId = optional(selection.voiceAssetId);
  if (voiceAssetId === false) return null;
  const documentAssetId = optional(selection.documentAssetId);
  if (documentAssetId === false) return null;
  // One story source. `finalizeIntakeSelection` refuses this too; refusing it
  // here means the refusal costs no intake reservation.
  if (voiceAssetId && documentAssetId) return null;

  return {
    primaryHeroPhotoAssetId,
    familyCharacterAssets,
    guidedStillAssetIds,
    voiceAssetId,
    documentAssetId,
  };
}

export function parseDirectIntakeOrderRequest(form: DirectIntakeFormLike): DirectIntakeOrderRequestParse {
  const rawPayload = form.get(DIRECT_INTAKE_FIELD);
  const rawCapability = form.get(DIRECT_INTAKE_CAPABILITY_FIELD);
  if (rawPayload == null && rawCapability == null) return { kind: 'legacy' };

  if (carriesRawMedia(form)) return invalid('direct_intake_media_forbidden');

  if (typeof rawPayload !== 'string' || !rawPayload) return invalid('direct_intake_payload_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return invalid('direct_intake_payload_invalid');
  }
  const payload = plainObject(parsed);
  if (!payload || !exactKeys(payload, PAYLOAD_KEYS)) return invalid('direct_intake_payload_invalid');

  if (typeof rawCapability !== 'string' || !CAPABILITY_RE.test(rawCapability)) {
    return invalid('direct_intake_capability_invalid');
  }

  const checkoutAttemptId = form.get('checkoutAttemptId');
  if (typeof checkoutAttemptId !== 'string' || !CHECKOUT_ATTEMPT_ID_RE.test(checkoutAttemptId)) {
    return invalid('direct_intake_checkout_attempt_invalid');
  }

  if (typeof payload.intakeId !== 'string' || !INTAKE_ID_RE.test(payload.intakeId)) {
    return invalid('direct_intake_id_invalid');
  }

  if (!Array.isArray(payload.familyCharacterIds)
    || payload.familyCharacterIds.length > MAX_FAMILY_CHARACTERS) {
    return invalid('direct_intake_family_identity_invalid');
  }
  const familyCharacterIds: string[] = [];
  for (const value of payload.familyCharacterIds) {
    if (typeof value !== 'string'
      || !FAMILY_CHARACTER_ID_RE.test(value)
      || familyCharacterIds.includes(value)) {
      return invalid('direct_intake_family_identity_invalid');
    }
    familyCharacterIds.push(value);
  }

  const selection = parseSelection(payload.selection, familyCharacterIds);
  if (!selection) return invalid('direct_intake_selection_invalid');

  return {
    kind: 'direct',
    request: {
      intakeId: payload.intakeId,
      capability: rawCapability,
      checkoutAttemptId,
      selection,
      familyCharacterIds,
    },
  };
}
