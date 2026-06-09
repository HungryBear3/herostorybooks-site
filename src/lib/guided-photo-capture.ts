export const GUIDED_PHOTO_CAPTURE_VERSION = 'guided-photo-capture-mvp-v1';

export const GUIDED_PHOTO_CONSENT_COPY =
  'This guided photo capture takes a few ordinary reference photos to help us illustrate your child more consistently. It is not a face scan, biometric scan, or Face ID. You can delete any photo before submitting.';

export const GUIDED_PHOTO_STILL_ONLY_COPY =
  'We only upload the still photos you approve — never video. These are temporary reference photos for your book, never used to train AI, and deleted after book delivery plus 30 days unless needed for support or legal record-keeping. Want them removed sooner? Email support@herostorybooks.com.';

export const GUIDED_CAMERA_TRUST_BADGES = [
  'Still photos only',
  'Parent-approved',
  'Never video',
] as const;

export const GUIDED_FACE_GUIDE_CLASS_NAME =
  'pointer-events-none absolute left-1/2 top-1/2 h-[72%] w-[52%] max-w-[16rem] -translate-x-1/2 -translate-y-1/2 rounded-[48%] border-2 border-white/80 shadow-[0_0_0_9999px_rgba(31,26,22,0.16)]';

export const GUIDED_PHOTO_LABELS = [
  'front',
  'left',
  'right',
  'up',
  'smile',
] as const;

export type GuidedPhotoLabel = (typeof GUIDED_PHOTO_LABELS)[number];

export interface GuidedPhotoPrompt {
  label: GuidedPhotoLabel;
  title: string;
  instruction: string;
}

export const GUIDED_PHOTO_PROMPTS: GuidedPhotoPrompt[] = [
  { label: 'front', title: 'Look straight', instruction: 'Face the camera with soft, even light.' },
  { label: 'left', title: 'Turn slightly left', instruction: 'Keep the face visible; no profile-only shot.' },
  { label: 'right', title: 'Turn slightly right', instruction: 'Match the same distance and lighting.' },
  { label: 'up', title: 'Tilt slightly up', instruction: 'A tiny upward angle helps the illustrator keep shape consistent.' },
  { label: 'smile', title: 'Smile', instruction: 'One natural expression for warmer storybook pages.' },
];

export function getNextGuidedPromptIndex(frames: Array<{ label?: unknown }> | null | undefined): number {
  const capturedLabels = new Set(
    (Array.isArray(frames) ? frames : [])
      .map((frame) => sanitizeGuidedPhotoLabel(frame?.label))
      .filter(Boolean),
  );
  const nextIndex = GUIDED_PHOTO_PROMPTS.findIndex((prompt) => !capturedLabels.has(prompt.label));
  return nextIndex >= 0 ? nextIndex : Math.max(0, GUIDED_PHOTO_PROMPTS.length - 1);
}

export interface GuidedPhotoFile {
  label: GuidedPhotoLabel | string;
  file: File;
  dataUrl: string;
}

export interface GuidedReferencePhotoRecord {
  label: GuidedPhotoLabel | string;
  fileName: string;
  photoBlobPath: string | null;
  photoBlobUrl: string | null;
  source: 'guided_capture';
  consentAt: string;
}

// ── Capture/upload guardrails ────────────────────────────────────────────────
// Still images only — NEVER video. Mobile cameras commonly emit HEIC/HEIF, so
// those are allowed alongside the web-standard still formats.
export const ACCEPTED_GUIDED_PHOTO_MIME = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;
export const MAX_GUIDED_PHOTOS = 8;
export const MAX_GUIDED_PHOTO_BYTES = 12 * 1024 * 1024; // 12 MB per still
export const MAX_GUIDED_PHOTOS_TOTAL_BYTES = 48 * 1024 * 1024; // 48 MB combined

export function isGuidedPhotoCaptureEnabled(envValue = process.env.NEXT_PUBLIC_HSB_GUIDED_PHOTO_CAPTURE) {
  return envValue === 'true';
}

