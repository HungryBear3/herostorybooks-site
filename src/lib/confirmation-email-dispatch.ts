/**
 * The frozen confirmation dispatcher (L-4 Slice A3-5).
 *
 * A record in `SNAPSHOTTED` or `PROVABLY_PRE_DISPATCH_FAILED` holds a frozen
 * envelope in the private store. This module sends that envelope's request,
 * verbatim, under its frozen key, and moves the record through the transition
 * model with one conditional write per step:
 *
 *   P0  the injected transport says it is ready, or the attempt defers;
 *   P1  re-read the record through the bound order I/O;
 *   P2  a purged ref is a `payload_purged` hold, with no store read;
 *   P3  read the envelope once; unusable from `SNAPSHOTTED` is a T13 hold;
 *   C2  one CAS records dispatch intent and the claim together (T2+T3, or T6),
 *       carrying the write-once first-intent instant forward (W1);
 *   F   the record↔envelope fence; a failure is an F4/F5 hold, zero calls;
 *   CK-T the ambient namespace still agrees, or nothing is sent or written;
 *   SEND the one provider call;
 *   C3…  one CAS for the outcome, guarded on this attempt's identity.
 *
 * An outcome that is not provably pre-submit is a hold. Nothing here retries,
 * and no receipt arm releases the claim. Before the provider call an
 * unrecognized fault propagates, as it does on the legacy path; from the
 * provider call on, nothing throws: a post-send write that fails or loses the
 * record is `receipt_unrecorded`, and the record stays where it is.
 *
 * Inert by default
 * ----------------
 * The dispatcher arms only on top of an armed snapshot writer (which carries
 * the Vercel, SDK-binding and build interlocks), with the dispatch flag exactly
 * `true` in the writer's supplied environment, and with a transport injected
 * by the caller. No default caller injects one. A3-5 lifts no interlock.
 *
 * Privacy: the request never reaches a log line, a record field or a returned
 * value. Logs carry order ids, provider message ids and closed codes only.
 */
import { digestConfirmationRequest } from './confirmation-email-envelope.ts';
import type { ConfirmationEmailEnvelopeV1, ConfirmationEmailRequestV1 } from './confirmation-email-envelope.ts';
import {
  appendConfirmationEmailAttempt,
  evaluateConfirmationEmailTransition,
  evaluateFirstDispatchIntentWrite,
} from './confirmation-email-state.ts';
import type {
  ConfirmationEmailAttemptOutcome,
  ConfirmationEmailAttemptRecord,
  ConfirmationEmailHoldReason,
  ConfirmationEmailTransitionDecision,
} from './confirmation-email-state.ts';
import type {
  CONFIRMATION_EMAIL_CLAIM_KIND,
  ConfirmationEmailBlockReason,
  ConfirmationEmailDeliveryOutcome,
} from './confirmation-email-delivery.ts';
import type {
  ArmedConfirmationEnvelopeWriterGate,
  ConfirmationEnvelopeSnapshotDeferral,
  ConfirmationEnvelopeWriterGate,
} from './confirmation-envelope-producer.ts';
import type { FrozenDispatchTransportResult } from './order-email.ts';
import type { OrderRecord, OrderTransactionOutcome } from './orders.ts';

// ---------------------------------------------------------------------------
// Closed vocabularies and constants
// ---------------------------------------------------------------------------

/** Read only from the writer's supplied environment; only `true` arms. */
export const CONFIRMATION_FROZEN_DISPATCH_ENV = 'HSB_CONFIRMATION_FROZEN_DISPATCH';

/** Local ceiling for the attempt that holds dispatch intent. Shorter than the
 *  stale-claim window, so a live dispatch is never mistaken for an abandoned
 *  claim. */
export const CONFIRMATION_DISPATCH_DEADLINE_MS = 90_000;

export interface ConfirmationDispatchProvenRejection {
  readonly statusCode: number;
  readonly providerErrorClass: string;
}

/**
 * Provider errors proven to mean "this request was not accepted and never will
 * be", which alone would license an automatic retry. Ships empty (RL-1): no
 * provider error vocabulary has been verified to that standard, so every
 * provider-returned error is held for an operator.
 */
export const CONFIRMATION_DISPATCH_PROVEN_PROVIDER_REJECTIONS: readonly ConfirmationDispatchProvenRejection[] = Object.freeze([]);

/** Every reason an attempt ends with no state change and no send. */
export type ConfirmationFrozenDispatchDeferral =
  | 'envelope_read_failed'
  | 'envelope_unusable_ppdf'
  | 'first_intent_invalid'
  | 'transport_not_ready'
  | 'namespace_drift'
  | 'cas_exhausted'
  | 'record_changed';

/** The hold reasons this module commits and reports as `held`. */
export type ConfirmationFrozenDispatchHoldReason = Extract<
  ConfirmationEmailHoldReason,
  | 'payload_purged'
  | 'snapshot_refused'
  | 'digest_mismatch'
  | 'account_binding_mismatch'
  | 'ambiguous_dispatch'
  | 'provider_body_conflict'
  | 'provider_concurrent_request'
