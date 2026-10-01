/**
 * Confirmation-email reconciliation (L-4 Slice A3-6): the dispatch-lease
 * reaper and the three operator doors out of a hold.
 *
 * Both halves make state writes only. Nothing here reaches a provider, the
 * frozen transport, the sender module or the private envelope store, and
 * nothing here sends: every commit goes through the writer gate's guarded,
 * namespace-bound order transaction, and with the gate off or refused —
 * which is every default caller today — nothing is read or written at all.
 *
 * The reaper (T9)
 * ---------------
 * A record that recorded dispatch intent and whose lease elapsed becomes a
 * `deadline_exceeded` hold. It is a separate enumeration pass (R1): the sweep's
 * eligibility filter delegates to a claimability fence that can never surface
 * a `DISPATCH_INTENT_RECORDED` record, so a reaper behind it would see nothing.
 * The claim, the attempt id and the deadline are kept as evidence; the hold is
 * a state no worker may claim out of, so a reaped record is never handed back
 * to the send path. A worker that passed its last check before the reap may
 * still be mid-send; its receipt CAS then finds the record no longer its own
 * and records nothing, which is why the door copy for a deadline hold warns
 * that the message may already have been accepted.
 *
 * Timing that cannot be read is never a reason to wait (R-2): a record with no
 * usable lease instant is held at once, with the same modelled hold reason and
 * a closed `basis` in its audit event.
 *
 * The operator doors (T10–T12)
 * ----------------------------
 * Authenticated before any body read, order read or CAS; exact origin; closed
 * input; a stale-record token over the transition fields; per-door evidence;
 * one guarded CAS that re-derives every check from the latest record, releases
 * only an `order_confirmation` claim (AM-1), and appends one accepted audit
 * event whose metadata is an allowlist of closed codes. Door 3 records that the
 * operator already sent the confirmation themselves (OD-1): it sends nothing,
 * builds nothing and mints no key.
 */
import { createHash } from 'node:crypto';

import { isAdminAuthedFromRequest } from './admin-auth.ts';
import { CONFIRMATION_EMAIL_CLAIM_KIND, classifyConfirmationEmailError } from './confirmation-email-delivery.ts';
import { CONFIRMATION_DISPATCH_DEADLINE_MS } from './confirmation-email-dispatch.ts';
import {
  CONFIRMATION_EMAIL_STATES,
  appendConfirmationEmailAttempt,
  evaluateConfirmationEmailTransition,
} from './confirmation-email-state.ts';
import type {
  ConfirmationEmailAttemptRecord,
  ConfirmationEmailEvent,
  ConfirmationEmailHoldReason,
  ConfirmationEmailState,
} from './confirmation-email-state.ts';
import { resolveConfirmationEnvelopeWriter } from './confirmation-envelope-producer.ts';
import type { BoundOrderIo, ConfirmationEnvelopeWriterDeps } from './confirmation-envelope-producer.ts';
import {
  CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE,
  projectConfirmationEmailEnvelopeRefIfValid,
} from './confirmation-envelope-ref.ts';
import type { ConfirmationEmailOperatorView } from './confirmation-envelope-ref.ts';
import type { OrderRecord, OrderTransactionOutcome, ReviewAuditEvent } from './orders.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Restated from the state module, whose copy is private: a value is an
 *  instant only if it is byte-identical to what `toISOString()` emits. */
function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

/** Restated from the dispatcher's provider message-id grammar. */
const PROVIDER_MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

const RECONCILIATION_REQUIRED = 'RECONCILIATION_REQUIRED';
const INTENT_STATE = 'DISPATCH_INTENT_RECORDED';

/** The adapter's conflict-exhaustion error, recognized by its class name only. */
function isVersionConflict(error: unknown): boolean {
  try {
    return error instanceof Error && error.name === 'OrderVersionConflictError';
  } catch {
    return false;
  }
}

type ReconciliationGate =
  | { readonly bound: true; readonly orderIo: BoundOrderIo }
  | { readonly bound: false; readonly kind: 'off' | 'refused' };

