/**
 * Magic-byte image type detection for the Family Review lane.
 *
 * Extracted from the parent upload route so BOTH upload paths use it.
 * The admin sample upload previously trusted the client-declared
 * `File.type` with no byte-level check, which made the admin path the
 * weaker of the two — a file could claim `image/png` and carry anything.
 *
 * The declared type is only ever ACCEPTED when the bytes agree with it.
 * Sniffing never reads File.name; original filenames still never leave
 * the parent's device.
 */

export interface ResolvedImageType {
  mime: string;
  ext: string;
}

/** The only types this lane stores. */
export const ALLOWED_IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/**
 * Collapse declared types onto the single mime the sniffer reports for
 * that family, so an equivalent spelling is not mistaken for a spoof:
 *
 *   image/jpg  → image/jpeg   (two spellings of one format)
 *   image/heif → image/heic   (one ISOBMFF container; the sniffer
 *                              reports every ftyp brand as image/heic)
 *
 * Exported because the asset migration compares a record's RECORDED mime
 * against the type sniffed from the source bytes, and must apply exactly
 * the same equivalence the upload path does.
 */
export function canonicalImageMime(mime: string): string {
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'image/heif') return 'image/heic';
  return mime;
}

/**
 * Identify an image purely from its leading bytes. Returns null when the
 * bytes match no supported format.
 */
export function sniffImageType(header: Uint8Array): ResolvedImageType | null {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  const brand = String.fromCharCode(...Array.from(header.slice(4, 12)));
  if (/ftyp(heic|heix|hevc|heif|mif1)/i.test(brand)) {
    return { mime: 'image/heic', ext: 'heic' };
  }
  return null;
}

/**
 * Resolve the type to store for an uploaded file.
 *
 * The BYTES are authoritative. A declared type is honored only when the
 * sniffed type agrees with it; a declared type that contradicts the
 * bytes is rejected outright rather than quietly overridden, so a
 * content-type spoof is a hard failure instead of a silent relabel.
 *
 * A blank or nonstandard declared type (common from mobile cameras) is
 * fine — the sniffed type is used.
 */
export async function resolveUploadImageType(
  file: File,
): Promise<ResolvedImageType | null> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const sniffed = sniffImageType(header);
  if (!sniffed) return null;

  const declaredExt = ALLOWED_IMAGE_MIME[file.type];
  if (!declaredExt) {
    // No usable declaration — trust the bytes.
    return sniffed;
  }
  if (canonicalImageMime(file.type) !== sniffed.mime) {
    // Declared type contradicts the bytes: content-type spoof.
    return null;
  }
  return sniffed;
}
