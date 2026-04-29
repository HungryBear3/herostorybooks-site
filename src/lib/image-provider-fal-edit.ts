// FAL image-conditioned ("edit") provider.
//
// Photo-conditioned generation path. Uses a FAL image-edit model that
// accepts the customer's uploaded child photo as `image_urls` so the
// produced illustration is grounded in the actual child's face, rather
// than a text description alone.
//
// Default model: fal-ai/nano-banana-pro/edit (documents image_urls input).
// Override via FAL_EDIT_IMAGE_ENDPOINT / FAL_EDIT_IMAGE_MODEL.
//
// Returns conditioning='photo_edit' on success so fulfillment + diagnostics
// can record which path actually produced each page. If no reference URL
// is supplied, this provider fails fast with a structured error rather than
// silently degrading to a text-only call — the orchestrator owns that
// fallback decision (see image-generator.ts).

import { createHash } from 'node:crypto';

import type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderDeps,
  ImageProviderInput,
} from './image-provider-types.ts';

const FAL_EDIT_ENDPOINT =
  process.env.FAL_EDIT_IMAGE_ENDPOINT ?? 'https://fal.run/fal-ai/nano-banana-pro/edit';
const DEFAULT_MODEL = process.env.FAL_EDIT_IMAGE_MODEL ?? 'fal-ai/nano-banana-pro/edit';

function deterministicSeedFromPrompt(prompt: string): number {
  const digest = createHash('sha256').update(prompt).digest();
  return digest.readUInt32BE(0);
}

/**
 * Collect all reference image URLs from the input, deduplicated, in order.
 * Falls back to `referenceImageUrl` when `imageUrls` is empty/unset.
 */
function collectImageUrls(input: ImageProviderInput): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string | null | undefined) => {
    if (!u) return;
    const trimmed = u.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  if (Array.isArray(input.imageUrls)) for (const u of input.imageUrls) push(u);
  push(input.referenceImageUrl ?? null);
  return out;
}

export const falEditImageProvider: ImageProvider = {
  name: 'fal_edit',
  async generate(
    input: ImageProviderInput,
    deps: ImageProviderDeps = {},
  ): Promise<GeneratedImageResult> {
    const startedAt = Date.now();
    const apiKey = process.env.FAL_KEY;
    const referenceUrls = collectImageUrls(input);
    const primaryReference = referenceUrls[0] ?? null;

    if (!apiKey) {
      return {
        imageUrl: null,
        provider: 'fal_edit',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: 'FAL_KEY not set',
      };
    }

    if (referenceUrls.length === 0) {
      // The orchestrator should not call us without a photo. Fail explicitly
      // so the caller can fall through to the text-only provider, instead
      // of silently producing a non-conditioned image and lying about it.
      return {
        imageUrl: null,
        provider: 'fal_edit',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: null,
        latencyMs: Date.now() - startedAt,
        error: 'fal_edit requires at least one reference image URL',
      };
    }

    const _fetch = deps.fetch ?? globalThis.fetch;
    try {
      const res = await _fetch(FAL_EDIT_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: input.prompt,
          image_urls: referenceUrls,
          num_images: 1,
          enable_safety_checker: true,
          seed: deterministicSeedFromPrompt(input.prompt),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          imageUrl: null,
          provider: 'fal_edit',
          model: DEFAULT_MODEL,
          promptUsed: input.prompt,
          conditioning: 'photo_edit',
          referencePhotoUrl: primaryReference,
          latencyMs: Date.now() - startedAt,
          error: `FAL ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      const data = (await res.json()) as {
        images?: Array<{ url?: string }>;
        image?: { url?: string };
      };
      const imageUrl = data.images?.[0]?.url ?? data.image?.url ?? null;

      if (!imageUrl) {
        return {
          imageUrl: null,
          provider: 'fal_edit',
          model: DEFAULT_MODEL,
          promptUsed: input.prompt,
          conditioning: 'photo_edit',
          referencePhotoUrl: primaryReference,
          latencyMs: Date.now() - startedAt,
          error: 'FAL edit returned no image URL',
        };
      }

      return {
        imageUrl,
        provider: 'fal_edit',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      return {
        imageUrl: null,
        provider: 'fal_edit',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
