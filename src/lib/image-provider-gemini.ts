// Direct Google Gemini image provider.
//
// Photo-conditioned image generation via the Google Generative Language API
// (`generativelanguage.googleapis.com/v1beta`). This is the *direct* path —
// it does NOT route through FAL. Today the FAL Seedream + Nano Banana
// providers also hit a Bytedance/Nano-Banana family of models, but they go
// through FAL's hosting layer; this provider goes straight to Google.
//
// Why a separate provider rather than a FAL config switch:
//   - Different auth (GOOGLE_GEMINI_API_KEY vs FAL_KEY).
//   - Different response shape (inline base64 vs hosted URL).
//   - Independent quota/billing — important while the operator is spending
//     down FAL credits and intentionally choosing Gemini as primary.
//
// Hard rules (mirrored from story-provider-gemini.ts):
//   - Per-request timeout via AbortSignal.timeout. A hung Gemini call must
//     not consume the whole serverless budget.
//   - On non-2xx, blocked prompt, invalid response shape, or missing
//     reference photo, return a structured failure result. Never throw —
//     the orchestrator owns the fallback decision.
//   - Never log the API key, the prompt, the photo URL, or the response
//     body. Errors include only status code + a short, key-redacted tail.
//   - This provider returns the generated image as a `data:` URL (the
//     Google API returns inline base64, not a hosted URL). Downstream
//     consumers must be verified to accept data URLs before
//     HSB_ENABLE_GEMINI_IMAGE is flipped on in production. See
//     docs/runbooks/gemini-image-routing.md for the production-readiness
//     checklist.

import { createHash } from 'node:crypto';

import type {
  BlobPutFn,
  GeneratedImageResult,
  ImageProvider,
  ImageProviderDeps,
  ImageProviderInput,
} from './image-provider-types.ts';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image-preview';

/** Per-request timeout. Matches the FAL/Seedream convention so a hung Gemini
 *  call does not eat the whole serverless budget. */
const GEMINI_IMAGE_REQUEST_TIMEOUT_MS = Number(
  process.env.HSB_GEMINI_IMAGE_REQUEST_TIMEOUT_MS ?? 60_000,
);

function getModel(): string {
  const override = (process.env.HSB_GEMINI_IMAGE_MODEL ?? '').trim();
  return override.length > 0 ? override : DEFAULT_GEMINI_IMAGE_MODEL;
}