>;

export interface ConfirmationFrozenDispatchTransport {
  readonly ready: () => boolean;
  readonly send: (request: ConfirmationEmailRequestV1, idempotencyKey: string) => Promise<FrozenDispatchTransportResult>;
}

export interface ConfirmationFrozenDispatchDeps {
  /** The transport-binding interlock: both members must be injected. */
  transport?: ConfirmationFrozenDispatchTransport;
  /** Tests only: the attempt identity. Default: the delivery context's. */
  newAttemptId?: () => string;
}

export type FrozenDispatcher =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'armed';
      readonly gate: ArmedConfirmationEnvelopeWriterGate;
      readonly transport: ConfirmationFrozenDispatchTransport;
      /** The injected attempt identity, when a test supplies one. */
      readonly newAttemptId: (() => string) | null;
    };

/** One delivery attempt's frozen inputs, supplied by the delivery module. */
export interface FrozenDispatchContext {
  readonly nowMs: number;
  readonly claimStaleMs: number;
  /** Delivery's pure fence, partially applied to `nowMs`. */
  readonly evaluateClaimability: (order: OrderRecord) => ConfirmationEmailBlockReason | null;
  readonly newClaimId: () => string;
  /** The attempt identity source (delivery's `randomUUID`). */
  readonly newAttemptId: () => string;
  readonly log: (line: string) => void;
  readonly errorLog: (line: string) => void;
}

const DISPATCHER_OFF: FrozenDispatcher = Object.freeze({ kind: 'off' });

const CLAIM_KIND: typeof CONFIRMATION_EMAIL_CLAIM_KIND = 'order_confirmation';

const INTENT_STATE = 'DISPATCH_INTENT_RECORDED';

type FrozenState = 'SNAPSHOTTED' | 'PROVABLY_PRE_DISPATCH_FAILED';

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Arm the dispatcher for one attempt, or not. Called synchronously right after
 * the writer gate. Reads one key of the writer's supplied environment, and only
 * once the writer is armed AND a transport is injected: the writer snapshots
 * its supplied environment exactly once, and no caller without a transport may
 * add a read to it.
 */
export function resolveFrozenDispatcher(
  suppliedEnv: NodeJS.ProcessEnv | undefined,
  deps: ConfirmationFrozenDispatchDeps | undefined,
  writerGate: ConfirmationEnvelopeWriterGate,
): FrozenDispatcher {
  if (writerGate.kind !== 'armed') return DISPATCHER_OFF;
  const transport = deps?.transport;
  if (!transport || typeof transport.ready !== 'function' || typeof transport.send !== 'function') return DISPATCHER_OFF;
  const env = suppliedEnv ?? process.env;
  if (env[CONFIRMATION_FROZEN_DISPATCH_ENV] !== 'true') return DISPATCHER_OFF;
  return Object.freeze({
    kind: 'armed',
    gate: writerGate,
    transport,
    newAttemptId: typeof deps.newAttemptId === 'function' ? deps.newAttemptId : null,
  });
}

// ---------------------------------------------------------------------------
// Classification (plan §4) — pure
// ---------------------------------------------------------------------------

export type FrozenDispatchClassification =
  | { readonly event: 'provider_accepted'; readonly providerMessageId: string }
  | {
      readonly event: 'pre_dispatch_failure_proven';
      readonly attemptOutcome: Extract<ConfirmationEmailAttemptOutcome, 'pre_dispatch_failed' | 'provider_rejected'>;
      readonly errorClass: string;
      readonly statusCode: number | null;
    }
  | {
      readonly event: 'ambiguous_outcome';
      readonly holdReason: Extract<ConfirmationEmailHoldReason, 'ambiguous_dispatch' | 'provider_body_conflict' | 'provider_concurrent_request'>;
      readonly providerErrorClass: string;
      readonly statusCode: number | null;
    };

const MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
const NOT_SUBMITTED_CAUSES: ReadonlySet<unknown> = new Set(['missing_resend_api_key', 'client_construction', 'argument_invalid']);

function className(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : 'unknown';
}

function ambiguous(providerErrorClass: string, statusCode: number | null): FrozenDispatchClassification {
  return { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass, statusCode };
}

/**
 * What a transport result licenses. Only a failure our own code proved to
 * precede submission — or a provider error on the (empty) proven list — is
 * pre-dispatch; everything else, recognized or not, is a hold.
 */
