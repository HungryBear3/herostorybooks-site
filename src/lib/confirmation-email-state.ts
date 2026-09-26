/**
 * The confirmation-email transition model (L-4 Slice A1).
 *
 * One rule shapes everything here: a confirmation whose provider outcome is not
 * decisively known is never presented again automatically. Automatic retry is
 * permitted from exactly one state — a failure proven to have preceded
 * submission — and every ambiguous window terminates in a hold that only an
 * authenticated operator can leave.
 *
 * The model is pure. It reads no clock, no environment, no credential and no
 * store; it decides, and the caller commits. That separation is what lets a
 * single conditional write carry both the state change and the evidence for it.
 */
import type { OrderRecord } from './orders.ts';

export const CONFIRMATION_EMAIL_STATES = [
  'SNAPSHOTTED',
  'DISPATCH_INTENT_RECORDED',
  'ACCEPTED',
  'PROVABLY_PRE_DISPATCH_FAILED',
  'RECONCILIATION_REQUIRED',
  'RECONCILED_ACCEPTED',
  'OWNER_AUTHORIZED_RESEND_SENT',
] as const;

export type ConfirmationEmailState = (typeof CONFIRMATION_EMAIL_STATES)[number];

/**
 * The states a record may not be claimed out of.
 *
 * This set is deliberately exported for the claimability fence rather than
 * restated there: a hold must survive a flag rollback, so the fence that reads
 * it cannot be allowed to drift from the model that produces it.
 */
export const CONFIRMATION_EMAIL_HELD_STATES = [
  'DISPATCH_INTENT_RECORDED',
  'RECONCILIATION_REQUIRED',
  'RECONCILED_ACCEPTED',
  'OWNER_AUTHORIZED_RESEND_SENT',
] as const;

export type ConfirmationEmailHeldState = (typeof CONFIRMATION_EMAIL_HELD_STATES)[number];

export function isConfirmationEmailHeldState(value: unknown): value is ConfirmationEmailHeldState {
  return (CONFIRMATION_EMAIL_HELD_STATES as readonly unknown[]).includes(value);
}

export type ConfirmationEmailHoldReason =
  | 'ambiguous_dispatch'
  | 'receipt_write_failed'
  | 'claim_lost_after_acceptance'
  | 'provider_body_conflict'
  | 'provider_concurrent_request'
  | 'account_binding_mismatch'
  | 'digest_mismatch'
  | 'payload_purged'
  | 'deadline_exceeded'
  | 'legacy_unresolved'
  | 'snapshot_refused';

export type ConfirmationEmailAttemptOutcome =
  | 'accepted'
  | 'pre_dispatch_failed'
  | 'ambiguous'
  | 'provider_rejected'
  | 'fenced_before_dispatch';

export interface ConfirmationEmailAttemptRecord {
  readonly attemptId: string;
  readonly claimId: string;
  readonly intentAt: string;
  readonly outcome: ConfirmationEmailAttemptOutcome;
  readonly providerMessageId?: string | null;
  readonly providerErrorClass?: string | null;
  readonly statusCode?: number | null;
  /** Present only on the synthetic marker that stands in for dropped entries. */
  readonly elidedCount?: number | null;
}

/** Retained entries, including the first and the elision marker. */
export const CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT = 20;
/** Most recent entries kept verbatim once the history overflows. */
export const CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL = 18;

const ELIDED_ATTEMPT_ID = 'elided';

/**
 * Append one attempt, keeping the history bounded.
 *
 * The first entry is never dropped: it is what corroborates the write-once
 * first dispatch intent, and a history that loses it loses the only local
 * evidence of when this order first reached the provider boundary. Everything
 * squeezed out in the middle collapses into one marker carrying the count, so
 * an operator can always see that detail is missing rather than infer a shorter
 * history than actually happened.
 */
