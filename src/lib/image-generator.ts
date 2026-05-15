// Image generator orchestrator.
//
// Routes by conditioning intent:
//   - When a referenceImageUrl (or imageUrls) is supplied, try the primary
//     photo-conditioned Seedream edit provider first, then the secondary
//     Nano Banana edit provider.
//   - When no reference image is supplied, do not degrade to a text-only lane.
//     Return a structured failure instead.
//
// Fallback ordering is deliberate: Seedream is cheaper and preferred for
// launch-quality output. Nano Banana edit is the recovery lane if Seedream
// fails. We do not silently ship text-only art for photo-based books.

import { falEditImageProvider } from './image-provider-fal-edit.ts';
import {
  geminiImageProvider,
  hasGeminiImageApiKey,
  isGeminiImageEnabled,
  isGeminiImageFalFallbackEnabled,
} from './image-provider-gemini.ts';
import { seedreamEditImageProvider } from './image-provider-seedream-edit.ts';
import type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderDeps,
  ImageProviderInput,
  ImageProviderName,
} from './image-provider-types.ts';

export type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderDeps,
  ImageProviderInput,
  ImageProviderName,
};

export interface OrchestratorDeps {
  fetch?: typeof globalThis.fetch;
  /**
   * Override the provider order. Defaults are derived from input:
   *   - input.referenceImageUrl set → [seedream_edit, fal_edit]
   *   - otherwise                    → [] (no text-only fallback)
   *
   * OpenAI image providers are not in the default chain. A caller may
   * include one explicitly, but it will be filtered out unless
   * `HSB_ENABLE_OPENAI_IMAGE === 'true'`. See PR1 of the image-pipeline
   * architecture work — business decision: avoid OpenAI image API by
   * default.
   */
  providers?: ImageProvider[];
  /**
   * Optional short context tags for the structured per-call log line.
   * `orderIdShort` should be the order ID prefix (the logger sanitises
   * anything URL- or secret-shaped regardless of field name). Both are
   * optional; existing callers that don't pass them keep working.
   */
  orderIdShort?: string;
  pageIndex?: number;
}

const PHOTO_EDIT_CHAIN: ImageProvider[] = [seedreamEditImageProvider, falEditImageProvider];
const NO_TEXT_ONLY_FALLBACK: ImageProvider[] = [];

/**
 * Build the default provider chain based on input + env flags.
 *
 * When a reference photo is present:
 *   - `HSB_ENABLE_GEMINI_IMAGE=true` + `GOOGLE_GEMINI_API_KEY` set:
 *       primary chain is [gemini].
 *       If `HSB_GEMINI_IMAGE_FAL_FALLBACK=true` is ALSO set, FAL providers
 *       (Seedream then Nano Banana) are appended as fallback. The brief
 *       requires this fallback to be explicit, not implicit — Gemini is
 *       the intended primary while operator credits permit.
 *   - Otherwise: legacy `[seedream_edit, fal_edit]` chain.
 *
 * When no reference photo is present: empty chain. We never silently
 * degrade a photo-based book to text-only art.
 *
 * Exported for tests so the chain-composition contract can be asserted
 * without going through the full orchestrator.
 */
export function defaultProviderOrder(input: ImageProviderInput): ImageProvider[] {
  const hasReference = Boolean(
    (input.imageUrls && input.imageUrls.length > 0) || input.referenceImageUrl,
  );
  if (!hasReference) return NO_TEXT_ONLY_FALLBACK;
  if (isGeminiImageEnabled() && hasGeminiImageApiKey()) {
    return isGeminiImageFalFallbackEnabled()
      ? [geminiImageProvider, ...PHOTO_EDIT_CHAIN]
      : [geminiImageProvider];
  }
  return PHOTO_EDIT_CHAIN;
}

// ── OpenAI gate ───────────────────────────────────────────────────────────────
//
// The OpenAI image API is intentionally NOT in the default chain. PR1's job is
// to make sure a future caller that constructs its own `deps.providers` cannot
// accidentally smuggle OpenAI in without an explicit operator opt-in.

