/**
 * `/api/order` on the direct private-intake path.
 *
 * THE ORDER OF OPERATIONS IS THE FEATURE
 * --------------------------------------
 *   finalize the intake  →  create-only persist  →  mark the intake finalized
 *   →  RENEW the exact lease  →  Stripe Checkout Session  →  record the created
 *   session id durably  →  bind the session under the exact lease
 *
 * The renewal is not bookkeeping. Between the durable commit and the provider
 * call there is at least one await, and the lease can be lost inside it — so
 * ownership is re-proved ATOMICALLY immediately before an unbound Session is
 * created, and proved AGAIN by the binder immediately after. A worker that has
 * lost the lease creates nothing, binds nothing and releases nothing.
 *
 * The durable candidate closes the other half. Refusing after a successful
 * create is safe for the buyer but not free: the provider's idempotency
 * retention is finite, so a later retry would create a SECOND payable Session.
 * The created id is therefore persisted create-only before anything else may
 * fail, and an authoritative retry resumes that exact id.
 *
 * Every earlier step is a commit the buyer can be held to, so each one has to
 * be provably done before the next begins. In particular the Checkout Session
 * is created only after the exact prepared order is durable AND has passed
 * whole-order reconciliation — a customer must never be able to pay for an
 * order that does not exist, or for one bound to different media than the
 * finalization that was reserved on their behalf.
 *
 * Everything after "the durable order exists" is either non-essential (the
 * recovery-lead conversion) or fails closed WITHOUT releasing a checkout URL.
 * A refusal here leaves a pending order and a reserved intake behind on
 * purpose: cleanup's authoritative reconciliation is what resolves them, and
 * it can only do that if we did not guess.
 *
 * The raw capability is a parameter and never a field. It is not written into
 * the draft, the prepared order, the response, or any log line; the saga
 * additionally scans the prepared bytes for it before persistence.
 */
import {
  runPreparedIntakeOrderBinding,
  type AuthoritativeOrderLookup,
  type CreateIfAbsentOrderResult,
  type PreparedIntakeOrderBindingDependencies,
} from './checkout-intake-order-binding.ts';
import type { DirectIntakeOrderRequest } from './checkout-direct-order-request.ts';
import { abortIntakeFinalization, finalizeIntakeSelection } from './checkout-finalize.ts';
import { markIntakeFinalized, type IntakeStore } from './checkout-intake.ts';
import {
  getOrderAuthoritative,
  persistNewOrder,
  readCheckoutSessionCandidate,
  requiresDurablePersistence,
  sanitizeFamilyCharacters,
  type FamilyCharacter,
  type OrderRecord,
} from './orders.ts';

export interface DirectCheckoutSessionRequest {
  order: OrderRecord;
  stripeProductId: string;
  baseUrl: string;
  gaClientId: string | null;
  idempotencyKey: string;
}

export interface DirectCheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired' | null;
}

export interface DirectIntakeCheckoutDeps {
  binding: PreparedIntakeOrderBindingDependencies;
  createCheckoutSession(request: DirectCheckoutSessionRequest): Promise<DirectCheckoutSession>;
  retrieveCheckoutSession(sessionId: string): Promise<DirectCheckoutSession>;
  /**
   * Atomically re-prove ownership of the EXACT lease/fingerprint and extend it.
   * Must fail (null) on expiry, takeover, a claimed retention, a settled
   * payment, or an order that has moved on. Wired to orders.renewCheckoutLease.
   */
  renewCheckoutLease(
    orderId: string,
    checkoutLeaseId: string,
    checkoutFingerprint: string,
  ): Promise<OrderRecord | null>;
  /** Create-only durable record of a Session created but not yet bound. */
  recordCheckoutSessionCandidate(
    orderId: string,
    stripeSessionId: string,
    checkout: { checkoutAttemptId: string; fingerprint: string },
  ): Promise<OrderRecord | null>;
  bindCheckoutSession(
    orderId: string,
    stripeSessionId: string,
    checkout: { leaseId: string; fingerprint: string },
  ): Promise<OrderRecord | null>;
  /** Non-essential. Runs only after the durable commit, and never blocks it. */
  markRecoveryLeadConverted?(email: string, orderId: string): Promise<unknown> | void;
  logError?(message: string, detail?: unknown): void;
}

