export type SupportingCharacterKind = 'human' | 'pet' | 'unknown';

export interface SupportingCharacterInput {
  id?: string;
  name?: string;
  relationship?: string;
  role?: string;
  kind?: string;
  species?: string;
  referencePhotoUrl?: string | null;
  referencePhotoBlobUrl?: string | null;
  photoBlobUrl?: string | null;
  photoUrl?: string | null;
}

export interface SupportingCharacter {
  id: string;
  name: string;
  relationship: string;
  role: string;
  kind: SupportingCharacterKind;
  species: string;
  hasReferencePhoto: boolean;
}

export interface SupportingCharacterValidationResult {
  ok: boolean;
  supportingCharacters: SupportingCharacter[];
  missingHumanPhotoCharacters: SupportingCharacter[];
  status?: 400;
  code?: string;
  error?: string;
}

const HUMAN_RELATION_RE = /\b(mom|mother|mama|mum|dad|father|daddy|papa|parent|grandma|grandmother|nana|grandpa|grandfather|sibling|sister|brother|aunt|uncle|cousin|friend|teacher|coach|person|kid|child|boy|girl|man|woman)\b/i;
const PET_RELATION_RE = /\b(pet|dog|cat|puppy|kitten|hamster|rabbit|bunny|horse|pony|bird|parrot|fish|turtle|lizard|dragon)\b/i;

function safeString(value: unknown, max = 80): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function stableId(input: SupportingCharacterInput, index: number): string {
  const raw = safeString(input.id || input.name || input.relationship || `character-${index + 1}`, 48)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || `character-${index + 1}`;
}

export function classifySupportingCharacterKind(input: SupportingCharacterInput): SupportingCharacterKind {
  const explicit = safeString(input.kind || input.role, 32).toLowerCase();
  if (['human', 'person', 'adult', 'child', 'friend', 'family'].includes(explicit)) return 'human';
  if (['pet', 'animal'].includes(explicit)) return 'pet';

  const species = safeString(input.species, 40);
  const text = [input.name, input.relationship, input.role, input.kind, species].map((v) => safeString(v, 80)).join(' ');
  if (species || PET_RELATION_RE.test(text)) return 'pet';
  if (HUMAN_RELATION_RE.test(text)) return 'human';
  return 'unknown';
}

export function parseSupportingCharacters(raw: FormDataEntryValue | null): SupportingCharacter[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.slice(0, 8).map((item, index) => {
    const input = (item && typeof item === 'object' ? item : {}) as SupportingCharacterInput;
    const kind = classifySupportingCharacterKind(input);
    const name = safeString(input.name, 60);
    const relationship = safeString(input.relationship, 60);
    const role = safeString(input.role, 60);
    const species = safeString(input.species, 40);
    const hasReferencePhoto = Boolean(
      safeString(input.referencePhotoUrl, 300) ||
      safeString(input.referencePhotoBlobUrl, 300) ||
      safeString(input.photoBlobUrl, 300) ||
      safeString(input.photoUrl, 300),
    );
    return {
      id: stableId(input, index),
      name,
      relationship,
      role,
      kind,
      species,
      hasReferencePhoto,
    };
  }).filter((character) => character.name || character.relationship || character.role || character.species);
}

export function validateSupportingCharactersForCheckout(
  raw: FormDataEntryValue | null,
): SupportingCharacterValidationResult {
  const supportingCharacters = parseSupportingCharacters(raw);
  const missingHumanPhotoCharacters = supportingCharacters.filter(
    (character) => character.kind === 'human' && !character.hasReferencePhoto,
  );

  if (missingHumanPhotoCharacters.length > 0) {
    const names = missingHumanPhotoCharacters
      .map((character) => character.name || character.relationship || character.role || 'supporting character')
      .join(', ');
    return {
      ok: false,
      supportingCharacters,
      missingHumanPhotoCharacters,
      status: 400,
      code: 'supporting_character_photo_required',
      error: `Please add a reference photo for human supporting character${missingHumanPhotoCharacters.length === 1 ? '' : 's'} before payment: ${names}.`,
    };
  }

  return { ok: true, supportingCharacters, missingHumanPhotoCharacters: [] };
}
