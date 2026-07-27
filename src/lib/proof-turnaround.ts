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
