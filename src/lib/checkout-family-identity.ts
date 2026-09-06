/**
 * Stable identity for supporting characters, shared by the direct-intake
 * checkout path.
 *
 * A supporting character is described in two places in the same request: the
 * `familyCharacters` payload (name, notes, role) and — for direct upload — the
 * `familyCharacterIds` list that names which characters own which private
 * media. The description gate and `likenessIntent` are both INDEX-based, so if
 * those two lists disagree about which position is whom, a photo uploaded for
 * one person satisfies (and is attributed to) another.
 *
 * Position alone cannot prove they agree, so the id travels ON the character.
 * This module derives the per-character stable id from the character payload
 * itself and refuses any declared list that does not match it exactly. That
 * refusal is the only reason index-based eligibility downstream is safe.
 */

/** Mirrors `FAMILY_CHARACTER_ID_RE` in `checkout-direct-order-request.ts`. */
const FAMILY_CHARACTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mirrors `FAMILY_CHARACTER_MAX_COUNT` in `orders.ts`. */
const FAMILY_CHARACTER_MAX_COUNT = 4;

export const FAMILY_IDENTITY_MISMATCH_CODE = 'direct_intake_family_identity_mismatch';

export type FamilyCharacterIdentityAlignment =
  | { ok: true; ids: readonly string[] }
  | { ok: false; code: typeof FAMILY_IDENTITY_MISMATCH_CODE };

const mismatch: FamilyCharacterIdentityAlignment = { ok: false, code: FAMILY_IDENTITY_MISMATCH_CODE };

/** The same shape-tolerant read `sanitizeFamilyCharacters` performs. */
function rawEntries(input: unknown): unknown[] | null {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input !== 'string') return [];
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Proves the declared id list describes exactly the characters this request
 * carries, in the same order, and returns the per-index stable ids.
 *
 * `sanitizedCount` is the length of the family list the order record will
 * actually hold, so an entry the sanitizer drops cannot silently shift every
 * id after it.
 */
export function alignFamilyCharacterIdentity(params: {
  rawFamilyCharacters: unknown;
  sanitizedCount: number;
  declaredIds: readonly string[];
}): FamilyCharacterIdentityAlignment {
  const entries = rawEntries(params.rawFamilyCharacters);
  if (entries === null) return mismatch;

  const ids: string[] = [];
  for (const entry of entries.slice(0, FAMILY_CHARACTER_MAX_COUNT)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return mismatch;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || !FAMILY_CHARACTER_ID_RE.test(id)) return mismatch;
    if (ids.includes(id)) return mismatch;
    ids.push(id);
  }

  if (ids.length !== params.sanitizedCount) return mismatch;
  if (ids.length !== params.declaredIds.length) return mismatch;
  if (ids.some((id, index) => id !== params.declaredIds[index])) return mismatch;

  return { ok: true, ids };
}

/**
 * The indexes of the supporting characters that own private media.
 *
 * Derived from each character's OWN id rather than from a lookup into the
 * client's declared array, so a bound id that names nobody contributes no
 * index instead of collapsing to `indexOf`'s -1.
 */
export function supportingPhotoIndexesForAlignment(
  ids: readonly string[],
  boundFamilyCharacterIds: Iterable<string>,
): Set<number> {
  const bound = new Set(boundFamilyCharacterIds);
  const indexes = new Set<number>();
  ids.forEach((id, index) => {
    if (bound.has(id)) indexes.add(index);
  });
  return indexes;
}
