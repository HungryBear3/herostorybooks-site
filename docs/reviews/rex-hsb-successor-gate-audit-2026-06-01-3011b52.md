# Rex HSB Successor Gate Audit — 3011b52

Signed by: Rex 🐺
Signed at: 2026-06-01 15:43 CDT
Scope: local worktree/code/docs evidence only. No deploy, production order mutation, Stripe charge, customer email, Lulu/RPI call, Resend action, or print action was performed.

## Candidate

- Worktree: `/Users/abigailclaw/.openclaw/workspace/cc-worktrees/hsb-red-yellow-candidate-20260601`
- Branch: `hsb/red-yellow-candidate-20260601`
- Audited commit: `3011b52` (`fix(hsb): close yellow public trust and capacity gates`)
- Stack observed:
  - `58b9701` — G2 stale-read/email refusal fix
  - `8d148fe` — G3 durable owner print-go intent lock
  - `f56eeee` — G1 route/provenance persistence before proof release
  - `b46edbe` — G5/ops/adversarial docs packet
  - `3011b52` — public trust/capacity/proof-release email lock follow-up
- Local status note: candidate worktree has untracked `ops/` screenshot/text evidence from public-trust smoke capture. Source/docs commit under audit is still `3011b52`.

## Verification I ran

- `git rev-parse --short HEAD` → `3011b52`
- `git branch --show-current` → `hsb/red-yellow-candidate-20260601`
- `npm test` → `1009/1009 pass`
- `npm run build` → green; existing Turbopack NFT warning remains
- `git diff --check` → clean
- skip/only scan over `tests/*.test.ts` → clean
- Source/docs inspection for G1/G2/G3/G5/public-trust/print-capacity patterns.

## Verdict

**YELLOW-CANDIDATE for controlled internal readiness only. Not GREEN. Not approved for paid traffic, creator/gifting outreach, or a real paid G5 run yet.**

Rationale:
- G1, G2, G3 are accepted as code gates against `3011b52`.
- G5 is a complete runbook/artifact checklist, but no real paid E2E artifact packet exists yet.
- Ops ownership/monitoring is still partly placeholder/manual.
- Print path/SLA decision is conservative: use Lulu API/code path if print is tested, but keep all customer print copy non-date-specific/best-chance unless a written partner SLA is obtained.

## Gate findings

### G1 — Route/provenance before proof release: PASS

Evidence:
- `src/lib/fulfillment.ts:187-229` builds `GenerationRouteDecision` and matching `route_decision_recorded` audit event with route/source/model/releasable fields.
- `src/lib/fulfillment.ts:529-535` persists story meta + generation route decision + route audit before any image/PDF artifact can become releasable.
- `src/lib/orders.ts:1564-1600` refuses proof artifact release unless `generationRouteDecision` exists, is `releasable`, and has a matching `route_decision_recorded` audit event.
- `tests/fulfillment.test.ts:219-293` covers the fail-closed release guard and asserts route decision/audit exists before artifact upload and proof generation.

Pattern-by-pattern:
- Missing `generationRouteDecision`: fail-closed by `assertRouteDecisionAllowsProofRelease`.
- Non-releasable fallback route: fail-closed by `decision.releasable` check.
- Missing matching audit event: fail-closed by `hasMatchingRouteDecisionAudit`.
- Route persistence before upload: covered by upload seam assertion in `tests/fulfillment.test.ts`.

Caveat:
- This accepts the code gate. It does not prove production deploy/env state.

### G2 — Stale-read/audit clobber handling: PASS

Evidence:
- `src/lib/orders.ts:1603+` supports passing a fresh `existingOrder` into `updateFulfillmentState` to avoid re-reading stale blob state before merge.
- `src/lib/fulfillment.ts:541-551` explicitly carries `storyMeta` and route decision forward through later fulfillment writes, including delivery-email-failure paths.
- Prior accepted `58b9701` threads the updated refusal record into subsequent audit writes; current `3011b52` includes that stack.
- Full suite now passes `1009/1009`; relevant test coverage includes fulfillment-email-failure, stale-read-clobber, fulfillment, and generation-manifest cases.

Pattern-by-pattern:
- Refusal path writes must not erase newly persisted route/proof evidence: accepted via `58b9701` + current full suite.
- Delivery-email failure must preserve both route decision and proof evidence: covered in current stack and daily evidence log.
- Stale read after regen/proof rebuild must preserve page artifacts: covered by stale-read-clobber tests in full suite.

Caveat:
- Production Vercel Blob behavior still needs the real G5 artifact packet. Code-level risk is accepted for YELLOW candidate.