export function appendConfirmationEmailAttempt(
  history: readonly ConfirmationEmailAttemptRecord[],
  entry: ConfirmationEmailAttemptRecord,
): readonly ConfirmationEmailAttemptRecord[] {
  const full = [...history, entry];
  if (full.length <= CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT) return full;

  const first = full[0] as ConfirmationEmailAttemptRecord;
  const tail = full.slice(full.length - CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL);
  const dropped = full.slice(1, full.length - CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL);

  let elidedCount = 0;
  for (const candidate of dropped) elidedCount += candidate.elidedCount ?? 1;

  const marker: ConfirmationEmailAttemptRecord = {
    attemptId: ELIDED_ATTEMPT_ID,
    claimId: ELIDED_ATTEMPT_ID,
    intentAt: (dropped[0] as ConfirmationEmailAttemptRecord).intentAt,
    outcome: 'ambiguous',
    elidedCount,
  };
  return [first, marker, ...tail];
}

// ── The write-once first dispatch intent ────────────────────────────────────

export type FirstDispatchIntentWriteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'first_dispatch_intent_immutable' | 'first_dispatch_intent_invalid';
    };

/** Canonical ISO 8601 UTC instant, exactly as `toISOString` renders it. */
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
 * The earliest instant any dispatch intent was durably recorded is written
 * once and then never moved — not by a release, not by a receipt, not by a
 * takeover, not by an operator proving non-acceptance. Moving it would let a
 * deadline or a retention window measure from an instant later than the one
 * where a message may actually have reached the provider.
 *
 * Both halves are validated rather than trusted. A persisted record is parsed
 * JSON cast to `OrderRecord`, so the declared `string | null` is a description
 * of intent, not a runtime guarantee. An initial write must be a canonical
 * instant, because a blank or malformed marker is not a usable measurement
 * origin and would read as absence everywhere downstream; and a marker that is
 * already present but not canonical stops the writer outright, because a
 * caller that proceeds on a corrupt origin is computing deadlines from nothing.
 */
export function evaluateFirstDispatchIntentWrite(
  current: string | null | undefined,
  next: string | null,
): FirstDispatchIntentWriteResult {
  if (!isAbsent(current)) {
    if (!isCanonicalIsoInstant(current)) return { ok: false, reason: 'first_dispatch_intent_invalid' };
    if (next === current) return { ok: true };
    return { ok: false, reason: 'first_dispatch_intent_immutable' };
  }
  if (!isCanonicalIsoInstant(next)) return { ok: false, reason: 'first_dispatch_intent_invalid' };
  return { ok: true };
}

// ── Legacy classification (§7.2, corrected by W-10 and OD-3) ────────────────

export const CONFIRMATION_EMAIL_LEGACY_CLASSES = [
  'LEGACY_ACCEPTED',
  'LEGACY_NEVER_DISPATCHED',
  'LEGACY_UNRESOLVED',
] as const;

export type ConfirmationEmailLegacyClass = (typeof CONFIRMATION_EMAIL_LEGACY_CLASSES)[number];

/**
 * A usable cutover instant can never be earlier than the instant the sweep
 * itself treats as the start of its eligible window; mirrors
 * `CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT`, restated here so this module
 * keeps no runtime dependency on the sweep.
 */
export const CONFIRMATION_EMAIL_LEGACY_T193_FLOOR_AT = '2026-09-21T12:48:51.665Z';

const LEGACY_T193_FLOOR_MS = Date.parse(CONFIRMATION_EMAIL_LEGACY_T193_FLOOR_AT);

export interface ConfirmationEmailLegacyConfig {
  /**
   * The proven instant the frozen-identity deployment finished rolling out,
   * plus a drain margin. `null` means it could not be established from frozen
   * evidence — in which case it is treated as infinitely far in the future and
   * every open record is unresolved. No instant is ever invented to fill it.
   */
  readonly t193AtMs: number | null;
}

type LegacyConfirmationFields = Pick<
  OrderRecord,
  | 'paidAt'
  | 'confirmationEmailSentAt'
  | 'confirmationEmailFrom'
  | 'confirmationEmailIdempotencyKey'
  | 'emailResendClaimId'
>;

