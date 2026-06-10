# HSB Manual Artifact Factory Runbook

Status: draft, internal only. No production/order/customer/payment/print action is authorized by this document.

## Purpose
Make manual HSB fulfillment repeatable and auditable. A paid order should never sit in vague `not_started` or broken `failed_manual_review` without a clear operator path.

## Factory states

1. `manual_generation_required`
   - Paid order is parked for operator work.
   - Customer has only received acknowledgement email.
   - No proof/customer release yet.

2. `awaiting_qa`
   - Required artifact bundle is attached and complete.
   - Customer still has not received proof/digital delivery.

3. `qa_passed_pending_release` or equivalent existing-field state
   - QA pass recorded.
   - Release still requires explicit operator action.

4. `proof_ready`
   - Customer proof email sent with proof/review link.
   - Waiting for customer review/approval.

5. `proof_approved`
   - Customer approved proof.
   - Print still blocked until owner print-go.

6. `submitting_to_print` / `print_in_production`
   - Owner print-go recorded and provider submission initiated.

## Required artifact bundle

Directory shape:

```txt
manual-artifacts/<orderId>/
  manifest.json
  story-brief.md
  page-plan.json
  prose.md
  art-direction-packet.json
  images/
    page-01.png
    page-02.png
    ...
  proof.pdf
  qa-report.md
```

Required artifact kinds:
- `story_brief`
- `page_plan`
- `prose`
- `art_direction_packet`
- `page_image` for every expected page
- `proof_pdf`
- `qa_report`

## Operator workflow

### 1. Confirm order is eligible
- Order is paid.
- Order is not refunded/cancelled.
- `fulfillmentStatus = manual_generation_required` or allowed repair state.
- No customer proof has been released.
- No print job has been submitted.

### 2. Build artifact bundle
Use subscription/manual workflow, not app API generation.

Create:
- story brief
- page plan
- prose
- art-direction packet
- page images
- proof PDF
- QA report draft

### 3. Upload artifacts safely
Avoid Vercel/Next request-body limits.

Allowed first-cut transports:
- CLI uploads files directly to Blob, then sends manifest metadata/blob refs to admin route.
- Browser direct-to-Blob upload with short-lived token, then admin route receives metadata/blob refs.
- Manual pre-upload to Blob and manifest references existing URLs/paths.

Not allowed:
- One giant multipart POST to a Next route with all images/PDFs.

### 4. Import bundle dry-run
Run importer with dry-run first.

Expected dry-run output:
- order id
- artifact count by kind
- expected pages vs provided pages
- missing pages/artifacts
- proof PDF present
- blob refs valid
- customer email would be sent: false
- print would be submitted: false

### 5. Commit import
Commit only if dry-run passes.

Expected post-import state:
- `fulfillmentStatus = awaiting_qa`
- `qaStatus = pending`
- `storyArtifactUrl` or proof artifact ref present
- `pageArtifacts` complete with manual lineage
- `storyMeta.source = manual`
- customer email sent: false
- print submitted: false

### 6. Human QA
Review:
- child/family details correct
- story is personalized, not generic/template fallback
- no prohibited child/family reuse
- no fixture/internal/sample asset leakage
- all pages present
- all images load
- art is consistent and child-safe
- proof PDF opens on desktop/mobile
- proof/review link can be generated
- print artifacts exist if physical order, but print is not submitted

### 7. Mark QA pass/fail
QA pass/fail action must not email customer.

If fail:
- record blocker
- keep/revert to manual generation state
- create new artifact revision for fixes

If pass:
- record `qaPassAt`, `qaReviewer`, checklist
- leave customer release pending

### 8. Release proof/customer email
Explicit action only.

Before release:
- rerun manifest/release guard
- confirm no template/fallback/missing artifact blockers
- confirm proof_release_hold policy allows action

After release:
- customer receives proof/review email
- order moves to proof-ready/customer-review state

### 9. Customer approval
Customer approval sends only confirmation copy: “thanks, we're routing to print.”

Customer approval must not submit print by itself.

### 10. Owner print-go
Print submission requires separate owner/operator print-go after customer approval.

## Transactional email checkpoints

1. Paid acknowledgement
   - Trigger: successful paid checkout.
   - Copy intent: “We’re preparing your handcrafted proof; you’ll get an email when it’s ready.”
   - Must not include proof link.

2. Proof ready/release
   - Trigger: explicit release-proof action after QA pass.
   - Includes proof/review link.

3. Customer approved
   - Trigger: customer approves proof.
   - Copy intent: “Thanks, we’re routing this to print.”
   - Must not submit print by itself.

## Evidence packet template

```md
Order: <orderId>
Paid at: <timestamp>
Factory state before: <status>
Artifact manifest: <path/blob>
Story brief: <ref>
Page plan: <ref>
Prose: <ref>
Art direction: <ref>
Page images: <count>/<expected>
Proof PDF: <ref>
QA report: <ref>
QA reviewer: <name>
QA pass/fail at: <timestamp>
Customer release: not released / released at <timestamp>
Customer email status: not sent / sent <messageId>
Print status: not submitted / owner-go pending / submitted <jobId>
Side-effect attestation: no print/payment/refund/prod deploy/env change performed.
```

## Hard blockers
- Template/fallback source present.
- Missing required artifact.
- Missing route decision/audit for proof artifact.
- Missing page image lineage.
- QA not passed.
- Customer release attempted before QA pass.
- Print attempted before customer approval + owner print-go.
- Any upload path requires >4 MB multipart body through Next route.