// getUserMedia constraints for guided capture: front camera, AUDIO OFF (we never
// record sound) — and we only ever capture still frames to canvas, never video.
export const GUIDED_CAPTURE_MEDIA_CONSTRAINTS = {
  video: { facingMode: 'user' as const },
  audio: false as const,
};

/** Camera may only start after explicit parent/guardian consent. */
export function canStartGuidedCamera(consent: boolean): boolean {
  return consent === true;
}

/** Stop every track on a MediaStream (idempotent, null-safe). Call on
 *  finish / cancel / unmount / error / navigation so the camera light goes off. */
export function stopMediaTracks(
  stream: { getTracks?: () => Array<{ stop: () => void }> } | null | undefined,
): number {
  if (!stream || typeof stream.getTracks !== 'function') return 0;
  let stopped = 0;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
      stopped += 1;
    } catch {
      /* a track that's already stopped is fine */
    }
  }
  return stopped;
}

export interface GuidedCaptureAppendable {
  label: GuidedPhotoLabel | string;
  file: File;
}

interface FormDataLikeAppend {
  append(name: string, value: string | Blob, fileName?: string): void;
}

/**
 * Append approved guided STILL frames to the checkout FormData as
 * guidedPhoto_0..N plus consent/version/labels metadata. Only still image files
 * are appended — there is no code path that appends video. Returns the count
 * appended (0 when there are no frames). Rebuilt from current frames on every
 * submit, so a deleted/retaken frame simply isn't in the array and isn't sent.
 */
export function appendGuidedCaptureToFormData(
  formData: FormDataLikeAppend,
  frames: GuidedCaptureAppendable[],
): number {
  if (!Array.isArray(frames) || frames.length === 0) return 0;
  const labels: string[] = [];
  let count = 0;
  for (const frame of frames.slice(0, MAX_GUIDED_PHOTOS)) {
    if (!frame?.file) continue;
    formData.append(`guidedPhoto_${count}`, frame.file, frame.file.name);
    labels.push(sanitizeGuidedPhotoLabel(frame.label));
    count += 1;
  }
  if (count === 0) return 0;
  formData.append('guidedPhotoConsent', 'true');
  formData.append('guidedPhotoCaptureVersion', GUIDED_PHOTO_CAPTURE_VERSION);
  formData.append('guidedPhotoLabels', JSON.stringify(labels));
  return count;
}

/**
 * Still-image-only MIME guard. Returns true ONLY for the accepted still photo
 * types; rejects video/* and everything else by construction.
 */
export function isAcceptedGuidedPhotoFile(file: { type?: string; name?: string } | null | undefined): boolean {
  if (!file) return false;
  const type = String(file.type ?? '').toLowerCase().trim();
  if (type.startsWith('video/')) return false;
  return (ACCEPTED_GUIDED_PHOTO_MIME as readonly string[]).includes(type);
}

export function sanitizeGuidedPhotoLabel(value: unknown): string {
  const cleaned = String(value ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32);
  return cleaned || 'reference';
}

export function buildGuidedPhotoFileName(label: string, index: number, extension = 'jpg') {
  const safeLabel = sanitizeGuidedPhotoLabel(label);
  const safeIndex = Number.isInteger(index) && index >= 0 ? index + 1 : 1;
  const safeExt = extension.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'jpg';
  return `guided-${safeIndex}-${safeLabel}.${safeExt}`;
}

export function parseGuidedPhotoLabels(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.slice(0, MAX_GUIDED_PHOTOS).map(sanitizeGuidedPhotoLabel);
    }
  } catch {
    return [];
  }
  return [];
}

// ── Server-side collection orchestrator (dep-injected; Stripe-free) ───────────
//
// The order route calls this BEFORE creating a Stripe Checkout Session. On any
// non-ok result the route returns the response and never creates a session, so
// a guided-photo MIME/size/persistence failure cannot charge the customer.

export interface GuidedPhotoFormLike {
  get(name: string): FormDataEntryValue | null;
}

