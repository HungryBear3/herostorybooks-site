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
   */
  providers?: ImageProvider[];
}

const PHOTO_EDIT_CHAIN: ImageProvider[] = [seedreamEditImageProvider, falEditImageProvider];
const NO_TEXT_ONLY_FALLBACK: ImageProvider[] = [];

function defaultProviderOrder(input: ImageProviderInput): ImageProvider[] {
  const hasReference = Boolean(
    (input.imageUrls && input.imageUrls.length > 0) || input.referenceImageUrl,
  );
  return hasReference ? PHOTO_EDIT_CHAIN : NO_TEXT_ONLY_FALLBACK;
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
      provider: 'fal_edit',
      model: 'photo-edit-unavailable',
      promptUsed: input.prompt,
      conditioning: 'photo_edit',
      referencePhotoUrl: input.referenceImageUrl ?? null,
      latencyMs: 0,
      error: 'No photo-conditioned providers configured',
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
