/**
 * Guided Photo Capture — pure logic (MVP, behind NEXT_PUBLIC_HSB_GUIDED_PHOTO_CAPTURE).
 * Source of truth: agent-shared/handoffs/2026-06-03-hsb-guided-photo-capture-spec.md
 *
 * A browser-based, parent-driven flow that captures a few ordinary still
 * reference photos at different angles so the illustrator can render the child
 * more consistently. It is a plain camera-capture helper:
 *   - NOT Face ID, NOT a face scan, NOT biometric, NOT a depth map / 3D model,
 *     NOT identity verification. It never accesses OS biometrics or depth data.
 *   - It only grabs the stills the parent selects; it never records or uploads
 *     video, and nothing is persisted until the parent confirms at submit.
 *
 * DOM/camera side effects live in the React component. This module holds the
 * pure, unit-testable pieces: flag, prompts + labels + filenames, consent copy,
 * a capture-version stamp, the frame-list reducer, the "stills only, never
 * video" upload guarantee, camera-support detection, stream cleanup, label
 * sanitization (shared with the server), and getUserMedia error mapping.
 */

export const GUIDED_PHOTO_CAPTURE_FLAG = 'NEXT_PUBLIC_HSB_GUIDED_PHOTO_CAPTURE';

/** Stamped into the order metadata so we can trace which capture build produced a ref set. */
export const GUIDED_PHOTO_CAPTURE_VERSION = 'guided-photo-capture-mvp-v1';

/** 5 guided angles required-ish; allow up to 8 total (extra optional shots). */
export const GUIDED_MIN_FRAMES = 5;
export const GUIDED_MAX_FRAMES = 8;

/** True only when the env flag is exactly "true". */
export function isGuidedPhotoCaptureEnabled(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): boolean {
  return env?.[GUIDED_PHOTO_CAPTURE_FLAG] === 'true';
}

export type GuidedFrameLabel = 'front' | 'left' | 'right' | 'up' | 'smile';

export interface GuidedCapturePrompt {
  /** Short stable label used for filenames + server metadata. */
  label: GuidedFrameLabel;
  /** Customer-facing instruction. */
  title: string;
  /** Helper line under the oval guide. */
  hint: string;
}

/** The five guided angles, in order. */
export const GUIDED_CAPTURE_PROMPTS: readonly GuidedCapturePrompt[] = Object.freeze([
  { label: 'front', title: 'Look straight', hint: 'Face the camera with a relaxed, neutral expression.' },
  { label: 'left', title: 'Turn slightly left', hint: 'A small turn — keep both eyes visible.' },
  { label: 'right', title: 'Turn slightly right', hint: 'A small turn the other way.' },
  { label: 'up', title: 'Tilt slightly up', hint: 'Lift the chin just a little.' },
  { label: 'smile', title: 'Smile', hint: 'A natural smile is perfect.' },
]);

/** Stable upload filename for a captured frame, e.g. "guided-front.jpg". */
export function guidedFrameFileName(label: string, format: 'image/jpeg' | 'image/webp' = 'image/jpeg'): string {
  const ext = format === 'image/webp' ? 'webp' : 'jpg';
  return `guided-${sanitizeGuidedLabel(label)}.${ext}`;
}

