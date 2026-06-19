# HSB Image-Flow Decision

**Date:** 2026-05-19
**Status:** Active (supersedes any prior RunPod/Comfy/PuLID assumption)
**Authority:** This document is the source of truth for which provider lane HSB uses for personalized page art. Other docs referring to RunPod/Comfy/PuLID as the active flow are archived/optional and should defer to this file.

## Decision summary

| Role | Provider |
|---|---|
| **Lead lane** | **fal.ai FLUX.2 [pro] multi-reference** (`fal-ai/flux-2-pro` / edit-capable FLUX.2 endpoint, exact endpoint verified at eval time) |
| **Fallback only if eval fails** | PuLID + FLUX.1 dev via fal hosted endpoint |
| **Premium later** | Per-order FLUX.2 LoRA for hardcover tier only, after digital is shipping and converting |
| **Hard no** | Google Gemini / Nano Banana, self-hosted Comfy/RunPod as primary ops path, OpenAI as production primary |

## Why Gemini / Nano Banana is no longer allowed

The previous 2026-05-15 decision selected direct Gemini / Nano Banana for the next image test. That is revoked.

Google Gemini API terms prohibit using the services as part of an API client directed at, or likely accessed by, people under 18. HeroStoryBooks is a personalized children's storybook product, so this is not an acceptable production dependency or fallback.

## Current gate

Do not write new HSB image-pipeline/product code until the FLUX.2 eval produces gift-quality evidence.

Runbook: [`docs/runbooks/flux2-photo-eval.md`](runbooks/flux2-photo-eval.md)

Required gate:

- Run the cheap parent sanity check first: 5 consented real child photos, 3 illustrations per child, parent answer to "would you give this as a gift?"
- Then run the full 10-photo / 20-scene eval before committing a week of engineering.
- Commit engineering only if the agreed go/no-go bars pass.
- If FLUX.2 [pro] and fallback PuLID + FLUX.1 dev miss after one week of prompt/reference iteration, pivot toward a Wonderbly-style template + color-picker product instead of AI-from-photo.

## Production reliability requirement

If fal goes into production, use the queue/webhook flow, not synchronous calls.

Requirements:

- Persist every fal `request_id` and `gateway_request_id` on order/artifact creation.
- Make webhook handling idempotent.
- Add a 5-minute sweep for stuck or missing webhooks.
- Treat pipeline reliability as higher priority than marginal model differences.

## Evidence

- Inventory: [`rex/briefings/hsb-image-flow-audit/FLOW_INVENTORY.md`](../../rex/briefings/hsb-image-flow-audit/FLOW_INVENTORY.md)
- Scoring guide: [`rex/briefings/hsb-image-flow-audit/SCORING_GUIDE.md`](../../rex/briefings/hsb-image-flow-audit/SCORING_GUIDE.md)
- Scoring sheet (template): [`rex/briefings/hsb-image-flow-audit/SCORING_SHEET.csv`](../../rex/briefings/hsb-image-flow-audit/SCORING_SHEET.csv)
- Visual scoring results: [`rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_RESULTS.md`](../../rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_RESULTS.md)
- Visual scoring filled: [`rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_FILLED.csv`](../../rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_FILLED.csv)
- Executive summary: [`rex/briefings/hsb-image-flow-audit/SUMMARY.md`](../../rex/briefings/hsb-image-flow-audit/SUMMARY.md)

(Paths above are workspace-relative from `herostorybooks-site/docs/`. Audit files live outside the repo under `/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-image-flow-audit/`.)

## Code pointers

- Previous Gemini provider (revoked for HSB image production): `src/lib/image-provider-gemini.ts`
- Previous fal.ai Nano Banana provider (revoked for HSB image production): `src/lib/image-provider-fal-edit.ts`
- Previous fal.ai Seedream provider (historical repair/support only): `src/lib/image-provider-seedream-edit.ts`
- Provider type/contract: `src/lib/image-provider-types.ts`
- Orchestrator + default chain composition: `src/lib/image-generator.ts` (see `defaultProviderOrder`)
- Deprecated Gemini routing runbook: `docs/runbooks/gemini-image-routing.md`

## Model-name caution

Ignore Gemini image model-name notes for HSB image production. They remain only as historical context.

## Next gate

1. Run the $5 parent gift-quality sanity check.
2. Run the 10-photo FLUX.2 [pro] multi-reference eval if the parent sanity check is not an obvious fail.
3. Only after the eval passes, write integration code using fal queue/webhook architecture.
4. After code exists, run a native-resolution / print-readiness check. 8.5×8.5 in at 300 dpi needs 2550×2550 for clean Lulu print.
5. Lulu / payment / production state remains **HOLD** until explicit approval.

## Not in scope of this decision

- Pricing, checkout, payment, fulfillment-submission, Lulu, Stripe, Supabase, Vercel deploy state. None changed by this audit.
- Story/prose-side provider routing (separate Gemini per-page prose path, see `src/lib/story-provider-gemini.ts` and the same routing runbook).
- Reviving self-hosted RunPod/Comfy. Those notes remain archived and accessible if someone explicitly chooses to revisit, but they are not the default and should not be cited as current behaviour.
