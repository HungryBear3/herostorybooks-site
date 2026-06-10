# CD handoff — HSB manual artifact factory UI

Repo/worktree: `/tmp/hsb-manual-artifact-factory` branch `hsb/manual-artifact-factory`.

## Goal
Make the admin/operator workflow obvious and safe:
- paid order enters `manual_generation_required`
- operator attaches required artifacts
- internal QA pass is recorded without emailing customer
- separate explicit release sends proof/customer email
- print remains customer approval + owner print-go only

## UI tasks

### First-cut scope limit
Do **not** build per-artifact upload/edit buttons in the first PR. Keep admin surface to three actions:
1. Attach artifact bundle
2. Mark QA pass/fail
3. Release proof/customer email

The panel can show artifact checklist/completeness, but editing is bundle-first only.

### Admin order detail
Add a “Manual Artifact Factory” panel to `/admin/orders/[orderId]`:
- Artifact checklist:
  - story brief
  - page plan
  - prose
  - art-direction packet
  - page images, count and missing pages
  - proof PDF
  - QA report
- State tiles:
  - Paid
  - Manual generation required
  - Artifacts attached
  - Proof artifact built
  - QA passed
  - Customer proof released
  - Customer approved
  - Owner print-go
- Warnings on buttons:
  - “Attach manual artifacts — does not email customer.”
  - “Mark QA pass — does not email customer.”
  - “Release customer proof/email — sends customer email.”
  - “Owner print-go — can submit to print; requires separate approval.”

Likely files:
- `src/app/admin/orders/[orderId]/page.tsx`
- `src/app/admin/orders/[orderId]/detail-client.tsx`
- `src/app/admin/orders/[orderId]/page-review-grid.tsx`
- `src/app/admin/orders/ops-client.tsx`

### QA Room
Add filter/label for manual queue:
- `manual_generation_required`
- existing `awaiting_manual_art`
- `qa_passed_pending_release` if backend adds it; otherwise `awaiting_qa + qaStatus='passed' + !customerProofReleasedAt`.

Likely files:
- `src/lib/qa-room.ts`
- `src/app/admin/qa-room/qa-room-client.tsx`

### Status/customer copy
Customer-facing status should be calm and non-internal:
- Internal: `manual_generation_required`
- Customer copy: “Your book is in production. We’re preparing your proof and will email it after review.”
- Do not expose internal artifact names or provider/provenance issues.

Likely file:
- `src/lib/order-status-view.ts`

## Desired copy
- `manual_generation_required`: “Manual generation required — attach artifacts before QA.”
- `awaiting_qa`: “Awaiting internal QA — customer has not received proof/digital delivery.”
- `qa_passed_pending_release`: “QA passed — explicit customer release still required.”
- `proof_ready`: “Proof email sent — waiting for customer review.”
- `proof_approved`: “Customer approved proof — owner print-go still required.”

## Constraints
- No prod deploy.
- No live order mutation.
- No button should imply it emails/prints unless it actually does.
- No optimistic “ready/released” wording before server-confirmed state.

## Verification
- Add UI/source tests for status labels and disabled/enabled states.
- `npm test`
- `npm run build`
- `graphify update .` after code changes.
