/**
 * Durable delivery of the paid-order confirmation email.
 *
 * One implementation is shared by every entry point — the post-webhook deferred
 * scheduler and the scheduled recovery sweep — so there is exactly one claim
 * protocol and one provider identity per order. Two implementations would be
 * two ways to accept the same email.
 *
 * The protocol is: read authoritatively → claim inside the order's versioned
 * transaction (re-evaluating every invariant against the latest record) → send
 * → record the receipt under that claim. A claim is always released when the
 * send does not produce a durable receipt, so a transient provider failure
 * cannot strand the order; a worker that dies mid-send leaves its claim behind
 * and it is reclaimed only after a bounded, explicit staleness window.
 *
 * Nothing here logs a customer identifier: order ids, claim ids, and provider
 * message ids only.
 *
 * A3-4 R2: every attempt first asks the snapshot producer's W0 gate. With the
 * writer flag absent or not exactly `true` the gate is `off` and the attempt is
 * the legacy path below, unchanged. With the flag `true` (armed intent) a
 * namespace problem refuses with no send; otherwise every order read and every
 * conditional commit of the attempt runs through the bound order I/O the gate
 * returns, and an enrolled order is snapshotted instead of sent. Armed intent
 * is deliberately not compatibility-preserving: the legacy continuation it
 * takes is bound to one frozen namespace, guarded before the claim write and
 * checked again before transport.
 *
 * A3-5: only under an armed writer, and only when the frozen dispatcher also
 * arms (dispatch flag exactly `true` in the writer's supplied environment and
 * a transport injected by the caller), a record waiting for the frozen
 * dispatcher — or one this attempt has just snapshotted — is handed to it.
 * Every other path, including the legacy tail below, is unchanged.
 */
import { randomUUID } from 'node:crypto';

import {
  buildOrderConfirmationIdempotencyKey,
  getOrderSenderEmail,
  sendOrderConfirmationEmail as defaultSendOrderConfirmationEmail,
} from './order-email.ts';
import { isConfirmationEmailHeldState } from './confirmation-email-state.ts';
import {
  getOrderAuthoritative,
  withOrderTransaction,
  type OrderRecord,
  type OrderTransactionOutcome,
} from './orders.ts';
import { resolveConfirmationEnvelopeWriter, snapshotConfirmationEnvelope } from './confirmation-envelope-producer.ts';
import { dispatchFrozenConfirmation, resolveFrozenDispatcher } from './confirmation-email-dispatch.ts';
import type {
  ConfirmationFrozenDispatchDeferral,
  ConfirmationFrozenDispatchDeps,
  ConfirmationFrozenDispatchHoldReason,
  FrozenDispatcher,
} from './confirmation-email-dispatch.ts';
import type {
  BoundOrderIo,
  ConfirmationEnvelopeSnapshotDeferral,
  ConfirmationEnvelopeSnapshotHoldReason,
  ConfirmationEnvelopeWriterDeps,
  ConfirmationEnvelopeWriterGate,
} from './confirmation-envelope-producer.ts';

/** The only `emailResendClaimKind` this module will ever take or release. */
export const CONFIRMATION_EMAIL_CLAIM_KIND = 'order_confirmation' as const;

/** Bounded reclaim window for a confirmation claim whose worker never came
 *  back. Long enough that a live sender is never fenced mid-flight, short
 *  enough that a crashed one does not hold the order past the next few sweeps. */
export const CONFIRMATION_EMAIL_CLAIM_STALE_MS = 15 * 60 * 1000;

export type ConfirmationEmailBlockReason =
  | 'order_not_found'
  | 'not_paid'
  | 'refunded'
  | 'already_sent'
  | 'held_for_reconciliation'
  | 'claim_other_kind'
  | 'claim_active'
  // A3-4 R2 (fence F1): the record holds a frozen envelope that only the
  // frozen dispatcher (A3-5) may send.
  | 'awaiting_frozen_dispatch';

/** A3-5: the one block reason an opted-in sweep may admit (fence F1). */
export const CONFIRMATION_EMAIL_AWAITING_FROZEN_DISPATCH: Extract<ConfirmationEmailBlockReason, 'awaiting_frozen_dispatch'> =
  'awaiting_frozen_dispatch';

/** The only skip reasons this boundary will repeat. A provider-supplied string
 *  is untrusted input at a PII-safe log boundary, so anything else collapses to
 *  a single literal rather than being echoed. */
export const CONFIRMATION_EMAIL_SKIP_REASONS = ['missing_resend_api_key'] as const;