export function classifyFrozenDispatchResult(result: FrozenDispatchTransportResult): FrozenDispatchClassification {
  try {
    if (result === null || typeof result !== 'object') return ambiguous('unknown', null);
    const r = result as Record<string, unknown>;
    switch (r.kind) {
      case 'accepted':
        return typeof r.id === 'string' && MESSAGE_ID_RE.test(r.id)
          ? { event: 'provider_accepted', providerMessageId: r.id }
          : ambiguous('no_message_id', null);
      case 'not_submitted':
        return NOT_SUBMITTED_CAUSES.has(r.cause)
          ? { event: 'pre_dispatch_failure_proven', attemptOutcome: 'pre_dispatch_failed', errorClass: r.cause as string, statusCode: null }
          : ambiguous('unknown', null);
      case 'provider_error': {
        const statusCode = typeof r.statusCode === 'number' && Number.isInteger(r.statusCode) ? r.statusCode : null;
        const providerErrorClass = className(r.providerErrorClass);
        const proven = CONFIRMATION_DISPATCH_PROVEN_PROVIDER_REJECTIONS.some(
          (row) => row.statusCode === statusCode && row.providerErrorClass === providerErrorClass,
        );
        if (proven) {
          return { event: 'pre_dispatch_failure_proven', attemptOutcome: 'provider_rejected', errorClass: providerErrorClass, statusCode };
        }
        if (statusCode === 409 && providerErrorClass === 'invalid_idempotent_request') {
          return { event: 'ambiguous_outcome', holdReason: 'provider_body_conflict', providerErrorClass, statusCode };
        }
        if (statusCode === 409 && providerErrorClass === 'concurrent_idempotent_requests') {
          return { event: 'ambiguous_outcome', holdReason: 'provider_concurrent_request', providerErrorClass, statusCode };
        }
        return ambiguous(providerErrorClass, statusCode);
      }
      case 'no_message_id':
        return ambiguous('no_message_id', null);
      case 'submit_threw':
        return ambiguous(className(r.errorClass), null);
      default:
        return ambiguous('unknown', null);
    }
  } catch {
    return ambiguous('unknown', null);
  }
}

// ---------------------------------------------------------------------------
// The record↔envelope fence — pure
// ---------------------------------------------------------------------------

type RefShape = Readonly<Record<string, unknown>>;

function refOf(order: OrderRecord): RefShape | null {
  const ref: unknown = order.confirmationEmailEnvelopeRef;
  return ref !== null && typeof ref === 'object' ? ref as RefShape : null;
}

