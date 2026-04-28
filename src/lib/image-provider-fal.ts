// FAL fallback provider. Mirrors the prior behavior of image-generator.ts but
// returns the structured GeneratedImageResult shape.

import { createHash } from 'node:crypto';

import type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderDeps,
  ImageProviderInput,
} from './image-provider-types.ts';

const FAL_ENDPOINT = process.env.FAL_IMAGE_ENDPOINT ?? 'https://fal.run/fal-ai/flux/schnell';
const DEFAULT_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux/schnell';

/**
 * Derive a deterministic 32-bit seed from the prompt. Same prompt → same seed,
 * so initial generation and a regenerate (which preserves the frozen character
 * anchor + basePrompt) land on the same noise pattern. Different pages of the
 * same book get different seeds (their basePrompts differ) but share the
 * frozen identity anchor in the prompt, which is what we actually need: same
 * child, different scene. Note: flux/schnell is still text-only, so this only
 * stabilizes stochastic noise; it does not condition on the customer photo.
 */
function deterministicSeedFromPrompt(prompt: string): number {
  const digest = createHash('sha256').update(prompt).digest();
  // Use the first 4 bytes as an unsigned 32-bit int.
  return digest.readUInt32BE(0);
}

export const falImageProvider: ImageProvider = {
  name: 'fal',
  async generate(
    input: ImageProviderInput,
    deps: ImageProviderDeps = {},
  ): Promise<GeneratedImageResult> {
    const startedAt = Date.now();
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) {
      return {
        imageUrl: null,
        provider: 'fal',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        latencyMs: Date.now() - startedAt,
        error: 'FAL_KEY not set',
      };
    }

    const _fetch = deps.fetch ?? globalThis.fetch;
    try {
      const res = await _fetch(FAL_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: input.prompt,
          image_size: 'landscape_4_3',
          num_inference_steps: 4,
          num_images: 1,
          enable_safety_checker: true,
          seed: deterministicSeedFromPrompt(input.prompt),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          imageUrl: null,
          provider: 'fal',
          model: DEFAULT_MODEL,
          promptUsed: input.prompt,
          latencyMs: Date.now() - startedAt,
          error: `FAL ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      const data = (await res.json()) as { images?: Array<{ url: string }> };
      const imageUrl = data.images?.[0]?.url ?? null;
      if (!imageUrl) {
        return {
          imageUrl: null,
          provider: 'fal',
          model: DEFAULT_MODEL,
          promptUsed: input.prompt,
          latencyMs: Date.now() - startedAt,
          error: 'FAL returned no image URL',
        };
      }
      return {
        imageUrl,
        provider: 'fal',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      return {
        imageUrl: null,
        provider: 'fal',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