export type ConfirmationEmailSkipReason =
  | (typeof CONFIRMATION_EMAIL_SKIP_REASONS)[number]
  | 'unknown_skip_reason';

export function narrowConfirmationEmailSkipReason(reason: string): ConfirmationEmailSkipReason {
  return (CONFIRMATION_EMAIL_SKIP_REASONS as readonly string[]).includes(reason)
    ? (reason as ConfirmationEmailSkipReason)
    : 'unknown_skip_reason';
}

/** Why a send that the provider accepted has no durable receipt behind it.
 *  A3-5: also why a frozen dispatch's post-send outcome is not durably
 *  recorded (the write failed, or the record left the attempt). */
export type ConfirmationEmailReceiptGap = 'write_failed' | 'claim_lost';

export type ConfirmationEmailDeliveryOutcome =
  | { status: 'sent' }
  | { status: 'skipped'; reason: ConfirmationEmailSkipReason }
  | { status: 'blocked'; reason: ConfirmationEmailBlockReason }
  | { status: 'receipt_unrecorded'; reason: ConfirmationEmailReceiptGap }
  | { status: 'failed'; reason: 'send_error'; errorClass: string }
  // A3-4 R2: the envelope was frozen and committed; nothing was sent.
  | { status: 'snapshotted'; via: 'committed' | 'adopted_existing_object' | 'peer_committed' }
  // A3-4 R2: the record was moved to a reconciliation hold; nothing was sent.
  // A3-5: or the frozen dispatcher committed a hold, which is never retried.
  | { status: 'held'; reason: ConfirmationEnvelopeSnapshotHoldReason | ConfirmationFrozenDispatchHoldReason }
  // A3-4 R2: no state change and no send; a later attempt may retry.
  | { status: 'snapshot_deferred'; reason: ConfirmationEnvelopeSnapshotDeferral | ConfirmationFrozenDispatchDeferral };

export type ConfirmationEmailSendResult =
  | { skipped: true; reason: string }
  | { skipped: false; id: string };

/** The slice of `withOrderTransaction` this module uses. Declared narrowly so a
 *  test can inject a fault without reimplementing the CAS contract. */
export type OrderTransactImpl = <T>(
  orderId: string,
  mutate: (order: OrderRecord) => OrderTransactionOutcome<T>,
  opts: { notFound: () => T },
) => Promise<T>;

export interface ConfirmationEmailClaimDeps {
  transact?: OrderTransactImpl;
  now?: () => number;
  claimStaleMs?: number;
  /** The PRIMARY configured sender, read at claim time. Only ever consulted
   *  when the record carries no frozen sender yet. */
  resolveSender?: () => string;
}

export interface DeliverOrderConfirmationEmailDeps extends ConfirmationEmailClaimDeps {
  getOrder?: (orderId: string) => Promise<OrderRecord | null>;
  send?: (order: OrderRecord) => Promise<ConfirmationEmailSendResult>;
  newClaimId?: () => string;
  /** Both sinks take a pre-sanitized line and nothing else. Provider and
   *  storage errors routinely quote the recipient address, so a raw error must
   *  never be handed to a log sink from this boundary. */
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  /** A3-4 R2: the snapshot writer's supplied environment and injected
   *  adapters. Absent: the gate reads only the ambient writer flag. */
  envelopeWriter?: ConfirmationEnvelopeWriterDeps;
  /** A3-5: the frozen dispatcher's injected transport. Absent: it never arms. */
  frozenDispatch?: ConfirmationFrozenDispatchDeps;
}

/**
 * Bounded, PII-free classification of a thrown value: its error class, and only
 * when that reads like a class name. Never its message, stack, or properties —
 * a Resend or Blob failure can quote the buyer's address in any of them.
 */
export function classifyConfirmationEmailError(error: unknown): string {
  let name: string;
  try {
    name = error instanceof Error ? String(error.name) : typeof error;
  } catch {
    return 'unknown';
  }
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'unknown';
}

export type ConfirmationEmailClaimResult =
  | { ok: true; order: OrderRecord }
  | { ok: false; reason: ConfirmationEmailBlockReason };

/**
 * Pure, fail-closed predicate: may this record be claimed for a confirmation
 * send right now? Returns the blocking reason, or null when it may.
 *
 * A claim with no parsable `emailResendClaimAt` has no bound, so it is treated
 * as active forever rather than silently stolen — an operator decides.
 *
 * Reads only the record. No environment, no flag, no provider, no mutation.
 */