export interface DirectIntakeCheckoutParams {
  /** Complete non-media order, built by the same code legacy checkout uses. */
  draftOrder: OrderRecord;
  request: DirectIntakeOrderRequest;
  stripeProductId: string;
  baseUrl: string;
  gaClientId: string | null;
}

export type DirectIntakeCheckoutResult =
  | { status: 'redirect'; redirectTo: string; order: OrderRecord }
  | { status: 'refused'; httpStatus: number; code: string; error: string };

const NO_CHARGE_RETRY =
  'We could not securely save your order. No charge was made. Please retry in a moment, and contact support@herostorybooks.com if it keeps happening.';
const MEDIA_MOVED =
  'Your photos changed while we were starting checkout. No charge was made — please review your photos and try again.';
const RECONCILIATION_REQUIRED =
  'Checkout requires reconciliation. No checkout link was released and no charge was made.';
const ATTEMPT_ALREADY_RESOLVED =
  'This checkout attempt is already in progress or has already reached payment. No new charge was made — reload the page to start a fresh attempt, and contact support@herostorybooks.com if you were charged.';

/**
 * HTTP status for a finalization refusal.
 *
 * The saga reports the intake error CODE but not its status, so the mapping
 * lives here. Anything unrecognised is a 400 rather than a 500: an unmapped
 * refusal is still a refusal the buyer can act on, and it must not read as an
 * outage the customer should retry into.
 */
const FINALIZE_STATUS: Readonly<Record<string, number>> = {
  intake_forbidden: 403,
  intake_expired: 410,
  intake_not_found: 404,
  asset_not_current: 409,
  asset_metadata_changed: 409,
  asset_prefix_mismatch: 403,
  intake_replacement_pending: 409,
  intake_already_finalized: 409,
  intake_finalization_conflict: 409,
  intake_finalization_reconciliation_required: 409,
  intake_cleanup_in_progress: 409,
  intake_store_unavailable: 503,
  intake_record_invalid: 503,
  intake_record_too_large: 503,
  intake_finalization_unavailable: 503,
};

function refused(httpStatus: number, code: string, error: string): DirectIntakeCheckoutResult {
  return { status: 'refused', httpStatus, code, error };
}

/**
 * The production dependency set for the saga.
 *
 * `persistNewOrder` deliberately reports only `created` or `ambiguous`: a
 * throwing create is never provably a no-write, so the saga's own
 * authoritative read — not a guess made here — decides between an exact
 * resumable order, a provable absence, and uncertainty.
 */
export function buildDirectIntakeBindingDependencies(
  store: IntakeStore,
  now: () => Date = () => new Date(),
): PreparedIntakeOrderBindingDependencies {
  return {
    finalizeIntake: (params) => finalizeIntakeSelection(store, params, now()),
    async persistNewOrder(order): Promise<CreateIfAbsentOrderResult> {
      try {
        return { status: 'created', order: await persistNewOrder(order) };
      } catch {
        return { status: 'ambiguous' };
      }
    },
    async readOrder(orderId): Promise<AuthoritativeOrderLookup> {
      try {
        const order = await getOrderAuthoritative(orderId);
        if (order) return { status: 'found', order };
        // A MISS is only authoritative absence when the durable store is what
        // answered. Outside a production-like environment `getOrderAuthoritative`
        // degrades to a local-filesystem read after a failed remote read, and
        // treating that miss as proof would release the buyer's private media
        // for an order that may well exist.
        return requiresDurablePersistence() ? { status: 'absent' } : { status: 'unknown' };
      } catch {
        return { status: 'unknown' };
      }
    },
    markIntakeFinalized: (params) => markIntakeFinalized(store, params, now()),
    abortIntakeFinalization: (params) => abortIntakeFinalization(store, params, now()),
  };
}