/** Deep equality over the ref's primitive members. */
function refsEqual(a: RefShape | null, b: RefShape | null): boolean {
  if (a === null || b === null) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

/**
 * The record that holds dispatch intent and the envelope read for it must
 * describe the same frozen request, for the same order, under the same key,
 * sender and provider account. Returns the hold reason, or null.
 */
export function evaluateFrozenDispatchFence(
  latest: OrderRecord,
  envelope: ConfirmationEmailEnvelopeV1,
  expectedAccountLabel: string,
): 'digest_mismatch' | 'account_binding_mismatch' | null {
  try {
    const ref = refOf(latest);
    if (ref === null || envelope === null || typeof envelope !== 'object' || !envelope.request) return 'digest_mismatch';
    const digest = digestConfirmationRequest(envelope.request);
    if (digest !== envelope.canonicalDigest || digest !== ref.canonicalDigest) return 'digest_mismatch';
    if (envelope.canonicalBytes !== ref.canonicalBytes) return 'digest_mismatch';
    if (envelope.templateVersion !== ref.templateVersion) return 'digest_mismatch';
    if (envelope.createdAt !== ref.createdAt) return 'digest_mismatch';
    if (envelope.orderId !== ref.orderId || ref.orderId !== latest.id) return 'digest_mismatch';
    if (envelope.purgedAt !== null || ref.purgedAt !== null) return 'digest_mismatch';
    if (typeof latest.confirmationEmailIdempotencyKey !== 'string'
      || envelope.idempotencyKey !== latest.confirmationEmailIdempotencyKey) return 'digest_mismatch';
    if (typeof latest.confirmationEmailFrom !== 'string' || envelope.request.from !== latest.confirmationEmailFrom) {
      return 'digest_mismatch';
    }
    const label = envelope.providerBinding?.accountLabel;
    if (typeof label !== 'string' || label !== ref.accountLabel || label !== expectedAccountLabel) {
      return 'account_binding_mismatch';
    }
    return null;
  } catch {
    return 'digest_mismatch';
  }
}

// ---------------------------------------------------------------------------
// The commits — pure CAS callbacks
// ---------------------------------------------------------------------------

/** What the attempt froze before its first commit. */
interface AttemptFrame {
  readonly orderId: string;
  readonly from: FrozenState;
  readonly ref: RefShape;
  readonly nowMs: number;
  readonly nowIso: string;
  readonly claimStaleMs: number;
  readonly claimId: string;
  readonly attemptId: string;
  readonly evaluateClaimability: (order: OrderRecord) => ConfirmationEmailBlockReason | null;
}

type PreTransportAbort = { readonly ok: false; readonly outcome: ConfirmationEmailDeliveryOutcome };

const blockedOutcome = (reason: ConfirmationEmailBlockReason): PreTransportAbort =>
  ({ ok: false, outcome: { status: 'blocked', reason } });
const deferredOutcome = (reason: ConfirmationFrozenDispatchDeferral): PreTransportAbort =>
  ({ ok: false, outcome: { status: 'snapshot_deferred', reason } });

/** The record is still the frozen record this attempt read, or why not. */
function frozenRecordStillHolds(latest: OrderRecord, frame: AttemptFrame): PreTransportAbort | null {
  const fence = frame.evaluateClaimability(latest);
  if (fence === null) return deferredOutcome('record_changed');
  if (fence !== 'awaiting_frozen_dispatch') return blockedOutcome(fence);
  if (latest.confirmationEmailState !== frame.from) return deferredOutcome('record_changed');
  if (!refsEqual(refOf(latest), frame.ref)) return deferredOutcome('record_changed');
  return null;
}

/** The live-claim rule of the claimability fence, which F1 runs ahead of. */
function claimStatus(
  latest: OrderRecord,
  frame: AttemptFrame,
): { readonly ok: true; readonly takeover: boolean } | { readonly ok: false; readonly reason: 'claim_other_kind' | 'claim_active' } {
  if (!latest.emailResendClaimId) return { ok: true, takeover: false };
  if (latest.emailResendClaimKind !== CLAIM_KIND) return { ok: false, reason: 'claim_other_kind' };
  const claimedAtMs = latest.emailResendClaimAt ? Date.parse(latest.emailResendClaimAt) : Number.NaN;
  if (!Number.isFinite(claimedAtMs)) return { ok: false, reason: 'claim_active' };
  if (frame.nowMs - claimedAtMs < frame.claimStaleMs) return { ok: false, reason: 'claim_active' };
  return { ok: true, takeover: true };
}

function permitsIntent(decision: ConfirmationEmailTransitionDecision): boolean {
  return decision.allowed === true
    && decision.to === INTENT_STATE
    && decision.holdReason === null
    && decision.permitsProviderCall === true
    && decision.writesFirstDispatchIntent === true;
}

/** T2 then T3 from `SNAPSHOTTED`; T6 from PPDF. */
function intentDecision(
  latest: OrderRecord,
  from: FrozenState,
  takeover: boolean,
): ConfirmationEmailTransitionDecision {
  const firstDispatchIntentAt = latest.confirmationEmailFirstDispatchIntentAt ?? null;
  if (from === 'PROVABLY_PRE_DISPATCH_FAILED') {
    return evaluateConfirmationEmailTransition({
      from, event: 'claim_acquired', actor: 'worker', claimTakeover: takeover, firstDispatchIntentAt, envelopeRequestPresent: true,
    });
  }
  const reclaim = evaluateConfirmationEmailTransition({
    from, event: 'claim_acquired', actor: 'worker', claimTakeover: takeover, firstDispatchIntentAt,
  });
  if (reclaim.allowed !== true) return reclaim;
  if (reclaim.to !== 'SNAPSHOTTED' || reclaim.permitsProviderCall !== false) {
    return { allowed: false, reason: 'transition_not_permitted' };
  }
  return evaluateConfirmationEmailTransition({ from, event: 'dispatch_intent', actor: 'worker', envelopeRequestPresent: true });
}

type IntentResult = { readonly ok: true; readonly committed: OrderRecord } | PreTransportAbort;

/** C2: dispatch intent and the claim, in one write, re-derived from `latest`. */
function decideIntentCommit(latest: OrderRecord, frame: AttemptFrame): OrderTransactionOutcome<IntentResult> {
  const moved = frozenRecordStillHolds(latest, frame);
  if (moved) return { abort: moved };
  const claim = claimStatus(latest, frame);
  if (claim.ok === false) return { abort: blockedOutcome(claim.reason) };

  const decision = intentDecision(latest, frame.from, claim.takeover);
  if (decision.allowed !== true) {
    return { abort: decision.reason === 'takeover_refused_after_dispatch_intent' ? blockedOutcome('claim_active') : deferredOutcome('record_changed') };
  }
  if (!permitsIntent(decision)) return { abort: deferredOutcome('record_changed') };

  // W1: the earliest intent instant is carried forward, never replaced.
  const current = latest.confirmationEmailFirstDispatchIntentAt;
  const firstIntent = current ?? frame.nowIso;
  if (evaluateFirstDispatchIntentWrite(current, firstIntent).ok !== true) return { abort: deferredOutcome('first_intent_invalid') };

  const committed: OrderRecord = {
    ...latest,
    confirmationEmailState: INTENT_STATE,
    confirmationEmailHoldReason: null,
    confirmationEmailAttemptId: frame.attemptId,
    confirmationEmailFirstDispatchIntentAt: firstIntent,
    confirmationEmailDispatchDeadlineAt: new Date(frame.nowMs + CONFIRMATION_DISPATCH_DEADLINE_MS).toISOString(),
    emailResendClaimId: frame.claimId,
    emailResendClaimKind: CLAIM_KIND,
    emailResendClaimArtifact: latest.stripeSessionId ?? latest.id,
    emailResendClaimAt: frame.nowIso,
    updatedAt: frame.nowIso,
  };
  return { commit: committed, result: { ok: true, committed } };
}

function isRefusalHold(decision: ConfirmationEmailTransitionDecision, reason: ConfirmationFrozenDispatchHoldReason): boolean {
  return decision.allowed === true
    && decision.to === 'RECONCILIATION_REQUIRED'
    && decision.holdReason === reason
    && decision.permitsProviderCall === false;
}

/** P2 / P3b: a hold before intent. State, hold reason and `updatedAt` only. */
function decideRefusalHoldCommit(
  latest: OrderRecord,
  frame: AttemptFrame,
  decision: ConfirmationEmailTransitionDecision,
  reason: ConfirmationFrozenDispatchHoldReason,
): OrderTransactionOutcome<IntentResult> {
  const moved = frozenRecordStillHolds(latest, frame);
  if (moved) return { abort: moved };
  if (!isRefusalHold(decision, reason)) return { abort: deferredOutcome('record_changed') };
  const committed: OrderRecord = {
    ...latest,
    confirmationEmailState: 'RECONCILIATION_REQUIRED',
    confirmationEmailHoldReason: reason,
    updatedAt: frame.nowIso,
  };
  return { commit: committed, result: { ok: true, committed } };
}

/** Every post-intent write is guarded on this attempt still holding intent. */
function isOurIntent(latest: OrderRecord, frame: AttemptFrame): boolean {
  return latest.confirmationEmailState === INTENT_STATE && latest.confirmationEmailAttemptId === frame.attemptId;
}

function attemptEntry(
  frame: AttemptFrame,
  outcome: ConfirmationEmailAttemptOutcome,
  detail: { providerMessageId?: string | null; providerErrorClass?: string | null; statusCode?: number | null } = {},
): ConfirmationEmailAttemptRecord {
  return {
    attemptId: frame.attemptId,
    claimId: frame.claimId,
    intentAt: frame.nowIso,
    outcome,
    providerMessageId: detail.providerMessageId ?? null,
    providerErrorClass: detail.providerErrorClass ?? null,
    statusCode: detail.statusCode ?? null,
  };
}

function withAttempt(latest: OrderRecord, entry: ConfirmationEmailAttemptRecord): readonly ConfirmationEmailAttemptRecord[] {
  const history = Array.isArray(latest.confirmationEmailAttempts) ? latest.confirmationEmailAttempts : [];
  return appendConfirmationEmailAttempt(history, entry);
}

const RELEASED_CLAIM = Object.freeze({
  emailResendClaimId: null,
  emailResendClaimKind: null,
  emailResendClaimArtifact: null,
  emailResendClaimAt: null,
});

/** F4/F5, T5 and T7: the outcome, the attempt, and the claim released. */
function decideReleasingCommit(
  latest: OrderRecord,
  frame: AttemptFrame,
  decision: ConfirmationEmailTransitionDecision,
  entry: ConfirmationEmailAttemptRecord,
): OrderTransactionOutcome<boolean> {
  if (!isOurIntent(latest, frame)) return { abort: false };
  if (decision.allowed !== true || decision.releasesClaim !== true || decision.permitsProviderCall !== false) return { abort: false };
  return {
    commit: {
      ...latest,
      confirmationEmailState: decision.to,
      confirmationEmailHoldReason: decision.holdReason,
      ...RELEASED_CLAIM,
      confirmationEmailAttempts: withAttempt(latest, entry),
      updatedAt: frame.nowIso,
    },
    result: true,
  };
}

/**
 * T8: the provider accepted and the receipt did not land. The record is held
 * with the acceptance recorded in the attempt, and the claim is NOT touched.
 */
function receiptFailedCommit(
  latest: OrderRecord,
  frame: AttemptFrame,
  holdReason: 'receipt_write_failed' | 'claim_lost_after_acceptance',
  providerMessageId: string,
): OrderRecord | null {
  const decision = evaluateConfirmationEmailTransition({
    from: INTENT_STATE, event: 'receipt_failed', actor: 'worker', holdReason,
  });
  if (decision.allowed !== true || decision.releasesClaim !== false || decision.holdReason !== holdReason) return null;
  return {
    ...latest,
    confirmationEmailState: decision.to,
    confirmationEmailHoldReason: decision.holdReason,
    confirmationEmailAttempts: withAttempt(latest, attemptEntry(frame, 'accepted', { providerMessageId })),
    updatedAt: frame.nowIso,
  };
}

type ReceiptResult = 'accepted' | 'claim_moved' | 'not_ours';

/** C3 (T4): state, receipt, acceptance, message id and release in one write. */
function decideReceiptCommit(latest: OrderRecord, frame: AttemptFrame, providerMessageId: string): OrderTransactionOutcome<ReceiptResult> {
  if (!isOurIntent(latest, frame)) return { abort: 'not_ours' };
  if (latest.emailResendClaimId !== frame.claimId) {
    const held = receiptFailedCommit(latest, frame, 'claim_lost_after_acceptance', providerMessageId);
    return held === null ? { abort: 'not_ours' } : { commit: held, result: 'claim_moved' };
  }
  const decision = evaluateConfirmationEmailTransition({ from: INTENT_STATE, event: 'provider_accepted', actor: 'worker' });
  if (decision.allowed !== true || decision.to !== 'ACCEPTED' || decision.releasesClaim !== true) return { abort: 'not_ours' };
  return {
    commit: {
      ...latest,
      confirmationEmailState: decision.to,
      confirmationEmailHoldReason: null,
      confirmationEmailSentAt: frame.nowIso,
      confirmationEmailAcceptedAt: frame.nowIso,
      confirmationEmailProviderMessageId: providerMessageId,
      confirmationEmailDispatchDeadlineAt: null,
      ...RELEASED_CLAIM,
      confirmationEmailAttempts: withAttempt(latest, attemptEntry(frame, 'accepted', { providerMessageId })),
      updatedAt: frame.nowIso,
    },
    result: 'accepted',
  };
}

// ---------------------------------------------------------------------------
// The attempt
// ---------------------------------------------------------------------------

/** The adapter's conflict-exhaustion error, recognized by its class name only. */
function isVersionConflict(error: unknown): boolean {
  try {
    return error instanceof Error && error.name === 'OrderVersionConflictError';
  } catch {
    return false;
  }
}

function errorClassOf(error: unknown): string {
  try {
    return className(error instanceof Error ? error.name : typeof error);
  } catch {
    return 'unknown';
  }
}

function transportReady(transport: ConfirmationFrozenDispatchTransport): boolean {
  try {
    return transport.ready() === true;
  } catch {
    return false;
  }
}

const UNUSABLE_ENVELOPE_REFUSALS: ReadonlySet<string> = new Set([
  'not_found', 'invalid_object', 'digest_mismatch', 'too_large', 'path_invalid',
]);

type DispatchDeferral = ConfirmationEnvelopeSnapshotDeferral | ConfirmationFrozenDispatchDeferral;

type PreparedDispatch = { frame: AttemptFrame; envelope: ConfirmationEmailEnvelopeV1; committed: OrderRecord };

/**
 * One frozen dispatch for an order whose record waits for it. Never sends
 * without a landed intent commit and a passing fence, and never retries.
 *
 * Before the provider call, a namespace fault or conflict exhaustion is a
 * closed deferral and any other fault propagates. From the provider call on,
 * this never throws.
 */
export async function dispatchFrozenConfirmation(
  orderId: string,
  dispatcher: Extract<FrozenDispatcher, { kind: 'armed' }>,
  ctx: FrozenDispatchContext,
): Promise<ConfirmationEmailDeliveryOutcome> {
  const io = dispatcher.gate.orderIo;
  const deferred = (reason: DispatchDeferral): ConfirmationEmailDeliveryOutcome => {
    ctx.errorLog(`[confirmation-email] frozen dispatch deferred orderId=${orderId} reason=${reason}`);
    return { status: 'snapshot_deferred', reason };
  };
  const preSendFault = (error: unknown): ConfirmationEmailDeliveryOutcome => {
    const fault = io.classifyFault(error);
    if (fault !== null) return deferred(fault);
    if (isVersionConflict(error)) return deferred('cas_exhausted');
    throw error;
  };

  // P0: no read, no write, no call until the transport says it can send.
  if (!transportReady(dispatcher.transport)) return deferred('transport_not_ready');

  let prepared: PreparedDispatch | ConfirmationEmailDeliveryOutcome;
  try {
    prepared = await prepareFrozenDispatch(orderId, dispatcher, ctx);
  } catch (error) {
    return preSendFault(error);
  }
  if ('status' in prepared) {
    if (prepared.status === 'snapshot_deferred') return deferred(prepared.reason);
    if (prepared.status === 'held') ctx.errorLog(`[confirmation-email] frozen dispatch held orderId=${orderId} reason=${prepared.reason}`);
    return prepared;
  }
  const { frame, envelope, committed } = prepared;
  const notFound = { notFound: () => false };

  // F: the fence, after intent landed and before any provider call. Nothing
  // has been sent, so its faults are pre-send faults.
  const fenced = evaluateFrozenDispatchFence(committed, envelope, dispatcher.gate.writer.accountLabel);
  if (fenced !== null) {
    const decision = evaluateConfirmationEmailTransition({
      from: INTENT_STATE, event: 'integrity_fence_failed', actor: 'worker', holdReason: fenced,
    });
    let written: boolean;
    try {
      written = await io.postTransportTransact<boolean>(
        orderId,
        (latest) => decideReleasingCommit(latest, frame, decision, attemptEntry(frame, 'fenced_before_dispatch')),
        notFound,
      );
    } catch (error) {
      return preSendFault(error);
    }
    if (!written) return deferred('record_changed');
    ctx.errorLog(`[confirmation-email] frozen dispatch held orderId=${orderId} reason=${fenced}`);
    return { status: 'held', reason: fenced };
  }

  // CK-T: a drift here sends nothing and writes nothing further. The record
  // stays in DISPATCH_INTENT_RECORDED, a held state, for the reaper.
  const drift = io.beforeTransport();
  if (drift !== null) return deferred(drift);

  // SEND: the one provider call, with the stored request and the stored key.
  let result: FrozenDispatchTransportResult;
  try {
    result = await dispatcher.transport.send(envelope.request!, envelope.idempotencyKey);
  } catch (error) {
    result = { kind: 'submit_threw', errorClass: errorClassOf(error) };
  }
  const classified = classifyFrozenDispatchResult(result);

  if (classified.event === 'provider_accepted') return recordFrozenReceipt(orderId, dispatcher, ctx, frame, classified.providerMessageId);
  return recordFrozenFailure(orderId, dispatcher, ctx, frame, classified);
}

/**
 * After a provider call that did not return an acceptance: T5 or T7, one CAS
 * guarded on this attempt. If that write throws or finds the record moved,
 * the outcome is `receipt_unrecorded` — the attempt reached the provider
 * boundary and its result is not durably recorded — and the record stays
 * where it is: a throw leaves DISPATCH_INTENT_RECORDED with its claim, a held
 * state only the reaper or an operator moves. Never throws.
 */
async function recordFrozenFailure(
  orderId: string,
  dispatcher: Extract<FrozenDispatcher, { kind: 'armed' }>,
  ctx: FrozenDispatchContext,
  frame: AttemptFrame,
  classified: Exclude<FrozenDispatchClassification, { event: 'provider_accepted' }>,
): Promise<ConfirmationEmailDeliveryOutcome> {
  const proven = classified.event === 'pre_dispatch_failure_proven';
  const decision = proven
    ? evaluateConfirmationEmailTransition({ from: INTENT_STATE, event: 'pre_dispatch_failure_proven', actor: 'worker' })
    : evaluateConfirmationEmailTransition({ from: INTENT_STATE, event: 'ambiguous_outcome', actor: 'worker', holdReason: classified.holdReason });
  const errorClass = proven ? classified.errorClass : classified.providerErrorClass;
  const entry = attemptEntry(frame, proven ? classified.attemptOutcome : 'ambiguous', {
    providerErrorClass: errorClass,
    statusCode: classified.statusCode,
  });
  const detail = `outcome=${proven ? 'pre_dispatch_failed' : classified.holdReason}`
    + ` providerErrorClass=${errorClass} statusCode=${classified.statusCode ?? 'none'} via=frozen_dispatch`;

  let written: boolean;
  try {
    written = await dispatcher.gate.orderIo.postTransportTransact<boolean>(
      orderId,
      (latest) => decideReleasingCommit(latest, frame, decision, entry),
      { notFound: () => false },
    );
  } catch (error) {
    ctx.errorLog(
      `[confirmation-email] outcome write failed orderId=${orderId} ${detail} errorClass=${errorClassOf(error)}`,
    );
    return { status: 'receipt_unrecorded', reason: 'write_failed' };
  }
  if (!written) {
    ctx.errorLog(`[confirmation-email] outcome not recorded orderId=${orderId} ${detail} reason=claim_lost`);
    return { status: 'receipt_unrecorded', reason: 'claim_lost' };
  }
  if (proven) {
    ctx.errorLog(`[confirmation-email] send failed orderId=${orderId} errorClass=${errorClass} via=frozen_dispatch`);
    return { status: 'failed', reason: 'send_error', errorClass };
  }
  ctx.errorLog(`[confirmation-email] frozen dispatch held orderId=${orderId} reason=${classified.holdReason} ${detail}`);
  return { status: 'held', reason: classified.holdReason };
}

/** P1–C2. Returns the landed intent, or the outcome that ended the attempt. */
async function prepareFrozenDispatch(
  orderId: string,
  dispatcher: Extract<FrozenDispatcher, { kind: 'armed' }>,
  ctx: FrozenDispatchContext,
): Promise<PreparedDispatch | ConfirmationEmailDeliveryOutcome> {
  const io = dispatcher.gate.orderIo;

  // P1
  const observed = await io.read(orderId);
  if (!observed) return { status: 'blocked', reason: 'order_not_found' };
  const fence = ctx.evaluateClaimability(observed);
  if (fence === null) return { status: 'snapshot_deferred', reason: 'record_changed' };
  if (fence !== 'awaiting_frozen_dispatch') return { status: 'blocked', reason: fence };
  const ref = refOf(observed);
  if (ref === null) return { status: 'blocked', reason: fence };

  const frame: AttemptFrame = Object.freeze({
    orderId,
    from: observed.confirmationEmailState as FrozenState,
    ref,
    nowMs: ctx.nowMs,
    nowIso: new Date(ctx.nowMs).toISOString(),
    claimStaleMs: ctx.claimStaleMs,
    claimId: ctx.newClaimId(),
    attemptId: (dispatcher.newAttemptId ?? ctx.newAttemptId)(),
    evaluateClaimability: ctx.evaluateClaimability,
  });
  const notFound = { notFound: (): IntentResult => blockedOutcome('order_not_found') };
  const refusalHold = async (decision: ConfirmationEmailTransitionDecision, reason: ConfirmationFrozenDispatchHoldReason) => {
    const held = await io.guardedTransact<IntentResult>(orderId, (latest) => decideRefusalHoldCommit(latest, frame, decision, reason), notFound);
    return held.ok === true ? { status: 'held' as const, reason } : held.outcome;
  };

  // P2: a purged payload is structurally unsendable; the model says so.
  if (ref.purgedAt !== null) {
    const decision = frame.from === 'PROVABLY_PRE_DISPATCH_FAILED'
      ? evaluateConfirmationEmailTransition({ from: frame.from, event: 'claim_acquired', actor: 'worker', envelopeRequestPresent: false })
      : evaluateConfirmationEmailTransition({ from: frame.from, event: 'dispatch_intent', actor: 'worker', envelopeRequestPresent: false });
    return refusalHold(decision, 'payload_purged');
  }

  // P3: one authenticated read of the private object.
  let stored: Awaited<ReturnType<typeof dispatcher.gate.writer.store.read>>;
  try {
    stored = await dispatcher.gate.writer.store.read(orderId);
  } catch {
    return { status: 'snapshot_deferred', reason: 'envelope_read_failed' };
  }
  if (stored.ok === false) {
    if (!UNUSABLE_ENVELOPE_REFUSALS.has(stored.refusal)) return { status: 'snapshot_deferred', reason: 'envelope_read_failed' };
    if (frame.from === 'PROVABLY_PRE_DISPATCH_FAILED') return { status: 'snapshot_deferred', reason: 'envelope_unusable_ppdf' };
    return refusalHold(
      evaluateConfirmationEmailTransition({ from: 'SNAPSHOTTED', event: 'snapshot_refused', actor: 'worker' }),
      'snapshot_refused',
    );
  }

  // C2: the single point of serialization.
  const intent = await io.guardedTransact<IntentResult>(orderId, (latest) => decideIntentCommit(latest, frame), notFound);
  if (intent.ok === false) return intent.outcome;
  return { frame, envelope: stored.value, committed: intent.committed };
}

/**
 * After acceptance. One receipt CAS; if it throws, one hold CAS; if that throws
 * too, the record stays in DISPATCH_INTENT_RECORDED. No arm releases the claim
 * and no arm throws.
 */
async function recordFrozenReceipt(
  orderId: string,
  dispatcher: Extract<FrozenDispatcher, { kind: 'armed' }>,
  ctx: FrozenDispatchContext,
  frame: AttemptFrame,
  providerMessageId: string,
): Promise<ConfirmationEmailDeliveryOutcome> {
  const io = dispatcher.gate.orderIo;
  let receipt: ReceiptResult;
  try {
    receipt = await io.postTransportTransact<ReceiptResult>(
      orderId,
      (latest) => decideReceiptCommit(latest, frame, providerMessageId),
      { notFound: () => 'not_ours' },
    );
  } catch (error) {
    ctx.errorLog(
      `[confirmation-email] receipt write failed orderId=${orderId} providerMessageId=${providerMessageId}`
        + ` errorClass=${errorClassOf(error)} via=frozen_dispatch`,
    );
    try {
      await io.postTransportTransact<boolean>(
        orderId,
        (latest) => {
          if (!isOurIntent(latest, frame)) return { abort: false };
          const held = receiptFailedCommit(latest, frame, 'receipt_write_failed', providerMessageId);
          return held === null ? { abort: false } : { commit: held, result: true };
        },
        { notFound: () => false },
      );
    } catch {
      // The record stays in DISPATCH_INTENT_RECORDED, with its claim; only
      // the reaper or an operator moves it.
    }
    return { status: 'receipt_unrecorded', reason: 'write_failed' };
  }
  if (receipt !== 'accepted') {
    ctx.errorLog(
      `[confirmation-email] receipt not recorded orderId=${orderId} providerMessageId=${providerMessageId}`
        + ' reason=claim_lost via=frozen_dispatch',
    );
    return { status: 'receipt_unrecorded', reason: 'claim_lost' };
  }
  ctx.log(`[confirmation-email] delivered orderId=${orderId} providerMessageId=${providerMessageId} via=frozen_dispatch`);
  return { status: 'sent' };
}