### G3 — Owner print-go before print submission: PASS

Evidence:
- `src/lib/fulfillment.ts:1365-1377` defines named refusal codes including `OWNER_BY_REQUIRED`, `RACE_LOST`, and idempotent already-submitted states.
- `src/lib/fulfillment.ts:1420-1481` refuses owner print-go unless payment is paid, not refunded, QA passed, customer approval exists, no print job exists, no prior owner-go exists, and fulfillment is `proof_approved`.
- `src/lib/orders.ts:1202-1257` creates a durable one-shot owner print-go intent lock before any Lulu/RPI call: Vercel Blob `allowOverwrite:false`; local/test FS `flag:'wx'`.
- `src/lib/fulfillment.ts:1483-1522` acquires that lock, persists owner fields, verifies token, then runs print; race losers return `RACE_LOST` before print side effect.
- `tests/fulfillment.test.ts:760-807` asserts customer approval alone leaves `ownerPrintGoAt`, `printJobId`, print cover, and `submitPrint` untouched.
- `tests/fulfillment.test.ts:810-919` covers owner-go happy path and refusal without customer approval.
- `tests/admin-shipping-proof.test.ts` current suite includes admin route auth/nonblank ownerBy/source checks and two parallel owner-go acquisition cases; full run passed.

Pattern-by-pattern:
- Customer approval auto-prints: blocked.
- Owner-go without QA/customer approval: blocked.
- Blank operator id: blocked.
- Customer-facing source importing print-go side effects: covered by source-level test in admin-shipping-proof suite.
- Concurrent admin POST double-submit: accepted after durable create-only lock before print side effect.

Caveat:
- Final operator UI/workflow must still be deployed and exercised in G5. Code gate is accepted.

### G5 — Real paid owner E2E: RUNBOOK PASS, ARTIFACT MISSING

Evidence:
- `docs/runbooks/hsb-g5-paid-owner-test-2026-06-01.md:16-29` enumerates required artifact packet: deployment id, Stripe Checkout/PaymentIntent, order id, route decision, route audit, proof email, revision, approval, and no-auto-print assertions.
- `docs/runbooks/hsb-g5-paid-owner-test-2026-06-01.md:31-77` covers paid order → route/provenance → proof artifacts → QA pass → proof email → revision → rebuild → approval → no-auto-print → owner print-go.
- `docs/runbooks/hsb-g5-paid-owner-test-2026-06-01.md:78-99` defines pass/fail criteria and fail-closed outcomes.

Finding:
- The runbook is acceptable. The gate itself is **not closed** until Alexy explicitly approves one real paid internal G5 run and the artifact packet is saved.

## Public trust / capacity / cutoff checks

Accepted improvements in `3011b52`:
- `src/lib/fathers-day.ts` now pins conservative internal safe order date to 2026-06-01 and avoids public date promises.
- `tests/fathers-day.test.ts:23-81` asserts no `Order by`, `Jun 5`, `June 5`, `June 1`, or guarantee copy in badge output.
- `tests/fathers-day.test.ts:92-111` asserts digital is safest and hardcover is follow-up keepsake, while avoiding guarantee/likeness promises.
- `tests/fathers-day.test.ts:123-127` asserts checkout copy says printed books are best-chance only.
- `tests/capacity-dashboard.test.ts:29-68` verifies daily paid target/ceiling and pause recommendation.
- `tests/capacity-dashboard.test.ts:117-201` verifies QA backlog, revision round-trip, defect-rate, and delayed print-ack pause signals.

Remaining ops gaps:
- Support inbox owner, refund/revision owner, banner-cutoff operator, and alarm owner are still named generically in `docs/ops/hsb-yellow-ops-readiness-2026-06-01.md:35-42`; they need actual named owners before operational YELLOW.
- Kill switches remain split/manual, not one console (`HSB_CHECKOUT_PAUSED`, owner-go hold, QA hold, marketing hold, provider hold).
- Resend bounce monitoring/webhook/list/dashboard/morning check not found; either implement KS-1 through KS-6/bounce monitoring or explicitly accept as manual-soft-launch risks.

## Final recommendation

Move the candidate to **YELLOW-CANDIDATE / internal prep** only after the print-path decision note below is adopted. Keep external launch status **RED/HOLD** until:

1. Named ops owners are assigned.
2. KS-1 through KS-6 + Resend bounce monitoring are either implemented or explicitly accepted as manual-soft-launch risks.
3. Alexy approves exactly one real paid internal G5 E2E.
4. G5 artifact packet is saved and reviewed.
5. Production deploy/go-no-go is separately approved.

Signed: Rex 🐺
