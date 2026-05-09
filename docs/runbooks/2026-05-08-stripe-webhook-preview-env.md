# Stripe webhook QA + Preview env runbook — 2026-05-08

## Why this exists

Two related findings from Rex's 2026-05-08 controlled local Stripe QA:

1. **Local digital paid → not_started bug (FIXED).** A paid digital order
   stayed at `fulfillmentStatus=null`, `attempts=0` after a successful
   webhook delivery. Root cause: `triggerFulfillment` re-read the order
   via `getOrder` and was vulnerable to read-after-write inconsistency
   on the persistence backend. The webhook now passes the in-memory
   post-write record into `triggerFulfillment` via `{ preloadedOrder }`,
   skipping the re-read race. Same pattern that already fixed
   `approvePrintProof`.

2. **Preview env classifies `STRIPE_WEBHOOK_SECRET` as missing — Preview
   is NOT safe for webhook QA until fixed.**

This runbook covers (2) and the operator-facing safe-QA procedure.

## ⚠ Preview env name presence is not enough

`vc env ls preview` lists encrypted variable NAMES. It does NOT prove
the value is non-empty inside a Preview deployment. Both:

- `vc env pull --environment=preview` (generic Preview)
- `vc env pull --environment=preview --git-branch=<feature-branch>`

must show `STRIPE_WEBHOOK_SECRET` as a non-empty `whsec_...` string for
Preview webhook QA to be safe.

Per `rex/briefings/hsb-stripe-qa/2026-05-08-preview-env-audit/`, both
pulled-env classifications today report `STRIPE_WEBHOOK_SECRET: missing`
on the `feat/hsb-path-b-transactional-spine` branch. This means Preview
deployments cannot verify Stripe webhook signatures, so the webhook
returns `500 Webhook secret not configured` and never updates the
order. **No webhook-driven fulfillment kickoff can happen on Preview
until the secret is restored AND a fresh Preview deploy is made.**

## Safe Preview webhook QA — preflight

Before any Preview webhook QA:

1. From the dev laptop:
   ```sh
   vc env pull .env.preview --environment=preview --git-branch=<feature-branch>
   # Open .env.preview LOCALLY ONLY. Do not commit. Do not paste.
   # Confirm STRIPE_WEBHOOK_SECRET starts with "whsec_" and is non-empty.
   # Classify only — do not log/print the value.
   ```
2. If empty/missing: re-add the variable in the Vercel dashboard for
   that branch's Preview scope, **and trigger a fresh Preview deploy**.
   Variables added after a deployment do not retroactively appear in
   the running Preview lambda.
3. Re-pull and confirm non-empty.
4. Only then attempt `stripe listen --forward-to <preview-url>/api/webhooks/stripe`.

## Preferred local QA (no Preview env risk)

Use local port 3458 + Stripe CLI forwarding. This is what Rex used for
the 2026-05-08 controlled run and what reproduced the not_started bug.

```sh
# Terminal 1: prod-like Next server (test-mode Stripe key in .env.local)
PORT=3458 npm start

# Terminal 2: forward Stripe to local webhook
stripe listen --forward-to http://127.0.0.1:3458/api/webhooks/stripe \
  --events checkout.session.completed,charge.refunded
# Print the resulting whsec_* into .env.local (test mode only).

# Terminal 3: visit /checkout?format=digital, fill, pay with test card.
```

If the Stripe CLI websocket flaps (Rex saw this on 2026-05-08), use a
**signed manual replay** of the recorded `checkout.session.completed`
event. The webhook accepts any signature signed with the listener's
local `whsec_*`.

## Verifying the 2026-05-08 fix landed

After paying a digital test order:

1. Webhook returns `{"received":true}` (HTTP 200).
2. `GET /api/order/<orderId>` shows `paymentStatus: "paid"`,
   `stripeSessionId: "cs_test_..."`.
3. **Fulfillment is no longer stuck**: within a few seconds the order
   advances through `fulfillmentStatus` → `generating_story` →
   `generating_images` → `building_pdf` → `complete`, and gains a
   `storyArtifactUrl`.
4. `printJobId` and `printJobStatus` MUST stay null/unset for a digital
   order. If either is populated, stop — the Lulu-skip path regressed.

If the order still shows `fulfillmentStatus: not_started`, `attempts: 0`
after several seconds:

- Check the webhook log for
  `[fulfillment] order <id> not paid — skipping fulfillment`. If it
  appears, the preloaded-record path was bypassed (regression). File
  it, do not re-pay.
- Check for `[webhook] fulfillment trigger failed for <id>:` lines.
  These now capture a real error shape (story-generator timeout, image
  provider failure, blob token, etc.).

## Tests pinning the fix

- `tests/fulfillment.test.ts`:
  - `triggerFulfillment: preloadedOrder=paid kicks off digital fulfillment even when persistence re-read is stale-pending`
  - `triggerFulfillment: preloadedOrder with mismatched id is ignored (defensive)`
  - `digital fulfillment never calls submitPrint — Lulu must not be triggered for digital`
  - `digital fulfillment: duplicate triggerFulfillment is idempotent (no double-generation, no Lulu call)`
  - `source-level: triggerFulfillment exposes preloadedOrder option matching the approvePrintProof in-memory pattern`
- `tests/stripe-webhook-refund-replay.test.ts`:
  - `webhook source: paid replay backfills fulfillment when still not_started` — now asserts the `{ preloadedOrder }` argument shape on BOTH webhook fulfillment kickoffs (new-paid path and replay-backfill path).

## Hard boundaries that did not change

- No live Stripe actions from this codepath.
- No Lulu submission for digital orders. Asserted by test.
- No payment-amount changes.
- No production env writes.
- No deploys.
