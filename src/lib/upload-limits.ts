// Client-side checkout upload-size limits (Phase 1).
//
// Why: checkout POSTs all uploads (main photo + supporting photos + optional
// voice/audio/doc) in ONE multipart FormData to /api/order. Vercel rejects a
// request whose body exceeds ~4.5 MB BEFORE our route code runs, so a too-large
// combined payload fails with an opaque platform error and no "not charged"
// reassurance. Image auto-resize (src/lib/photo-upload.ts) only helps images;
// it does not bound voice/docs or the COMBINED total. These limits + the
// pure helpers below let the browser block oversized attachments with clear,
// honest copy instead of waiting for Vercel to reject.
//
// Phase 2 (separate) will pre-upload large files directly to Blob and send only
// references, which removes these per-request caps.

// Combined cap for everything attached to a single checkout. Held safely under
// Vercel's ~4.5 MB serverless request-body limit, leaving headroom for the form
// fields + multipart overhead.
export const MAX_TOTAL_UPLOAD_BYTES = 4 * 1024 * 1024;

// Per-file cap for a voice note / audio / text / document inspiration upload.
export const MAX_VOICE_UPLOAD_BYTES = 3 * 1024 * 1024;

export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Voice / audio / doc ──────────────────────────────────────────────────────

export function isVoiceUploadTooLarge(bytes: number): boolean {
  return bytes > MAX_VOICE_UPLOAD_BYTES;
}

export function voiceTooLargeMessage(bytes: number): string {
  return (
    `That file is ${formatMb(bytes)}, over the ${formatMb(MAX_VOICE_UPLOAD_BYTES)} limit for ` +
    `inspiration uploads. Try a shorter voice note, or paste your idea as a short text or PDF instead.`
  );
}

// ── Combined payload ─────────────────────────────────────────────────────────

export interface UploadByteParts {
  mainPhotoBytes?: number;
  supportingPhotoBytes?: number[];
  voiceBytes?: number;
}

export function estimateTotalUploadBytes(parts: UploadByteParts): number {
  const supporting = (parts.supportingPhotoBytes ?? []).reduce((sum, n) => sum + (n || 0), 0);
  return (parts.mainPhotoBytes ?? 0) + supporting + (parts.voiceBytes ?? 0);
}

export function isCombinedUploadTooLarge(bytes: number): boolean {
  return bytes > MAX_TOTAL_UPLOAD_BYTES;
}

export function combinedTooLargeMessage(bytes: number): string {
  return (
    `Your attachments add up to about ${formatMb(bytes)}, over the ${formatMb(MAX_TOTAL_UPLOAD_BYTES)} ` +
    `limit for a single checkout. Remove or shrink a photo, or use a shorter voice note or text ` +
    `inspiration, then try again — you have not been charged.`
  );
}
