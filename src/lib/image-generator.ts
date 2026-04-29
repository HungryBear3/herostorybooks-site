// Image generator orchestrator.
//
// Routes by conditioning intent:
//   - When a referenceImageUrl (or imageUrls) is supplied, try the photo-
//     conditioned `fal_edit` provider first, then fall through to the
//     text-only `fal` provider on failure.
//   - When no reference image is supplied, go straight to text-only `fal`
//     (skips the edit provider — calling it without a reference would just
//     fail-fast).
//
// Fallback ordering is deliberate: photo-conditioned generation can fail
// transiently (rate limit, model error, missing FAL_KEY edit quota); we
// would rather ship a recognizable scene from text-only FAL than fail the
// whole order. Each returned GeneratedImageResult carries `conditioning`
// and `referencePhotoUrl` so callers can record honest per-page metadata.

import { falEditImageProvider } from './image-provider-fal-edit.ts';
import { falImageProvider } from './image-provider-fal.ts';
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
   *   - input.referenceImageUrl set → [fal_edit, fal]
   *   - otherwise                    → [fal]
   */
  providers?: ImageProvider[];
}

const FAL_EDIT_FIRST: ImageProvider[] = [falEditImageProvider, falImageProvider];
const FAL_TEXT_ONLY: ImageProvider[] = [falImageProvider];

function defaultProviderOrder(input: ImageProviderInput): ImageProvider[] {
  const hasReference = Boolean(
    (input.imageUrls && input.imageUrls.length > 0) || input.referenceImageUrl,
  );
  return hasReference ? FAL_EDIT_FIRST : FAL_TEXT_ONLY;
}

export async function generatePageImage(
  input: ImageProviderInput,
  deps: OrchestratorDeps = {},
): Promise<GeneratedImageResult> {
  const providers = deps.providers ?? defaultProviderOrder(input);
  const providerDeps: ImageProviderDeps = deps.fetch ? { fetch: deps.fetch } : {};

  let last: GeneratedImageResult | null = null;
  for (const provider of providers) {
    const result = await provider.generate(input, providerDeps);
    last = result;
    if (result.imageUrl) return result;
  }
  return (
    last ?? {
      imageUrl: null,
      provider: 'fal',
      model: 'unknown',
      promptUsed: input.prompt,
      conditioning: 'text_only',
      referencePhotoUrl: input.referenceImageUrl ?? null,
      latencyMs: 0,
      error: 'No providers configured',
    }
  );
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

export async function generateStoryImages(
  imagePrompts: string[],
  deps: { fetch?: FetchDep; referenceImageUrl?: string | null } = {},
): Promise<(string | null)[]> {
  return Promise.all(imagePrompts.map((p) => generateImage(p, deps)));
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
  return Promise.all(
    imagePrompts.map((p) =>
      generatePageImage(
        { prompt: p, referenceImageUrl: deps.referenceImageUrl ?? null },
        { fetch: deps.fetch as typeof globalThis.fetch | undefined },
      ),
    ),
  );
}