/** Sanitize a label for filenames / blob paths (shared client + server). */
export function sanitizeGuidedLabel(label: string): string {
  const cleaned = (label ?? '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'frame';
}

/**
 * Required consent / privacy copy (verbatim from the spec). Asserted by tests so
 * the "not a face scan / biometric / Face ID" disclaimer can't drift.
 */
export const GUIDED_CAPTURE_CONSENT_COPY =
  'This guided photo capture takes a few ordinary reference photos to help us ' +
  'illustrate your child more consistently. It is not a face scan, biometric scan, ' +
  'or Face ID. You can delete any photo before submitting.';

/** Concise inline reassurance shown near the capture/submit controls. */
export const GUIDED_CAPTURE_CONCISE_COPY =
  'We only upload the still photos you approve — never video. These are temporary ' +
  'reference photos for your book.';

/** Consent checkbox label (consent is taken before the camera opens). */
export const GUIDED_CAPTURE_CONSENT_CHECKBOX_LABEL =
  'I’m the parent/guardian and I consent to taking a few reference photos. I understand this is not a face scan, biometric scan, or Face ID.';

export interface CapturedFrame {
  id: string;
  /** Which prompt/angle this frame was taken for. */
  label: GuidedFrameLabel | string;
  /** The encoded still image (image/jpeg or image/webp). Never video. */
  file: File;
  /** Object URL for in-UI preview (revoked on remove). */
  previewUrl: string;
  /** Whether the parent has this frame selected for upload. */
  selected: boolean;
}

export function addFrame(frames: readonly CapturedFrame[], frame: CapturedFrame): CapturedFrame[] {
  return [...frames, frame];
}

/** Remove a frame (delete). Returns the removed frame so callers can revoke its preview URL. */
export function removeFrame(
  frames: readonly CapturedFrame[],
  id: string,
): { frames: CapturedFrame[]; removed: CapturedFrame | null } {
  const removed = frames.find((f) => f.id === id) ?? null;
  return { frames: frames.filter((f) => f.id !== id), removed };
}

/** Retake: drop the frame(s) for a label so its slot reopens for a fresh capture. */
export function retakeFrame(
  frames: readonly CapturedFrame[],
  label: string,
): { frames: CapturedFrame[]; removed: CapturedFrame[] } {
  const removed = frames.filter((f) => f.label === label);
  return { frames: frames.filter((f) => f.label !== label), removed };
}

export function setFrameSelected(
  frames: readonly CapturedFrame[],
  id: string,
  selected: boolean,
): CapturedFrame[] {
  return frames.map((f) => (f.id === id ? { ...f, selected } : f));
}

export function selectedStills(frames: readonly CapturedFrame[]): CapturedFrame[] {
  return frames.filter((f) => f.selected);
}

export function hasSelectedStills(frames: readonly CapturedFrame[]): boolean {
  return selectedStills(frames).length > 0;
}

/**
 * The files to hand to the upload path. HARD GUARANTEE: only the parent's
 * selected still images are returned, capped at GUIDED_MAX_FRAMES, and a
 * non-image (e.g. a video blob) throws rather than ever being uploaded.
 */
export function framesToUploadFiles(frames: readonly CapturedFrame[]): File[] {
  const files = selectedStills(frames).map((f) => f.file);
  for (const file of files) {
    if (!file.type || !file.type.startsWith('image/')) {
      throw new Error('Guided capture may only upload still images, never video');
    }
  }
  return files.slice(0, GUIDED_MAX_FRAMES);
}

/** Ordered labels of the parent's selected stills (for FormData metadata). */
export function selectedLabels(frames: readonly CapturedFrame[]): string[] {
  return selectedStills(frames).slice(0, GUIDED_MAX_FRAMES).map((f) => sanitizeGuidedLabel(String(f.label)));
}

export interface CameraSupport {
  supported: boolean;
  reason: 'ok' | 'no-navigator' | 'no-getusermedia';
}

/** Detect whether guided camera capture is even possible in this environment. */
export function cameraSupport(nav: unknown = typeof navigator !== 'undefined' ? navigator : undefined): CameraSupport {
  const n = nav as { mediaDevices?: { getUserMedia?: unknown } } | undefined;
  if (!n) return { supported: false, reason: 'no-navigator' };
  if (!n.mediaDevices || typeof n.mediaDevices.getUserMedia !== 'function') {
    return { supported: false, reason: 'no-getusermedia' };
  }
  return { supported: true, reason: 'ok' };
}

/** The plain file-upload path is ALWAYS available as a fallback. */
export function shouldOfferFileUploadFallback(): boolean {
  return true;
}

interface StoppableTrack {
  stop: () => void;
}
interface StoppableStream {
  getTracks: () => StoppableTrack[];
}

/**
 * Stop every track on a MediaStream and return how many were stopped. Safe with
 * null/undefined. Called on finish, cancel, unmount, and route change so the
 * camera light never lingers.
 */
export function stopStreamTracks(stream: StoppableStream | null | undefined): number {
  if (!stream || typeof stream.getTracks !== 'function') return 0;
  const tracks = stream.getTracks();
  for (const track of tracks) {
    try {
      track.stop();
    } catch {
      /* a track that's already ended can throw; ignore */
    }
  }
  return tracks.length;
}

/** Map a getUserMedia error to friendly, fallback-pointing copy (Safari/iOS / in-app browser aware). */
export function describeGetUserMediaError(err: unknown): string {
  const name = (err as { name?: string } | undefined)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera in your browser settings, or use file upload below instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera was found on this device. Use file upload below instead.';
    case 'NotReadableError':
      return 'Your camera is being used by another app. Close it and try again, or use file upload below.';
    default:
      return 'We couldn’t start the camera (some in-app browsers block it). Use file upload below instead.';
  }
}