export function evaluateConfirmationEmailClaimability(
  order: OrderRecord,
  cfg: { nowMs: number; claimStaleMs: number },
): ConfirmationEmailBlockReason | null {
  if (order.paymentStatus !== 'paid') return 'not_paid';
  if (order.refundedAt || order.stripeRefundId || order.refundClaimId) return 'refunded';
  // Requirement R2 (architecture §3.9). `ACCEPTED` is a success, not a hold, so
  // it is deliberately absent from `CONFIRMATION_EMAIL_HELD_STATES` — which
  // leaves the receipt check below as the only thing that would stop it. A
  // record in `ACCEPTED` with no `confirmationEmailSentAt` is reachable through
  // a partial or hand-edited record, and it was claimable and re-sendable.
  //
  // Fenced on the state itself and placed BEFORE the receipt check so it cannot
  // be skipped by a missing or falsy receipt. The literal is checked against the
  // state union by `tsc`, so a misspelling is a compile error rather than a
  // silently dead branch; the held set is deliberately not modified, because it
  // is the exported hold set other callers consume.
  if (order.confirmationEmailState === 'ACCEPTED') return 'already_sent';
  if (order.confirmationEmailSentAt) return 'already_sent';
  // A record whose dispatch outcome is unknown, or whose hold an operator has
  // already resolved, is never re-claimed — by this path or any other. This
  // block is deliberately unconditional: it is what keeps a hold durable if the
  // durable-confirmation work is ever rolled back by turning its flag off, and
  // a hold that only exists while a flag is on is not a hold at all. It is also
  // evaluated ahead of the stale-claim window below, because past dispatch
  // intent an abandoned claim is exactly the case that must NOT be recovered:
  // the abandoned attempt may already have reached the provider.
  if (isConfirmationEmailHeldState(order.confirmationEmailState)) return 'held_for_reconciliation';
  // A3-4 R2 fence F1. Both states hold a frozen envelope that only the frozen
  // dispatcher (A3-5) may send; the legacy path must neither re-render it nor
  // spend PPDF's single modelled retry. Unconditional, like the hold above,
  // and ahead of the claim checks, so no stale claim can reopen either state.
  if (order.confirmationEmailState === 'SNAPSHOTTED'
      || order.confirmationEmailState === 'PROVABLY_PRE_DISPATCH_FAILED') return 'awaiting_frozen_dispatch';
  if (order.emailResendClaimId) {
    if (order.emailResendClaimKind !== CONFIRMATION_EMAIL_CLAIM_KIND) return 'claim_other_kind';
    const claimedAtMs = order.emailResendClaimAt ? Date.parse(order.emailResendClaimAt) : Number.NaN;
    if (!Number.isFinite(claimedAtMs)) return 'claim_active';
    if (cfg.nowMs - claimedAtMs < cfg.claimStaleMs) return 'claim_active';
  }
  return null;
}

/**
 * Freeze the provider identity for this order, exactly once.
 *
 * First claim: the PRIMARY configured sender and the deterministic per-order
 * key. Every claim after that — an ordinary retry, or a takeover of a claim
 * abandoned past the stale window — carries the stored pair forward untouched,
 * even when `HSB_EMAIL_FROM` has since changed. That is the whole point: a
 * previous attempt may already have had its message accepted under the old
 * pair, and Resend can only collapse a re-send onto it if both halves match.
 */
function freezeConfirmationEmailIdentity(
  order: OrderRecord,
  resolveSender: () => string,
): { confirmationEmailFrom: string; confirmationEmailIdempotencyKey: string } {
  return {
    confirmationEmailFrom: order.confirmationEmailFrom || resolveSender(),
    confirmationEmailIdempotencyKey:
      order.confirmationEmailIdempotencyKey || buildOrderConfirmationIdempotencyKey(order),
  };
}

/**
 * Take the confirmation claim, or report why not. Every invariant is
 * re-evaluated against the record inside the transaction, so a snapshot that
 * has since been refunded, confirmed, or re-claimed by a live worker aborts.
 *
 * The same transaction is where the immutable provider identity is initialized,
 * so the claim and the identity it will send under are committed together —
 * there is no window in which a worker holds a claim with no identity, or an
 * identity nobody may send under.
 */
