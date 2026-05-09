# HSB Live-Order Validation Runbook

One real end-to-end order through production to confirm every state transition fires correctly. Run this before any release that touches checkout, fulfillment, review, or print submission.

## When to run

- Before promoting a meaningful change to checkout / Stripe / orders / fulfillment / review / Lulu.
- After a production incident on any of the above.
- Monthly smoke check (cheap to do; catches infra drift).

## Prerequisites

- Stripe live key access **OR** test-mode key wired into the validation env. (Test mode is fine for end-to-end if Lulu sandbox is also wired — see "Mode matrix" below.)
- `HSB_ORDER_ADMIN_KEY` configured in the target env. Sign in to `/admin/orders` first.
- Vercel Blob token with write access in the target env (`BLOB_READ_WRITE_TOKEN`).
- A throwaway email you control (e.g. an alias on your inbox).
- A small JPG/PNG photo file you're allowed to use.
- For the print path: a real shipping address you can intercept (your own).
- Local terminal with `node --experimental-strip-types` available for the status script.

## Mode matrix

| Concern        | Live (real charge)               | Test mode                                          |
| -------------- | -------------------------------- | -------------------------------------------------- |
| Stripe         | live keys, real card, real $$    | test keys, `4242 4242 4242 4242`                   |
| Lulu           | live job (will produce a book!)  | sandbox creds — no physical book printed           |
| Email          | real customer email arrives      | real email still arrives — use a throwaway inbox   |
| Blob storage   | production store                 | preview/dev store                                  |

The only mode that produces a printed book and shipped product is **live Stripe + live Lulu**. All other combos are safe smoke tests.

## Test-order inputs

Use these exact inputs each run so the audit trail is comparable across runs:

- **Format:** `classic` (covers the print path; digital is a sub-case)
- **Child name:** `Validation Test <YYYY-MM-DD>` (e.g. `Validation Test 2026-04-27`)
- **Email:** your throwaway inbox
- **Photo:** the same small JPG every time
- **Theme / lesson / occasion:** any single sample option each
- **Shipping address:** your own (only relevant for `classic`/`premium`)

Capture the `orderId` (printed on `/checkout/success`) and the `cs_*` Stripe Checkout Session id. Both go in the run log.

## Where to watch state

| Surface | URL | What you see |
| --- | --- | --- |
| Customer status | `/status/<orderId>` | Customer-visible timeline. This is the failure surface customers actually see. |
| Customer review (print only) | `/review/<orderId>?token=<proofApprovalToken>` | The proof PDF, per-page review, "I reviewed the proof" checkbox, "Approve and print" button. |
| Admin detail | `/admin/orders/<orderId>` | Order, payment, fulfillment, review audit, diagnostics block (see below). |
| Diagnostics JSON | `/api/admin/orders/<orderId>/diagnostics` | Machine-readable structured snapshot. |
| Diagnostics text | `/api/admin/orders/<orderId>/diagnostics?format=text` | One paste-friendly escalation block. |
| CLI snapshot | `npm run order:status -- <orderId>` | Same data on a terminal, no auth required (reads the same store). |

The **Diagnostics** section at the top of the admin detail page colors each check `OK / INFO / WARN / FAIL`. If anything is `FAIL` after the run completes, the validation order failed.

## Validation steps

For each step, check the diagnostics and the customer status page. If a step fails or stalls, jump straight to "What to collect when escalating" below.

### 1. Checkout

- Hit the public site, configure the order with the inputs above, upload the photo, complete Stripe Checkout.
- **Success:** Stripe redirects to `/checkout/success?session_id=cs_...`.
- **Watch:** Stripe Dashboard → Payments. The session should be `complete` and the PaymentIntent `succeeded`.
- **Failure modes:** if you hit Stripe's "session expired" or your card is declined, abort — this is not a code issue.

### 2. Webhook + order persistence

- Within ~30 seconds, the Stripe webhook should land and persist the order.
- **Verify:** `npm run order:status -- <orderId>` (or the admin page).
  - `payment.status = paid`
  - `payment.stripeSessionId = cs_...` matches the redirect url
  - `photo.blobPath` is set (the customer photo durably landed)
- **FAIL signals:**
  - `paid` but `stripeSessionId` missing → webhook race / persistence skipped → check Vercel logs for `[orders] persistOrder`.
  - `paymentStatus = pending` after >2 min → webhook never landed. Check Stripe Dashboard → Webhooks for delivery failures.
  - `photo.blobPath` null → photo upload silently dropped. (Hardened to throw; investigate `OrderPersistenceError` or `BLOB_READ_WRITE_TOKEN` missing.)

### 3. Story + image generation

- Asynchronously, the fulfillment pipeline runs OpenAI primary + FAL fallback to draft pages.
- **Watch:** admin diagnostics → `pages.pageArtifactCount > 0`, `pagesWithoutImage = 0`. Should reach this within a few minutes.
- **Fulfillment status path:** `not_started → generating_story → generating_images → building_pdf → proof_ready` (print) or `→ complete` (digital).
- **FAIL signals:**
  - `fulfillmentStatus = failed_manual_review` → `fulfillmentLastError` shows the cause (rate limit, NSFW filter, model error).
  - `pagesWithoutImage > 0` and not transitioning → check provider health + `auditEvents` for `page_regenerated` failures.

### 4. Proof generation

