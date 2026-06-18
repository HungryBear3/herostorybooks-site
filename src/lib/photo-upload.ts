export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const TARGET_PHOTO_BYTES = Math.floor(MAX_PHOTO_BYTES * 0.82);
const MAX_RESIZE_DIMENSION = 1600;
const MIN_JPEG_QUALITY = 0.55;
const INITIAL_JPEG_QUALITY = 0.86;
const RESIZABLE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const RESIZABLE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
export const ALLOWED_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
export const ALLOWED_PHOTO_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
export const UNSUPPORTED_STILL_PHOTO_MESSAGE =
  'That file is not a supported still photo. Please upload JPG, PNG, WebP, or HEIC.';

export type BasicPhotoFile = {
  name: string;
  size: number;
  type: string;
};

export function getPhotoExtension(fileName: string) {
  return fileName.split('.').pop()?.trim().toLowerCase() ?? '';
}

export function isHeicLikePhoto(file: BasicPhotoFile) {
  const extension = getPhotoExtension(file.name);
  const mimeType = file.type.toLowerCase();
  return mimeType === 'image/heic' || mimeType === 'image/heif' || extension === 'heic' || extension === 'heif';
}

export function isBrowserResizablePhoto(file: BasicPhotoFile) {
  const extension = getPhotoExtension(file.name);
  const mimeType = file.type.toLowerCase();
  return RESIZABLE_MIME_TYPES.has(mimeType) || RESIZABLE_EXTENSIONS.has(extension);
}

export function validateStillPhotoMetadata(file: BasicPhotoFile):
  | { ok: true }
  | { ok: false; error: string } {
  const extension = getPhotoExtension(file.name);
  const mimeType = file.type.trim().toLowerCase();
  const acceptedExtension = ALLOWED_PHOTO_EXTENSIONS.includes(extension);
  const acceptedMime = ALLOWED_PHOTO_MIME_TYPES.has(mimeType);

  if (!acceptedExtension || !acceptedMime) {
    return { ok: false, error: UNSUPPORTED_STILL_PHOTO_MESSAGE };
  }

  return { ok: true };
}

export function shouldAutoShrinkPhoto(file: BasicPhotoFile, maxBytes = MAX_PHOTO_BYTES) {
  return file.size > maxBytes && isBrowserResizablePhoto(file) && !isHeicLikePhoto(file);
}

function formatMb(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildAutoShrinkNotice(originalBytes: number, resizedBytes: number) {
  return `Large photo detected — we reduced it automatically from ${formatMb(originalBytes)} to ${formatMb(resizedBytes)} so checkout can continue.`;
}

function targetMimeType(file: File) {
  const mimeType = file.type.toLowerCase();
  if (mimeType === 'image/png') return 'image/jpeg';
  if (mimeType === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

async function fileToImageBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function scaledDimensions(width: number, height: number, maxDimension: number) {
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height };
  }

  if (width >= height) {
    const ratio = maxDimension / width;
    return { width: maxDimension, height: Math.max(1, Math.round(height * ratio)) };
  }

  const ratio = maxDimension / height;
  return { width: Math.max(1, Math.round(width * ratio)), height: maxDimension };
}

async function canvasToFile(canvas: HTMLCanvasElement, type: string, quality: number, originalName: string) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) {
    throw new Error('Photo compression failed');
  }

  const baseName = originalName.replace(/\.[^.]+$/, '') || 'photo';
  const extension = type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], `${baseName}.${extension}`, { type, lastModified: Date.now() });
}

async function shrinkPhotoToTargetBytes(file: File, targetBytes: number, maxBytes = MAX_PHOTO_BYTES): Promise<File> {
  const decoded = await fileToImageBitmap(file);
  const width = 'naturalWidth' in decoded ? decoded.naturalWidth : decoded.width;
  const height = 'naturalHeight' in decoded ? decoded.naturalHeight : decoded.height;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas unavailable for photo resize');
  }

  let currentMaxDimension = MAX_RESIZE_DIMENSION;
  let currentQuality = INITIAL_JPEG_QUALITY;
  let best: File | null = null;
  const outputType = targetMimeType(file);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { width: nextWidth, height: nextHeight } = scaledDimensions(width, height, currentMaxDimension);
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    context.clearRect(0, 0, nextWidth, nextHeight);
    context.drawImage(decoded as CanvasImageSource, 0, 0, nextWidth, nextHeight);

    const candidate = await canvasToFile(canvas, outputType, currentQuality, file.name);
    if (!best || candidate.size < best.size) best = candidate;
    if (candidate.size <= targetBytes || candidate.size <= maxBytes) return candidate;

    currentQuality = Math.max(MIN_JPEG_QUALITY, currentQuality - 0.08);
    currentMaxDimension = Math.max(900, Math.round(currentMaxDimension * 0.85));
  }

  if (best && best.size <= maxBytes) return best;
  throw new Error('Photo still too large after resize');
}

export async function shrinkPhotoForUpload(file: File, maxBytes = MAX_PHOTO_BYTES) {
  if (!shouldAutoShrinkPhoto(file, maxBytes)) {
    return file;
  }
  const targetBytes = Math.min(TARGET_PHOTO_BYTES, Math.floor(maxBytes * 0.82));
  return shrinkPhotoToTargetBytes(file, targetBytes, maxBytes);
}

/**
 * Compress resizable photos so their combined size fits within budgetBytes.
 * Non-resizable photos (HEIC) are returned unchanged — caller should check
 * whether the budget was actually met after this returns.
 */
export async function compressPhotosForBudget(
  photos: File[],
  budgetBytes: number,
): Promise<File[]> {
  if (photos.length === 0) return photos;

  const resizable = photos.filter((f) => isBrowserResizablePhoto(f) && !isHeicLikePhoto(f));
  const nonResizable = photos.filter((f) => !isBrowserResizablePhoto(f) || isHeicLikePhoto(f));

  const nonResizableTotal = nonResizable.reduce((sum, f) => sum + f.size, 0);
  const remainingBudget = budgetBytes - nonResizableTotal;
  if (remainingBudget <= 0 || resizable.length === 0) return photos;

  // Distribute budget proportionally by current size, floor at 150 KB per photo.
  const currentResizableTotal = resizable.reduce((sum, f) => sum + f.size, 0);
  const compressed = await Promise.all(
    resizable.map((f) => {
      const share = Math.max(150 * 1024, Math.floor((f.size / currentResizableTotal) * remainingBudget));
      return f.size <= share ? Promise.resolve(f) : shrinkPhotoToTargetBytes(f, share, share);
    }),
  );

  // Rebuild the original order
  const resizableIter = compressed[Symbol.iterator]();
  const nonResizableIter = nonResizable[Symbol.iterator]();
  return photos.map((f) =>
    isBrowserResizablePhoto(f) && !isHeicLikePhoto(f)
      ? resizableIter.next().value
      : nonResizableIter.next().value,
  );
}
