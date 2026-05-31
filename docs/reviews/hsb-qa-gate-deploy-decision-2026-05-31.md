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

## Remaining Business Decisions

- Set daily order cap: recommended 8/day until QA throughput proves clean.
- Set print cutoff: recommended Friday, June 5, 2026 unless RPI/Lulu lead-time evidence improves.
- Decide if digital-included-with-print copy is live-product true before saying it publicly.
- Approve first 3 social assets before any post.
