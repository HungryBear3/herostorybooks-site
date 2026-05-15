# Direct Gemini/Google image + prose routing

## What this covers

How HeroStoryBooks selects between the **direct Google Generative Language
API** path and the **FAL-hosted** path for both per-page **prose** and
per-page **images**. Read this before flipping any of the env flags below.

## TL;DR

| Surface | Direct Google path | FAL path | Status today |
|---|---|---|---|
| Per-page **prose** | `gemini-2.5-flash` via REST | (no equivalent — falls back to Ollama, then OpenAI, then template) | **Wired.** Selected when `HSB_ENABLE_GEMINI_PAGE_PROSE=true` + `GOOGLE_GEMINI_API_KEY` set. See `src/lib/story-provider-gemini.ts` and the gate at `src/lib/story-generator.ts:885`. |
| Per-page **images** | `gemini-2.5-flash-image-preview` via REST | Seedream v4 edit → Nano Banana edit, both via `fal.run` | **Wired but gated off-by-default.** Selected when `HSB_ENABLE_GEMINI_IMAGE=true` + `GOOGLE_GEMINI_API_KEY` set. See `src/lib/image-provider-gemini.ts` and `defaultProviderOrder` in `src/lib/image-generator.ts`. |

The OpenAI image API is **never** in the default chain. The legacy
`HSB_ENABLE_OPENAI_IMAGE` gate exists only to allow a caller that
explicitly constructs its own provider list to opt in — it never affects
the default chain.

## Env flags

### Prose (already in production-ready state)

| Flag | Effect |
|---|---|
| `HSB_ENABLE_GEMINI_PAGE_PROSE=true` | Enables the direct Gemini per-page prose path as the highest-priority LLM option. |
| `GOOGLE_GEMINI_API_KEY=<key>` | Required when the Gemini prose path is enabled. Without it the gate is treated as off. |
| `HSB_GEMINI_PAGE_PROSE_MODEL=<model>` | Optional. Defaults to `gemini-2.5-flash`. |

If the Gemini prose call fails (timeout, 4xx/5xx, validation failure 3×, blocked prompt), the generator records `fallbackError` and degrades to the existing template path — exactly like the OpenAI/Ollama branches do.

### Images (new — gated off by default)

| Flag | Effect |
|---|---|
| `HSB_ENABLE_GEMINI_IMAGE=true` | Promote direct Gemini to **primary** in the photo-edit chain. |
| `GOOGLE_GEMINI_API_KEY=<key>` | Required. Same key as prose. If unset, the gate is treated as off and the chain falls back to the legacy `[seedream, fal_edit]` order. |
| `HSB_GEMINI_IMAGE_FAL_FALLBACK=true` | Optional. If set, the FAL Seedream + Nano Banana providers are appended after Gemini as fallback. **Off by default** — when Gemini is enabled, the chain is `[gemini]` only. The brief requires FAL fallback to be an explicit operator decision. |
| `HSB_GEMINI_IMAGE_MODEL=<model>` | Optional. Defaults to `gemini-2.5-flash-image-preview`. |
| `HSB_GEMINI_IMAGE_REQUEST_TIMEOUT_MS=<ms>` | Optional. Defaults to `60000`. Per-request timeout (AbortSignal). |

The text-only branch (no reference photo) remains intentionally empty — we never silently degrade a photo-based book to text-only art.

## Resulting chain at runtime

`defaultProviderOrder(input)` in `src/lib/image-generator.ts` produces:

- No reference photo → `[]` (structured failure surfaced upstream).
- Reference photo + `HSB_ENABLE_GEMINI_IMAGE=true` + key set + `HSB_GEMINI_IMAGE_FAL_FALLBACK=true` → `[gemini, seedream_edit, fal_edit]`.
- Reference photo + `HSB_ENABLE_GEMINI_IMAGE=true` + key set + fallback flag unset → `[gemini]`.
- Reference photo + `HSB_ENABLE_GEMINI_IMAGE` not `true` (or key missing) → `[seedream_edit, fal_edit]` (legacy default).

## Before flipping `HSB_ENABLE_GEMINI_IMAGE=true` in production

The Gemini direct API returns generated images as inline base64 (not a
hosted URL), so this provider returns a `data:image/...;base64,...` URL.

**Verify these consumers accept data URLs before flipping the gate, or add a
blob-upload step inside `image-provider-gemini.ts` first:**

1. `src/lib/fulfillment.ts` — `imageUrls` array gets persisted onto the order and embedded into proof / version-history records. Confirm the persistence layer accepts data URLs (size + serialisation).
2. PDF builders in `src/lib/pdf-builder.ts` and friends — confirm they can embed images from a `data:` URL rather than fetching an `https:` URL.
3. Anywhere that fetches an `imageUrl` to re-process (e.g. proof preview, admin diagnostics, retry flow).

If any of those need a real URL, the simplest fix is: in
`image-provider-gemini.ts` after decoding the inline image, upload it to
Vercel Blob and return the resulting public URL, mirroring what the FAL
providers already return.

## Test coverage

- `tests/image-provider-gemini.test.ts` — unit tests for the provider itself (auth missing, no reference, happy path, model override, 429, blocked prompt, no-image-returned, reference-fetch failure, camelCase response shape, **API key never leaks into error strings**).
- `tests/image-provider-gemini-routing.test.ts` — chain-composition contract: gate states, key presence, fallback flag, photo-absent branch, OpenAI never appearing.
- `tests/story-provider-gemini.test.ts` — prose-path contract (gate off, gate on without key, model override, 503, validation-failure-3×, empty candidates, precedence, key redaction).

## Failure modes & where they show up

- **Missing key (image)** → provider returns structured failure with `error='GOOGLE_GEMINI_API_KEY not set'`. The orchestrator logs `errorClass=auth_missing` and falls through to the next provider if any.
- **Missing key (prose)** → `isGeminiPageProseEnabled() && geminiApiKey` short-circuits; the next-priority prose path (Ollama → OpenAI → template) runs.
- **Quota / rate-limit (4xx/5xx)** → provider returns `error='Gemini API error <code>: <redacted-body-tail>'`. API key is replaced with `[redacted-api-key]` in the tail.
- **Safety block** → provider returns `error='Gemini blocked: <reason>'`. The orchestrator surfaces this as `errorClass=other`.
- **Empty/malformed response** → provider returns `error='Gemini returned no image candidate'` (image) or `error='Gemini returned empty content'` (prose).
