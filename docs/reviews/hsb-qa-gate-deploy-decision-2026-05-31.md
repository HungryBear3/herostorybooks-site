# HSB QA Gate Deploy Decision - 2026-05-31

Status: local review packet; no deploy, production order mutation, webhook replay, Stripe/Lulu/RPI/Vercel API action, or public marketing action performed.

## Recommendation

Ship the QA/email gate before any Father's Day traffic push.

Reason: the current cash-flow plan depends on proof-before-print trust. That promise is only safe if the system structurally prevents customer proof/digital emails from going out before a positive human QA pass.

## What This Branch Adds

- `qaPassAt` / `qaPassBy` on `OrderRecord`
- `awaiting_qa` fulfillment state
- digital fulfillment holds the generated PDF and does not call `sendDigitalDeliveryEmail` until QA pass exists
- print fulfillment holds the generated proof/print artifacts and does not call `sendProofReadyEmail` until QA pass exists
- admin-auth POST `/api/admin/orders/[orderId]/qa-pass`
- admin order-detail checklist/button for "Approve for customer proof release"
- `qa_pass_recorded` audit event
- customer email release after QA pass
- proof token creation for print proof release
- resend/retry/manual print approval hardened to require QA pass

## Explicit Non-Goals Preserved

- No print go/no-go side effect from QA pass
- No automatic Lulu/RPI submission
- No webhook replay
- No production order mutation
- No deploy
- No route for non-admin QA pass

## Copy/Marketing Alignment Added

The branch also updates visible Father's Day copy away from older digital-first/tool-language positioning:

- print is the early-window keepsake hero
- digital is the late-window safety valve
- proof-before-print is the conversion promise
- no "AI" marketing language
- no same-day / instant / guaranteed Father's Day delivery framing
- no fake scarcity

## Ship Gate

Before production deploy:

1. Confirm this branch is the only intended release scope.
2. Confirm no unrelated dirty files are included.
3. Re-run focused QA/fulfillment tests.
4. Re-run Father’s Day/pricing/orders copy tests.
5. Run `npm run build`.
6. If approved, deploy once, then smoke:
   - `/`
   - `/pricing`
   - `/checkout`
   - admin login
   - admin order detail renders QA action for an `awaiting_qa` fixture only
7. No live Stripe order, production order edit, webhook replay, Lulu/RPI call, or customer email test unless explicitly approved separately.

## Father's Day Capacity Rule

Warm launch should stay manually capped until proof QA and print fulfillment have several clean days of evidence.

- **Hard ceiling:** 10 paid orders per day.
- **Daily target:** 8 paid orders per day.
- **Slowdown triggers:** in-flight QA queue above 6, median time-to-proof above 36 hours, or any single revision exceeding 2 round-trips.
- **Slowdown action:** back off traffic, remove any express/timing implication from active copy, and hold non-essential changes.
- **Pause triggers:** 10 paid orders in a day, QA defect rate above 20% across the latest 5 orders, Lulu/RPI acknowledgment delayed more than 24 hours, or any Stripe dispute/chargeback.
- **Pause action:** set `HSB_CHECKOUT_PAUSED=true` so `/checkout` and `/api/order` stop new orders and show the queue-full notice.
- **Post-June-5 rule:** print is closed by default. Keep digital-first copy live; enable print only with Alexy's explicit go and fresh print-partner SLA evidence for that order window.

## Review Findings Resolved Locally

- Price set is `Digital $14.99 / Classic $44.99 / Premium $64.99`; checkout/pricing/order records now align to that set.
- Old 15-minute, AI-likeness, satisfaction-guarantee, and selectable Mother's Day checkout copy are blocked by regression tests.
- Premium no longer claims extra-copy bundle language in pricing tests.
- Print timing now says 5-7 business days after proof approval.
- The checkout pause surface now says the queue is full and reopens tomorrow.
- "Digital included with every print order" is intentionally not used until final digital delivery for print buyers is confirmed or implemented.

## Remaining Business Decisions

- Confirm the manual operator for the daily order count and `HSB_CHECKOUT_PAUSED` toggle.
- Set print cutoff: recommended Friday, June 5, 2026 unless RPI/Lulu lead-time evidence improves.
- Decide if final digital edition included with print is live-product true before saying it publicly.
- Approve first 3 social assets before any post.
