// Shared provider types. Imported by image-generator + per-provider modules.

export type ImageProviderName = 'manual' | 'openai' | 'fal' | 'fal_edit' | 'gemini' | 'seedream' | 'seedream_edit';

/**
 * How a particular generated image was conditioned.
 *
 * - 'text_only'  : prompt-only generation (e.g. flux/schnell)
 * - 'photo_edit' : the customer's uploaded photo was passed as image input
 *                  (e.g. fal-ai/nano-banana-pro/edit with image_urls)
 */
export type ImageConditioning = 'text_only' | 'photo_edit';

export interface GeneratedImageResult {
  imageUrl: string | null;
  provider: ImageProviderName;
  model: string;
  promptUsed: string;
  revisedPrompt?: string;
  /** What conditioning the produced image actually used. Null/undefined for
   *  legacy callers that didn't track this. */
  conditioning?: ImageConditioning | null;
  /** When the call used a customer photo as conditioning input, the source
   *  URL passed to the provider. Useful for diagnostics + audit. */
  referencePhotoUrl?: string | null;
  latencyMs: number;
  error?: string | null;
}

/**
 * Per-page mode hint for photo-conditioned providers. Lets fulfillment ask
 * for stronger conditioning on a cover/page-1 vs lighter conditioning on
 * later interior pages without changing the prompt itself. The provider may
 * ignore this hint if the underlying model does not differentiate.
 */
export type ImageConditioningMode = 'reference' | 'edit' | 'cover' | 'interior';

export interface ImageProviderInput {
  prompt: string;
  /**
   * Optional reference image (data URL or https URL) for identity grounding.
   * Used by the photo-conditioned (fal_edit) path. Ignored by text-only
   * providers.
   */
  referenceImageUrl?: string | null;
  /**
   * Multi-image variant. Some image-edit models accept multiple references
   * (e.g. character + scene). When both are set, providers may concatenate
   * referenceImageUrl with imageUrls; concrete behavior is per-provider.
   */
  imageUrls?: string[] | null;
  /** Hint to the provider about how aggressively to condition on the photo. */
  conditioningMode?: ImageConditioningMode | null;
  /**
   * When true and no reference image is supplied, providers MUST return a
   * structured failure rather than attempt a text-only fallback. This is the
   * machine-checkable shape of the rule the orchestrator already enforces
   * for photo-based books: if the customer uploaded a photo, the order
   * cannot ship text-only art under any provider's hood.
   *
   * Today the orchestrator enforces the policy via its provider chain
   * (no text-only lane in the photo branch). This flag lets individual
   * providers self-enforce as defense-in-depth, and lets future callers
   * that supply their own provider chain still get the same protection.
   */
  referenceImageRequired?: boolean;
}

/**
 * Minimal `put` surface that providers needing to rehost their inline output
 * (notably gemini — Google returns base64 inline, not a hosted URL) call to
 * push the bytes to durable storage and get back a public URL.
 *
 * Shape matches `@vercel/blob`'s `put`, narrowed to the options HSB actually
 * uses. Tests inject a stub so the upload path is exercised without touching
 * the network or Blob. Production code falls back to `@vercel/blob`'s real
 * `put` when this dep is absent.
 */
export interface BlobPutOptions {
  access: 'public';
  contentType?: string;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  token?: string;
}
export interface BlobPutResult {
  url: string;
}
export type BlobPutFn = (
  path: string,
  body: Buffer | Uint8Array,
  opts: BlobPutOptions,
) => Promise<BlobPutResult>;

export interface ImageProviderDeps {
  fetch?: typeof globalThis.fetch;
  /**
   * Optional Vercel Blob `put` override. Currently used only by the Gemini
   * image provider to rehost its inline base64 output as a public HTTPS URL.
   * When unset, the provider falls back to dynamic-importing `@vercel/blob`
   * if `BLOB_READ_WRITE_TOKEN` is configured, or returns the image as a
   * `data:` URL if not (dev-friendly degraded mode).
   */
  blobPut?: BlobPutFn;
}

export interface ImageProvider {
  name: ImageProviderName;
  generate(input: ImageProviderInput, deps?: ImageProviderDeps): Promise<GeneratedImageResult>;
}
