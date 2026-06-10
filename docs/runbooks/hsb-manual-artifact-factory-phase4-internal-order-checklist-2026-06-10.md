# HSB Phase 4 — Internal End-to-End Order Checklist

Status: draft, internal only.

Purpose: prove the manual artifact factory as a **process**, not just code. Run only after Phase 1+2+3 are merged and deployed with explicit scoped approval.

## Approval gates

Phase 4 touches production/customer/payment/order/email surfaces. Do not run until Alexy explicitly approves each needed Tier 3 action.

Required approvals before run:
- [ ] Approve production deploy of the manual factory commit/PR.
- [ ] Approve one internal paid HSB order using Alexy/internal email.
- [ ] Approve admin artifact import/QA actions for that specific order.
- [ ] Approve customer proof release email for that specific order.
- [ ] Print is **not approved** unless separately stated after proof approval.

## Pre-run checks

- [ ] Production deploy matches intended commit.
- [ ] Public checkout posture is controlled/capped.
- [ ] Stripe webhook bad-signature probe rejects with 400.
- [ ] Resend health is acceptable or known-risk documented.
- [ ] Blob storage write/read path is healthy.
- [ ] Real-order watcher/lantern is armed or replacement monitor is running.
- [ ] No stale owner-test order will be mutated by mistake.

## Step 1 — Create internal order

- [ ] Use internal/customer-safe email.
- [ ] Include realistic custom story details.
- [ ] Include photo/reference inputs if the flow requires them.
- [ ] Complete payment only after explicit approval.

Expected after payment:
- [ ] `paymentStatus = paid`
- [ ] `fulfillmentStatus = manual_generation_required`
- [ ] `fulfillmentAttempts = 0` or no auto-generation attempt from payment path
- [ ] acknowledgement email sent only
- [ ] no proof email
- [ ] no print job

Evidence:
```md
Order: <orderId>
Stripe session/payment: <redacted id/status>
Paid timestamp: <ts>
Fulfillment status: <status>
Ack email id/status: <id/status>
Auto fulfillment scheduled: no
Proof/customer release: no
Print: no
```

## Step 2 — Build manual artifact bundle

Bundle path:
```txt
manual-artifacts/<orderId>/
```

Required files:
- [ ] manifest.json
- [ ] story-brief.md
- [ ] page-plan.json
- [ ] prose.md
- [ ] art-direction-packet.json
- [ ] images/page-01..N
- [ ] proof.pdf
- [ ] qa-report.md

Generation method:
- [ ] Manual/subscription workflow only.
- [ ] No app API/FAL/Gemini/RunPod routine generation.

## Step 3 — Dry-run import

Run importer in dry-run mode.

Expected:
- [ ] all required artifact kinds present
- [ ] page count matches expected
- [ ] proof PDF present
- [ ] binary uploads use Blob/direct path, not giant Next multipart route
- [ ] customer email would be sent: false
- [ ] print would be submitted: false
- [ ] missing/template/fallback guard passes

## Step 4 — Commit artifact import

Expected after import:
- [ ] `fulfillmentStatus = awaiting_qa`
- [ ] `qaStatus = pending`
- [ ] artifact manifest attached
- [ ] page artifacts complete
- [ ] manual lineage present
- [ ] story/proof refs present
- [ ] no customer email sent
- [ ] no print submitted

## Step 5 — Human QA pass/fail

Checklist:
- [ ] personalization/details correct
- [ ] no template/fallback prose/source
- [ ] no child/family reuse
- [ ] all pages present
- [ ] all images load
- [ ] art consistency acceptable
- [ ] proof PDF opens desktop/mobile
- [ ] no fixture/internal asset leakage
- [ ] release guard passes
- [ ] print guard remains blocked pending customer approval + owner print-go

Expected after QA pass:
- [ ] QA pass recorded
- [ ] customer email still not sent
- [ ] proof release still pending explicit action

## Step 6 — Release proof/customer email

Requires explicit approval for this order.

Before release:
- [ ] rerun release guard
- [ ] confirm QA pass present
- [ ] confirm no template/fallback/missing artifact blockers

Expected after release:
- [ ] proof review email sent
- [ ] proof/review link works
- [ ] order is proof-ready/customer-review state
- [ ] print still not submitted

## Step 7 — Customer proof approval

If testing proof approval:
- [ ] Customer approves proof via review flow.
- [ ] Confirmation email says “thanks, we're routing to print” or equivalent.
- [ ] Confirmation email does **not** submit print.
- [ ] Owner print-go still required.

## Stop conditions

Stop and preserve evidence if:
- order does not enter `manual_generation_required` after payment
- auto-generation starts unexpectedly
- template/fallback artifact can pass release guard
- customer proof/email sends before explicit release
- print job submits before owner print-go
- upload/import path hits request-body ceiling
- Blob refs are inaccessible to proof/release code

## Final Phase 4 report format

```md
HSB Phase 4 internal order result: PASS/FAIL
Order: <orderId>
Commit/deploy: <sha/deployment>
Payment: paid/unpaid
Initial status after payment: <status>
Ack email: sent/not sent <id>
Artifact import: pass/fail
QA: pass/fail
Proof release: sent/not sent <id>
Customer approval tested: yes/no
Print submitted: no unless separately approved
Blockers: <list>
Side effects: <exact list>
Verdict: controlled intake ready / not ready
```
