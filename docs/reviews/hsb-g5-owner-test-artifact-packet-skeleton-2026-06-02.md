# HSB G5 Owner-Test Artifact Packet Skeleton — 2026-06-02

Status: SKELETON READY, NOT EXECUTED
Prepared by: Rex
Scope: artifact checklist only. No Stripe charge/replay, no Lulu API call, no Resend action, no customer email, no production deploy, and no print action performed.

## Purpose

G5 closes only when a real paid internal owner-test is explicitly approved and the full evidence packet is saved. This file is the capture template so the run is auditable and cannot become a vague “it worked” claim.

## Required preconditions before any G5 run

- Alexy explicitly approves the exact owner-test window and spend.
- Production env checker returns PASS from `vercel env pull --environment=production .env.production.local` + `node --env-file=.env.production.local scripts/check-production-env.mjs --env=production --json`.
- `proof_release_hold` is active unless Alexy explicitly approves customer-facing proof/digital release.
- `HSB_CHECKOUT_PAUSED` / checkout kill-switch posture is known and documented.
- Resend webhook is registered and a dashboard test event appears in `/admin/email-health`.
- Operator confirms no creator/gifting/public traffic is being opened as part of G5.

## Artifact index to fill during the run

### 1. Run metadata

- Run ID:
- Date/time CDT:
- Operator:
- Approved by:
- Approved spend cap:
- Deployment URL:
- Commit SHA:
- Branch:
- Env-check artifact path:
- Kill-switch state snapshot path:

### 2. Checkout/payment evidence

- Stripe mode: live/test (must match approved plan):
- Checkout session ID: `[record internally; do not paste secrets]`
- Order ID:
- Payment status readback:
- Webhook received timestamp:
- Order persistence path/readback evidence:
- Screenshot/artifact path:

### 3. Fulfillment/proof evidence

- Fulfillment start timestamp:
- Route decision persisted before releasable artifact: yes/no
- Story artifact URL/path:
- PDF/proof artifact URL/path:
- QA state before approval:
- `proof_release_hold` behavior observed:
- Proof email sent? expected no unless explicitly released:
- Screenshot/artifact path:

### 4. Customer-review / approval evidence

- Review URL generated:
- Token/URL stored securely; not pasted public:
- Customer approval simulated/performed by owner:
- Approval audit event persisted:
- Print owner-go remained separate from customer approval: yes/no
- Screenshot/artifact path:

### 5. Print/Lulu evidence

Only fill if Alexy explicitly approves print handoff.

- Owner-go approval ID/time:
- Lulu endpoint/mode:
- Print job ID:
- Lulu status readback:
- Shipping/address used:
- Screenshot/artifact path:

If print handoff is not approved, record: `NOT RUN — owner-go withheld`.

### 6. Email health evidence

- `/admin/email-health` accessible after run: yes/no
- Resend webhook last event timestamp:
- Bounce count trailing 24h:
- Complaint count trailing 24h:
- Delivery delayed count trailing 24h:
- Any anomaly disposition:

### 7. Kill-switch and rollback evidence

- Checkout pause state after run:
- Proof release hold state after run:
- Provider/QA/marketing holds after run:
- Any sticky failure/hold created:
- Rollback action required: yes/no

### 8. Final verdict

- G5 result: PASS / FAIL / INCOMPLETE
- Reason:
- Must-fix before GREEN:
- Approved next posture: HOLD / YELLOW owner-test only / limited traffic / GREEN

## Fail conditions

Mark G5 FAIL/INCOMPLETE if any of these occur:

- Payment and persisted order state disagree.
- Artifact exists without route decision/audit evidence.
- Any customer-facing email sends while `proof_release_hold` is active.
- Customer approval directly triggers Lulu print without separate owner-go.
- Resend webhook/monitor cannot prove email-health visibility.
- Blob persistence fails or reads become unavailable in production.
- Operator cannot produce screenshots/paths for payment, order, proof, email health, and kill-switch state.

## Recommended storage layout for completed run

Create a run folder:

`docs/reviews/g5-owner-test/<YYYY-MM-DD>-<run-id>/`

Suggested files:

- `README.md` — filled packet summary.
- `env-check.json` — sanitized checker output.
- `kill-switch-before.json` / `kill-switch-after.json` — no secrets.
- `order-readback.json` — scrubbed order status/provenance only.
- `email-health.json` — scrubbed event summary only.
- `screenshots/` — admin/order/proof/email-health screenshots.

## Current state

Skeleton is ready. G5 has not run. No paid/customer/provider/print side effects were performed while creating this packet.
