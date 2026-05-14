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
