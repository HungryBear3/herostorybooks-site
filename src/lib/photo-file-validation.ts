import sharp from 'sharp';

export const MAX_ORDER_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_ORDER_PHOTO_PIXELS = 40_000_000;
export const MAX_ORDER_PHOTO_DIMENSION = 12_000;
export const NORMALIZED_ORDER_PHOTO_DIMENSION = 4_096;

export type ValidatedPhotoFormat = 'jpeg' | 'png' | 'webp';

export interface ValidatedPhotoFile {
  ok: true;
  format: ValidatedPhotoFormat;
  contentType: 'image/jpeg';
  extension: 'jpg';
  width: number;
  height: number;
  normalizedBytes: Buffer;
}

export interface InvalidPhotoFile {
  ok: false;
  code: 'photo_missing' | 'photo_invalid_type' | 'photo_invalid_content' | 'photo_too_large';
}

export type PhotoFileValidation = ValidatedPhotoFile | InvalidPhotoFile;

const ACCEPTED_DECLARED_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

function decodedFormat(sharpFormat: string | undefined): ValidatedPhotoFormat | null {
  if (sharpFormat === 'jpeg') return 'jpeg';
  if (sharpFormat === 'png') return 'png';
  if (sharpFormat === 'webp') return 'webp';
  return null;
}

function declaredTypeMatches(format: ValidatedPhotoFormat, declaredType: string): boolean {
  if (format === 'jpeg') return declaredType === 'image/jpeg' || declaredType === 'image/jpg';
  return declaredType === `image/${format}`;
}

export async function validateOrderPhotoFile(value: unknown): Promise<PhotoFileValidation> {
  if (!(value instanceof File) || value.size <= 0 || typeof value.arrayBuffer !== 'function') {
    return { ok: false, code: 'photo_missing' };
  }
  if (value.size > MAX_ORDER_PHOTO_BYTES) return { ok: false, code: 'photo_too_large' };

  const declaredType = String(value.type || '').trim().toLowerCase();
  if (!ACCEPTED_DECLARED_TYPES.has(declaredType)) {
    return { ok: false, code: 'photo_invalid_type' };
  }

  try {
    const sourceBytes = Buffer.from(await value.arrayBuffer());

    const metadata = await sharp(sourceBytes, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_ORDER_PHOTO_PIXELS,
    }).metadata();
    const format = decodedFormat(metadata.format);
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const pages = metadata.pages ?? 1;

    if (
      !format ||
      !declaredTypeMatches(format, declaredType) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_ORDER_PHOTO_DIMENSION ||
      height > MAX_ORDER_PHOTO_DIMENSION ||
      width * height > MAX_ORDER_PHOTO_PIXELS ||
      pages !== 1
    ) {
      return { ok: false, code: 'photo_invalid_content' };
    }

    // Decode and re-encode every accepted upload. This strips caller-controlled
    // metadata and trailing/polyglot bytes before anything reaches public Blob
    // storage. All persisted order photos have one canonical safe media type.
    const normalizedBytes = await sharp(sourceBytes, {
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_ORDER_PHOTO_PIXELS,
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: NORMALIZED_ORDER_PHOTO_DIMENSION,
        height: NORMALIZED_ORDER_PHOTO_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();

    // Defense in depth: verify the canonical output decodes as one JPEG frame.
    const normalizedMetadata = await sharp(normalizedBytes, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_ORDER_PHOTO_PIXELS,
    }).metadata();
    if (
      normalizedMetadata.format !== 'jpeg' ||
      !normalizedMetadata.width ||
      !normalizedMetadata.height ||
      (normalizedMetadata.pages ?? 1) !== 1
    ) {
      return { ok: false, code: 'photo_invalid_content' };
    }

    return {
      ok: true,
      format,
      contentType: 'image/jpeg',
      extension: 'jpg',
      width: normalizedMetadata.width,
      height: normalizedMetadata.height,
      normalizedBytes,
    };
  } catch {
    return { ok: false, code: 'photo_invalid_content' };
  }
}
