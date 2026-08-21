/**
 * Authoritative customer-facing proof-turnaround window.
 *
 * Alexy decision (2026-07-26): proofs are usually ready in "2–3 business days"
 * everywhere — public pages, checkout, gift pages, thank-you, order records,
 * confirmation email, and status. Do NOT tighten the customer commitment to
 * 2 days. This is the single source of truth so those surfaces cannot drift
 * apart (the pre-payment vs post-payment mismatch flagged in review).
 *
 * Pure string constants only — no server-only imports — so this module is safe
 * to import from both Server and Client Components with no boundary regression.
 */
export const PROOF_TURNAROUND_WINDOW = '2–3 business days';

/** Common full phrase, e.g. "Digital proof usually ready in 2–3 business days". */
export const PROOF_TURNAROUND_PHRASE = `usually ready in ${PROOF_TURNAROUND_WINDOW}`;

/**
 * Honest processing-expectation copy that pairs with the window above.
 *
 * These exist so no surface has to invent its own queue/capacity wording. They
 * deliberately carry NO new numeric SLA: `PROOF_TURNAROUND_WINDOW` is the only
 * authorized customer-facing number (Alexy decision 2026-07-26) and there is no
 * project record authorizing a second one. They also never promise instant,
 * same-day, or guaranteed proof preparation, and never conflate proof readiness
 * with printing/shipping — printing and shipping language stays on the
 * per-format delivery strings that already say "after approval".
 */

/**
 * What actually happens between payment and the proof email.
 *
 * This deliberately does NOT claim a person checks every book first. The
 * fulfillment paths in src/lib/fulfillment.ts persist the proof and call
 * sendDigitalDeliveryEmail / sendProofReadyEmail with no `qaPassAt`,
 * `qaStatus`, page-level `reviewedAt`, or operator-release prerequisite —
 * those fields are ops-dashboard state, not gates — so a manual-review promise
 * would be false (Rex audit, 2026-08-21). The constant name is historical;
 * whatever it holds must stay true of the automated pipeline alone. If an
 * authoritative QA gate is ever enforced before release, this is the one place
 * to say so.
 */
export const PROOF_REVIEW_ASSURANCE =
  'We write the story, illustrate every page, and build your proof before it reaches you.';

/**
 * Volume honesty. This is the customer-facing replacement for any hard intake
 * cap: instead of refusing an order, we tell the buyer that a busy queue means
 * a longer wait. No queue position or date is stated because no customer-facing
 * queue telemetry exists.
 */
export const PROOF_VOLUME_NOTE =
  'When order volume is high, proofs can take longer than usual — we email you as soon as yours is ready.';

/** Support path for an unusually delayed order. Exposes no private order data. */
export const PROOF_DELAY_SUPPORT_NOTE =
  'If your proof is taking longer than you expected, reply to any Hero Story Books email or write to support@herostorybooks.com and we will check on it.';
