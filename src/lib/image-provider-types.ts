// Shared provider types. Imported by image-generator + per-provider modules.

export type ImageProviderName = 'openai' | 'fal';

export interface GeneratedImageResult {
  imageUrl: string | null;
  provider: ImageProviderName;
  model: string;
  promptUsed: string;
  revisedPrompt?: string;
  latencyMs: number;
  error?: string | null;
}

export interface ImageProviderInput {
  prompt: string;
  /** Optional reference image (data URL or https URL) for identity grounding. */
  referenceImageUrl?: string | null;
}

export interface ImageProviderDeps {
  fetch?: typeof globalThis.fetch;
}

export interface ImageProvider {
  name: ImageProviderName;
  generate(input: ImageProviderInput, deps?: ImageProviderDeps): Promise<GeneratedImageResult>;
}