/** The writer gate, reduced to its order I/O. Off or refused binds nothing. */
function resolveReconciliationGate(writer: ConfirmationEnvelopeWriterDeps | undefined): ReconciliationGate {
  const gate = resolveConfirmationEnvelopeWriter(writer);
  if (gate.kind === 'off' || gate.kind === 'refused') return { bound: false, kind: gate.kind };
  return { bound: true, orderIo: gate.orderIo };
}

function attemptsOf(order: OrderRecord): readonly ConfirmationEmailAttemptRecord[] | null {
  const attempts: unknown = order.confirmationEmailAttempts;
  if (isAbsent(attempts)) return [];
  return Array.isArray(attempts) ? attempts as readonly ConfirmationEmailAttemptRecord[] : null;
}

// ---------------------------------------------------------------------------
// The reaper
// ---------------------------------------------------------------------------

export const CONFIRMATION_EMAIL_REAPER_MAX_PER_RUN = 10;
/** How far past the modelled lease a deadline may sit and still be believed. */
export const CONFIRMATION_EMAIL_REAPER_SKEW_MS = 60_000;

export type ConfirmationEmailReapBasis = 'deadline' | 'claim_at' | 'first_intent' | 'unusable';

/** What the listing saw; the CAS proves the latest record still says it. */
export interface ConfirmationEmailReapObservation {
  readonly attemptId: unknown;
  readonly deadline: unknown;
}

export type ConfirmationEmailReapOutcome =
  | { readonly status: 'reaped'; readonly basis: ConfirmationEmailReapBasis }
  | { readonly status: 'not_due' }
  | { readonly status: 'moved' };

export interface ConfirmationEmailReaperDeps {
  nowMs: number;
  log: (line: string) => void;
  /** Order ids and closed codes only. */
  errorLog: (line: string) => void;
  maxPerRun?: number;
  /** Tests only. Default: the ambient writer gate. */
  writer?: ConfirmationEnvelopeWriterDeps;
}

export interface ConfirmationEmailReaperResult {
  /** Listed dispatch-intent records whose lease had elapsed. */
  candidates: number;
  reaped: number;
  /** The CAS found the record no longer the one listed; nothing written. */
  moved: number;
  /** A namespace fault, conflict exhaustion or fault; nothing written. */
  deferred: number;
  /** Candidates left alone because the writer gate is off or refused. */
  unbound: number;
}

type LeaseVerdict = { readonly due: boolean; readonly basis: ConfirmationEmailReapBasis; readonly intentAt: string | null };

/**
 * When did this lease end, and has it? The deadline when it is canonical and
 * plausible; else the claim instant (C2 sets it to the intent instant); else
 * the first intent; else nothing usable, which is due now. A fallback instant
 * later than `now + skew` is no more believable than a far-future deadline.
 */
function evaluateLease(order: OrderRecord, nowMs: number): LeaseVerdict {
  const deadline: unknown = order.confirmationEmailDispatchDeadlineAt;
  if (isCanonicalIsoInstant(deadline)) {
    const deadlineMs = Date.parse(deadline);
    if (deadlineMs - nowMs <= CONFIRMATION_DISPATCH_DEADLINE_MS + CONFIRMATION_EMAIL_REAPER_SKEW_MS) {
      return {
        due: deadlineMs <= nowMs,
        basis: 'deadline',
        intentAt: new Date(deadlineMs - CONFIRMATION_DISPATCH_DEADLINE_MS).toISOString(),
      };
    }
  }
  const fallbacks: Array<[ConfirmationEmailReapBasis, unknown]> = [
    ['claim_at', order.emailResendClaimKind === CONFIRMATION_EMAIL_CLAIM_KIND ? order.emailResendClaimAt : null],
    ['first_intent', order.confirmationEmailFirstDispatchIntentAt],
  ];
  for (const [basis, instant] of fallbacks) {
    if (!isCanonicalIsoInstant(instant)) continue;
    const instantMs = Date.parse(instant);
    if (instantMs - nowMs > CONFIRMATION_EMAIL_REAPER_SKEW_MS) continue;
    return { due: instantMs + CONFIRMATION_DISPATCH_DEADLINE_MS <= nowMs, basis, intentAt: instant };
  }
  return { due: true, basis: 'unusable', intentAt: null };
}