/**
 * Marks the family characters this order is about to bind private media to.
 *
 * Derived from the REQUEST rather than from the finalization result, because
 * `likenessIntent` is part of the order contract that has to exist before the
 * order is prepared — and it must be identical on an idempotent retry, or the
 * whole-order reconciliation would refuse a legitimate resume.
 */
function withReferenceLikeness(
  draftOrder: OrderRecord,
  request: DirectIntakeOrderRequest,
): FamilyCharacter[] | null {
  const characters = sanitizeFamilyCharacters(draftOrder.familyCharacters);
  if (characters.length !== request.familyCharacterIds.length) return null;
  const bound = new Set(request.selection.familyCharacterAssets.map((entry) => entry.familyCharacterId));
  return characters.map((character, index) => (
    bound.has(request.familyCharacterIds[index]!)
      ? { ...character, likenessIntent: 'reference' as const }
      : character
  ));
}

export async function runDirectIntakeCheckout(
  params: DirectIntakeCheckoutParams,
  deps: DirectIntakeCheckoutDeps,
): Promise<DirectIntakeCheckoutResult> {
  const { request } = params;
  const log = deps.logError ?? (() => {});

  if (params.draftOrder.checkoutAttemptId !== request.checkoutAttemptId) {
    return refused(400, 'direct_intake_checkout_attempt_mismatch', NO_CHARGE_RETRY);
  }
  const familyCharacters = withReferenceLikeness(params.draftOrder, request);
  if (!familyCharacters) {
    // The declared stable ids must line up 1:1 with the family list the order
    // record actually holds, or an index-based binding would name the wrong
    // person. Refused before any intake reservation is spent.
    return refused(400, 'direct_intake_family_identity_mismatch', NO_CHARGE_RETRY);
  }

  const draftOrder: OrderRecord = { ...params.draftOrder, familyCharacters };

  const bound = await runPreparedIntakeOrderBinding({
    draftOrder,
    intakeId: request.intakeId,
    capability: request.capability,
    selection: request.selection,
    familyCharacterIds: request.familyCharacterIds,
  }, deps.binding);

  switch (bound.status) {
    case 'committed':
      break;
    case 'intake_finalize_failed':
      log(`[order] ABORT BEFORE STRIPE: intake finalization refused for ${bound.orderId}: ${bound.code}`);
      return refused(FINALIZE_STATUS[bound.code] ?? 400, bound.code, MEDIA_MOVED);
    case 'preparation_failed':
      log(`[order] ABORT BEFORE STRIPE: direct order preparation failed for ${bound.orderId}: ${bound.code}`);
      return refused(400, 'direct_intake_preparation_failed', NO_CHARGE_RETRY);
    case 'order_conflict':
      // Either a foreign order already owns this id, or this attempt's own
      // order has moved past the pre-Stripe state it would have to be resumed
      // from (a bound Session, a settled payment, a claimed retention). Both
      // are refusals: this request may not re-release a checkout URL.
      log(`[order] ABORT BEFORE STRIPE: durable order conflicts with the prepared binding for ${bound.orderId}`);
      return refused(409, 'direct_intake_order_conflict', ATTEMPT_ALREADY_RESOLVED);
    case 'order_persistence_failed':
      log(
        `[order] ABORT BEFORE STRIPE: durable order persistence failed for ${bound.orderId} `
        + `(reconciliation=${bound.reconciliation}, reservation=${bound.reservation})`,
      );
      return refused(503, 'direct_intake_order_persist_failed', NO_CHARGE_RETRY);
    case 'intake_mark_pending':
      // The order IS durable. Refusing here leaves it for the authoritative
      // reconciliation sweep rather than charging against an intake that does
      // not yet know which order owns its media.
      log(`[order] ABORT BEFORE STRIPE: intake acknowledgement pending for ${bound.order.id}`);
      return refused(503, 'direct_intake_mark_pending', NO_CHARGE_RETRY);
    default:
      return refused(503, 'direct_intake_binding_unrecognised', NO_CHARGE_RETRY);
  }

  const order = bound.order;
  if (!order.checkoutLeaseId || !order.checkoutFingerprint) {
    log(`[order] ABORT BEFORE STRIPE: durable order ${order.id} has no checkout lease to bind against`);
    return refused(503, 'direct_intake_checkout_lease_missing', RECONCILIATION_REQUIRED);
  }

  // Non-essential, and strictly after the safety-critical commit.
  try {
    const pending = deps.markRecoveryLeadConverted?.(order.email, order.id);
    if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
      (pending as Promise<unknown>).catch(() => {});
    }
  } catch {
    // A recovery-lead bookkeeping failure must never affect checkout.
  }

  // ── The already-bound path is unchanged ────────────────────────────────
  // This attempt's Session was durably bound under an exact lease in an
  // earlier request, so the binder has already fenced it. Retrieval is a call
  // ABOUT a bound Session, not an unbound creation, and it can release only the
  // one id the order itself names.
  if (order.stripeSessionId) {
    let session: DirectCheckoutSession;
    try {
      session = await deps.retrieveCheckoutSession(order.stripeSessionId);
    } catch (error) {
      log(`[order] Stripe Checkout Session retrieval failed for ${order.id}`, error);
      return refused(503, 'direct_intake_session_retrieve_failed', NO_CHARGE_RETRY);
    }
    if (session.status !== 'open') {
      log(`[order] Stripe Session ${session.id} for ${order.id} is not open`);
      return refused(409, 'direct_intake_session_not_open', RECONCILIATION_REQUIRED);
    }
    if (session.id !== order.stripeSessionId || !session.url) {
      log(`[order] Existing Stripe Session reconciliation failed for ${order.id}`);
      return refused(503, 'direct_intake_session_reconciliation_failed', RECONCILIATION_REQUIRED);
    }
    return { status: 'redirect', redirectTo: session.url, order };
  }

  // ── Renew the exact lease IMMEDIATELY before the unbound provider call ──
  // Everything above — the persist, the intake acknowledgement, the recovery
  // lead — is an intervening await, and the lease can be lost in any of them.
  // The durable order existing is not authority to create something payable,
  // so ownership is re-proved atomically here, with nothing awaited in between.
  let current: OrderRecord | null;
  try {
    current = await deps.renewCheckoutLease(
      order.id,
      order.checkoutLeaseId,
      order.checkoutFingerprint,
    );
  } catch (error) {
    log(`[order] ABORT BEFORE STRIPE: checkout lease renewal failed for ${order.id}`, error);
    current = null;
  }
  if (!current) {
    // Expired, stolen, retention claimed, or the order moved on. Refuse BEFORE
    // the provider: zero Sessions created, no URL, nothing bound.
    log(`[order] ABORT BEFORE STRIPE: checkout lease no longer held for ${order.id}`);
    return refused(409, 'direct_intake_checkout_lease_lost', ATTEMPT_ALREADY_RESOLVED);
  }
  if (!current.checkoutLeaseId || !current.checkoutFingerprint || !current.checkoutAttemptId) {
    log(`[order] ABORT BEFORE STRIPE: renewed order ${order.id} carries no checkout identity`);
    return refused(503, 'direct_intake_checkout_lease_missing', RECONCILIATION_REQUIRED);
  }

  // The renewal result is the freshest authoritative record, so it — not the
  // copy read before those awaits — decides whether a Session already exists.
  const candidate = readCheckoutSessionCandidate(current);
  if (candidate.status === 'invalid') {
    log(`[order] ABORT BEFORE STRIPE: unusable Checkout Session candidate on ${order.id}`);
    return refused(409, 'direct_intake_session_candidate_invalid', RECONCILIATION_REQUIRED);
  }

  let session: DirectCheckoutSession;
  if (candidate.status === 'resumable') {
    // A previous attempt created this Session but could not bind it. Resuming
    // it is mandatory, not an optimisation: creating again once the provider's
    // idempotency retention has lapsed would mint a SECOND payable Session.
    const { stripeSessionId } = candidate.candidate;
    try {
      session = await deps.retrieveCheckoutSession(stripeSessionId);
    } catch (error) {
      log(`[order] Stripe Checkout Session retrieval failed for ${order.id}`, error);
      return refused(503, 'direct_intake_session_retrieve_failed', NO_CHARGE_RETRY);
    }
    if (session.id !== stripeSessionId) {
      log(`[order] Stripe returned ${session.id} for candidate ${stripeSessionId} on ${order.id}`);
      return refused(503, 'direct_intake_session_candidate_mismatch', RECONCILIATION_REQUIRED);
    }
  } else {
    try {
      session = await deps.createCheckoutSession({
        order: current,
        stripeProductId: params.stripeProductId,
        baseUrl: params.baseUrl,
        gaClientId: params.gaClientId,
        // Deterministic per order, so a retry inside the provider's retention
        // window returns this exact Session rather than a second one.
        idempotencyKey: `hsb_checkout_${order.id}`,
      });
    } catch (error) {
      log(`[order] Stripe Checkout Session creation failed for ${order.id}`, error);
      return refused(503, 'direct_intake_session_create_failed', NO_CHARGE_RETRY);
    }

    // Durable BEFORE anything else may fail. From here the Session exists at
    // the provider whatever happens next, and only this record lets a later
    // retry reconcile it instead of creating another payable one.
    let recorded: OrderRecord | null;
    try {
      recorded = await deps.recordCheckoutSessionCandidate(order.id, session.id, {
        checkoutAttemptId: current.checkoutAttemptId,
        fingerprint: current.checkoutFingerprint,
      });
    } catch (error) {
      log(`[order] Checkout Session candidate persistence failed for ${order.id}`, error);
      recorded = null;
    }
    if (!recorded) {
      // No durable evidence, so nothing may be released on the strength of it.
      // A safe retry finds no candidate and calls the provider again — but
      // under the same deterministic idempotency key, so within the retention
      // window it recovers this exact Session rather than minting another.
      log(`[order] Stripe Session ${session.id} created but not durably recorded for ${order.id}`);
      return refused(503, 'direct_intake_session_candidate_persist_failed', NO_CHARGE_RETRY);
    }
  }

  if (session.status !== 'open') {
    log(`[order] Stripe Session ${session.id} for ${order.id} is not open`);
    return refused(409, 'direct_intake_session_not_open', RECONCILIATION_REQUIRED);
  }

  // The binder re-proves the exact ACTIVE, UNEXPIRED lease one last time. A
  // Session that came back after the lease was lost is refused here: this
  // worker exposes nothing and binds nothing, and the candidate above is what
  // an authoritative retry uses to finish the job.
  const boundSession = await deps.bindCheckoutSession(order.id, session.id, {
    leaseId: current.checkoutLeaseId,
    fingerprint: current.checkoutFingerprint,
  });
  if (!boundSession) {
    log(`[order] Stripe Session ${session.id} created but durable binding failed for ${order.id}`);
    return refused(503, 'direct_intake_session_bind_failed', RECONCILIATION_REQUIRED);
  }
  if (!session.url) {
    log(`[order] Stripe Session ${session.id} for ${order.id} carried no checkout URL`);
    return refused(503, 'direct_intake_session_url_missing', RECONCILIATION_REQUIRED);
  }

  return { status: 'redirect', redirectTo: session.url, order: boundSession };
}
