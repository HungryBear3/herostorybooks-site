export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const TARGET_PHOTO_BYTES = Math.floor(MAX_PHOTO_BYTES * 0.82);
const MAX_RESIZE_DIMENSION = 1600;
const MIN_JPEG_QUALITY = 0.55;
const INITIAL_JPEG_QUALITY = 0.86;
const RESIZABLE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const RESIZABLE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
export const ALLOWED_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
export const ALLOWED_PHOTO_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

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

export function shouldAutoShrinkPhoto(file: BasicPhotoFile) {
  return file.size > MAX_PHOTO_BYTES && isBrowserResizablePhoto(file) && !isHeicLikePhoto(file);
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

/**
 * Encode a captured camera still (a canvas frame) into an upload-ready JPG/WebP
 * File, reusing the same resize ceiling, quality ramp, and size budget as the
 * mobile file-upload path. Used by Guided Photo Capture so captured stills go
 * through exactly the same compression as uploaded photos.
 */
export async function canvasFrameToUploadFile(
  source: HTMLCanvasElement,
  { format = 'image/jpeg', baseName = 'guided-frame' }: { format?: 'image/jpeg' | 'image/webp'; baseName?: string } = {},
): Promise<File> {
  const outputType = format === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const srcWidth = source.width;
  const srcHeight = source.height;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas unavailable for frame encode');
  }

  let currentMaxDimension = MAX_RESIZE_DIMENSION;
  let currentQuality = INITIAL_JPEG_QUALITY;
  let best: File | null = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { width, height } = scaledDimensions(srcWidth, srcHeight, currentMaxDimension);
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);

    const candidate = await canvasToFile(canvas, outputType, currentQuality, baseName);
    best = candidate;
    if (candidate.size <= MAX_PHOTO_BYTES) {
      return candidate;
    }
    currentQuality = Math.max(MIN_JPEG_QUALITY, currentQuality - 0.08);
    currentMaxDimension = Math.max(900, Math.round(currentMaxDimension * 0.85));
  }

  if (best && best.size <= MAX_PHOTO_BYTES) {
    return best;
  }
  throw new Error('Captured frame still too large after resize');
}

export async function shrinkPhotoForUpload(file: File) {
  if (!shouldAutoShrinkPhoto(file)) {
    return file;
  }

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

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { width: nextWidth, height: nextHeight } = scaledDimensions(width, height, currentMaxDimension);
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    context.clearRect(0, 0, nextWidth, nextHeight);
    context.drawImage(decoded as CanvasImageSource, 0, 0, nextWidth, nextHeight);

    const candidate = await canvasToFile(canvas, outputType, currentQuality, file.name);
    best = candidate;
    if (candidate.size <= MAX_PHOTO_BYTES) {
      return candidate;
    }

    if (candidate.size <= TARGET_PHOTO_BYTES) {
      return candidate;
    }

    currentQuality = Math.max(MIN_JPEG_QUALITY, currentQuality - 0.08);
    currentMaxDimension = Math.max(900, Math.round(currentMaxDimension * 0.85));
  }

  if (best && best.size <= MAX_PHOTO_BYTES) {
    return best;
  }

  throw new Error('Photo still too large after resize');
}