function sameObservedLeaseField(latest: unknown, observed: unknown): boolean {
  if (Object.is(latest, observed)) return true;
  try {
    return JSON.stringify(latest) === JSON.stringify(observed);
  } catch {
    return false;
  }
}

/**
 * The T9 commit, re-derived from `latest`. Pure: no clock beyond `nowMs`, no
 * environment, no I/O. Aborts unless the latest record is still the listed
 * attempt (state, attempt id and deadline, by their JSON-backed value), its
 * lease has elapsed, and the model allows exactly a claim-keeping, non-sending
 * deadline hold.
 */
export function decideConfirmationEmailReap(
  latest: OrderRecord,
  observed: ConfirmationEmailReapObservation,
  nowMs: number,
): OrderTransactionOutcome<ConfirmationEmailReapOutcome> {
  if (latest.confirmationEmailState !== INTENT_STATE) return { abort: { status: 'moved' } };
  if (!sameObservedLeaseField(latest.confirmationEmailAttemptId, observed.attemptId)) return { abort: { status: 'moved' } };
  if (!sameObservedLeaseField(latest.confirmationEmailDispatchDeadlineAt, observed.deadline)) return { abort: { status: 'moved' } };

  const lease = evaluateLease(latest, nowMs);
  if (!lease.due) return { abort: { status: 'not_due' } };

  const decision = evaluateConfirmationEmailTransition({ from: INTENT_STATE, event: 'deadline_elapsed', actor: 'reaper' });
  if (
    decision.allowed !== true
    || decision.to !== RECONCILIATION_REQUIRED
    || decision.holdReason !== 'deadline_exceeded'
    || decision.permitsProviderCall !== false
    || decision.releasesClaim !== false
    || decision.writesFirstDispatchIntent !== false
  ) {
    return { abort: { status: 'moved' } };
  }
  const history = attemptsOf(latest) ?? [];

  const nowIso = new Date(nowMs).toISOString();
  const attempts = appendConfirmationEmailAttempt(history, {
    attemptId: typeof observed.attemptId === 'string' ? observed.attemptId : 'unknown',
    claimId: typeof latest.emailResendClaimId === 'string' ? latest.emailResendClaimId : 'none',
    intentAt: lease.intentAt ?? nowIso,
    outcome: 'ambiguous',
  });
  const event: ReviewAuditEvent = {
    at: nowIso,
    type: 'confirmation_held',
    reason: decision.holdReason,
    meta: { basis: lease.basis, toState: decision.to, attemptCount: attempts.length },
  };
  return {
    commit: {
      ...latest,
      confirmationEmailState: decision.to,
      confirmationEmailHoldReason: decision.holdReason,
      confirmationEmailAttempts: attempts,
      auditEvents: [...(Array.isArray(latest.auditEvents) ? latest.auditEvents : []), event],
      updatedAt: nowIso,
    },
    result: { status: 'reaped', basis: lease.basis },
  };
}

/**
 * One bounded reaper pass over an already-listed set of orders. Resolves the
 * writer gate only when there is something to reap; never throws for a single
 * order.
 */