const OPENAI_PROVIDER_NAMES = new Set<string>(['openai']);

function applyOpenAIGate(
  providers: ImageProvider[],
  orderIdShort: string | undefined,
): ImageProvider[] {
  const allowOpenAI = process.env.HSB_ENABLE_OPENAI_IMAGE === 'true';
  if (allowOpenAI) return providers;
  const filtered = providers.filter((p) => !OPENAI_PROVIDER_NAMES.has(p.name));
  if (filtered.length !== providers.length) {
    // One-line warning identifying the order (short id only) when a filter
    // happens. We deliberately do NOT include the dropped provider object
    // itself — only that we dropped something OpenAI-shaped — so we don't
    // risk leaking model names or config embedded on the provider.
    // eslint-disable-next-line no-console
    console.warn(
      `[image-gen] orderIdShort=${sanitizeFieldValue(orderIdShort ?? 'unknown')} ` +
        `event=openai_filtered count=${providers.length - filtered.length} ` +
        `reason=HSB_ENABLE_OPENAI_IMAGE_not_true`,
    );
  }
  return filtered;
}

// ── Structured log helper ─────────────────────────────────────────────────────
//
// One machine-grep-able line per generation attempt. NEVER throws. NEVER
// fails image generation. Field values are sanitised — anything URL-shaped,
// secret-shaped, or unreasonably long is replaced with a redacted marker
// so a future field rename can't leak. Whole helper is wrapped in
// try/catch as defence-in-depth.

const REDACTED_URL = '[redacted-url]';
const REDACTED_SECRET = '[redacted-secret]';
const REDACTED_TOO_LONG = '[redacted-too-long]';
const MAX_FIELD_LEN = 200;

function sanitizeFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  try {
    s = typeof value === 'string' ? value : String(value);
  } catch {
    return '[redacted-unstringifiable]';
  }
  if (s.length > MAX_FIELD_LEN) return REDACTED_TOO_LONG;
  if (/^https?:\/\//i.test(s)) return REDACTED_URL;
  if (/^Bearer\s+/i.test(s) || /^sk_/i.test(s) || /^sk-/i.test(s)) return REDACTED_SECRET;
  return s;
}

/**
 * Classify a provider error string into a short bucket so logs can answer
 * "what kind of failure?" without echoing the underlying message (which
 * might carry a URL, body fragment, or provider-supplied detail).
 */
function classifyError(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  const lower = error.toLowerCase();
  if (/abort|timed?\s*out|timeout/.test(lower)) return 'timeout';
  if (/4\d\d/.test(error)) return 'http_4xx';
  if (/5\d\d/.test(error)) return 'http_5xx';
  if (/no image|no_image|returned no image/i.test(error)) return 'no_image_returned';
  if (/no photo-conditioned/i.test(error)) return 'no_photo_provider';
  if (/key not set|apikey/i.test(error)) return 'auth_missing';
  return 'other';
}

interface ImageGenLogPayload {
  orderIdShort?: string;
  pageIndex?: number;
  provider: string;
  model: string;
  conditioning?: string | null;
  latencyMs: number;
  refPhoto: 'yes' | 'no';
  result: 'ok' | 'error';
  errorClass?: string;
}

function logImageGen(payload: ImageGenLogPayload): void {
  try {
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined || v === null) continue;
      safe[k] = sanitizeFieldValue(v);
    }
    const line = Object.entries(safe)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.info(`[image-gen] ${line}`);
  } catch {
    // Logging is observability, not behaviour. A failure here must never
    // propagate to the generation pipeline.
  }
}