function sanitizeGeminiErrorDetail(
  value: string | undefined | null,
  apiKey: string,
  maxLen = 200,
): string {
  if (!value) return '';
  let safe = String(value);
  if (apiKey) safe = safe.split(apiKey).join('[redacted-api-key]');
  safe = safe
    .replace(/([?&]key=)[^\s&]+/gi, '$1[redacted-api-key]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted-token]')
    .replace(/\bsk[_-][A-Za-z0-9_-]+/g, '[redacted-secret]');
  return safe.trim().slice(0, maxLen);
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

function looksLikeImageMime(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return /^image\//i.test(mime);
}

async function fetchReferencePhotoBase64(
  fetchFn: typeof globalThis.fetch,
  url: string,
  apiKey: string,
): Promise<{ mimeType: string; base64: string }> {
  const res = await fetchFn(url, {
    method: 'GET',
    signal: AbortSignal.timeout(GEMINI_IMAGE_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `reference photo fetch ${res.status}: ${sanitizeGeminiErrorDetail(
        await res.text().catch(() => ''),
        apiKey,
        120,
      )}`,
    );
  }
  const mimeFromHeader = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const mimeType = looksLikeImageMime(mimeFromHeader) ? mimeFromHeader : 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, base64: buf.toString('base64') };
}

interface GeminiImageResponseBody {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inline_data?: { mime_type?: string; data?: string };
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Strict mime → file extension. Limited to image mime types Google's image
 * models actually return so we don't write an unbounded set of extensions
 * to blob keys.
 */
function extForMime(mime: string): string {
  const lower = (mime || '').toLowerCase();
  if (lower === 'image/png') return 'png';
  if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg';
  if (lower === 'image/webp') return 'webp';
  return 'png';
}

type HostResult =
  | { kind: 'hosted'; url: string }
  | { kind: 'no_storage' }
  | { kind: 'failed'; error: string };

/**
 * Rehost the inline image bytes returned by Gemini to durable public storage
 * and return an HTTPS URL.
 *
 * Resolution order:
 *   1. Caller-injected `deps.blobPut` (used by tests + future custom storage).
 *   2. Dynamic import of `@vercel/blob` `put`, gated on
 *      `BLOB_READ_WRITE_TOKEN`. Production path.
 *   3. Neither available → return `no_storage` so the caller can degrade to
 *      a `data:` URL. Dev/test friendly; never used in production because
 *      every prod-like env has the token (orders.ts enforces this).
 *
 * Path layout mirrors `withBlobNamespace('generated/gemini/<hash>.<ext>')` so
 * preview + production share a token but never collide.
 */
async function hostInlineImage(
  bytes: Buffer,
  mimeType: string,
  prompt: string,
  injectedPut: BlobPutFn | undefined,
): Promise<HostResult> {
  const hash = createHash('sha256').update(bytes).update(prompt).digest('hex').slice(0, 16);
  const ext = extForMime(mimeType);
  let relPath = `generated/gemini/${hash}.${ext}`;
  // Best-effort namespace alignment with the rest of the codebase. If the
  // import fails (unlikely; same module is used for orders), fall back to
  // the un-namespaced path — still functionally correct, just less tidy.
  try {
    const { withBlobNamespace } = await import('./orders.ts');
    relPath = withBlobNamespace(relPath);
  } catch {
    // ignore
  }

  const token = (process.env.BLOB_READ_WRITE_TOKEN ?? '').trim() || undefined;
  const putFn = injectedPut ?? (token ? (await import('@vercel/blob')).put : null);
  if (!putFn) {
    // Defense-in-depth: in a production-like environment (Vercel deploy or
    // NODE_ENV=production), refuse to silently degrade to a data: URL.
    // Otherwise an operator who flips HSB_ENABLE_GEMINI_IMAGE=true without
    // first ensuring BLOB_READ_WRITE_TOKEN is set would write multi-MB
    // base64 strings into every order's currentImageUrl + versionHistory —
    // bloating the order JSON on each regenerate and stressing Blob
    // serialisation. The data: URL fallback is intentional for local dev
    // and unit tests; not safe for preview/production traffic.
    try {
      const { requiresDurablePersistence } = await import('./orders.ts');
      if (requiresDurablePersistence()) {
        return {
          kind: 'failed',
          error:
            'BLOB_READ_WRITE_TOKEN must be set when HSB_ENABLE_GEMINI_IMAGE is on in a production-like env',
        };
      }
    } catch {
      // If the import itself fails, fall through to the dev-friendly
      // no_storage result. We never want this safety check to become its
      // own outage source.
    }
    return { kind: 'no_storage' };
  }

  try {
    const result = await putFn(relPath, bytes, {
      access: 'public',
      contentType: mimeType,
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
    });
    if (!result?.url) return { kind: 'failed', error: 'blob put returned no url' };
    return { kind: 'hosted', url: result.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', error: message.slice(0, 200) };
  }
}

function extractFirstImage(body: GeminiImageResponseBody): { mimeType: string; data: string } | null {
  const parts = body.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const snake = part?.inline_data;
    if (snake && looksLikeImageMime(snake.mime_type) && snake.data) {
      return { mimeType: snake.mime_type ?? 'image/png', data: snake.data };
    }
    const camel = part?.inlineData;
    if (camel && looksLikeImageMime(camel.mimeType) && camel.data) {
      return { mimeType: camel.mimeType ?? 'image/png', data: camel.data };
    }
  }
  return null;
}

export const geminiImageProvider: ImageProvider = {
  name: 'gemini',
  async generate(
    input: ImageProviderInput,
    deps: ImageProviderDeps = {},
  ): Promise<GeneratedImageResult> {
    const startedAt = Date.now();
    const model = getModel();
    const apiKey = (process.env.GOOGLE_GEMINI_API_KEY ?? '').trim();
    const referenceUrls = collectImageUrls(input);
    const primaryReference = referenceUrls[0] ?? null;
    const _fetch = deps.fetch ?? globalThis.fetch;

    if (!apiKey) {
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: 'GOOGLE_GEMINI_API_KEY not set',
      };
    }

    if (referenceUrls.length === 0) {
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: null,
        latencyMs: Date.now() - startedAt,
        error: 'gemini requires at least one reference image URL',
      };
    }

    let photo: { mimeType: string; base64: string };
    try {
      photo = await fetchReferencePhotoBase64(_fetch, referenceUrls[0]!, apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: `gemini reference fetch failed: ${sanitizeGeminiErrorDetail(message, apiKey)}`,
      };
    }

    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.prompt },
            { inline_data: { mime_type: photo.mimeType, data: photo.base64 } },
          ],
        },
      ],
      generationConfig: {
        response_modalities: ['IMAGE'],
      },
    };

    let response: Response;
    try {
      response = await _fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_IMAGE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: `gemini fetch failed: ${sanitizeGeminiErrorDetail(message, apiKey)}`,
      };
    }

    if (!response.ok) {
      const tail = sanitizeGeminiErrorDetail(
        await response.text().catch(() => ''),
        apiKey,
      );
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: `Gemini API error ${response.status}: ${tail}`,
      };
    }

    let parsed: GeminiImageResponseBody;
    try {
      parsed = (await response.json()) as GeminiImageResponseBody;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: `gemini response parse failed: ${sanitizeGeminiErrorDetail(message, apiKey)}`,
      };
    }

    if (parsed.promptFeedback?.blockReason) {
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: `Gemini blocked: ${sanitizeGeminiErrorDetail(parsed.promptFeedback.blockReason, apiKey, 80)}`,
      };
    }

    const image = extractFirstImage(parsed);
    if (!image) {
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: 'Gemini returned no image candidate',
      };
    }

    // Rehost the inline bytes to durable HTTPS storage. Without this every
    // downstream consumer (PDF builder, order persistence, version history,
    // admin/review UI) would have to round-trip a multi-MB data: URL —
    // workable for fetch + PDF embed, but the persisted order JSON would
    // grow unboundedly on each regenerate.
    const bytes = Buffer.from(image.data, 'base64');
    const hosted = await hostInlineImage(bytes, image.mimeType, input.prompt, deps.blobPut);
    if (hosted.kind === 'failed') {
      return {
        imageUrl: null,
        provider: 'gemini',
        model,
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: primaryReference,
        latencyMs: Date.now() - startedAt,
        error: `gemini blob upload failed: ${hosted.error}`,
      };
    }
    const imageUrl =
      hosted.kind === 'hosted'
        ? hosted.url
        : `data:${image.mimeType};base64,${image.data}`;
    if (hosted.kind === 'no_storage') {
      // No token + no injected put. This branch is intentional for local dev
      // and tests; production environments always have BLOB_READ_WRITE_TOKEN
      // (orders.ts hard-fails without it). A single info line per call so
      // operators can spot accidental token-missing config in staging.
      // eslint-disable-next-line no-console
      console.info(
        '[image-provider-gemini] returning data: URL (BLOB_READ_WRITE_TOKEN unset and no blobPut injected)',
      );
    }

    return {
      imageUrl,
      provider: 'gemini',
      model,
      promptUsed: input.prompt,
      conditioning: 'photo_edit',
      referencePhotoUrl: primaryReference,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  },
};

export function isGeminiImageEnabled(): boolean {
  return process.env.HSB_ENABLE_GEMINI_IMAGE === 'true';
}

export function isGeminiImageFalFallbackEnabled(): boolean {
  return process.env.HSB_GEMINI_IMAGE_FAL_FALLBACK === 'true';
}

export function hasGeminiImageApiKey(): boolean {
  return (process.env.GOOGLE_GEMINI_API_KEY ?? '').trim().length > 0;
}