- After image generation completes, the PDF is built and uploaded.
- **Verify:** `artifacts.storyArtifactUrl` is non-null and resolves; `fulfillmentStatus = proof_ready` (for print) or `complete` (for digital).
- **FAIL signals:**
  - `storyArtifactUrl` set but 404s → blob access mode mismatch (private writes against a public store, or vice versa). Check `HSB_BLOB_ACCESS_MODE`.
  - `building_pdf` stalls > 5 min → check serverless logs for `pdfkit` errors.

### 5. Review + page acceptance (print path only)

- Open `/review/<orderId>?token=<proofApprovalToken>`. The page should render the proof PDF inline and per-page review controls.
- Click through and accept all pages. Optionally regenerate one page to validate the regen + auto-rebuild flow.
- **Verify after each action:**
  - Per-page accept → `pageArtifacts[i].accepted = true` and `auditEvents` grows by `page_accepted`.
  - Regen → `auditEvents` grows by `page_regenerated`; if regen succeeded, `auditEvents` also grows by `proof_rebuilt` and `proofReviewedAt` is cleared (stale-ack invalidation).
- **FAIL signals:**
  - Accepting all pages flips `reviewStatus = approved` (this is a regression — `acceptPage` should NEVER flip approval; only `approveWholeBook` does).
  - Regen succeeds but `proofReviewedAt` is not cleared → stale-ack bug returned.

### 6. Proof acknowledgment

- Tick "I reviewed the proof" on `/review`. This calls the acknowledge endpoint.
- **Verify:** `review.proofReviewedAt` is now an ISO timestamp; `auditEvents` shows `proof_review_acknowledged`.
- **FAIL signals:** Endpoint returns 409 → likely `proof pdf is not ready` (storyArtifactUrl missing) or order already approved.

### 7. Whole-book approval

- Click "Approve and send to print" on `/review`.
- **Verify:**
  - `review.reviewStatus = approved`
  - `review.proofApprovedAt` set
  - `auditEvents` shows `whole_book_approved`
  - `fulfillmentStatus → submitting_to_print` then `complete`
- **FAIL signals:**
  - 409 with `proof_ack_missing` → ack didn't persist; re-ack and retry.
  - 409 with `pages_not_accepted` → at least one page is still pending.
  - 200 but `reviewStatus` stays `in_review` → write didn't land; check `persistOrder` errors in logs.

### 8. Lulu print submission (live print only)

- The fulfillment pipeline calls Lulu's job submission API.
- **Verify:** `print.printJobId` set, `print.printJobStatus` populated.
- **FAIL signals:** `approved` but no `printJobId` after several minutes → `submitToPrint` failed; check logs for Lulu auth or interior/cover validation errors.

### 9. Lulu shipped webhook + tracking

- When Lulu ships, their webhook lands and stamps tracking on the order.
- **Verify:** `print.trackingNumber`, `print.trackingUrl`, `print.shippedAt` populated; `status = shipped`; customer status page shows "shipped" tile.
- For test/sandbox mode this won't fire automatically — use the admin "Mark shipped" form to simulate.

### 10. Customer-visible vs internal failure

| Symptom on `/status/<id>` | Internal cause | Where to look |
| --- | --- | --- |
| "We hit a snag" tile | `fulfillmentStatus = failed_manual_review` | `fulfillment.lastError` in diagnostics |
| Stuck on "Writing the story" > 10 min | provider failure mid-pipeline | logs + `pageArtifacts` regen counts |
| "Payment confirmed" never advances | webhook didn't trigger fulfillment | Stripe webhook delivery log |
| "Your proof is ready for review" but no email | proof email send failed | recovery script can resend; or use admin "Resend proof email" |

If the customer surface looks fine but diagnostics show `FAIL`, the order is silently broken — fix internally before the customer notices.

## What to collect when escalating

For any order that gets stuck or a customer disputes, paste the following into the issue/ticket:

1. `orderId` and the customer's email.
2. `npm run order:status -- <orderId>` output (or the diagnostics text endpoint).
3. The Stripe Checkout Session id (`cs_*`) and PaymentIntent id (`pi_*`).
4. The Vercel deployment id at the time of the order, if known.
5. Any error message from `fulfillmentLastError` and the most recent 5 `auditEvents`.
6. If the customer reports a UI issue: the URL they were on and a screenshot.

This is all read-only data — never paste raw photo URLs or shipping addresses into a public channel.

## Special checks

- **Stripe / session / webhook:** webhook signature must verify; `stripeSessionId` on the persisted order must match the `cs_*` from the Checkout redirect; the StripeEvent dedup row must exist (prevents replay double-charge).
- **Durable persistence:** in production-like envs the order JSON must be in Vercel Blob (not tmp). The diagnostics `photo.blobPath` is a leading indicator — if photos are being stored durably, order JSON is too.
- **Proof generation:** `storyArtifactUrl` must resolve. If it's set but 404s, blob access mode is mismatched (`HSB_BLOB_ACCESS_MODE`).
- **Acknowledgment + approval path:** every successful proof rebuild must clear `proofReviewedAt`. Ack must persist before approve will run server-side.
- **Print-order progression:** `proof_approved → submitting_to_print → complete` and `printJobId` must populate; absence of either means submission silently failed.

## Known gaps that still require manual checking

- **Email deliverability** is not in the diagnostics — confirm the throwaway inbox actually received the proof + ready emails.
- **Photo upload integrity** — diagnostics confirm a blob path was stored, not that the bytes are intact. Open the blob URL once per validation run.
- **Lulu sandbox vs live** is environment-dependent and not asserted by the script.
- **Tracking link health** — diagnostics report the URL is set, not that it resolves. Click it once.
- **Customer email rendering** in dark mode / Outlook is still eyeball-only.