export async function claimConfirmationEmail(
  orderId: string,
  claimId: string,
  deps: ConfirmationEmailClaimDeps = {},
): Promise<ConfirmationEmailClaimResult> {
  const transact = deps.transact ?? withOrderTransaction;
  const nowMs = (deps.now ?? Date.now)();
  const claimStaleMs = deps.claimStaleMs ?? CONFIRMATION_EMAIL_CLAIM_STALE_MS;
  const resolveSender = deps.resolveSender ?? getOrderSenderEmail;
  const now = new Date(nowMs).toISOString();

  return transact<ConfirmationEmailClaimResult>(
    orderId,
    (latest): OrderTransactionOutcome<ConfirmationEmailClaimResult> => {
      const blocked = evaluateConfirmationEmailClaimability(latest, { nowMs, claimStaleMs });
      if (blocked) return { abort: { ok: false, reason: blocked } };
      const claimed: OrderRecord = {
        ...latest,
        ...freezeConfirmationEmailIdentity(latest, resolveSender),
        emailResendClaimId: claimId,
        emailResendClaimKind: CONFIRMATION_EMAIL_CLAIM_KIND,
        emailResendClaimArtifact: latest.stripeSessionId ?? latest.id,
        emailResendClaimAt: now,
        updatedAt: now,
      };
      return { commit: claimed, result: { ok: true, order: claimed } };
    },
    { notFound: () => ({ ok: false, reason: 'order_not_found' }) },
  );
}

/** Drop our own claim. Returns false — changing nothing — if the claim is no
 *  longer ours, so a fenced worker can never release a live one. */
export async function releaseConfirmationEmailClaim(
  orderId: string,
  claimId: string,
  deps: ConfirmationEmailClaimDeps = {},
): Promise<boolean> {
  const transact = deps.transact ?? withOrderTransaction;
  const now = new Date((deps.now ?? Date.now)()).toISOString();

  return transact<boolean>(
    orderId,
    (latest) => {
      if (latest.emailResendClaimId !== claimId) return { abort: false };
      return {
        commit: {
          ...latest,
          emailResendClaimId: null,
          emailResendClaimKind: null,
          emailResendClaimArtifact: null,
          emailResendClaimAt: null,
          updatedAt: now,
        },
        result: true,
      };
    },
    { notFound: () => false },
  );
}

/** Record the durable receipt and release the claim in one commit. Returns
 *  false if the claim is no longer ours; the record is then owned by whoever
 *  holds it and is left untouched. */
export async function recordConfirmationEmailReceipt(
  orderId: string,
  claimId: string,
  deps: ConfirmationEmailClaimDeps = {},
): Promise<boolean> {
  const transact = deps.transact ?? withOrderTransaction;
  const now = new Date((deps.now ?? Date.now)()).toISOString();

  return transact<boolean>(
    orderId,
    (latest) => {
      if (latest.emailResendClaimId !== claimId) return { abort: false };
      return {
        commit: {
          ...latest,
          confirmationEmailSentAt: now,
          emailResendClaimId: null,
          emailResendClaimKind: null,
          emailResendClaimArtifact: null,
          emailResendClaimAt: null,
          updatedAt: now,
        },
        result: true,
      };
    },
    { notFound: () => false },
  );
}

/** How one attempt reads and commits the order record. */
interface DeliveryOrderIo {
  read: (orderId: string) => Promise<OrderRecord | null>;
  /** The claim. */
  claimTransact: OrderTransactImpl | undefined;
  /** The receipt, and the release after a send error, a skip or a lost receipt. */
  postTransportTransact: OrderTransactImpl | undefined;
  /** CK-T, armed intent only: a pure check immediately before transport. */
  beforeTransport?: () => 'namespace_drift' | null;
}

/**
 * Claim → send → receipt for exactly one order. Safe to call concurrently with
 * itself and with the post-webhook scheduler: at most one caller holds the
 * claim, and the provider identity is frozen on the record at the first claim,
 * so a retry after a lost receipt write re-presents the same sender AND the
 * same key — which is what lets Resend collapse it onto the message it may
 * already have accepted, instead of sending a second confirmation.
 *
 * A3-4 R2: the W0 gate decides first. `off` is the legacy path, unchanged;
 * `refused` ends the attempt with no read and no send; `disarmed` and `armed`
 * run the same claim protocol bound to the gate's order I/O, and `armed`
 * snapshots an enrolled order instead of sending it.
 */