/**
 * Classify a record that carries no transition state yet.
 *
 * Null identity fields prove "no claim was ever committed, so the sender was
 * never reached" only for a record whose entire paid lifetime ran under code
 * that had those fields. Before that, the confirmation went out through a
 * two-key fallback pair with a live-environment sender, so an acceptance under
 * the historical fallback key is invisible to today's deduplication: a retry
 * there would be a guaranteed second confirmation, not a deduplicated one.
 * Everything that is not positively post-cutover is therefore unresolved.
 */
export function classifyLegacyConfirmationRecord(
  order: LegacyConfirmationFields,
  cfg: ConfirmationEmailLegacyConfig,
): ConfirmationEmailLegacyClass {
  // Presence is tested by absence, never by truthiness. An empty string is a
  // marker that exists and cannot be read — which is the opposite of the
  // "nothing was ever written here" that alone licenses a retry. A receipt
  // that is present but not a real instant proves neither acceptance nor
  // non-acceptance, so it holds rather than deciding in either direction.
  if (!isAbsent(order.confirmationEmailSentAt)) {
    return isCanonicalIsoInstant(order.confirmationEmailSentAt)
      ? 'LEGACY_ACCEPTED'
      : 'LEGACY_UNRESOLVED';
  }

  const t193AtMs = cfg.t193AtMs;
  if (t193AtMs === null || !Number.isFinite(t193AtMs)) return 'LEGACY_UNRESOLVED';
  if (t193AtMs < LEGACY_T193_FLOOR_MS) return 'LEGACY_UNRESOLVED';

  if (!isAbsent(order.confirmationEmailFrom)) return 'LEGACY_UNRESOLVED';
  if (!isAbsent(order.confirmationEmailIdempotencyKey)) return 'LEGACY_UNRESOLVED';
  if (!isAbsent(order.emailResendClaimId)) return 'LEGACY_UNRESOLVED';

  // `paidAt` must be a canonical instant before its value means anything.
  // `Date.parse` is a repair tool, not a validator: it silently normalizes an
  // impossible calendar date (September 31 becomes October 1) and reads a
  // timezone-less date-time in the host timezone, so the same stored string
  // classifies differently in Chicago than in UTC. Neither is evidence that
  // this order's entire paid lifetime ran after the cutover — and that is the
  // only thing that licenses putting the record back on the send path. Nothing
  // here normalizes, trims, repairs, or assumes a zone; a value that is not
  // byte-identical to what `toISOString()` emits is held.
  if (!isCanonicalIsoInstant(order.paidAt)) return 'LEGACY_UNRESOLVED';
  const paidAtMs = Date.parse(order.paidAt);
  if (paidAtMs < t193AtMs) return 'LEGACY_UNRESOLVED';

  return 'LEGACY_NEVER_DISPATCHED';
}

// ── The transition table ────────────────────────────────────────────────────

export const CONFIRMATION_EMAIL_ACTORS = ['worker', 'reaper', 'operator'] as const;

export type ConfirmationEmailActor = (typeof CONFIRMATION_EMAIL_ACTORS)[number];

export const CONFIRMATION_EMAIL_EVENTS = [
  'claim_acquired',
  'dispatch_intent',
  'provider_accepted',
  'pre_dispatch_failure_proven',
  'ambiguous_outcome',
  'receipt_failed',
  'integrity_fence_failed',
  'deadline_elapsed',
  'snapshot_refused',
  'claim_released',
  'operator_bind_acceptance',
  'operator_prove_non_acceptance',
  'operator_authorized_resend',
] as const;

export type ConfirmationEmailEvent = (typeof CONFIRMATION_EMAIL_EVENTS)[number];

export interface ConfirmationEmailTransitionInput {
  readonly from: ConfirmationEmailState | null;
  readonly event: ConfirmationEmailEvent;
  readonly actor: ConfirmationEmailActor;
  /** Required for a hold event; must be absent otherwise. */
  readonly holdReason?: ConfirmationEmailHoldReason | null;
  /** Required for the first touch of a record that carries no state. */
  readonly legacyClass?: ConfirmationEmailLegacyClass | null;
  /** True when this claim is stealing a claim abandoned past its window. */
  readonly claimTakeover?: boolean;
  readonly firstDispatchIntentAt?: string | null;
  /**
   * Whether the envelope still holds its request. Omitted means absent: a
   * decision that says nothing about the payload may not authorize a send.
   */
  readonly envelopeRequestPresent?: boolean;
}

