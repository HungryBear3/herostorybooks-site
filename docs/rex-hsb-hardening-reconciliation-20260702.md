# Rex HSB Hardening Reconciliation — 2026-07-02

## Branch / deploy candidate
- Worktree: `/Users/abigailclaw/.openclaw/workspace/rex/worktrees/hsb-hardening-20260702`
- Branch: `rex/hsb-checkout-fulfillment-hardening-20260702`
- Base/deploy candidate: `origin/hsb/deploy-candidate-20260602`
- Reconciliation check: `git rev-list --left-right --count HEAD...origin/hsb/deploy-candidate-20260602` returned `0 0` before this hardening slice, so this work starts exactly on the deploy candidate.

## Existing relevant protections found before coding
- `/api/cron/fulfillment-sweep` exists in `vercel.json` and is auth-gated via `CRON_SECRET` or admin key.
- `submitPrintAfterOwnerGo` already has a durable create-only print-go intent lock and single-attempt provider submit semantics.
- `sendOperatorFailureAlert` exists, but alert recording was not durable/audited on all manual-review and delivery-email-failed paths.
- Stripe checkout collects shipping for print formats, but webhook processing needed a server-side missing-shipping gate and stronger session replay idempotency.
- `/api/order/[orderId]/approve-whole-book` needed server-side review-token authorization before `approveWholeBook`.

## Hardening added
- Stripe replay guard: `updateOrderPayment` refuses to overwrite an existing order's Stripe session with a different incoming session.
- Print webhook shipping gate: paid print orders without a usable shipping address move to manual review instead of fulfillment.
- Ops visibility: admin orders and cron sweep responses include paid-stuck / manual-review / delivery-email-failed digest buckets.
- Alert audit durability: actual manual-review / delivery-email-failed alerts append `operator_alert_recorded`; expected `proof_release_hold` pauses remain proof-release audit events and do not create operator-alert noise.
- Customer review auth: whole-book approval POST now requires the order-bound proof token before invoking `approveWholeBook`; the review UI submits the token from the URL.

## Verification
- PASS: `node --experimental-strip-types --test tests/fulfillment.test.ts tests/fulfillment-backlog.test.ts tests/cron-fulfillment-sweep.test.ts tests/stripe-checkout.test.ts tests/approve-whole-book-route-token.test.ts`
- PASS: `npm run build`
- PASS: `npm run lint` (0 errors; existing warnings remain)
- PASS: `git diff --check`
- PASS: `graphify update .`
- NOT CLEAN: full `npm test` still fails on pre-existing/stale source-copy contract tests unrelated to this branch (`voice-upload`, `supporting-character-reference-photo-ux`, `fathers-day`, `her49-upload-validation-ux`). Focused hardening tests pass.

## Review note
Claude review found one must-fix in the first draft: proof-release holds were recording operator-alert audits. Fixed by leaving proof-release holds as `proof_release_failed` only, plus regression assertions for digital and print holds.

## Scope boundary
No live deploy, live customer mutation, print submission, email send, or public/social action is authorized by this branch/report.