export interface GuidedPhotoUploadRef {
  pathname: string;
  url: string;
}

export interface CollectGuidedPhotosDeps {
  /** Persist one still to durable storage. Must throw on production persistence
   *  failure so we abort before Stripe (mirrors uploadOrderPhoto). */
  upload: (orderId: string, index: number, file: File) => Promise<GuidedPhotoUploadRef | null>;
  now?: () => Date;
}

// Single-shape result (not a discriminated union): this codebase compiles with
// tsconfig "strict": false, under which `!result.ok` does not narrow a true/false
// discriminant. `ok === false` carries status/code/error; records is always present.
export interface CollectGuidedPhotosResult {
  ok: boolean;
  records: GuidedReferencePhotoRecord[];
  status?: 400 | 413 | 503;
  code?: string;
  error?: string;
}

export async function collectGuidedReferencePhotos(
  form: GuidedPhotoFormLike,
  orderId: string,
  deps: CollectGuidedPhotosDeps,
): Promise<CollectGuidedPhotosResult> {
  const files: Array<{ index: number; file: File }> = [];
  for (let i = 0; i < MAX_GUIDED_PHOTOS; i += 1) {
    const v = form.get(`guidedPhoto_${i}`);
    if (v instanceof File && v.size > 0) files.push({ index: i, file: v });
  }
  if (files.length === 0) return { ok: true, records: [] };

  const consentRaw = String(form.get('guidedPhotoConsent') ?? '').trim().toLowerCase();
  const consentGiven = consentRaw === 'true' || consentRaw === 'on' || consentRaw === '1';
  if (!consentGiven) {
    return {
      ok: false,
      records: [],
      status: 400,
      code: 'guided_photo_consent_required',
      error: 'Parent/guardian consent is required to attach guided reference photos.',
    };
  }

  // Still-images-only + size guards, BEFORE any upload or Stripe call.
  let combined = 0;
  for (const { file } of files) {
    if (!isAcceptedGuidedPhotoFile(file)) {
      return {
      ok: false,
      records: [],
      status: 400,
      code: 'guided_photo_invalid_type',
        error: 'Guided reference photos must be still images (JPEG, PNG, WebP, or HEIC) — never video. No charge was made.',
      };
    }
    if (file.size > MAX_GUIDED_PHOTO_BYTES) {
      return {
      ok: false,
      records: [],
      status: 413,
      code: 'guided_photo_too_large',
        error: 'One of your reference photos is too large. Please use smaller still photos and try again — no charge was made.',
      };
    }
    combined += file.size;
  }
  if (combined > MAX_GUIDED_PHOTOS_TOTAL_BYTES) {
    return {
      ok: false,
      records: [],
      status: 413,
      code: 'guided_photo_too_large',
      error: 'Your reference photos are too large together. Please remove a few and try again — no charge was made.',
    };
  }

  const labels = parseGuidedPhotoLabels(form.get('guidedPhotoLabels'));
  const consentAt = (deps.now ?? (() => new Date()))().toISOString();
  const records: GuidedReferencePhotoRecord[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const { index, file } = files[i]!;
    const label = labels[i] ?? sanitizeGuidedPhotoLabel(GUIDED_PHOTO_LABELS[i] ?? 'reference');
    let uploaded: GuidedPhotoUploadRef | null = null;
    try {
      uploaded = await deps.upload(orderId, index, file);
    } catch {
      // Persistence failed durably — abort BEFORE Stripe; the customer is not charged.
      return {
      ok: false,
      records: [],
      status: 503,
      code: 'guided_photo_persist_failed',
        error:
          'We could not securely save your guided reference photos, so we stopped before payment. No charge was made — please try again.',
      };
    }
    records.push({
      label,
      fileName: file.name || buildGuidedPhotoFileName(label, index),
      photoBlobPath: uploaded?.pathname ?? null,
      photoBlobUrl: uploaded?.url ?? null,
      source: 'guided_capture',
      consentAt,
    });
  }

  return { ok: true, records };
}
