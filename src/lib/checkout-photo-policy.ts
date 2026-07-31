import type { FamilyCharacter } from './orders.ts';

export function clearUntrustedSupportingPhotoMetadata(
  characters: FamilyCharacter[],
): FamilyCharacter[] {
  return characters.map((character) => ({
    ...character,
    photoFileName: null,
    photoBlobPath: null,
    photoBlobUrl: null,
    likenessIntent: 'storybook',
  }));
}

function characterLabel(character: FamilyCharacter): string {
  return (character.name || character.relationshipLabel || character.role || 'family member').trim();
}

function isHumanSupportingCharacter(character: FamilyCharacter): boolean {
  return character.role !== 'pet';
}

export function missingSupportingCharacterDescriptionLabels(
  characters: FamilyCharacter[],
  actualPhotoIndexes: ReadonlySet<number>,
): string[] {
  return characters
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => character.appearsInStory !== false)
    .filter(({ character }) => isHumanSupportingCharacter(character))
    .filter(({ character, index }) => !actualPhotoIndexes.has(index) && !character.notes.trim())
    .map(({ character }) => characterLabel(character));
}
