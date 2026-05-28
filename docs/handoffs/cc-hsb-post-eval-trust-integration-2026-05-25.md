# Claude Code Handoff: HSB Post-Eval Trust Integration

Date: 2026-05-25

## Context

Alexy wants the image-quality decision work first, then the design integration work. The eval harness now exists:

```bash
node scripts/build-image-eval-contact-sheet.mjs \
  --run ../artifacts/hsb-family-photo-eval-2026-05-25
```

Generated sheet:

```text
../artifacts/hsb-family-photo-eval-2026-05-25/contact-sheets/gpt-vs-flux2-contact-sheet.html
```

Do not copy private family references, GPT exports, or generated likeness outputs into `public/`.

## Goal

After GPT-vs-FLUX comparison, integrate the strongest buyer-trust design ideas into real app components without changing fulfillment, checkout pricing, image generation, or production routing.

## Priority Order

1. Extract one reusable proof/trust section from the standalone mockups.
2. Improve the homepage/sample proof gallery with real Lukas proof assets already in `public/assets`.
3. Improve family-review admin operator flow only after the public trust surfaces are clean.

## Guardrails

- No production deploy in this task.
- Keep changes behind existing pages or an internal preview route until reviewed.
- Do not add new image-generation provider logic.
- Do not alter Stripe, order fulfillment, Lulu, webhook, or pricing logic.
- Do not introduce private child/family photos into the app tree.
- Preserve the existing proof-first claims:
  - digital proof before print
  - revisions before approval
  - digital is safest for Father’s Day timing
  - printed book timing is carrier-dependent
  - photos are not sold or used to train AI

## Suggested Implementation

Use Direction B from the buyer-trust mockup as the source of truth:

```text
/Users/abigailclaw/Downloads/Hero Story Books - Buyer-Trust Directions.html
```

Create a production-shaped component:

```text
src/components/landing/ProofFirstTrust.tsx
```

Suggested content blocks:

- Hero headline: “You see the whole book. Then we print it.”
- Three-step proof flow:
  - Tell us who it is for
  - We craft the proof
  - You approve, then we print or deliver
- Real proof artifacts:
  - `/assets/hsb-lukas-print-story-07.jpg`
  - `/assets/hsb-lukas-print-story-16.jpg`
  - `/assets/hsb-lukas-print-story-21.jpg`
  - `/assets/lukas-dino-bedtime-proof.jpg`
- Trust facts:
  - Proof-first approval
  - Free revisions before approval
  - Photo privacy
  - Stripe checkout

Wire it first into an internal route such as:

```text
src/app/design-previews/hsb-trust-section/page.tsx
```

Only after visual review, consider replacing or tightening:

- `SamplePreviewSection`
- `PrivacyBand`
- any duplicated trust copy in `EditorialHomePage`

## Verification

Run:

```bash
npm test
npm run build
```

If the repo already has unrelated dirty changes or unrelated test failures, report them explicitly and do not revert them.

## Done Criteria

- Internal preview route renders the extracted trust section.
- No private eval/family images are referenced.
- Mobile and desktop layouts do not overlap text or crop the child face badly.
- Existing tests/build pass, or failures are clearly identified as preexisting/unrelated.
