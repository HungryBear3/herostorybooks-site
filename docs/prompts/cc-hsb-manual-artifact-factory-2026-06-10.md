# CC handoff — HSB manual artifact factory

Branch/worktree: `/tmp/hsb-manual-artifact-factory` on `hsb/manual-artifact-factory` from `origin/hsb/deploy-candidate-20260602`.

## Goal
Turn paid HSB fulfillment from vague auto-fail states into a manual artifact factory:

1. Customer pays.
2. Order enters `manual_generation_required`.
3. Operator attaches/generates:
   - story brief
   - page plan
   - prose
   - art-direction packet
   - page images
   - proof PDF
   - QA report
4. Artifacts are attached to the order.
5. Human QA passes it.
6. Separate explicit release sends proof/customer email.
7. Print remains gated until customer proof approval + owner print-go.

## Non-negotiable constraints
- Tier 0–1 only unless Alexy gives scoped approval.
- No prod deploy/alias/env writes.
- No live order/payment/email/proof release/print mutation.
- No customer emails in attach/import/QA-pass paths.
- No print provider call in attach/import/QA-pass/release-proof paths.
- Subscription-first generation: do not use app OpenAI API/FAL/Gemini/RunPod for routine book generation.

## Backend tasks

### Slice 1 — status + payment parking
- Add `manual_generation_required` to `FulfillmentStatus` in `src/lib/fulfillment-types.ts` / related status unions.
- Stripe paid path should set paid order to `manual_generation_required` and **not** schedule normal `scheduleFulfillmentKickoff`.
- Replay/backfill/sweep/retry must not auto-run fulfillment from `manual_generation_required`.
- Admin retry should refuse or require a clearly separate emergency override.

Likely files:
- `src/app/api/webhooks/stripe/route.ts`
- `src/lib/fulfillment-types.ts`
- `src/lib/orders.ts`
- `src/lib/fulfillment.ts`
- `src/lib/fulfillment-backlog.ts`
- `src/lib/order-diagnostics.ts`
- `src/lib/order-status-view.ts`

Tests:
- Paid webhook parks to `manual_generation_required`.
- Paid webhook does not call kickoff.
- Replay/backlog excludes manual queue.
- Admin retry cannot silently auto-generate manual queue orders.

### Slice 2 — manual artifact model + import helper
Add a pure helper, likely `src/lib/manual-artifacts.ts`, with:
- Artifact kinds: `story_brief`, `page_plan`, `prose`, `art_direction_packet`, `page_image`, `proof_pdf`, `qa_report`.
- Additive order field: `artifactManifest?: ManualArtifactManifest | null` or `manualArtifacts?: ManualGenerationArtifact[]`.
- Validation/completeness helper: missing artifact list, page count check, proof presence, QA report presence.
- Patch builder that updates canonical existing fields too:
  - `storyMeta.source = 'manual'`
  - `pageArtifacts[].generationProvider = 'manual'`
  - `pageArtifacts[].generationModel = 'abby:manual-subscription'` or bounded operator label
  - `assetSource = 'live'`
  - `artDirectionPacket`
  - `storyArtifactUrl`
  - route decision/audit required by proof guard.

Tests:
- Missing artifacts keep order in `manual_generation_required`.
- Complete artifact set transitions to `awaiting_qa`, `qaStatus='pending'`.
- Page images build safe `PageArtifact[]` with manual lineage.
- Proof PDF writes include route decision + audit event.
- Fixture/internal/template lineage blocks release.

### Slice 3 — admin route + CLI import
Add:
- `POST /api/admin/orders/[orderId]/manual-artifacts`
- `scripts/import-manual-artifacts.mjs`

Route behavior:
- Require admin auth.
- Require paid, non-refunded order.
- Allow from `manual_generation_required`, maybe `awaiting_manual_art`, `failed_manual_review` only with explicit replace flag.
- Upload/record artifacts, hash binaries if present, persist via existing safe order write lock/CAS path.
- Transition to `awaiting_qa` only when complete.
- Never send customer email or call print.

CLI shape:
```bash
node scripts/import-manual-artifacts.mjs --order ord_123 --operator abby --manifest ./manual-artifacts/ord_123/manifest.json --dry-run
node scripts/import-manual-artifacts.mjs --order ord_123 --operator abby --manifest ./manual-artifacts/ord_123/manifest.json --commit
```

### Slice 4 — split QA pass from customer release
Existing `/qa-pass` couples QA pass with customer email. Split it.

Add/refactor:
- `recordQaPassOnly()` — records QA pass, sends no email.
- `releaseCustomerProofAfterQa()` — explicit proof/customer email release, reruns release guard.
- New routes:
  - `POST /api/admin/orders/[orderId]/qa-mark-pass`
  - `POST /api/admin/orders/[orderId]/release-proof`

Tests:
- QA mark pass does not email.
- Release-proof refuses before QA pass.
- Release-proof sends only after QA pass and release guard pass.
- Print remains blocked until customer approval + owner print-go.

## Suggested verification
- `npm test`
- `npm run build`
- `graphify update .` after code changes.

## Known risk seams
- Existing webhook/replay/admin retry can auto-kick fulfillment; must be neutralized for manual queue.
- Proof artifacts require route-decision audit, otherwise current guard rejects.
- Artifact writes must not clobber page review state; use existing order write lock/CAS-safe persist path.
