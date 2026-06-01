# HSB YELLOW Ops Readiness Checklist - 2026-06-01

Status: docs-only readiness packet for the `f56eeee` RED-to-YELLOW candidate. No production deploy, order mutation, customer communication, Stripe/Lulu/RPI action, or print action was performed.

## YELLOW Entry Rule

HSB can move from RED/HOLD to YELLOW only after:

- G1 route/provenance is integrated and verified.
- G2 stale-read audit handling remains accepted.
- G3 owner print-go is integrated and verified with a durable create-only lock.
- G5 paid owner-test runbook is accepted.
- This ops checklist has named owners and active kill-switch access.
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

- Checkout pause: set `HSB_CHECKOUT_PAUSED=true`.
- Print action hold: do not run owner print-go; keep orders at `proof_approved`.
- Customer proof hold: do not run QA pass; keep orders at `awaiting_qa`.
- Marketing hold: stop paid traffic, creator/gifting pushes, and new social CTAs.
- Provider hold: disable any route that lacks explicit route/provenance evidence or partner SLA confidence.

## Required Owners

- Daily cap owner: Alexy or named operator.
- QA operator: named person completing the proof checklist.
- Support inbox owner: named person checking `support@herostorybooks.com`.
- Refund/revision owner: named person deciding whether the customer gets revision, refund, or hold.
- Print-go owner: named operator whose id is recorded in `ownerPrintGoBy`.
- Incident owner: Abigail/Rex for internal triage, with Alexy as final business go/no-go.

## Daily Checks While YELLOW

Run at least once each business day and before any traffic push:

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
