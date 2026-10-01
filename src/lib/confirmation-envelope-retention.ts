/**
 * Retention for the frozen confirmation envelope (L-4 Slice A3-7) — SAFE INERT.
 *
 * The plan lets a frozen confirmation request be purged from the private
 * envelope store on an owner-configured clock while the order record keeps its
 * audit identity. This slice ships the shape of that and none of its reach:
 *
 *   - `resolveConfirmationEnvelopeRetention` is unconfigured by construction.
 *     It takes no input and reads no environment, so setting the retention-days
 *     variable changes nothing. No period is invented (OD-2).
 *   - `runConfirmationEnvelopePurge` reports `retention_unconfigured` and
 *     enumerates, reads and writes nothing, dry run or not.
 *   - `evaluateConfirmationEnvelopePurgeEligibility` is a pure planner with a
 *     closed vocabulary. It has no "purge is due" verdict, because no duration
 *     exists to be due against; `state_eligible` is the most it ever says, and
 *     nothing acts on it.
 *
 * This module imports no store, no config, no Blob SDK and no order I/O. Its one
 * runtime edge is the pure ref module; the order record arrives as a type.
 *
 * Activation (removing any envelope bytes) is a separate slice and requires ALL
 * of:
 *
 *   1. A3-6 integrated: a writer for RECONCILED_ACCEPTED, and OD-1 for
 *      OWNER_AUTHORIZED_RESEND_SENT, so those states gain an anchor;
 *   2. OD-2: an owner-decided retention period, parsed strictly, never defaulted;
 *   3. OD-3: who may set the retention hold, and whether a past hold expires;
 *   4. store amendments: an expected-objectPath removal method, a readback that
 *      proves `not_found` before `purgedAt` is marked, and a record-level purge
 *      claim that closes the hold race;
 *   5. a separate owner approval to enable it on Production.
 */
import { isConfirmationEmailEnvelopeRefTombstone, validateConfirmationEmailEnvelopeRefShape } from './confirmation-envelope-ref.ts';
import type { OrderRecord } from './orders.ts';

export type ConfirmationEnvelopeRetention = { readonly configured: false };

/** Unconfigured by construction (OD-2): no argument, no environment read. */
export function resolveConfirmationEnvelopeRetention(): ConfirmationEnvelopeRetention {
  return { configured: false };
}

/**
 * Everything the planner can say. Closed, and deliberately without a member
 * that means "remove it now": with no period there is nothing to be due.
 */
export const CONFIRMATION_ENVELOPE_PURGE_ELIGIBILITY = Object.freeze([
  'state_eligible',
  'not_terminal',
  'no_envelope_ref',
  'ref_invalid',
  'already_purged',
  'anchor_unavailable',
  'retention_hold_active',
  'retention_hold_invalid',
] as const);

export type ConfirmationEnvelopePurgeEligibility = (typeof CONFIRMATION_ENVELOPE_PURGE_ELIGIBILITY)[number];

type RetentionFields = Pick<
  OrderRecord,
  | 'id'
  | 'confirmationEmailState'
  | 'confirmationEmailEnvelopeRef'
  | 'confirmationEmailAcceptedAt'
  | 'confirmationEmailRetentionHoldUntil'
>;

/** A canonical ISO instant, round-trip proven, so both test zones agree. */
function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Absence, under the record contract. Anything else is present evidence. */
function isAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Could this record's envelope ever be purged, setting the clock aside?
 *
 * Pure: no clock (`nowMs` is supplied), no environment, no I/O. Checked in this
 * order, and the first refusal wins:
 *
 *   1. state — only `ACCEPTED` is state-eligible. RECONCILED_ACCEPTED and
 *      OWNER_AUTHORIZED_RESEND_SENT are terminal but nothing writes them yet,
 *      so they have no acceptance instant to anchor on until A3-6. A record
 *      with no state, or any other state, is not terminal.
 *   2. ref — an `ACCEPTED` record with no ref (the LEGACY_ACCEPTED shape) has
 *      nothing to purge; a ref the shape validator refuses is invalid; a
 *      tombstone is already purged.
 *   3. hold — any present hold blocks. A canonical instant is active whether it
 *      is past or future, because whether a past hold expires is OD-3's to
 *      decide; anything else present is invalid, never ignored.
 *   4. anchor — `confirmationEmailAcceptedAt` alone, canonical and not after
 *      `nowMs`. There is no fallback to an earlier instant: falling back would
 *      start the clock early.
 */
export function evaluateConfirmationEnvelopePurgeEligibility(
  order: RetentionFields,
  nowMs: number,
): ConfirmationEnvelopePurgeEligibility {
  const state = order.confirmationEmailState;
  if (state === 'RECONCILED_ACCEPTED' || state === 'OWNER_AUTHORIZED_RESEND_SENT') return 'anchor_unavailable';
  if (state !== 'ACCEPTED') return 'not_terminal';

  const ref = order.confirmationEmailEnvelopeRef;
  if (isAbsent(ref)) return 'no_envelope_ref';
  if (validateConfirmationEmailEnvelopeRefShape(ref, { orderId: order.id }) !== null) return 'ref_invalid';
  if (isConfirmationEmailEnvelopeRefTombstone(ref)) return 'already_purged';

  const hold: unknown = order.confirmationEmailRetentionHoldUntil;
  if (!isAbsent(hold)) return isCanonicalIsoInstant(hold) ? 'retention_hold_active' : 'retention_hold_invalid';

  const anchor: unknown = order.confirmationEmailAcceptedAt;
  if (!Number.isFinite(nowMs) || !isCanonicalIsoInstant(anchor) || Date.parse(anchor) > nowMs) {
    return 'anchor_unavailable';
  }
  return 'state_eligible';
}

export type ConfirmationEnvelopePurgeRunResult = {
  readonly ok: true;
  readonly skipped: 'retention_unconfigured';
};

/**
 * The scheduled run. Retention is never configured in this slice, so it reports
 * that and stops: no order is enumerated or read, no envelope is touched, and
 * `dryRun` changes nothing because there is no plan to report without a period.
 */
export function runConfirmationEnvelopePurge(_options: { readonly dryRun: boolean }): ConfirmationEnvelopePurgeRunResult {
  return { ok: true, skipped: 'retention_unconfigured' };
}
