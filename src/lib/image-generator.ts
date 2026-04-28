// Image generator orchestrator.
//
// Provider order: OpenAI primary → FAL fallback.
// - generatePageImage(): structured result; use for regenerate path.
// - generateImage() / generateStoryImages(): legacy URL-only API for callers
//   that just need a URL (fulfillment proof builder, tests).

import { openaiImageProvider } from './image-provider-openai.ts';
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
  /** Inject providers in tests — defaults to [openai, fal]. */
  providers?: ImageProvider[];
}

const DEFAULT_PROVIDER_ORDER: ImageProvider[] = [openaiImageProvider, falImageProvider];

/**
 * Try OpenAI first, then FAL. Returns whichever produces a non-null imageUrl.
 * If all providers fail, returns the last attempt so callers can log the error.
 */
export async function generatePageImage(
  input: ImageProviderInput,
  deps: OrchestratorDeps = {},
): Promise<GeneratedImageResult> {
  const providers = deps.providers ?? DEFAULT_PROVIDER_ORDER;
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
      provider: 'openai',
      model: 'unknown',
      promptUsed: input.prompt,
      latencyMs: 0,
      error: 'No providers configured',
    }
  );
}

// ── Legacy URL-only API (used by fulfillment proof generation) ───────────────

interface FetchDep {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export async function generateImage(
  prompt: string,
  deps: { fetch?: FetchDep } = {},
): Promise<string | null> {
  const result = await generatePageImage(
    { prompt },
    { fetch: deps.fetch as typeof globalThis.fetch | undefined },
  );
  return result.imageUrl;
}

export async function generateStoryImages(
  imagePrompts: string[],
  deps: { fetch?: FetchDep } = {},
): Promise<(string | null)[]> {
  return Promise.all(imagePrompts.map((p) => generateImage(p, deps)));
}