export async function deliverOrderConfirmationEmail(
  orderId: string,
  deps: DeliverOrderConfirmationEmailDeps = {},
): Promise<ConfirmationEmailDeliveryOutcome> {
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const gate = resolveConfirmationEnvelopeWriter(deps.envelopeWriter);

  switch (gate.kind) {
    case 'off':
      return runConfirmationEmailDelivery(orderId, deps, {
        read: deps.getOrder ?? getOrderAuthoritative,
        claimTransact: deps.transact,
        postTransportTransact: deps.transact,
      }, null);
    case 'refused':
      errorLog(`[confirmation-envelope] deferred orderId=${orderId} reason=${gate.reason}`);
      return { status: 'snapshot_deferred', reason: gate.reason };
    case 'disarmed':
      if (gate.reason !== 'flag_off') {
        errorLog(`[confirmation-envelope] writer disarmed orderId=${orderId} reason=${gate.reason}`);
      }
      return runBoundConfirmationEmailDelivery(orderId, deps, gate.orderIo, null);
    case 'armed':
      return runBoundConfirmationEmailDelivery(
        orderId,
        deps,
        gate.orderIo,
        gate,
        resolveFrozenDispatcher(deps.envelopeWriter?.env, deps.frozenDispatch, gate),
      );
  }
}

/**
 * Armed intent: the same orchestrator over the bound order I/O. Under armed
 * intent `deps.getOrder` and `deps.transact` are never called. A namespace
 * fault raised before transport — a provenance mismatch on the read or the
 * claim, or CK-G refusing the claim write — ends the attempt with no send.
 * Anything else propagates exactly as it does today.
 */
async function runBoundConfirmationEmailDelivery(
  orderId: string,
  deps: DeliverOrderConfirmationEmailDeps,
  orderIo: BoundOrderIo,
  armedGate: Extract<ConfirmationEnvelopeWriterGate, { kind: 'armed' }> | null,
  dispatcher: FrozenDispatcher | null = null,
): Promise<ConfirmationEmailDeliveryOutcome> {
  try {
    return await runConfirmationEmailDelivery(orderId, deps, {
      read: orderIo.read,
      claimTransact: orderIo.guardedTransact,
      postTransportTransact: orderIo.postTransportTransact,
      beforeTransport: orderIo.beforeTransport,
    }, armedGate, dispatcher);
  } catch (error) {
    const fault = orderIo.classifyFault(error);
    if (fault === null) throw error;
    (deps.errorLog ?? ((line: string) => console.error(line)))(
      `[confirmation-envelope] deferred orderId=${orderId} reason=${fault}`,
    );
    return { status: 'snapshot_deferred', reason: fault };
  }
}

