# Elon review remediation — local only

Review input e678019c; full repository patch based on 9b61691. External review is evidence, not executable authority. No imported harness scripts executed. Reproductions were ported as semantic regression tests against full repository modules; no missing-module stubs.

## Findings

- F1 confirmed, fixed: low-level retry mutation refuses enrolled/character-reviewed orders; both automatic kickoff boundaries refuse them even after character approval; retry no longer reports success for policy refusal/no start. Flag-on pending→paid enrollment atomically sets manual_hold.
- F2 confirmed, fixed locally: workToken is event-stable, delivery token rotates per claim. Reconciliation cannot orphan the accepted runner; old delivery token cannot ack after reclaim. Runner renewal accepts workToken; transports validate rotating token with validDeliveryClaim. Neither token may be printed or placed in agent prose.
- F3 confirmed, fixed locally: first leased attempt sends directly; all ambiguous retries require authoritative reconciliation. Unknown is never resent. No exactly-once claim.
- F4 confirmed, invitation recovery fixed: authenticated reissue_invitation rotates only invitation secret/expiry for same awaiting version, CAS-bound and audited in review history; no send and no work enqueue. Superseding/replacing an awaiting sheet without customer revision is NOT added: needs distinct audited operator action, not a fabricated customer decision.
- F5 confirmed against full canonicalSourceHash: stable proof source excludes only workOutbox, updatedAt, supplemental stripePaymentIntentId. Unknown fields remain bound. Character image/version/approval, intake, payment status/revenue, format, shipping and print upgrade stay bound. Print upgrade is not harmless by assumption: changes require revalidation/rebinding. Lease is 10 minutes (>300s route). Heartbeat during verification still safely conflicts CAS; retry same package on fresh preflight, never silently rebase or overwrite lease writes.
- F6 fixed local enrollment: newly enrolled orders require manual/character workflow; no parallel automatic generation.
- F7 fixed eligibility: agent work ends once proof/page artifacts exist (durable event history retained).
- F8 fixed lane eligibility: owner receipts survive character progression. Refund/release/print blockers remain fail-closed.
- F9 fixed: known receipt may ack after lease expiry if the same delivery token is still current; never after replacement.
- F10 remains blocker: scoped event-worker credentials and secure credential handoff not implemented. Current endpoints remain admin-only. Do not give runner full admin key or put tokens in transcript.
- F11 cookie authentication exists; Origin rejection added to handoff and manual proof mutation boundaries (same-origin browser vs absent-origin authenticated CLI).
- F12 zero-total/unknown-revenue are held, not dispatched. Internal owner-test authorization/classification must be explicit before enabling a test lane; do not relabel free/internal as revenue.
- F13 no stop adapter: fences stop adoption/renewal on refund, but running agent cancellation/owner alert still needs implementation. List exposes blocked state for operator observation only.
- F14 list now exposes ambiguous/dead-letter attention instead of filtering it away. No live alert/resolution workflow; remains rollout blocker. Do not blind requeue terminal work.
- F15 PaymentIntent backfill no longer invalidates prepared source. Original CAS churn remains safe.
- F16 admin panel fence acquisition not implemented here; operator must not bypass fencing. UI integration remains separate.
- F17 planner describes Gateway agent RPC/idempotency, not unsupported CLI session-key; still explicitly non-executable pending authoritative receipt reconciliation.
- F18 async payment compatibility remains unreviewed/pre-existing; no supported-method expansion.

## Verification and release posture

Focused paid-order/character/manual-proof suites: 77/77 pass. Fulfillment/admin/order mode regression suites: 82/82 pass. Combined final backend/regression run: 159/159 pass. Full typecheck and Next production build pass locally (logs /tmp/elon-remediation-*). Build is not a deploy. No full repository test suite or browser suite run for this backend patch yet.

Synthetic local development permitted only; Preview/Production and owner-test invitation NOT ready. Missing concrete dispatch/reconciliation, scoped credentials, durable exception resolution/alert, stop signal, and end-to-end test remain blockers. No sends, customer writes, provider calls, runtime activation or production changes performed.

## Independent-review follow-up: accepted-run liveness

Late successful agent acknowledgements intentionally preserve an expired work lease. This formerly left a delivered event unable to renew or reclaim. Added explicit admin-only `recover_accepted_run`: requires expired delivered agent lane, exact current delivery token AND event work token, matching accepted receipt, and `verified_same_accepted_run` attestation. Existing payment/refund/disposition/version/proof eligibility checks run first inside the transaction. The command extends the lease for the same run and appends bounded recovery history; it never dispatches, resets attempts, rotates work identity or makes delivered events claimable. Stale delivery owner, wrong receipt, live lease, superseded character, refund and completed proof fail. Recovery does not supply missing authoritative adapter evidence: operator must actually verify that exact accepted run before attesting.
