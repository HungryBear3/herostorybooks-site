# Cowork handoff — HSB manual artifact factory ops/runbook

Repo/worktree: `/tmp/hsb-manual-artifact-factory` branch `hsb/manual-artifact-factory`.

## Goal
Define the operating standard for manual book production so “manual” becomes a repeatable artifact factory, not a vague rescue path.

## Need from Cowork

### 1. Artifact manifest convention
Define folder + manifest shape for an order:

```txt
manual-artifacts/<orderId>/
  manifest.json
  story-brief.md
  page-plan.json
  prose.md
  art-direction-packet.json
  images/page-01.png ... page-24.png
  proof.pdf
  qa-report.md
```

Manifest should include:
- order id
- operator id
- child/book title
- expected page count
- artifact file paths/URLs
- source/provenance notes
- generation method: subscription/manual, not app API
- QA checklist result
- revision number

### 2. QA checklist
Define human QA checklist before customer proof release:
- personalization details correct
- no template/generic fallback prose
- no child/family reuse
- page count correct
- no missing/broken images
- child likeness/safety acceptable
- art consistency acceptable
- no fixture/internal/provenance leakage
- proof PDF opens on desktop/mobile
- customer email/review link ready
- print metadata exists if physical order, but print not submitted

### 3. Runbook
Write operator runbook:
1. Locate paid order in manual queue.
2. Generate/subscription-create story brief, page plan, prose, art direction, images, proof PDF.
3. Fill manifest.
4. Import artifacts dry-run.
5. Commit import.
6. Verify order status: `awaiting_qa`, `qaStatus=pending`, proof URL present, customer email sent=false.
7. QA pass only.
8. Explicit release customer proof/email.
9. Verify release/email.
10. Wait for customer proof approval.
11. Owner print-go only after approval.

### 4. Evidence packet template
Template for Rex/Abby to paste after each order:
- order id
- paid timestamp
- artifact manifest path
- proof PDF URL
- page count/image count
- QA pass timestamp/operator
- customer proof release timestamp/operator
- email status
- print status: not submitted / waiting customer approval / owner-go submitted
- explicit side-effect attestation: no print unless approved

### 5. Policy decisions to settle
- Can manual import overwrite existing artifacts, or must every change create a revision?
- Operator IDs: `abby`, `rex`, `alexy`, `cc`, `cowork`?
- Minimum image dimensions/formats for proof and print.
- Whether proof PDF is uploaded manually or always rebuilt by app from page artifacts.

## Constraints
- Draft/runbook only; no production/customer/order mutation.
- Keep legal/customer language safe and non-promissory.
- No live print/payment/customer email actions.