export type ConfirmationEmailTransitionRefusal =
  /** A state, event, actor or legacy class this build does not recognize. */
  | 'unrecognized_input'
  | 'transition_not_permitted'
  | 'takeover_refused_after_dispatch_intent'
  | 'hold_reason_not_permitted'
  | 'legacy_class_required';

export type ConfirmationEmailTransitionDecision =
  | {
      readonly allowed: true;
      readonly to: ConfirmationEmailState | null;
      readonly holdReason: ConfirmationEmailHoldReason | null;
      /**
       * True only for the commit that records dispatch intent. A provider call
       * is legal only immediately after such a commit succeeds.
       */
      readonly permitsProviderCall: boolean;
      readonly writesFirstDispatchIntent: boolean;
      readonly releasesClaim: boolean;
    }
  | { readonly allowed: false; readonly reason: ConfirmationEmailTransitionRefusal };

const SAME_STATE = Symbol('same');

interface TransitionRow {
  readonly to: ConfirmationEmailState | typeof SAME_STATE;
  readonly permitsProviderCall?: boolean;
  readonly writesFirstDispatchIntent?: boolean;
  readonly releasesClaim?: boolean;
  readonly fixedHoldReason?: ConfirmationEmailHoldReason;
  readonly allowedHoldReasons?: readonly ConfirmationEmailHoldReason[];
  /** The first touch of a stateless record: the target comes from the class. */
  readonly legacyDependent?: boolean;
  /** Refuse when a stale claim is stolen on a record that recorded intent. */
  readonly refuseTakeoverAfterIntent?: boolean;
}

const STATE_SET: ReadonlySet<string> = new Set(CONFIRMATION_EMAIL_STATES);
const EVENT_SET: ReadonlySet<string> = new Set(CONFIRMATION_EMAIL_EVENTS);
const ACTOR_SET: ReadonlySet<string> = new Set(CONFIRMATION_EMAIL_ACTORS);
const LEGACY_CLASS_SET: ReadonlySet<string> = new Set(CONFIRMATION_EMAIL_LEGACY_CLASSES);

/**
 * The lookup token for "this record carries no state yet".
 *
 * It contains a NUL, which no member of `CONFIRMATION_EMAIL_STATES` does and
 * no state string validated by `STATE_SET` can, so a persisted state value can
 * never collide with the null row. The earlier rendering of null as the word
 * `none` did exactly that: a record whose `confirmationEmailState` had been
 * persisted as the string "none" aliased the first-touch row and could be
 * routed to SNAPSHOTTED.
 */
const NO_STATE_KEY = '\u0000no-state';

function key(from: ConfirmationEmailState | null, event: string, actor: string): string {
  return `${from === null ? NO_STATE_KEY : from}|${event}|${actor}`;
}

