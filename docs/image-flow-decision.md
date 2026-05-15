# HSB Image-Flow Decision

**Date:** 2026-05-15
**Status:** Active (supersedes any prior RunPod/Comfy/PuLID assumption)
**Authority:** This document is the source of truth for which provider lane HSB uses for personalized page art. Other docs referring to RunPod/Comfy/PuLID as the active flow are archived/optional and should defer to this file.

## Decision summary

| Role | Provider |
|---|---|
| **Lead lane** | **direct Gemini Nano Banana** (Google Generative Language API; preferred image model for the next preview test: `gemini-2.5-flash-image`) |
| **Fallback / secondary A/B** | fal.ai Nano Banana edit (`fal-ai/nano-banana/edit`) |
| **Repair / support** | fal.ai Seedream/Seedance-family edit (`fal-ai/bytedance/seedream/v4/edit`) |
| **Not current default** | RunPod / Comfy / PuLID — historical only |

## Benchmark variants (lead lane)

The direct-Gemini lead lane has three prompt/style variants worth pinning as known-good benchmarks for future page work:

1. `ready-direction`
2. `free-look-tuned`
3. `natural-negative-space`

## Best page benchmark

- **Primary:** `p19 — natural-negative-space` and `p19 — ready-direction` (direct Gemini Nano Banana). Strongest combination of identity, watercolor style, integrated text-safe space, and low artifact risk per the 2026-05-15 visual scoring pass.
- **Family-opener benchmark:** `p01 — free-look-tuned` (direct Gemini Nano Banana).
- **Adventure-page benchmark:** `p16 — ready-direction` (direct Gemini Nano Banana); needs an explicit text-space plan because the scene is busy.

## Evidence

- Inventory: [`rex/briefings/hsb-image-flow-audit/FLOW_INVENTORY.md`](../../rex/briefings/hsb-image-flow-audit/FLOW_INVENTORY.md)
- Scoring guide: [`rex/briefings/hsb-image-flow-audit/SCORING_GUIDE.md`](../../rex/briefings/hsb-image-flow-audit/SCORING_GUIDE.md)
- Scoring sheet (template): [`rex/briefings/hsb-image-flow-audit/SCORING_SHEET.csv`](../../rex/briefings/hsb-image-flow-audit/SCORING_SHEET.csv)
- Visual scoring results: [`rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_RESULTS.md`](../../rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_RESULTS.md)
- Visual scoring filled: [`rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_FILLED.csv`](../../rex/briefings/hsb-image-flow-audit/VISUAL_SCORING_FILLED.csv)
- Executive summary: [`rex/briefings/hsb-image-flow-audit/SUMMARY.md`](../../rex/briefings/hsb-image-flow-audit/SUMMARY.md)

(Paths above are workspace-relative from `herostorybooks-site/docs/`. Audit files live outside the repo under `/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-image-flow-audit/`.)

## Code pointers

- Gemini provider (lead lane): `src/lib/image-provider-gemini.ts`
- fal.ai Nano Banana provider (fallback): `src/lib/image-provider-fal-edit.ts`
- fal.ai Seedream provider (repair/support): `src/lib/image-provider-seedream-edit.ts`
- Provider type/contract: `src/lib/image-provider-types.ts`
- Orchestrator + default chain composition: `src/lib/image-generator.ts` (see `defaultProviderOrder`)
- Routing runbook (env flags + production-readiness checklist): `docs/runbooks/gemini-image-routing.md`

## Model-name caution

Earlier local smoke testing found `gemini-2.5-flash-image-preview` could return
404 while the available model list included `models/gemini-2.5-flash-image`.
Before the controlled Preview test, verify the deployed env/code path is using a
currently available Gemini image model. If code or runbook defaults still refer
to the `-preview` model ID, treat that as a configuration item to fix before
closing the customer-quality gate.

## Next gate

1. **No new generation** off this audit. The next gate is a single **controlled preview test** to confirm the lead-lane pipeline end-to-end on a non-production order, and it requires **explicit approval before kicking off**.
2. After preview-test sign-off, run a **native-resolution / print-readiness check** on the resulting pages (the existing local samples are mostly 1024×1024; 8.5×8.5 in at 300 dpi needs 2550×2550 for clean Lulu print).
3. Only after print-readiness passes can the lead lane be considered for any Lulu submission. Lulu / payment / production state remains **HOLD** until then.

## Not in scope of this decision

- Pricing, checkout, payment, fulfillment-submission, Lulu, Stripe, Supabase, Vercel deploy state. None changed by this audit.
- Story/prose-side provider routing (separate Gemini per-page prose path, see `src/lib/story-provider-gemini.ts` and the same routing runbook).
- Reviving RunPod/Comfy/PuLID. Those notes remain archived and accessible if someone explicitly chooses to revisit, but they are not the default and should not be cited as current behaviour.
