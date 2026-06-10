// FAL Seedream image-conditioned ("edit") provider.
//
// Primary photo-conditioned generation path. Uses Seedream v4 edit so the
// produced illustration is grounded in the actual child's face via image_urls.
//
// Default model: fal-ai/bytedance/seedream/v4/edit.
// Override via FAL_SEEDREAM_IMAGE_ENDPOINT / FAL_SEEDREAM_IMAGE_MODEL.

import { createHash } from 'node:crypto';

import type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderDeps,
  ImageProviderInput,
} from './image-provider-types.ts';
import { redactProviderError } from './redact-secrets.ts';

const FAL_SEEDREAM_ENDPOINT =
  process.env.FAL_SEEDREAM_IMAGE_ENDPOINT ?? 'https://fal.run/fal-ai/bytedance/seedream/v4/edit';
const DEFAULT_MODEL = process.env.FAL_SEEDREAM_IMAGE_MODEL ?? 'fal-ai/bytedance/seedream/v4/edit';
/** Per-request timeout. A hung Seedream edit request can otherwise consume
 *  the whole serverless budget and leave the order stuck at
 *  fulfillmentStatus='generating_images' with no recorded error. */
const FAL_SEEDREAM_REQUEST_TIMEOUT_MS = Number(process.env.FAL_SEEDREAM_REQUEST_TIMEOUT_MS ?? 60_000);

function deterministicSeedFromPrompt(prompt: string): number {
  const digest = createHash('sha256').update(prompt).digest();
  return digest.readUInt32BE(0);
}

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

export const seedreamEditImageProvider: ImageProvider = {
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
      return {
        imageUrl: null,
        provider: 'fal_edit',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: null,
        latencyMs: Date.now() - startedAt,
        error: 'seedream_edit requires at least one reference image URL',
      };
    }

    const _fetch = deps.fetch ?? globalThis.fetch;
    try {
      const res = await _fetch(FAL_SEEDREAM_ENDPOINT, {
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
        signal: AbortSignal.timeout(FAL_SEEDREAM_REQUEST_TIMEOUT_MS),
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
          error: redactProviderError(null, { provider: 'FAL', status: res.status }),
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
        error: redactProviderError(err, { provider: 'FAL' }),
      };
    }
  },
};
