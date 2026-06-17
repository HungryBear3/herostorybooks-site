import type { FamilyCharacter } from '@/lib/orders';

/**
 * Friends/family checkout invariant (ported from hotfix 6880bb4):
 * every HUMAN supporting character that appears in the story must have a
 * still reference photo before Stripe. Pets remain optional.
 *
 * A character satisfies the requirement when EITHER:
 *   - a still photo for its slot was uploaded in the current request
 *     (`familyCharacterPhoto_${index}`), OR
 *   - it already carries persisted photo metadata (single-photo fields or a
 *     populated `referencePhotos` array from the split asset-intake flow).
 *
 * This module is pure (its only import is a type, erased at runtime) so it can
 * be unit-tested directly and reused by the order route without pulling in the
 * blob/Stripe dependency chain.
 */

export const SUPPORTING_CHARACTER_PHOTO_REQUIRED_CODE = 'supporting_character_photo_required';

export function familyCharacterLabel(character: FamilyCharacter): string {
  return (character.name || character.relationshipLabel || character.role || 'family member').trim();
}

export function isHumanSupportingCharacter(character: FamilyCharacter): boolean {
  return character.role !== 'pet';
}

function hasPersistedReferencePhoto(character: FamilyCharacter): boolean {
  if (character.photoFileName || character.photoBlobPath || character.photoBlobUrl) return true;
  const refs = character.referencePhotos;
  if (Array.isArray(refs)) {
    return refs.some((ref) => Boolean(ref?.photoBlobPath || ref?.photoBlobUrl || ref?.fileName));
  }
  return false;
}

/**
 * Returns the buyer-facing labels of every human supporting character that
 * appears in the story but is still missing a still reference photo. Empty
 * array => the invariant is satisfied and checkout may proceed.
 *
 * @param hasUploadedPhoto predicate that reports whether a still photo file was
 *   uploaded for the character at the given index in the current request.
 */
export function missingSupportingCharacterPhotoLabels(
  familyCharacters: FamilyCharacter[],
  hasUploadedPhoto: (index: number) => boolean,
): string[] {
  return familyCharacters
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => character.appearsInStory !== false)
    .filter(({ character }) => isHumanSupportingCharacter(character))
    .filter(({ character, index }) => !hasPersistedReferencePhoto(character) && !hasUploadedPhoto(index))
    .map(({ character }) => familyCharacterLabel(character));
}

export function buildSupportingCharacterPhotoError(missingLabels: string[]): {
  error: string;
  code: typeof SUPPORTING_CHARACTER_PHOTO_REQUIRED_CODE;
} {
  return {
    error: `Add a still reference photo for ${missingLabels.join(', ')} before payment. No charge was made.`,
    code: SUPPORTING_CHARACTER_PHOTO_REQUIRED_CODE,
  };
}
