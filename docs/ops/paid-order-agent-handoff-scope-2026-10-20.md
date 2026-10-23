# Paid-order → operator/agent handoff: implementation scope

Read-only code map, not an enabled worker or production claim.

## Existing trusted path

1. `src/app/api/webhooks/stripe/route.ts` constructs Stripe event from raw body + signature using configured webhook secret. Invalid signatures return400.
2. Checkout settlement verification validates exact bound session/order, payment state/amount/currency; terminal refund/dispute/failure events converge separately. Upgrade purchases use a separate branch and must not create a new-book task.
3. `src/lib/orders.ts: settleOrderPayment` → `updateOrderPaymentResult` uses `withOrderTransaction` CAS. A permitted pending→paid transition stores paidAt/session/PaymentIntent/settled amount. Replays return `transitionedToPaid:false`; conflicting/refunded states cannot resurrect paid work.
4. After durable write webhook schedules customer confirmation, trusted purchase analytics, and `scheduleFulfillmentKickoff`. Replays can repair deferred confirmation/kickoff but are not new purchases.
5. `src/lib/fulfillment-kickoff.ts` deduplicates in-process after/setImmediate callbacks and retries bounded readback. This is NOT a durable external agent task queue.
6. `src/lib/fulfillment.ts: claimFulfillmentKickoff` requires auto mode and no internal disposition. Current manual_hold orders do not auto-generate a book. Media-backed stories require manual production regardless. Character-review enrollment now also blocks unapproved character auto-work.
7. New character review persists versioned approval/revision events on the order atomically with the decision. These are durable records, not a notification transport or agent run.

## Concrete next implementation slice (default-off until separately enabled)

A. **Atomic paid-order outbox:** add one deterministic `new_paid_order` event in the SAME pending→paid order CAS commit, keyed by order + bound Stripe checkout session, not webhook delivery id. Do not create for print-copy/upgrade branches. Include only internal order key, task kind, stable event id, creation time and pending status; resolve private intake under separate authenticated access. Label zero-total owner/promo orders distinctly from genuine revenue. Replays must not create duplicates or reset consumed state.

B. **Authenticated claim/read/ack:** a bounded operator endpoint scans explicit eligible pending records and atomically leases individual events with worker id, expiry, attempt count and fencing/claim token. Re-read paid/refund/disposition/current character version under the claim CAS. Refund/dispute/changed-version events cancel or suspend work. Mark task started/completed only on durable receipt from actual runner, never from an HTTP send attempt. Idempotent terminal acknowledgement uses the exact claim token. Retry ambiguous transport outcomes through event-id reconciliation, not blind resend.

C. **Two distinct deliveries:** owner notification and agent-work dispatch each have their own durable receipt/status. Telegram message id proves owner notification; OpenClaw run/task id proves accepted work. No raw customer photo/audio, capability, email, or address in push messages. Capability delivery to customer is separate and subject to internal QA/release flow. Emailing owner is not the queue.

D. **Consumer scope:** `new_paid_order` starts intake validation/character-sheet preparation only; `revise_character` starts the exact requested revision; `character_approved` starts book preparation using the approved immutable image/description. No customer proof release, final proof approval, print order, refund or payment mutation. Every consumer rechecks latest authoritative version before output adoption. Workers may finish after a lease expires; adoption must reject stale claim/state, not merely trust a worker's initial read.

E. **Verification before activation:** duplicate/out-of-order Stripe deliveries, zero-total/internal test, failed durable commit, notification timeout after send, agent accepted-but-response-lost, claim expiry/two workers, refund during work, approval/revision races, stale candidate adoption, unavailable runtime, and dead-letter alert. Synthetic signed events and stub transports first; then isolated Preview. Confirm real owner test separately only after notification+runner receipts+character review+proof path are demonstrated. Do not automatically replay historical paid orders.

## Current boundary

No paid-order outbox or live notification worker was implemented by the character portal commit. Existing scheduled payment watchers may report aggregates, but are not a replacement for per-order durable claims/receipts. Runtime activation, cadence, destination, exact producer capacity and customer-release authority remain explicit operational configuration, not implied by this document.

## Local implementation (not activated)

- `paid-order-outbox.ts`: stable new-order event added only on the pending→paid CAS when `HSB_PAID_ORDER_OUTBOX_ENABLED=true` (default off); no replay backfill. Zero-total is separate. Owner/agent lanes have separate leases, claim tokens and receipt fields. Five attempts then dead-letter. Expired/ambiguous sends require authoritative transport reconciliation before retry.
- `/api/admin/orders/[orderId]/handoff` authenticated POST: explicit-order bounded listing, claim and acknowledgement; no unbounded scan of customer records. The caller supplies explicit known order ids. CAS rechecks payment/refund/disposition and character version each mutation.
- `deliverClaim` prepares runner/notification integration with adapters. `reconcile` MUST be authoritative, and `deliver` MUST use provider-side event-id idempotency. Telegram adapters without reliable deduplication/reconciliation must return unknown and stop, not blindly resend. `delivered` means receipt accepted, NOT book completed.
- `validWorkFence` is an output-adoption guard primitive. Concrete consumer output adoption must enforce it inside its CAS; it is NOT yet wired into character-sheet/manual-proof adoption. No runtime consumer is enabled.

### Remaining activation requirements

Real Telegram notification transport and OpenClaw runner adapter, credential/destination configuration, idempotent acceptance/reconciliation contract, event discovery scheduler, lease renewal for long-running jobs, adoption-fence integration and durable dead-letter owner alert remain unimplemented. The route and synthetic adapters are preparation, not live notification delivery. Character review events are projected from their existing atomic workQueue, not replayed from historical payment records. Do not enable until these pieces pass isolated end-to-end rehearsal. No release authorization inferred.

### Follow-on local fencing and transport discovery

`renew` now extends the exact unexpired agent claim, including an accepted-run/delivered claim. It cannot resurrect expired claims. Both character-sheet publication and manual proof adoption now require the task-kind-matched fence for outbox-enrolled orders, checking again immediately before their conditional commit. Concurrent payment/version/lease writes invalidate that CAS. Manual proof CLI accepts the fence from `HSB_WORK_EVENT_ID` / `HSB_WORK_CLAIM_TOKEN`, never stdout. Proof packages use manualProofSourceHash: workOutbox, updatedAt and supplemental PaymentIntent reference do not change source identity. All other fields remain bound, including character approval/image/version, payment status/amount, book format and print upgrade/shipping changes. Renewals during artifact verification still cause a safe CAS conflict; retry with the same package after fresh preflight, never silently rebase. The 10-minute lease exceeds the 300-second route duration. Transport claim token rotates; workToken is event-stable and is the token used for runner renewal/adoption. Never log either token.

Read-only local tool discovery (`openclaw message send --help`, `openclaw agent --help`) confirms command shapes but exposes **no documented caller idempotency key or authoritative event-id reconciliation**. An explicit session key does not deduplicate agent turns. Therefore `scripts/plan-paid-order-handoff.ts` performs bounded offline discovery on explicit order snapshots and emits concrete CLI argument plans only; owner args include `--dry-run`, agent plan is marked non-executable. It never invokes tools/network and has no execution flag. This is a true runtime API blocker, not a reliable live adapter. Before activation obtain a durable acceptance/reconciliation API or implement a transactional gateway inbox; an on-disk receipt written after a send cannot close the accepted-but-response-lost gap. No live probe was attempted.
