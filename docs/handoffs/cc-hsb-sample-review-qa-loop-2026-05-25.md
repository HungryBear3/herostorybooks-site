# Claude Code Handoff: HSB Sample Review QA Loop

Date: 2026-05-25

## Task

Build the internal QA loop for HeroStoryBooks generated sample images, then tighten proof-first trust surfaces and write the operator runbook.

## Context

Repo:

```text
/Users/abigailclaw/.openclaw/workspace/herostorybooks-site
```

Current active image-generation decision:

- Use the subscription GPT image-generation workflow for HSB sample/eval/book-art work.
- Do not route routine HSB image work through local OpenAI API keys, app API routes, FLUX/fal, Gemini/Nano Banana, or provider harnesses.
- API/provider work is a separate investigation only if Alexy explicitly asks for it.

Current eval artifacts:

```text
../artifacts/hsb-family-photo-eval-2026-05-25/
../artifacts/hsb-family-photo-eval-2026-05-25/contact-sheets/gpt-vs-flux2-contact-sheet.html
../artifacts/hsb-family-photo-eval-2026-05-25/gpt-exports/
```

Recent QA findings from Alexy:

- Bedtime/father-reading sample: Lukas likeness 6/10, father likeness 7/10, otherwise acceptable.
- Family-reading sample: Lukas likeness 7/10, father likeness 3/10 because father was Asian-coded, mother likeness hard to judge, Brody likeness 8/10, and an extra/random child appeared behind father/son.
- Corrected family-reading candidates failed: one still had two kids, father 4/10, mother 2/10; two candidates looked materially identical.

The immediate problem is not just image quality. The operator workflow has no structured place to capture candidates, scores, rejection reasons, duplicate detection, or next-prompt notes.

## Priority Order

1. Build lightweight internal sample-review tracker.
2. Add stricter failed-sample tagging in family-review/admin.
3. Tighten proof-preview buyer-trust copy/UI using existing real sample assets.
4. Add the GPT subscription generation runbook/checklist.

## Files To Inspect First

```text
src/lib/family-review/store.ts
src/app/family-review/admin/admin-board.tsx
src/app/api/family-review/admin/submissions/[submissionId]/sample/route.ts
src/app/api/family-review/admin/submissions/[submissionId]/status/route.ts
src/app/family-review/review/[reviewToken]/review-portal.tsx
src/components/landing/ProofFirstTrust.tsx
src/components/editorial-site.tsx
docs/runbooks/gpt-vs-flux-image-eval.md
scripts/build-image-eval-contact-sheet.mjs
tests/family-review-privacy.test.ts
tests/family-review-sample-briefs.test.ts
```

Also run:

```bash
git status --short
```

There is likely an existing dirty worktree. Do not revert unrelated changes.

## Implementation Goals

### 1. Internal Sample-Review Tracker

Add a small data model for image sample QA that can live alongside family-review submissions without storing private reference images in public assets.

Minimum useful fields:

- `candidateId`
- `sampleRunId`
- `briefId`
- `assetId`
- `createdAt`
- `promptSummary`
- `compositionNotes`
- `likenessScores`
  - child/Lukas
  - father
  - mother
  - sibling/Brody when present
- `status`
  - `candidate`
  - `rejected`
  - `needs_revision`
  - `approved_for_parent_review`
- `rejectionReasons`
  - `extra_person`
  - `extra_child`
  - `wrong_ethnicity`
  - `bad_child_likeness`
  - `bad_parent_likeness`
  - `unclear_parent_face`
  - `near_duplicate`
  - `text_artifact`
  - `pet_rendering_error`
  - `composition_mismatch`
  - `other`
- `nextPromptNotes`

Keep it simple and JSON-friendly. Prefer adding optional fields to the family-review store/types rather than introducing a database or new external service.

### 2. Admin Tagging UX

In the family-review admin board, add operator controls to tag failed sample candidates quickly.

Expected controls:

- Select sample candidate/pass.
- Mark status.
- Add rejection reason tags.
- Add concise next-prompt note.
- Preserve history instead of overwriting prior feedback.

Do not make this parent-facing unless a sample is explicitly approved for parent review.

### 3. Proof-Preview Trust Surface

Use existing real/public sample assets only. Do not add private family eval exports to `public/`.

Target surfaces:

- `src/components/landing/ProofFirstTrust.tsx`
- `src/components/editorial-site.tsx`
- existing sample/proof sections already on homepage, `/samples`, `/checkout`, or `/fathers-day`

Copy direction:

- Emphasize: “We review the proof before it goes to print.”
- Emphasize: “You approve the book before print.”
- Avoid overpromising perfect likeness.
- Avoid “AI magic” framing.
- Avoid “instant PDF” wording.
- Make the manual QA loop feel like a trust feature, not a defect.

Use real Lukas proof assets already in `public/assets`, such as:

```text
public/assets/hsb-lukas-print-front-cover.jpg
public/assets/hsb-lukas-print-story-07.jpg
public/assets/hsb-lukas-print-story-16.jpg
public/assets/hsb-lukas-print-story-21.jpg
public/assets/lukas-dino-bedtime-proof.jpg
public/assets/lukas-dino-companion-proof.jpg
```

### 4. GPT Subscription Runbook

Create or update:

```text
docs/runbooks/gpt-subscription-sample-generation.md
```

The runbook should include:

- Required reference inputs.
- How to name and save exports under `../artifacts/hsb-family-photo-eval-YYYY-MM-DD/gpt-exports/`.
- Prompt constraints for person count, parent ethnicity, mother face visibility, pet rendering, and duplicate avoidance.
- Pre-send rejection gate:
  - exactly intended people
  - no background child/extra face
  - no wrong parent ethnicity
  - child likeness passable
  - parent face visible enough to judge
  - composition materially different from prior failed candidates
- How to record Alexy’s scores and rejection reasons.
- Explicit note: subscription GPT is the default workflow; do not switch providers or API routes for routine HSB sample generation.

## Constraints

- No production deploy.
- No Stripe, Lulu, payment, webhook, fulfillment, order-pricing, or live customer-action changes.
- No Gemini/Nano Banana.
- No new image-provider plumbing.
- Do not copy private reference photos or private generated family likeness images into `public/`.
- Do not weaken privacy guarantees around child/family photos.
- Keep the implementation single-purpose. Avoid broad landing-page redesigns.

## Verification

Run the smallest meaningful set first, then broader checks if the touched files justify it:

```bash
npm test -- family-review
npm test -- samples
npm test
npm run build
```

If exact test filters are not supported, use the closest repo-supported commands and report what ran.

If unrelated tests fail because the worktree already has broad dirty changes, identify the failures and do not revert unrelated files.

## Done Criteria

- Admin reviewers can record candidate status, scores, rejection tags, and next-prompt notes.
- Failed candidates can be tagged with the reasons Alexy is currently surfacing manually.
- Approved samples remain the only ones that should be parent-facing.
- Buyer-facing proof copy reinforces manual review/proof approval without implying perfect likeness.
- GPT subscription runbook exists and matches the current decision.
- Tests/build are run and results are reported.

## Suggested Commit Message

```text
feat(hsb): add sample QA tracker and GPT generation runbook
```