/** The one claim protocol, parameterized by how the order is read and committed. */
async function runConfirmationEmailDelivery(
  orderId: string,
  deps: DeliverOrderConfirmationEmailDeps,
  io: DeliveryOrderIo,
  armedGate: Extract<ConfirmationEnvelopeWriterGate, { kind: 'armed' }> | null,
  dispatcher: FrozenDispatcher | null = null,
): Promise<ConfirmationEmailDeliveryOutcome> {
  const send = deps.send ?? defaultSendOrderConfirmationEmail;
  const newClaimId = deps.newClaimId ?? randomUUID;
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const claimDeps: ConfirmationEmailClaimDeps = {
    transact: io.claimTransact,
    now: deps.now,
    claimStaleMs: deps.claimStaleMs,
    resolveSender: deps.resolveSender,
  };
  const postTransportDeps: ConfirmationEmailClaimDeps = { ...claimDeps, transact: io.postTransportTransact };
  const nowMs = (deps.now ?? Date.now)();
  const claimStaleMs = deps.claimStaleMs ?? CONFIRMATION_EMAIL_CLAIM_STALE_MS;

  const observed = await io.read(orderId);
  if (!observed) return { status: 'blocked', reason: 'order_not_found' };
  const preBlocked = evaluateConfirmationEmailClaimability(observed, { nowMs, claimStaleMs });
  // A3-5: a dispatcher is armed only under an armed writer.
  const dispatchFrozen = (armed: Extract<FrozenDispatcher, { kind: 'armed' }>) => dispatchFrozenConfirmation(orderId, armed, {
    nowMs,
    claimStaleMs,
    evaluateClaimability: (order) => evaluateConfirmationEmailClaimability(order, { nowMs, claimStaleMs }),
    newClaimId,
    newAttemptId: randomUUID,
    log,
    errorLog,
  });
  if (preBlocked === CONFIRMATION_EMAIL_AWAITING_FROZEN_DISPATCH && dispatcher?.kind === 'armed') return dispatchFrozen(dispatcher);
  if (preBlocked) return { status: 'blocked', reason: preBlocked };

  if (armedGate) {
    let produced: Awaited<ReturnType<typeof snapshotConfirmationEnvelope>>;
    try {
      produced = await snapshotConfirmationEnvelope(observed, armedGate, {
        nowMs,
        evaluateClaimability: (order) => evaluateConfirmationEmailClaimability(order, { nowMs, claimStaleMs }),
        resolveSender: deps.resolveSender,
      });
    } catch {
      // The producer never throws; if it ever did, nothing was sent and the
      // attempt ends on a closed code.
      produced = { status: 'snapshot_deferred', reason: 'unexpected' };
    }
    switch (produced.status) {
      case 'not_enrolled':
        break;
      case 'snapshotted':
        log(`[confirmation-envelope] snapshotted orderId=${orderId} via=${produced.via}`);
        if (dispatcher?.kind === 'armed') return dispatchFrozen(dispatcher);
        return { status: 'snapshotted', via: produced.via };
      case 'held':
        errorLog(`[confirmation-envelope] held orderId=${orderId} reason=${produced.reason} cause=${produced.cause}`);
        return { status: 'held', reason: produced.reason };
      case 'blocked':
        return { status: 'blocked', reason: produced.reason };
      case 'snapshot_deferred':
        errorLog(`[confirmation-envelope] deferred orderId=${orderId} reason=${produced.reason}`);
        return { status: 'snapshot_deferred', reason: produced.reason };
    }
  }

  const claimId = newClaimId();
  const claim = await claimConfirmationEmail(orderId, claimId, claimDeps);
  if (claim.ok === false) return { status: 'blocked', reason: claim.reason };

  // CK-T (armed intent only). A drift seen here sends nothing and writes
  // nothing further — no release, no receipt: the claim stays, and the
  // bounded stale-claim window recovers it.
  const drift = io.beforeTransport?.() ?? null;
  if (drift !== null) {
    errorLog(`[confirmation-envelope] deferred orderId=${orderId} reason=${drift}`);
    return { status: 'snapshot_deferred', reason: drift };
  }

  const release = async (context: string) => {
    try {
      await releaseConfirmationEmailClaim(orderId, claimId, postTransportDeps);
    } catch (error) {
      // The claim stays behind; the bounded stale window is what recovers it.
      errorLog(
        `[confirmation-email] claim release failed orderId=${orderId} after=${context}`
          + ` errorClass=${classifyConfirmationEmailError(error)}`,
      );
    }
  };

  let result: ConfirmationEmailSendResult;
  try {
    result = await send(claim.order);
  } catch (error) {
    const errorClass = classifyConfirmationEmailError(error);
    await release('send_error');
    errorLog(`[confirmation-email] send failed orderId=${orderId} errorClass=${errorClass}`);
    return { status: 'failed', reason: 'send_error', errorClass };
  }

  if (result.skipped === true) {
    const reason = narrowConfirmationEmailSkipReason(result.reason);
    await release('send_skipped');
    log(`[confirmation-email] send skipped orderId=${orderId} reason=${reason}`);
    return { status: 'skipped', reason };
  }
  const providerMessageId = result.id;

  // Past this point the provider has accepted the message. The attempt is only
  // a success once that acceptance is durably recorded — reporting "sent"
  // without a receipt would hide an order from both the operator and the next
  // sweep. Retrying is safe because the frozen sender+key are re-presented
  // verbatim: Resend collapses the re-send onto the message it already accepted.
  let recorded = false;
  try {
    recorded = await recordConfirmationEmailReceipt(orderId, claimId, postTransportDeps);
  } catch (error) {
    errorLog(
      `[confirmation-email] receipt write failed orderId=${orderId} providerMessageId=${providerMessageId}`
        + ` errorClass=${classifyConfirmationEmailError(error)}`,
    );
    // Best effort: hand the order straight back by dropping OUR claim (the
    // release is a no-op against anyone else's). If that write fails too, the
    // claim stays and the bounded stale window is the fallback.
    await release('receipt_write_failed');
    return { status: 'receipt_unrecorded', reason: 'write_failed' };
  }
  if (!recorded) {
    // The claim moved on while the send was in flight, so the receipt is not
    // ours to write and the live claim is left exactly as it is.
    errorLog(
      `[confirmation-email] receipt not recorded orderId=${orderId} providerMessageId=${providerMessageId}`
        + ' reason=claim_lost',
    );
    return { status: 'receipt_unrecorded', reason: 'claim_lost' };
  }
  log(`[confirmation-email] delivered orderId=${orderId} providerMessageId=${providerMessageId}`);
  return { status: 'sent' };
}