const TRANSITIONS = new Map<string, TransitionRow>([
  // T1 — first touch of a record with no state.
  [key(null, 'claim_acquired', 'worker'), { to: SAME_STATE, legacyDependent: true }],
  // T13 — a snapshot that cannot be built is a hold, never a send.
  [key(null, 'snapshot_refused', 'worker'), { to: 'RECONCILIATION_REQUIRED', fixedHoldReason: 'snapshot_refused' }],
  [key('SNAPSHOTTED', 'snapshot_refused', 'worker'), { to: 'RECONCILIATION_REQUIRED', fixedHoldReason: 'snapshot_refused' }],

  // T2 — re-claim or safe takeover; the envelope is carried forward untouched.
  [key('SNAPSHOTTED', 'claim_acquired', 'worker'), { to: 'SNAPSHOTTED', refuseTakeoverAfterIntent: true }],
  // T3 — the only commit that authorizes a first provider call.
  [key('SNAPSHOTTED', 'dispatch_intent', 'worker'), {
    to: 'DISPATCH_INTENT_RECORDED',
    permitsProviderCall: true,
    writesFirstDispatchIntent: true,
  }],

  // T4 — provider returned a message id.
  [key('DISPATCH_INTENT_RECORDED', 'provider_accepted', 'worker'), { to: 'ACCEPTED', releasesClaim: true }],
  // T5 — failure proven to precede submission.
  [key('DISPATCH_INTENT_RECORDED', 'pre_dispatch_failure_proven', 'worker'), {
    to: 'PROVABLY_PRE_DISPATCH_FAILED',
    releasesClaim: true,
  }],
  // T7 — the outcome is not known. No automatic retry, ever.
  [key('DISPATCH_INTENT_RECORDED', 'ambiguous_outcome', 'worker'), {
    to: 'RECONCILIATION_REQUIRED',
    releasesClaim: true,
    allowedHoldReasons: ['ambiguous_dispatch', 'provider_body_conflict', 'provider_concurrent_request'],
  }],
  // T8 — the provider accepted and the receipt did not land.
  [key('DISPATCH_INTENT_RECORDED', 'receipt_failed', 'worker'), {
    to: 'RECONCILIATION_REQUIRED',
    allowedHoldReasons: ['receipt_write_failed', 'claim_lost_after_acceptance'],
  }],
  // F4/F5 — the dispatch fence refused, with zero provider calls.
  [key('DISPATCH_INTENT_RECORDED', 'integrity_fence_failed', 'worker'), {
    to: 'RECONCILIATION_REQUIRED',
    releasesClaim: true,
    allowedHoldReasons: ['digest_mismatch', 'account_binding_mismatch'],
  }],
  // T9 — what a crashed worker becomes. Not a takeover.
  [key('DISPATCH_INTENT_RECORDED', 'deadline_elapsed', 'reaper'), {
    to: 'RECONCILIATION_REQUIRED',
    fixedHoldReason: 'deadline_exceeded',
  }],

  // T6 — the single automatic retry in the system.
  [key('PROVABLY_PRE_DISPATCH_FAILED', 'claim_acquired', 'worker'), {
    to: 'DISPATCH_INTENT_RECORDED',
    permitsProviderCall: true,
    writesFirstDispatchIntent: true,
  }],

  // T10/T11/T12 — the only doors out of a hold, all operator-driven.
  [key('RECONCILIATION_REQUIRED', 'operator_bind_acceptance', 'operator'), { to: 'RECONCILED_ACCEPTED' }],
  [key('RECONCILIATION_REQUIRED', 'operator_prove_non_acceptance', 'operator'), { to: 'SNAPSHOTTED' }],
  [key('RECONCILIATION_REQUIRED', 'operator_authorized_resend', 'operator'), { to: 'OWNER_AUTHORIZED_RESEND_SENT' }],
]);

// I-5 — a release drops the claim fields and nothing else, from any state.
for (const from of [null, ...CONFIRMATION_EMAIL_STATES] as const) {
  TRANSITIONS.set(key(from, 'claim_released', 'worker'), { to: SAME_STATE, releasesClaim: true });
}

/**
 * A `Map`, not an object literal. An object index walks the prototype chain,
 * so a persisted legacy class of `constructor`, `__proto__` or `toString`
 * resolved to an inherited member and produced an allowed decision whose
 * target and hold reason were both undefined.
 */
const LEGACY_TARGETS = new Map<
  ConfirmationEmailLegacyClass,
  { readonly to: ConfirmationEmailState; readonly holdReason: ConfirmationEmailHoldReason | null }
>([
  ['LEGACY_ACCEPTED', { to: 'ACCEPTED', holdReason: null }],
  ['LEGACY_NEVER_DISPATCHED', { to: 'SNAPSHOTTED', holdReason: null }],
  ['LEGACY_UNRESOLVED', { to: 'RECONCILIATION_REQUIRED', holdReason: 'legacy_unresolved' }],
]);

/**
 * Decide one transition, or refuse.
 *
 * Refusal is the default: only the rows transcribed above are reachable, and
 * anything absent — including a state or event this build does not know — is
 * refused rather than defaulted into something sendable.
 */
