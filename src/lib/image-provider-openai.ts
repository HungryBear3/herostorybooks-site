// OpenAI gpt-image-1 / dall-e-3 image generation. Returns a structured result;
// callers decide whether to fall back on null/error.

import type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderDeps,
  ImageProviderInput,
} from './image-provider-types.ts';
import { redactProviderError } from './redact-secrets.ts';

const OPENAI_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
/** Per-request timeout. A hung OpenAI image request can otherwise consume
 *  the whole serverless budget and leave the order stuck at
 *  fulfillmentStatus='generating_images' with no recorded error. Matches
 *  the timeout pattern used by the FAL and Seedream providers. Read on
 *  each call so tests / runtime overrides apply without a fresh import. */
function getOpenaiTimeoutMs(): number {
  return Number(process.env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS ?? 60_000);
}

export const openaiImageProvider: ImageProvider = {
  name: 'openai',
  async generate(
    input: ImageProviderInput,
    deps: ImageProviderDeps = {},
  ): Promise<GeneratedImageResult> {
    const startedAt = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        imageUrl: null,
        provider: 'openai',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        latencyMs: Date.now() - startedAt,
        error: 'OPENAI_API_KEY not set',
      };
    }

    const _fetch = deps.fetch ?? globalThis.fetch;
    try {
      const res = await _fetch(OPENAI_IMAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          prompt: input.prompt,
          n: 1,
          size: '1024x1024',
        }),
        signal: AbortSignal.timeout(getOpenaiTimeoutMs()),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          imageUrl: null,
          provider: 'openai',
          model: DEFAULT_MODEL,
          promptUsed: input.prompt,
          latencyMs: Date.now() - startedAt,
          error: redactProviderError(null, { provider: 'OpenAI', status: res.status }),
        };
      }

      const data = (await res.json()) as {
        data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
      };
      const first = data.data?.[0];
      let imageUrl: string | null = null;
      if (first?.url) {
        imageUrl = first.url;
      } else if (first?.b64_json) {
        imageUrl = `data:image/png;base64,${first.b64_json}`;
      }
      const revisedPrompt = first?.revised_prompt;

      if (!imageUrl) {
        return {
          imageUrl: null,
          provider: 'openai',
          model: DEFAULT_MODEL,
          promptUsed: input.prompt,
          latencyMs: Date.now() - startedAt,
          error: 'OpenAI returned no image data',
        };
      }

      return {
        imageUrl,
        provider: 'openai',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        ...(revisedPrompt ? { revisedPrompt } : {}),
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      return {
        imageUrl: null,
        provider: 'openai',
        model: DEFAULT_MODEL,
        promptUsed: input.prompt,
        latencyMs: Date.now() - startedAt,
        error: redactProviderError(err, { provider: 'OpenAI' }),
      };
    }
  },
};
