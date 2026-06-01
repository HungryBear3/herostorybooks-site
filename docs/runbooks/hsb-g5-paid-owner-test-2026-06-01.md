# HSB G5 Paid Owner-Test Runbook - 2026-06-01

Status: preparation packet only. Do not run this against production until Alexy gives an explicit side-effect go/no-go for the specific order window.

Candidate branch: `hsb/red-yellow-candidate-20260601`  
Candidate HEAD: `f56eeee`  
Scope: one real paid E2E proof-first order, with no automatic print submission.

## Hard Stops

- No Stripe charge, live checkout order, production order mutation, customer email, proof release, refund, Lulu/RPI submission, or print action without explicit approval.
- Do not use existing owner-test order `ord_d8ba45c3169b456f` unless Alexy separately approves that exact recovery path.
- Do not submit print unless the order has customer proof approval, owner print-go, and an explicit final print go/no-go.
- If any step produces template fallback, missing route provenance, missing QA evidence, or unclear print partner/SKU state, stop and mark the run blocked.

## Required Evidence

Capture these in the run log before proceeding to the next stage:

- Vercel deployment id and git commit.
- Stripe Checkout Session id and PaymentIntent id.
- HSB order id.
- `generationRouteDecision` route/source/model/releasable values.
- `route_decision_recorded`, `proof_generated`, `qa_pass_recorded`, proof email, revision, proof rebuild, proof approval, and owner print-go audit events when they occur.
- Admin QA checklist screenshot or copied diagnostics text.
- Customer proof/review URL presence without exposing the token publicly.
- Proof email delivery evidence in the controlled inbox.
- Explicit assertion that no print job id exists before owner print-go.
- Explicit assertion that no auto-print occurred after customer approval.

## Step-by-Step Run

1. Deploy candidate to an approved preview or production target only after deploy approval.
2. Confirm `/checkout`, `/admin/qa-room`, `/admin/capacity`, and `/admin/orders` are reachable and admin-auth protected.
3. Create one controlled paid print order using approved owner inputs, a controlled inbox, and an interceptable shipping address.
4. Record `orderId`, `cs_*`, `pi_*`, deployment id, and commit.
5. Wait for fulfillment to generate artifacts and hold at `awaiting_qa`.
6. Verify route/provenance:
   - `generationRouteDecision` exists.
   - route is `model_story` or `manual_safe`.
   - `releasable` is `true`.
   - matching `route_decision_recorded` audit event exists before proof release.
7. Verify proof artifacts:
   - `storyArtifactUrl` exists.
   - page artifacts exist.
   - no customer proof email has been sent before QA pass.
8. Complete admin QA checklist only if the proof is customer-safe.
9. Run QA pass.
10. Verify proof email release:
    - fulfillment moves to `proof_ready`.
    - `proofApprovalToken` exists.
    - proof email arrives in the controlled inbox.
    - no print job id exists.
11. Open the review URL from the email.
12. Request one revision using the customer review surface.
13. Verify revision request evidence:
    - order returns to a non-approved review state.
    - revision/page-change audit is recorded.
    - customer approval is not available until rebuilt proof is ready and acknowledged.
14. Rebuild or regenerate the revised proof through the approved admin/customer flow.
15. Verify revised proof:
    - `proof_rebuilt` or equivalent audit exists.
    - `proofReviewedAt` is cleared after rebuild.
    - page artifacts remain intact.
16. Acknowledge the revised proof from the customer review page.
17. Approve the revised proof as the customer.
18. Assert no auto-print:
    - `reviewStatus` is approved.
    - fulfillment is `proof_approved`.
    - no `printJobId` exists.
    - no Lulu/RPI call has happened.
19. Only after a separate print go/no-go, run owner print-go with a nonblank operator id.
20. Verify owner print-go:
    - `ownerPrintGoAt`, `ownerPrintGoBy`, and durable lock evidence exist.
    - duplicate/concurrent owner-go returns safe refusal or `RACE_LOST`.
    - only one print submission can occur.

## Pass Criteria

- Paid order reaches generated proof state without customer release before QA.
- Route/provenance exists before proof release and matches audit evidence.
- QA pass is required before proof email release.
- Revision request pauses approval and requires a revised proof.
- Customer approval does not submit print.
- Owner print-go is the first point where print submission can occur.
- No stale-read write drops route, proof, QA, approval, or owner-go audit evidence.

## Fail-Closed Outcomes

Stop the run and keep HSB RED/HOLD if any of these occur:

- `generationRouteDecision` missing.
- `route_decision_recorded` missing.
- route decision is `releasable: false`.
- template fallback reaches customer proof/email release.
- proof email sends before QA pass.
- customer approval submits print.
- owner print-go races can produce more than one print submission.
- production diagnostics disagree with admin/order state.

## Final Report Format

```text
G5 owner-test result: PASS / HOLD
Order:
Deployment:
Commit:
Route/provenance:
QA evidence:
Proof email evidence:
Revision evidence:
Revised proof evidence:
Customer approval evidence:
No-auto-print assertion:
Owner print-go evidence, if approved:
Side effects performed:
Residual blockers:
```