export function evaluateConfirmationEmailTransition(
  input: ConfirmationEmailTransitionInput,
): ConfirmationEmailTransitionDecision {
  // Validate membership before any lookup. The declared parameter types say
  // what a caller should pass; they are erased at runtime, and `from` in
  // particular arrives from a persisted record that was parsed from JSON and
  // cast. An unrecognized value is refused here rather than being allowed to
  // reach a table lookup, where a collision or an inherited property could
  // turn it into an allowed decision.
  if (input.from !== null && !STATE_SET.has(input.from as unknown as string)) {
    return { allowed: false, reason: 'unrecognized_input' };
  }
  if (!EVENT_SET.has(input.event as unknown as string)) {
    return { allowed: false, reason: 'unrecognized_input' };
  }
  if (!ACTOR_SET.has(input.actor as unknown as string)) {
    return { allowed: false, reason: 'unrecognized_input' };
  }
  if (!isAbsent(input.legacyClass) && !LEGACY_CLASS_SET.has(input.legacyClass as unknown as string)) {
    return { allowed: false, reason: 'unrecognized_input' };
  }

  // A record that has recorded dispatch intent is never handed to a fresh
  // worker: the previous attempt may already have reached the provider, and a
  // takeover would present the same key a second time on a live body. It moves
  // only through the reaper, to a hold.
  if (input.event === 'claim_acquired' && input.from === 'DISPATCH_INTENT_RECORDED') {
    return { allowed: false, reason: 'takeover_refused_after_dispatch_intent' };
  }

  const row = TRANSITIONS.get(key(input.from, input.event, input.actor));
  if (!row) return { allowed: false, reason: 'transition_not_permitted' };

  // Presence, not truthiness. A blank or malformed marker is evidence that
  // something was written here and cannot be read — never evidence that
  // nothing was. Stealing a stale claim on that basis is precisely how a
  // possible prior dispatch becomes a second confirmation.
  if (row.refuseTakeoverAfterIntent && input.claimTakeover === true && !isAbsent(input.firstDispatchIntentAt)) {
    return { allowed: false, reason: 'takeover_refused_after_dispatch_intent' };
  }

  const suppliedHoldReason = input.holdReason ?? null;
  let holdReason: ConfirmationEmailHoldReason | null = null;
  if (row.allowedHoldReasons) {
    if (suppliedHoldReason === null || !row.allowedHoldReasons.includes(suppliedHoldReason)) {
      return { allowed: false, reason: 'hold_reason_not_permitted' };
    }
    holdReason = suppliedHoldReason;
  } else if (row.fixedHoldReason) {
    if (suppliedHoldReason !== null && suppliedHoldReason !== row.fixedHoldReason) {
      return { allowed: false, reason: 'hold_reason_not_permitted' };
    }
    holdReason = row.fixedHoldReason;
  } else if (suppliedHoldReason !== null) {
    return { allowed: false, reason: 'hold_reason_not_permitted' };
  }

  let to: ConfirmationEmailState | null = row.to === SAME_STATE ? input.from : row.to;
  let permitsProviderCall = row.permitsProviderCall === true;
  let writesFirstDispatchIntent = row.writesFirstDispatchIntent === true;

  if (row.legacyDependent) {
    if (isAbsent(input.legacyClass)) return { allowed: false, reason: 'legacy_class_required' };
    const target = LEGACY_TARGETS.get(input.legacyClass as ConfirmationEmailLegacyClass);
    if (!target) return { allowed: false, reason: 'unrecognized_input' };
    to = target.to;
    holdReason = target.holdReason;
  }

  // I-8 — a purged payload is structurally unsendable. Anything that would
  // otherwise authorize a provider call becomes a hold instead, which is what
  // makes purging safe: after the payload is gone there is no path to the
  // provider at all.
  if (permitsProviderCall && input.envelopeRequestPresent !== true) {
    to = 'RECONCILIATION_REQUIRED';
    holdReason = 'payload_purged';
    permitsProviderCall = false;
    writesFirstDispatchIntent = false;
  }

  return {
    allowed: true,
    to,
    holdReason,
    permitsProviderCall,
    writesFirstDispatchIntent,
    releasesClaim: row.releasesClaim === true,
  };
}
