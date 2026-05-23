# HSB Support Checklist — Stuck or Disputed Order

Use this when a customer reports their book never arrived, the proof never appeared, or the order seems broken. Read-only flow — none of these steps mutates state.

## What to look at first (in order)

1. **Pull the diagnostics.** Either:
   - Web: `/admin/orders/<orderId>` (top "Diagnostics" section)
   - JSON: `/api/admin/orders/<orderId>/diagnostics`
   - Text (paste-friendly): `/api/admin/orders/<orderId>/diagnostics?format=text`
   - CLI: `npm run order:status -- <orderId>`

   For a dashboard-wide queue of paid orders that need artifact attention, use:
   - Web: `/admin/orders` → filter **Paid attention**
   - JSON: `/api/admin/orders?opsIssue=paid_artifact`

   For the **full** stuck-order sweep (broader than `paid_artifact` — see "Proactive watchdog" below), use:
   - CLI: `npm run order:watchdog` (text) · `npm run order:watchdog -- --json` · `npm run order:watchdog -- --fail-only`
   - JSON: `/api/admin/orders?opsIssue=stuck` (returns `{ orders, watchdog }`)

2. **Read the colored checks** at the top of the diagnostics block. Anything `FAIL` is a real problem; `WARN` may be benign but is worth understanding.

3. **Match the customer's complaint to the diagnostics:**

   | Customer says | Look at |
   | --- | --- |
   | "I never got an email." | `payment.status`, `fulfillment.fulfillmentStatus`, `artifacts.storyArtifactUrl`. If `paid` + `complete` + `storyArtifactUrl` set, this is a deliverability problem, not a code problem. |
   | "My proof never came." | `flags.proofReady`. If false, check `fulfillment.lastError` and recent `auditEvents`. |
   | "I paid but nothing generated." | `paidOrderOpsIssue` / check id `paid-artifact`. This is raised when a paid order has no proof/digital artifact and is `not_started`, `failed_manual_review`, stale in an in-progress state (>15 minutes), or in a terminal state without `storyArtifactUrl`. |
   | "I approved but it never shipped." | `flags.approved`, `print.printJobId`, `print.printJobStatus`. If approved but no printJobId, `submitToPrint` failed. |
   | "I was charged twice." | Stripe Dashboard first; webhook idempotency means the order should be a single row. |
   | "The book has the wrong photo." | `photo.blobPath` — open it. Then `pageArtifacts[].currentImageUrl` to see what was generated. |
   | "I see 'we hit a snag'." | `flags.isFailed = true`. `fulfillment.lastError` is the cause. |

4. **Check the audit trail.** The diagnostics `review.recentEvents` are the last 10 review/proof events. The full list lives on the admin page under "Review audit trail". Look for:
   - `whole_book_approval_rejected` events with a `reason` (tells you exactly why approval was blocked).
   - `page_regenerated` clusters (5+ on the same page = manual review territory).
   - Missing `proof_generated` on a paid order = fulfillment never produced a proof.

5. **Cross-reference Stripe.** Search `payment.stripeSessionId` in Stripe Dashboard. Confirm the PaymentIntent succeeded and the customer email matches.

## Proactive watchdog (find stuck orders before customers complain)

`paid_artifact` only catches the **pre-artifact** stage (paid but no story/proof PDF yet). The watchdog widens this to the whole path to delivery so revenue-at-risk orders surface before they become refunds. It is **read-only** — it never mutates orders, Stripe, Lulu, or blob state.

- CLI sweep: `npm run order:watchdog` (add `--json` for a machine report, `--fail-only` to show just FAIL findings). Exit code is `1` when any FAIL-severity order is stuck, so it can gate a cron/CI check.
- Web/JSON: `GET /api/admin/orders?opsIssue=stuck` → `{ orders, watchdog }`, where `watchdog.findings[]` carries `reason`, `severity`, `label`, `detail`, `suggestedAction`, and `minutesSinceUpdate`.
- Store selection mirrors `order:status`: set `BLOB_READ_WRITE_TOKEN` (and `HSB_BLOB_NAMESPACE` if used) to scan the **production** store. Without it the CLI scans the local dev store and says so — it never silently implies "all clear".

Findings (each maps to a `suggestedAction` and a runbook step below):

| reason | severity | meaning | next step |
| --- | --- | --- | --- |
| `paid_no_artifact_not_started` | FAIL | Paid, fulfillment never started | Check webhook/kickoff logs; admin Retry if truly paid + no artifacts |
| `paid_no_artifact_failed` | FAIL | `failed_manual_review` before any artifact | Read `fulfillmentLastError`; admin Retry once understood |
| `paid_no_artifact_stale_in_progress` | FAIL | In-progress >15 min, no artifact | Generation hung; check logs, then admin Retry if nothing produced |
| `paid_no_artifact_terminal` | FAIL | Terminal status, no artifact URL | Manual review before any retry |
| `delivery_email_failed` | FAIL | Book exists, only the customer email failed | **Resend** delivery/proof email — do NOT re-run the pipeline |
| `print_proof_awaiting_customer_stale` | WARN | Paid print proof un-approved for >3 days | Send a reminder / follow up; never auto-approve without consent |
| `print_approved_not_submitted` | FAIL | Approved but no `printJobId` | `submitToPrint` likely failed; verify address, retry submit when safe |
| `print_submit_stalled` | FAIL | `submitting_to_print` with no `printJobId` | Check Lulu submission logs before retry |
| `print_submitted_no_shipment_stale` | WARN | Print job submitted, no shipment for >14 days | Check Lulu job status / tracking and follow up |

Thresholds (15 min / 3 days / 30 min / 14 days) live in `WATCHDOG_DEFAULT_THRESHOLDS` in `src/lib/order-watchdog.ts` and are overridable per call. Unpaid, refunded, and internal-disposition (test/smoke) orders are excluded.

## Severity heuristics

- **Drop everything:** any `FAIL` check + a paid customer waiting + no movement in `updatedAt` for >24h.
- **Same business day:** `WARN` on photo, stripe session id, or print job id with the customer waiting.
- **Backlog:** `WARN` on audit events / `INFO` checks only.

## Read-only escalation packet

When handing off, paste the **text diagnostics** (`?format=text`) and the customer's email. Don't paste the JSON — it's noisy. Don't paste blob URLs publicly — they're bearer credentials in the current `public` access mode.

## Mutating actions (when authorized)

These exist on the admin page under "Actions" but are NOT part of inspection. Use only when you understand why:

- **Retry fulfillment** — only on `failed_manual_review`.
- **Paid but no artifact + not_started** — inspect webhook/kickoff logs first. If the order is truly paid and has not already generated artifacts, admin retry can kick fulfillment; record the Stripe session and diagnostics in the ticket.
- **Resend proof email** — safe, idempotent.
- **Manually approve proof** — bypasses the customer ack. Only with explicit customer consent (e.g. they emailed approval).
- **Mark shipped & email customer** — only after the print partner confirms a real shipment.

If none of these are safe, escalate to engineering with the diagnostics text block.