export async function runConfirmationEmailReaper(
  orders: readonly OrderRecord[],
  deps: ConfirmationEmailReaperDeps,
): Promise<ConfirmationEmailReaperResult> {
  const result: ConfirmationEmailReaperResult = { candidates: 0, reaped: 0, moved: 0, deferred: 0, unbound: 0 };
  const due = orders.filter((order) => order.confirmationEmailState === INTENT_STATE && evaluateLease(order, deps.nowMs).due);
  result.candidates = due.length;
  if (due.length === 0) return result;

  const gate = resolveReconciliationGate(deps.writer);
  if (gate.bound === false) {
    result.unbound = due.length;
    deps.errorLog(`[confirmation-email-reaper] unbound gate=${gate.kind} candidates=${due.length}`);
    return result;
  }

  const budget = deps.maxPerRun ?? CONFIRMATION_EMAIL_REAPER_MAX_PER_RUN;
  for (const order of due.slice(0, budget)) {
    const observed: ConfirmationEmailReapObservation = {
      attemptId: order.confirmationEmailAttemptId,
      deadline: order.confirmationEmailDispatchDeadlineAt,
    };
    try {
      const outcome = await gate.orderIo.guardedTransact<ConfirmationEmailReapOutcome>(
        order.id,
        (latest) => decideConfirmationEmailReap(latest, observed, deps.nowMs),
        { notFound: () => ({ status: 'moved' }) },
      );
      if (outcome.status === 'reaped') {
        result.reaped += 1;
        deps.log(`[confirmation-email-reaper] reaped orderId=${order.id} basis=${outcome.basis}`);
      } else {
        result.moved += 1;
      }
    } catch (error) {
      result.deferred += 1;
      const reason = gate.orderIo.classifyFault(error)
        ?? (isVersionConflict(error) ? 'cas_exhausted' : `errorClass_${classifyConfirmationEmailError(error)}`);
      deps.errorLog(`[confirmation-email-reaper] deferred orderId=${order.id} reason=${reason}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The operator doors
// ---------------------------------------------------------------------------

export const CONFIRMATION_EMAIL_OPERATOR_ACTIONS = ['bind_acceptance', 'prove_non_acceptance', 'resend_attestation'] as const;

export type ConfirmationEmailOperatorAction = (typeof CONFIRMATION_EMAIL_OPERATOR_ACTIONS)[number];

type DoorSpec = {
  readonly event: Extract<ConfirmationEmailEvent, 'operator_bind_acceptance' | 'operator_prove_non_acceptance' | 'operator_authorized_resend'>;
  readonly to: ConfirmationEmailState;
  readonly audit: 'confirmation_reconciled' | 'confirmation_owner_resend';
  readonly evidenceKind: 'provider_message_id' | 'provider_shows_no_acceptance' | 'sent_out_of_band';
  readonly attestation: string | null;
  readonly result: 'reconciled_accepted' | 'returned_to_snapshot' | 'resend_attested';
};

const DOORS: ReadonlyMap<string, DoorSpec> = new Map<ConfirmationEmailOperatorAction, DoorSpec>([
  ['bind_acceptance', {
    event: 'operator_bind_acceptance', to: 'RECONCILED_ACCEPTED', audit: 'confirmation_reconciled',
    evidenceKind: 'provider_message_id', attestation: null, result: 'reconciled_accepted',
  }],
  ['prove_non_acceptance', {
    event: 'operator_prove_non_acceptance', to: 'SNAPSHOTTED', audit: 'confirmation_reconciled',
    evidenceKind: 'provider_shows_no_acceptance', attestation: 'provider_shows_no_acceptance', result: 'returned_to_snapshot',
  }],
  ['resend_attestation', {
    event: 'operator_authorized_resend', to: 'OWNER_AUTHORIZED_RESEND_SENT', audit: 'confirmation_owner_resend',
    evidenceKind: 'sent_out_of_band', attestation: 'sent_out_of_band', result: 'resend_attested',
  }],
]);

export type ConfirmationEmailOperatorRefusal =
  | 'not_held'
  | 'stale_record'
  | 'door_not_permitted'
  | 'evidence_conflict'
  | 'claim_other_kind';

export type ConfirmationEmailOperatorErrorCode =
  | ConfirmationEmailOperatorRefusal
  | 'bad_input'
  | 'reconciliation_unavailable'
  | 'unexpected';

export type ConfirmationEmailOperatorResultCode = DoorSpec['result'] | ConfirmationEmailOperatorErrorCode;

/** The closed input of one door request, after validation. */
interface DoorInput {
  readonly action: ConfirmationEmailOperatorAction;
  readonly expectedToken: string;
  readonly providerMessageId: string | null;
}

/**
 * The stale-record token: sha256 over the transition fields an operator's
 * decision rests on. `updatedAt` is deliberately outside it, so an unrelated
 * fulfillment write does not invalidate the page.
 */
export function computeConfirmationEmailReconciliationToken(order: OrderRecord): string {
  const scalar = (value: unknown): string | number | null => {
    if (typeof value === 'string' || typeof value === 'number') return value;
    return isAbsent(value) ? null : `non_scalar:${typeof value}`;
  };
  const attempts = attemptsOf(order);
  const canonical = JSON.stringify({
    orderId: scalar(order.id),
    state: scalar(order.confirmationEmailState),
    holdReason: scalar(order.confirmationEmailHoldReason),
    attemptId: scalar(order.confirmationEmailAttemptId),
    firstDispatchIntentAt: scalar(order.confirmationEmailFirstDispatchIntentAt),
    dispatchDeadlineAt: scalar(order.confirmationEmailDispatchDeadlineAt),
    attemptCount: attempts === null ? -1 : attempts.length,
    claimId: scalar(order.emailResendClaimId),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Provider acceptance this record already knows about: ids, and whether any exists. */
function recordedAcceptance(order: OrderRecord): { readonly any: boolean; readonly ids: ReadonlySet<string> } | null {
  const attempts = attemptsOf(order);
  if (attempts === null) return null;
  const ids = new Set<string>();
  let any = false;
  for (const attempt of attempts) {
    const entry: unknown = attempt;
    if (entry === null || typeof entry !== 'object') return null;
    const { outcome, providerMessageId } = entry as { outcome?: unknown; providerMessageId?: unknown };
    if (outcome === 'accepted') any = true;
    if (!isAbsent(providerMessageId)) {
      any = true;
      if (typeof providerMessageId === 'string') ids.add(providerMessageId);
    }
  }
  if (!isAbsent(order.confirmationEmailProviderMessageId)) {
    any = true;
    if (typeof order.confirmationEmailProviderMessageId === 'string') ids.add(order.confirmationEmailProviderMessageId);
  }
  if (!isAbsent(order.confirmationEmailAcceptedAt) || !isAbsent(order.confirmationEmailSentAt)) any = true;
  return { any, ids };
}

/** The claim fields, or why a door may not touch them. */
function claimDisposition(order: OrderRecord): 'none' | 'confirmation' | 'claim_other_kind' {
  const present = !isAbsent(order.emailResendClaimId)
    || !isAbsent(order.emailResendClaimKind)
    || !isAbsent(order.emailResendClaimArtifact)
    || !isAbsent(order.emailResendClaimAt);
  if (!present) return 'none';
  return order.emailResendClaimKind === CONFIRMATION_EMAIL_CLAIM_KIND ? 'confirmation' : 'claim_other_kind';
}

/**
 * Every refusal that depends only on the record and the door — shared by the
 * commit and by the projection's `availableDoors`, so the page never offers a
 * door the commit would refuse for a reason it can already see.
 */
function doorRefusal(order: OrderRecord, action: ConfirmationEmailOperatorAction): ConfirmationEmailOperatorRefusal | null {
  if (order.confirmationEmailState !== RECONCILIATION_REQUIRED) return 'not_held';
  if (claimDisposition(order) === 'claim_other_kind') return 'claim_other_kind';
  if (action === 'prove_non_acceptance') {
    const hold: unknown = order.confirmationEmailHoldReason;
    if (hold === 'receipt_write_failed' || hold === 'claim_lost_after_acceptance') return 'door_not_permitted';
    const acceptance = recordedAcceptance(order);
    if (acceptance === null || acceptance.any) return 'door_not_permitted';
    // Without a usable ref the dispatcher would stop before sending anything,
    // so returning the record to SNAPSHOTTED would only park it again.
    if (projectConfirmationEmailEnvelopeRefIfValid(order.confirmationEmailEnvelopeRef, { orderId: order.id }) === null) {
      return 'door_not_permitted';
    }
  }
  return null;
}

type DoorCommitResult = { readonly ok: true; readonly result: DoorSpec['result'] } | { readonly ok: false; readonly refusal: ConfirmationEmailOperatorRefusal };

const RELEASED_CLAIM = Object.freeze({
  emailResendClaimId: null,
  emailResendClaimKind: null,
  emailResendClaimArtifact: null,
  emailResendClaimAt: null,
});

const HOLD_REASONS: readonly ConfirmationEmailHoldReason[] = [
  'ambiguous_dispatch', 'receipt_write_failed', 'claim_lost_after_acceptance', 'provider_body_conflict',
  'provider_concurrent_request', 'account_binding_mismatch', 'digest_mismatch', 'payload_purged',
  'deadline_exceeded', 'legacy_unresolved', 'snapshot_refused',
];

/** A closed member, `null` when absent, `'unrecognized'` otherwise. */
function closedOrUnrecognized<T extends string>(value: unknown, members: readonly T[]): T | 'unrecognized' | null {
  if (isAbsent(value)) return null;
  return (members as readonly unknown[]).includes(value) ? value as T : 'unrecognized';
}

/** One door's CAS, re-derived from `latest`. Pure. */
function decideOperatorDoor(latest: OrderRecord, input: DoorInput, nowIso: string): OrderTransactionOutcome<DoorCommitResult> {
  const refuse = (refusal: ConfirmationEmailOperatorRefusal) => ({ abort: { ok: false as const, refusal } });
  const door = DOORS.get(input.action);
  if (!door) return refuse('door_not_permitted');

  if (latest.confirmationEmailState !== RECONCILIATION_REQUIRED) return refuse('not_held');
  if (computeConfirmationEmailReconciliationToken(latest) !== input.expectedToken) return refuse('stale_record');
  const refusal = doorRefusal(latest, input.action);
  if (refusal !== null) return refuse(refusal);

  if (input.action === 'bind_acceptance') {
    const acceptance = recordedAcceptance(latest);
    if (acceptance === null || input.providerMessageId === null) return refuse('door_not_permitted');
    if (acceptance.ids.size > 0 && !acceptance.ids.has(input.providerMessageId)) return refuse('evidence_conflict');
  }

  const decision = evaluateConfirmationEmailTransition({ from: RECONCILIATION_REQUIRED, event: door.event, actor: 'operator' });
  if (
    decision.allowed !== true
    || decision.to !== door.to
    || decision.holdReason !== null
    || decision.permitsProviderCall !== false
    || decision.writesFirstDispatchIntent !== false
    || decision.releasesClaim !== true
  ) {
    return refuse('door_not_permitted');
  }

  const attempts = attemptsOf(latest);
  const event: ReviewAuditEvent = {
    at: nowIso,
    type: door.audit,
    meta: {
      door: input.action,
      fromHoldReason: closedOrUnrecognized(latest.confirmationEmailHoldReason, HOLD_REASONS),
      toState: door.to,
      attemptCount: attempts === null ? 0 : attempts.length,
      evidenceKind: door.evidenceKind,
      ...(input.action === 'bind_acceptance' && input.providerMessageId !== null ? { providerMessageId: input.providerMessageId } : {}),
    },
  };
  const commit: OrderRecord = {
    ...latest,
    confirmationEmailState: decision.to,
    confirmationEmailHoldReason: null,
    ...(claimDisposition(latest) === 'confirmation' ? RELEASED_CLAIM : {}),
    auditEvents: [...(Array.isArray(latest.auditEvents) ? latest.auditEvents : []), event],
    updatedAt: nowIso,
  };
  return { commit, result: { ok: true, result: door.result } };
}

// ── The request ─────────────────────────────────────────────────────────────

export interface ConfirmationEmailOperatorDeps {
  now?: () => number;
  /** Order ids and closed codes only. */
  errorLog?: (line: string) => void;
  /** Tests only. Default: the ambient writer gate. */
  writer?: ConfirmationEnvelopeWriterDeps;
}

const MAX_BODY_CHARS = 4096;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const BODY_KEYS: ReadonlySet<string> = new Set(['action', 'expectedToken', 'providerMessageId', 'attestation']);

/** Parse and validate the closed body, or `null`. Reads only own string values. */
function parseDoorInput(text: string, form: boolean): DoorInput | null {
  if (text.length > MAX_BODY_CHARS) return null;
  const fields = new Map<string, string>();
  if (form) {
    for (const [key, value] of new URLSearchParams(text)) {
      if (fields.has(key)) return null;
      fields.set(key, value);
    }
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') return null;
      fields.set(key, value);
    }
  }
  for (const key of fields.keys()) if (!BODY_KEYS.has(key)) return null;

  const action = fields.get('action');
  const door = action === undefined ? undefined : DOORS.get(action);
  if (!door) return null;
  const expectedToken = fields.get('expectedToken');
  if (expectedToken === undefined || !TOKEN_RE.test(expectedToken)) return null;
  const attestation = fields.get('attestation') ?? null;
  const providerMessageId = fields.get('providerMessageId') ?? null;
  if (attestation !== door.attestation) return null;
  if (door.evidenceKind === 'provider_message_id') {
    if (providerMessageId === null || !PROVIDER_MESSAGE_ID_RE.test(providerMessageId)) return null;
  } else if (providerMessageId !== null) {
    return null;
  }
  return { action: action as ConfirmationEmailOperatorAction, expectedToken, providerMessageId };
}

const STATUS: Readonly<Record<ConfirmationEmailOperatorErrorCode, number>> = {
  bad_input: 400,
  not_held: 409,
  stale_record: 409,
  door_not_permitted: 409,
  evidence_conflict: 409,
  claim_other_kind: 409,
  reconciliation_unavailable: 409,
  unexpected: 500,
};

/**
 * `POST /api/admin/orders/[orderId]/confirmation-email`.
 *
 * Order of checks: auth (401), origin (403), order-id grammar (404) — none of
 * which reads the body or the order — then the closed body (400), then the
 * writer gate (409 `reconciliation_unavailable`, still no read), then one
 * guarded CAS. A native form gets a 303 back to the order page with a closed
 * result code; a JSON caller gets `{ ok, result }` or `{ ok: false, error }`.
 */
export async function handleConfirmationEmailOperatorRequest(
  request: Request,
  params: Promise<{ orderId: string }> | { orderId: string },
  deps: ConfirmationEmailOperatorDeps = {},
): Promise<Response> {
  if (!isAdminAuthedFromRequest(request)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const origin = request.headers.get('origin');
  let requestOrigin: string | null = null;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    requestOrigin = null;
  }
  if (origin !== null && (requestOrigin === null || origin !== requestOrigin)) {
    return Response.json({ ok: false, error: 'origin_mismatch' }, { status: 403 });
  }

  const { orderId } = await params;
  if (typeof orderId !== 'string' || !CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE.test(orderId)) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  const form = contentType.startsWith('application/x-www-form-urlencoded');
  const respond = (code: ConfirmationEmailOperatorResultCode, ok: boolean): Response => {
    if (form) {
      return new Response(null, { status: 303, headers: { location: `/admin/orders/${orderId}?confirmation=${code}` } });
    }
    return ok
      ? Response.json({ ok: true, result: code })
      : Response.json({ ok: false, error: code }, { status: STATUS[code as ConfirmationEmailOperatorErrorCode] });
  };

  let text: string;
  try {
    text = await request.text();
  } catch {
    return respond('bad_input', false);
  }
  const input = parseDoorInput(text, form);
  if (input === null) return respond('bad_input', false);

  const gate = resolveReconciliationGate(deps.writer);
  if (gate.bound === false) return respond('reconciliation_unavailable', false);

  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  let outcome: DoorCommitResult | 'not_found';
  try {
    outcome = await gate.orderIo.guardedTransact<DoorCommitResult | 'not_found'>(
      orderId,
      (latest) => decideOperatorDoor(latest, input, nowIso),
      { notFound: () => 'not_found' },
    );
  } catch (error) {
    const fault = gate.orderIo.classifyFault(error);
    if (fault !== null) {
      errorLog(`[confirmation-email-operator] door refused orderId=${orderId} reason=${fault}`);
      return respond('reconciliation_unavailable', false);
    }
    if (isVersionConflict(error)) return respond('stale_record', false);
    errorLog(`[confirmation-email-operator] door failed orderId=${orderId} errorClass=${classifyConfirmationEmailError(error)}`);
    return respond('unexpected', false);
  }
  if (outcome === 'not_found') return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  if (outcome.ok === false) return respond(outcome.refusal, false);
  return respond(outcome.result, true);
}

// ---------------------------------------------------------------------------
// The operator projection and the page's result lookup
// ---------------------------------------------------------------------------

export const CONFIRMATION_EMAIL_OPERATOR_PROJECTION_KEYS = [
  'envelope',
  'state',
  'holdReason',
  'firstDispatchIntentAt',
  'dispatchDeadlineAt',
  'acceptedAt',
  'sentAt',
  'providerMessageId',
  'from',
  'attemptCount',
  'availableDoors',
  'expectedToken',
] as const;

export interface ConfirmationEmailOperatorProjection {
  envelope: ConfirmationEmailOperatorView | null;
  state: ConfirmationEmailState | 'unrecognized' | null;
  holdReason: ConfirmationEmailHoldReason | 'unrecognized' | null;
  firstDispatchIntentAt: string | null;
  dispatchDeadlineAt: string | null;
  acceptedAt: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  from: string | null;
  attemptCount: number;
  availableDoors: ConfirmationEmailOperatorAction[];
  expectedToken: string;
}

const SENDER_IDENTITY_RE = /^[\x20-\x7E]{1,320}$/;

/**
 * The only view of a record's confirmation state an operator surface renders.
 * Every key is assigned by name from a validated value; the idempotency key,
 * the request, the customer email, the claim and the attempt history never
 * enter it.
 */
export function projectConfirmationEmailForOperator(order: OrderRecord): ConfirmationEmailOperatorProjection {
  const instant = (value: unknown) => (isCanonicalIsoInstant(value) ? value : null);
  const messageId: unknown = order.confirmationEmailProviderMessageId;
  const from: unknown = order.confirmationEmailFrom;
  const attempts = attemptsOf(order);
  return {
    envelope: projectConfirmationEmailEnvelopeRefIfValid(order.confirmationEmailEnvelopeRef, { orderId: order.id }),
    state: closedOrUnrecognized(order.confirmationEmailState, CONFIRMATION_EMAIL_STATES),
    holdReason: closedOrUnrecognized(order.confirmationEmailHoldReason, HOLD_REASONS),
    firstDispatchIntentAt: instant(order.confirmationEmailFirstDispatchIntentAt),
    dispatchDeadlineAt: instant(order.confirmationEmailDispatchDeadlineAt),
    acceptedAt: instant(order.confirmationEmailAcceptedAt),
    sentAt: instant(order.confirmationEmailSentAt),
    providerMessageId: typeof messageId === 'string' && PROVIDER_MESSAGE_ID_RE.test(messageId) ? messageId : null,
    from: typeof from === 'string' && SENDER_IDENTITY_RE.test(from) ? from : null,
    attemptCount: attempts === null ? 0 : attempts.length,
    availableDoors: CONFIRMATION_EMAIL_OPERATOR_ACTIONS.filter((action) => doorRefusal(order, action) === null),
    expectedToken: computeConfirmationEmailReconciliationToken(order),
  };
}

const RESULT_MESSAGES: ReadonlyMap<string, string> = new Map<ConfirmationEmailOperatorResultCode, string>([
  ['reconciled_accepted', 'Recorded: the provider accepted this confirmation.'],
  ['returned_to_snapshot', 'Recorded: the provider shows no acceptance. The frozen confirmation is waiting again.'],
  ['resend_attested', 'Recorded: you sent the confirmation yourself. Nothing was sent from here.'],
  ['bad_input', 'Nothing changed: the request was incomplete or malformed.'],
  ['stale_record', 'Nothing changed: this order moved since the page loaded. Reload and check again.'],
  ['not_held', 'Nothing changed: this confirmation is not on hold any more.'],
  ['door_not_permitted', 'Nothing changed: that action is not permitted for this hold.'],
  ['evidence_conflict', 'Nothing changed: that message id does not match the acceptance already recorded.'],
  ['claim_other_kind', 'Nothing changed: another email operation holds this order.'],
  ['reconciliation_unavailable', 'Nothing changed: reconciliation is not available in this deployment.'],
  ['unexpected', 'Nothing changed: something went wrong. Check the logs before retrying.'],
]);

/** A closed lookup for the page's `?confirmation=` code. Unknown → `null`. */
export function describeConfirmationEmailOperatorResult(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return RESULT_MESSAGES.get(raw) ?? null;
}
