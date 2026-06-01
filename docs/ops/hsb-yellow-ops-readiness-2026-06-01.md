# HSB YELLOW Ops Readiness Checklist - 2026-06-01

Status: docs-only readiness packet for the `3011b52` RED-to-YELLOW candidate. Rex successor audit and print-path decision are recorded in `docs/reviews/rex-hsb-successor-gate-audit-2026-06-01-3011b52.md` and `docs/ops/hsb-print-path-sla-decision-2026-06-01.md`. No production deploy, order mutation, customer communication, Stripe/Lulu/RPI action, or print action was performed.

## YELLOW Entry Rule

HSB can move from RED/HOLD to YELLOW only after:

- G1 route/provenance is integrated and verified.
- G2 stale-read audit handling remains accepted.
- G3 owner print-go is integrated and verified with a durable create-only lock.
- G5 paid owner-test runbook is accepted.
- This ops checklist has named owners and active kill-switch access or an explicit manual-risk acceptance for the internal-only window.
- Opus/adversarial review finds no hidden launch blockers or the blockers are resolved.
- Alexy gives production deploy/go-no-go.

## Operating Limits

- Daily target: 8 paid orders.
- Hard cap: 10 paid orders.
- QA in-flight slowdown trigger: more than 6 orders in `awaiting_qa`.
- Median proof timing slowdown trigger: more than 36 hours from paid order to QA pass/proof release.
- Revision slowdown trigger: any order over 2 revision round-trips.
- Defect slowdown trigger: QA defect rate above 20% across the latest 5 paid orders.
- Print acknowledgment slowdown trigger: any order stuck in `submitting_to_print` for more than 24 hours without partner status.

## Kill Switches

Admin console: `/admin/kill-switches`.

- KS-1 checkout pause: enforced through `/api/order` before form parsing, upload, or Stripe Checkout session creation. The legacy env pause `HSB_CHECKOUT_PAUSED=true` still works separately.
- KS-2 proof release hold: enforced through `releaseOrderAfterQa` before customer proof/digital email and before release state advance.
- KS-3 owner print-go hold: enforced through `recordOwnerPrintGo` / `submitPrintAfterOwnerGo` before the durable owner print-go lock and before print submission.
- KS-4 marketing hold: manual/status-only; stop paid traffic, creator/gifting pushes, and new social CTAs.
- KS-5 provider hold: manual/status-only; generation routing still relies on route/provenance policy guards rather than one global provider toggle.
- KS-6 print-provider hold: enforced through `submitPrintAfterOwnerGo` and `runPrintProduction` before Lulu/RPI provider submission.

## Required Owners

- Daily cap owner: Rex runs read-only morning/evening capacity checks; Alexy owns final pause/resume decisions; Abigail records candidate posture and escalates anomalies.
- QA operator: Alexy for any real paid G5 unless he explicitly delegates; `qaPassBy` / `qaReviewer` must record the actual operator id.
- Support inbox owner: Alexy primary for `support@herostorybooks.com`; Abigail/Rex may perform read-only daily checks and summarize blockers when authorized.
- Refund/revision owner: Alexy final business decision; Abigail/Rex prepare read-only evidence packets and recommended dispositions.
- Print-go owner: Alexy primary; `ownerPrintGoBy` must record the named operator id. Abigail/Rex may not trigger print-go without explicit per-order approval.
- Banner/cutoff operator: Alexy final decision-maker. Abigail/Rex may set or monitor a 2026-06-06 00:00 CDT reminder, but current approved public posture is no date-specific print cutoff and no deploy/copy flip without explicit go/no-go.
- Incident owner: Abigail/Rex for internal triage, with Alexy as final business go/no-go.

## Father’s Day Week SLA

- Support inbox check: at least morning and afternoon CDT during any approved G5/internal traffic window.
- Proof/revision/refund/payment issues: escalate to Alexy the same business day; during an active G5 run, target under 4 business hours.
- Capacity check: before any traffic push and after any paid order.
- Banner/cutoff check: on 2026-06-06, verify public copy remains non-date-specific unless a written partner SLA has been attached and Alexy approves a deploy.

## Manual Controls Not Yet Replaced By Console

- KS-1, KS-2, KS-3, and KS-6 are implemented as enforced kill-switches in the admin console.
- KS-4 marketing hold and KS-5 provider hold are visible manual/status-only controls because no single marketing or generation-provider integration boundary exists in this app.
- Resend bounce monitoring is not implemented in this candidate.
- For internal-only YELLOW-CANDIDATE, Resend bounce monitoring remains a manual risk only if Alexy explicitly approves the G5 run with manual inbox/Resend/dashboard checks.
- Before external paid traffic or creator/gifting traffic, implement bounce monitoring or record a separate explicit risk acceptance.

## Daily Checks While YELLOW

Run at least once each business day and before any traffic push:

- `/admin/kill-switches`: confirm KS-1/KS-2/KS-3/KS-6 enforced holds are clear or intentionally active; confirm KS-4/KS-5 manual holds match current traffic/provider posture.
- `/admin/capacity`: paid today, QA in-flight, oldest proof age, median time-to-proof, revision round-trips, QA defect rate, print ack delay.
- `/admin/qa-room`: no route/provenance blockers, no template fallback customer release, no unauthenticated QA action.
- `/admin/orders`: all paid orders have clear status and latest audit event.
- Support inbox: no unanswered proof/revision/refund messages older than one business day.
- Stripe dashboard: no disputes/chargebacks/refund anomalies.
- Print partner dashboard/logs: no stuck `submitting_to_print` orders.
- Public copy: no hardcover-by-Father's-Day promise and no June 5 print cutoff unless partner-confirmed SLA exists.

## Father’s Day Copy Rules

- Conservative softcover-by-Father's-Day cutoff: 2026-06-01 23:59 CDT.
- Aggressive softcover cutoff: 2026-06-03 only with active operator judgment and current capacity.
- Do not promise hardcover by Father's Day.
- Digital-only cutoff: 2026-06-17 23:59 CDT.
- If print timing is uncertain, public copy should say digital is the safest timing option and print follows proof approval.

## Refund and Revision Rules

- Digital orders are refundable until proof approval/delivery.
- Print orders are refundable until customer proof approval and before owner print-go.
- After owner print-go/print submission, only fulfillment defects or printing errors are eligible for replacement/refund review.
- Revision requests pause approval until the revised proof is rebuilt and acknowledged.
- More than 2 revision round-trips triggers manual owner review before promising timing.

## Incident Response

Set `HSB_CHECKOUT_PAUSED=true` and stop traffic if:

- Any customer receives template/fallback proof content.
- Any customer proof or digital delivery releases without QA pass.
- Customer approval causes print submission without owner print-go.
- More than one print submission occurs for the same order.
- Stripe dispute or chargeback appears.
- Support inbox has unresolved proof/revision/refund issue older than one business day during active traffic.
- Print partner SLA or SKU entitlement is unclear for a paid print order.

## YELLOW Exit / GREEN Consideration

Do not consider GREEN until:

- At least one paid owner-test passes end-to-end.
- Several production orders complete proof/revision/approval without manual state repair.
- Print partner path is confirmed for the selected SKU and fulfillment mode.
- Capacity stays under limits for several days.
- Opus/adversarial review and Rex/Oscar ops checks are clean.
