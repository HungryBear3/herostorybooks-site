# CC Prompt — HSB multi-family guided photo intake — 2026-06-16

You are Claude Code working on HeroStoryBooks in an isolated branch/worktree.

## Mission
Build a preview-first, feature-flagged extension of the existing HSB checkout/draft-intake flow so buyers can optionally attach guided reference photos to supporting family members/pets, not just the primary child.

This is a customer-intake/product-quality feature. It is **not** a production launch request.

## Current facts from Rex inspection
- Repo: `/Users/abigailclaw/.openclaw/workspace/herostorybooks-site`
- Current branch observed: `hsb/guided-photo-capture-eric`
- Existing checkout already has supporting-character UI around `src/app/checkout/checkout-form.tsx` lines ~1071+:
  - “Who else should appear?”
  - `familyCharacters`
  - copy: “Add family members or pets for the story text and scene notes. The child photo remains the main visual identity reference.”
- Existing old handoff exists: `docs/handoffs/hsb-multi-family-characters-2026-05-25.md`.
- HER-51 split draft/asset intake PR #66 exists separately and fixed preview draft Blob reads via `list()` + exact pathname + `readBlobText(...)`.

## Hard boundaries
- Do not deploy production.
- Do not merge to production/main/live branches.
- Do not run live Stripe/payment/checkout completion.
- Do not send customer emails.
- Do not release proofs.
- Do not submit print/Lulu/RPI/provider actions.
- Do not post/schedule social.
- Do not call paid image-generation/provider routes for family photos.
- Do not use Gemini/Nano Banana for HSB image generation.
- Do not expose secrets or raw private photo URLs in logs/UI/tests.
- Do not claim multi-family likeness is guaranteed.

## Product promise
Safe customer-facing promise:
- Primary child photo remains the main visual identity reference.
- Supporting family members/pets can appear in story text and scene notes.
- Optional reference photos can help the reviewer understand family-member details.
- Secondary reference photos are **reference-only**, not a guaranteed exact likeness.

Unsafe promise unless separately proven and approved:
- “We recreate every family member’s likeness.”
- “Upload photos for every family member and we make them all look exact.”
- Any biometric/Face ID/face-scan framing.

## Feature flag
Gate all new multi-family photo UI and behavior behind a preview/client flag, e.g.:

```env
NEXT_PUBLIC_HSB_MULTI_FAMILY_PHOTO_INTAKE=true
```

Flag off:
- Existing one-child checkout and supporting-character text fields behave exactly as before.
- No new required fields.
- Existing orders/tests stay compatible.

Flag on:
- Each supporting character may optionally get 0–1 reference photo in first pass.
- Hard cap total supporting photo uploads, recommended max 4.
- Child photo remains the only required/primary visual identity anchor.

## Implementation approach
### 1. Model / types
Add or extend typed metadata for supporting-character photo assets:

```ts
type SupportingCharacterPhotoAsset = {
  characterId: string;
  assetId: string;
  filename?: string;
  contentType: string;
  sizeBytes: number;
  role?: string;
  name?: string;
  relationshipLabel?: string;
  consentConfirmed: boolean;
  referenceOnly: true;
  uploadedAt: string;
};
```

Persist this metadata on the draft/order record in a backward-compatible optional field, e.g. `familyCharacterPhotoAssets?: SupportingCharacterPhotoAsset[]`.

### 2. UI
In `src/app/checkout/checkout-form.tsx`, when the flag is on and `familyCharacters.length > 0`:
- Show an optional “Add reference photo” area inside each supporting-character card.
- Keep it small and mobile-first.
- Copy direction:
  - “Optional: add a reference photo for this family member or pet.”
  - “Used only as reviewer guidance; your child’s photo remains the main visual reference.”
  - “I have permission to share this photo for private book prep.”
- Show upload progress/success/error/retry states.
- Do not make secondary photos required.
- Avoid scary legal overcopy, but keep consent clear.

### 3. Upload path
Prefer the split draft/asset intake pattern over bloating `/api/order`.

Possible pattern:
- Draft exists first.
- Upload child/primary asset through existing route.
- Upload supporting-character photo asset with metadata:
  - `assetRole=family-character-reference`
  - `characterId=<id>`
  - `referenceOnly=true`
  - `consentConfirmed=true`
- Server validates:
  - character exists in draft payload
  - max 1 photo per supporting character for first pass
  - max total supporting photos <= 4
  - accepted image types only
  - size cap consistent with current upload policy
  - no public path leakage

If PR #66 split-intake code is not merged into your branch, do not blindly reimplement it. Either base your branch on that PR/branch or leave a clear dependency note.

### 4. Server validation / persistence
- Sanitize character names/roles/relationship labels.
- Persist photo metadata only, not raw files in order JSON.
- Asset paths should remain private Blob paths/ids.
- Existing order paths with no `familyCharacterPhotoAssets` must behave exactly as before.
- Avoid logging filenames if they may contain private family names; sanitize or omit.

### 5. Story/art-direction integration
Add helper output for operator/story planning, not automated likeness claims.

Example safe internal block:

```text
Supporting family references:
- Dad / Alex: optional private reference photo uploaded for reviewer guidance only. Use for broad details; do not promise exact likeness.
- Brody / family dog: reference photo uploaded for reviewer guidance; use markings/size/personality in scene notes.
```

Customer-facing copy should not expose internal labels, artifact ids, raw blob urls, or provider prompts.

### 6. Privacy / safety copy
Add tests/source checks that copy includes:
- private book prep / reviewer guidance
- permission/consent confirmation
- child remains primary visual anchor
- reference-only/no exact-likeness guarantee

And excludes:
- biometric
- face scan
- Face ID
- exact likeness guarantee
- public/social reuse

## Tests
Add focused tests before broad suite:
1. Flag-off checkout/order path remains unchanged.
2. Supporting character without photo still works.
3. Supporting character with photo persists metadata with `referenceOnly: true` and `consentConfirmed: true`.
4. Reject unsupported file type.
5. Reject oversized photo.
6. Reject photo for unknown `characterId`.
7. Reject >1 photo for same supporting character in first pass.
8. Reject >4 total supporting-character photos.
9. Story/art-direction helper includes safe reference-only language.
10. Customer copy does not include unsafe biometric/exact-likeness wording.
11. Mobile checkout still renders without overflow at 320px if Playwright/local browser test exists.

## Verification commands
Use repo-appropriate commands. At minimum:

```bash
git status --short --branch
npm test -- --run <new-focused-test-file>
npm test -- --run tests/checkout-split-asset-intake.test.ts
npm test
npm run build
```

If the repo uses a different test runner invocation for focused tests, adapt but report exact commands/results.

## Preview QA gate
Only after tests/build pass:
- Create or use a correct Vercel Preview for the HSB project only.
- No `--prod`.
- Smoke `/checkout` with flag enabled.
- Verify:
  - flag-off behavior remains normal in a local build or separate env
  - supporting character photo upload succeeds in preview namespace
  - finalize reaches test Stripe handoff only if using test keys, and stop before payment
  - no production orders/admin list contamination

Follow `hsb-safe-preview-qa-prep` rules if mutating preview QA is needed.

## Deliverables
Final report must include:
- branch/worktree
- changed files
- tests/build results
- preview URL if created
- exact feature flag used
- dependency on PR #66 if any
- residual risks
- explicit side-effect statement: no production deploy, live payment, customer email, proof release, print/Lulu/RPI/provider/social action.
