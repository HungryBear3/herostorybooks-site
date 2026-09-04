/**
 * The ONE MIME contract behind checkout media.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-09-04 the browser and the server each kept their own idea of
 * which media types checkout accepts: the story-attachment classifier passed
 * the browser's raw `File.type` through, and `INTAKE_CATEGORY_POLICY` judged
 * that string by exact match against a private list. Safari reports an iPhone
 * Voice Memo (`.m4a`) as `audio/x-m4a`; the classifier accepted it, the server
 * refused it as `asset_mime_invalid`, and a buyer who had already uploaded four
 * photos was stopped at the payment button with a bare error code.
 *
 * This module is imported by BOTH sides. It is deliberately browser-safe — no
 * `node:` imports, no SDKs — so the checkout page can compute the exact string
 * the server will accept BEFORE it reserves, and the server can re-derive the
 * same string before it judges. A parity test pins the two together.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never widens the policy. `image/*`, arbitrary values, and unspecified
 * photo types are refusals, not passes. HEIC/HEIF are not accepted: nothing
 * downstream is proven to decode them, and advertising them would be a lie.
 * Extension fallback exists only for the audio/document lanes, where the
 * product already accepted it; a photo with no reported type is refused.
 */

export type MediaAssetClass = 'photo' | 'audio' | 'document';

export type MediaIntakeCategory =
  | 'primary_hero_photo'
  | 'family_pet_reference'
  | 'guided_still'
  | 'voice_inspiration'
  | 'document_inspiration';

/** Still photos only. Aligned with what the deployed image runtime decodes. */
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const AUDIO_MIME_TYPES = [
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg',
  'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/x-caf', 'audio/aiff',
] as const;

export const DOCUMENT_MIME_TYPES = [
  'text/plain', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/**
 * Browser-reported strings that name a format we already accept under
 * another spelling. Keyed by the normalized (lowercased, parameter-free)
 * browser value; the value is the canonical string that is stored, reserved,
 * uploaded, and compared everywhere downstream.
 */
export const MEDIA_MIME_ALIASES: Readonly<Record<string, string>> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/x-aiff': 'audio/aiff',
  'image/jpg': 'image/jpeg',
};

/** Extension → canonical MIME for the audio lane's empty-type fallback. */
export const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  caf: 'audio/x-caf',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

/** Extension → canonical MIME for the document lane's empty-type fallback. */
export const DOCUMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const CATEGORY_CLASS: Readonly<Record<MediaIntakeCategory, MediaAssetClass>> = {
  primary_hero_photo: 'photo',
  family_pet_reference: 'photo',
  guided_still: 'photo',
  voice_inspiration: 'audio',
  document_inspiration: 'document',
};

export function mediaClassForCategory(category: MediaIntakeCategory): MediaAssetClass {
  const assetClass = CATEGORY_CLASS[category];
  if (!assetClass) throw new Error(`unknown media category: ${String(category)}`);
  return assetClass;
}

export function allowedMimeTypesFor(assetClass: MediaAssetClass): readonly string[] {
  if (assetClass === 'photo') return PHOTO_MIME_TYPES;
  if (assetClass === 'audio') return AUDIO_MIME_TYPES;
  return DOCUMENT_MIME_TYPES;
}

/** `"  Audio/WebM;codecs=opus "` → `"audio/webm"`. Non-strings → `""`. */
export function normalizeMimeToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.split(';', 1)[0]!.trim().toLowerCase();
}

export function fileExtension(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return /\.([^.]+)$/.exec(trimmed)?.[1]?.toLowerCase() ?? null;
}

/**
 * The server-side judgement: normalize, resolve a known alias, and accept only
 * an allowlisted canonical string. No extension fallback — by the time a value
 * reaches the server it must already be a MIME type, not a filename.
 */
export function canonicalAllowlistedMime(raw: unknown, assetClass: MediaAssetClass): string | null {
  const normalized = normalizeMimeToken(raw);
  if (!normalized) return null;
  const canonical = MEDIA_MIME_ALIASES[normalized] ?? normalized;
  return allowedMimeTypesFor(assetClass).includes(canonical) ? canonical : null;
}

export type MediaMimeResolution =
  | { ok: true; mimeType: string }
  | { ok: false; reason: 'unspecified' | 'unsupported' };

/**
 * The client-side judgement for a selected file: the exact string that will be
 * reserved, uploaded, stored, and compared. Unspecified audio/document types
 * may be derived from a recognized extension; an unspecified photo type is a
 * refusal because nothing downstream can safely guess an image format.
 */
export function canonicalMediaMime(
  file: { type?: string | null; name?: string | null },
  assetClass: MediaAssetClass,
): MediaMimeResolution {
  const normalized = normalizeMimeToken(file.type);
  const unspecified = normalized === '' || normalized === 'application/octet-stream';
  if (unspecified) {
    if (assetClass === 'photo') return { ok: false, reason: 'unspecified' };
    const extension = fileExtension(file.name);
    const byExtension = assetClass === 'audio' ? AUDIO_MIME_BY_EXTENSION : DOCUMENT_MIME_BY_EXTENSION;
    const derived = extension ? byExtension[extension] : undefined;
    return derived ? { ok: true, mimeType: derived } : { ok: false, reason: 'unspecified' };
  }
  const canonical = canonicalAllowlistedMime(normalized, assetClass);
  return canonical ? { ok: true, mimeType: canonical } : { ok: false, reason: 'unsupported' };
}
