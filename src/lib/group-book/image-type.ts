import sharp from 'sharp';

export interface GroupBookImageType {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
  ext: 'jpg' | 'png' | 'webp' | 'heic';
}

// Decode limits follow src/lib/photo-file-validation.ts. That validator is not
// imported because its contract rejects an empty or octet-stream declared type,
// which this intake has always accepted when the bytes themselves identify the
// format.
export const MAX_GROUP_BOOK_PHOTO_PIXELS = 40_000_000;
export const MAX_GROUP_BOOK_PHOTO_DIMENSION = 12_000;
export const NORMALIZED_GROUP_BOOK_PHOTO_DIMENSION = 4_096;

export type NormalizedGroupBookImage =
  | { ok: true; bytes: Buffer; mime: 'image/jpeg'; ext: 'jpg'; width: number; height: number }
  | { ok: false; error: 'unsupported_image' | 'invalid_image' };

export function sniffGroupBookImage(header: Uint8Array): GroupBookImageType | null {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 &&
    header[3] === 0x46 && header[8] === 0x57 && header[9] === 0x45 &&
    header[10] === 0x42 && header[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  const brand = String.fromCharCode(...Array.from(header.slice(4, 12)));
  if (/ftyp(heic|heix|hevc|heif|mif1)/i.test(brand)) {
    return { mime: 'image/heic', ext: 'heic' };
  }
  return null;
}

export async function resolveGroupBookImage(file: File): Promise<GroupBookImageType | null> {
  const sniffed = sniffGroupBookImage(
    new Uint8Array(await file.slice(0, 16).arrayBuffer()),
  );
  if (!sniffed) return null;
  const declared = file.type === 'image/jpg' ? 'image/jpeg' :
    file.type === 'image/heif' ? 'image/heic' : file.type;
  if (declared && declared !== 'application/octet-stream' && declared !== sniffed.mime) {
    return null;
  }
  return sniffed;
}

function decodedMime(format: string | undefined): GroupBookImageType['mime'] | null {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return null;
}

/**
 * Server-side decode and re-encode of one uploaded photo. Only the returned
 * canonical JPEG bytes may be persisted: EXIF and every other metadata block,
 * trailing/polyglot payloads and extra animation frames do not survive.
 *
 * HEIC is refused here. Server-side HEIC decoding depends on the deployed
 * libvips build and has not been qualified; browsers that can decode HEIC
 * convert it to JPEG before upload.
 */
export async function normalizeGroupBookImage(file: File): Promise<NormalizedGroupBookImage> {
  const type = await resolveGroupBookImage(file);
  if (!type || type.mime === 'image/heic') return { ok: false, error: 'unsupported_image' };

  try {
    const sourceBytes = Buffer.from(await file.arrayBuffer());
    const metadata = await sharp(sourceBytes, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_GROUP_BOOK_PHOTO_PIXELS,
    }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (decodedMime(metadata.format) !== type.mime) return { ok: false, error: 'unsupported_image' };
    if (
      width <= 0 ||
      height <= 0 ||
      width > MAX_GROUP_BOOK_PHOTO_DIMENSION ||
      height > MAX_GROUP_BOOK_PHOTO_DIMENSION ||
      width * height > MAX_GROUP_BOOK_PHOTO_PIXELS ||
      (metadata.pages ?? 1) !== 1
    ) {
      return { ok: false, error: 'invalid_image' };
    }

    // Full decode with failOn:'error' refuses truncated or corrupt pixel data.
    // Output carries no input metadata because none is requested.
    const bytes = await sharp(sourceBytes, {
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_GROUP_BOOK_PHOTO_PIXELS,
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: NORMALIZED_GROUP_BOOK_PHOTO_DIMENSION,
        height: NORMALIZED_GROUP_BOOK_PHOTO_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();

    // Defense in depth: the canonical output must decode as one metadata-free
    // JPEG frame before it can reach private storage.
    const output = await sharp(bytes, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_GROUP_BOOK_PHOTO_PIXELS,
    }).metadata();
    if (
      output.format !== 'jpeg' ||
      !output.width ||
      !output.height ||
      (output.pages ?? 1) !== 1 ||
      output.exif ||
      output.xmp ||
      output.iptc
    ) {
      return { ok: false, error: 'invalid_image' };
    }

    return { ok: true, bytes, mime: 'image/jpeg', ext: 'jpg', width: output.width, height: output.height };
  } catch {
    return { ok: false, error: 'invalid_image' };
  }
}
