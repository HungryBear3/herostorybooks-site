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
  requiresDurablePersistence,
  sanitizeFamilyCharacters,
  type FamilyCharacter,
  type OrderRecord,
} from './orders.ts';
import {
  CHECKOUT_ATTEMPT_ALREADY_RESOLVED,
  CHECKOUT_NO_CHARGE_RETRY,
  CHECKOUT_RECONCILIATION_NO_CHARGE,
  provisionCheckoutSession,
  type CheckoutSessionProvisionDeps,
  type ProviderCheckoutSession,
  type ProviderCheckoutSessionRequest,
} from './checkout-session-provisioning.ts';

/** Structural aliases; the provider contract now lives with the shared machine. */
export type DirectCheckoutSessionRequest = ProviderCheckoutSessionRequest;
export type DirectCheckoutSession = ProviderCheckoutSession;

export interface DirectIntakeCheckoutDeps extends CheckoutSessionProvisionDeps {
  binding: PreparedIntakeOrderBindingDependencies;
  /** Non-essential. Runs only after the durable commit, and never blocks it. */
  markRecoveryLeadConverted?(email: string, orderId: string): Promise<unknown> | void;
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

const NO_CHARGE_RETRY = CHECKOUT_NO_CHARGE_RETRY;
const MEDIA_MOVED =
  'Your photos changed while we were starting checkout. No charge was made — please review your photos and try again.';
const RECONCILIATION_REQUIRED = CHECKOUT_RECONCILIATION_NO_CHARGE;
const ATTEMPT_ALREADY_RESOLVED = CHECKOUT_ATTEMPT_ALREADY_RESOLVED;

/**
 * The shared provisioning codes, renamed into this path's stable vocabulary.
 *
 * The `direct_intake_*` codes are already in customer support runbooks and in
 * the checkout page's error mapper, so the shared machine reports neutral codes
 * and they are translated here rather than churning the public surface.
 */
const DIRECT_INTAKE_CODE: Readonly<Record<string, string>> = {
  checkout_lease_lost: 'direct_intake_checkout_lease_lost',
  checkout_session_identity_missing: 'direct_intake_checkout_lease_missing',
  checkout_session_candidate_invalid: 'direct_intake_session_candidate_invalid',
  checkout_session_create_failed: 'direct_intake_session_create_failed',
  checkout_session_retrieve_failed: 'direct_intake_session_retrieve_failed',
  checkout_session_candidate_persist_failed: 'direct_intake_session_candidate_persist_failed',
  checkout_session_candidate_mismatch: 'direct_intake_session_candidate_mismatch',
  checkout_session_reconciliation_failed: 'direct_intake_session_reconciliation_failed',
  checkout_session_complete: 'direct_intake_session_complete',
  checkout_session_not_open: 'direct_intake_session_not_open',
  checkout_session_supersede_failed: 'direct_intake_session_supersede_failed',
  checkout_session_supersede_limit: 'direct_intake_session_supersede_limit',
  checkout_session_bind_failed: 'direct_intake_session_bind_failed',
  checkout_session_url_missing: 'direct_intake_session_url_missing',
};

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

  // ── Hand off to the shared provider-Session state machine ─────────────
  // The direct and legacy paths must hold the SAME invariant — at most one
  // payable Session per attempt, durably recorded before it can be lost, and
  // replaced only after the provider proves the previous one dead. Keeping two
  // implementations of that is how the legacy path ended up without it.
  const provisioned = await provisionCheckoutSession({
    order,
    leaseId: order.checkoutLeaseId,
    fingerprint: order.checkoutFingerprint,
    stripeProductId: params.stripeProductId,
    baseUrl: params.baseUrl,
    gaClientId: params.gaClientId,
  }, {
    createCheckoutSession: deps.createCheckoutSession,
    retrieveCheckoutSession: deps.retrieveCheckoutSession,
    renewCheckoutLease: deps.renewCheckoutLease,
    recordCheckoutSessionCandidate: deps.recordCheckoutSessionCandidate,
    supersedeCheckoutSession: deps.supersedeCheckoutSession,
    bindCheckoutSession: deps.bindCheckoutSession,
    logError: deps.logError,
  });

  if (provisioned.status === 'refused') {
    return refused(
      provisioned.httpStatus,
      DIRECT_INTAKE_CODE[provisioned.code] ?? provisioned.code,
      provisioned.message,
    );
  }
  return { status: 'redirect', redirectTo: provisioned.url, order: provisioned.order };
}