export async function generatePageImage(
  input: ImageProviderInput,
  deps: OrchestratorDeps = {},
): Promise<GeneratedImageResult> {
  const rawProviders = deps.providers ?? defaultProviderOrder(input);
  // Apply the OpenAI gate ONLY when the caller supplied its own chain.
  // The default chains don't contain OpenAI, so this is a no-op for normal
  // callers — but it slams the door on future code that builds its own
  // `deps.providers` list without thinking about provider policy.
  const callerSupplied = deps.providers !== undefined;
  const providers = callerSupplied
    ? applyOpenAIGate(rawProviders, deps.orderIdShort)
    : rawProviders;
  const providerDeps: ImageProviderDeps = deps.fetch ? { fetch: deps.fetch } : {};
  const refPhoto: 'yes' | 'no' =
    input.referenceImageUrl || (input.imageUrls && input.imageUrls.length > 0) ? 'yes' : 'no';

  let last: GeneratedImageResult | null = null;
  for (const provider of providers) {
    const result = await provider.generate(input, providerDeps);
    last = result;
    logImageGen({
      orderIdShort: deps.orderIdShort,
      pageIndex: deps.pageIndex,
      provider: result.provider,
      model: result.model,
      conditioning: result.conditioning ?? null,
      latencyMs: result.latencyMs,
      refPhoto,
      result: result.imageUrl ? 'ok' : 'error',
      errorClass: result.imageUrl ? undefined : classifyError(result.error),
    });
    if (result.imageUrl) return result;
  }
  if (last) return last;

  // No providers in the chain at all (typical: no-photo branch). Emit a
  // synthetic failure line so the absence of generation is still visible
  // in the log stream — silence here would look like "didn't run" rather
  // than "ran with no chain".
  const synthetic: GeneratedImageResult = {
    imageUrl: null,
    provider: 'fal_edit',
    model: 'photo-edit-unavailable',
    promptUsed: input.prompt,
    conditioning: 'photo_edit',
    referencePhotoUrl: input.referenceImageUrl ?? null,
    latencyMs: 0,
    error: 'No photo-conditioned providers configured',
  };
  logImageGen({
    orderIdShort: deps.orderIdShort,
    pageIndex: deps.pageIndex,
    provider: synthetic.provider,
    model: synthetic.model,
    conditioning: synthetic.conditioning ?? null,
    latencyMs: synthetic.latencyMs,
    refPhoto,
    result: 'error',
    errorClass: classifyError(synthetic.error),
  });
  return synthetic;
}

// ── Legacy URL-only API (used by fulfillment proof generation) ───────────────

interface FetchDep {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * URL-only convenience. Accepts an optional reference photo URL so the
 * full-book fulfillment path can opt into photo-conditioning per page
 * without each call site reaching for the structured API.
 */
export async function generateImage(
  prompt: string,
  deps: { fetch?: FetchDep; referenceImageUrl?: string | null } = {},
): Promise<string | null> {
  const result = await generatePageImage(
    { prompt, referenceImageUrl: deps.referenceImageUrl ?? null },
    { fetch: deps.fetch as typeof globalThis.fetch | undefined },
  );
  return result.imageUrl;
}

function getImageGenConcurrency(): number {
  const raw = Number(process.env.HSB_IMAGE_GEN_CONCURRENCY ?? 3);
  if (!Number.isFinite(raw) || raw < 1) return 3;
  return Math.max(1, Math.floor(raw));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current]!, current);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function generateStoryImages(
  imagePrompts: string[],
  deps: { fetch?: FetchDep; referenceImageUrl?: string | null } = {},
): Promise<(string | null)[]> {
  return mapWithConcurrency(
    imagePrompts,
    getImageGenConcurrency(),
    (p) => generateImage(p, deps),
  );
}

/**
 * Structured story-image generation that returns conditioning metadata per
 * page (provider, model, conditioning, referencePhotoUrl). Use this from
 * fulfillment when you want to persist honest per-page diagnostics.
 */
export async function generateStoryImageResults(
  imagePrompts: string[],
  deps: { fetch?: FetchDep; referenceImageUrl?: string | null } = {},
): Promise<GeneratedImageResult[]> {
  return mapWithConcurrency(
    imagePrompts,
    getImageGenConcurrency(),
    (p) =>
      generatePageImage(
        { prompt: p, referenceImageUrl: deps.referenceImageUrl ?? null },
        { fetch: deps.fetch as typeof globalThis.fetch | undefined },
      ),
  );
}
