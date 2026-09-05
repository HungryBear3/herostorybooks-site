/**
 * The one place a payable provider Checkout Session comes into existence.
 *
 * Both checkout paths — the direct private-intake saga and the legacy public
 * path — route through here, because the invariant they have to hold is the
 * same one and it was previously implemented once, in only one of them:
 *
 *   **At most one PAYABLE Session may exist per order attempt, and a
 *   replacement may be minted only after the provider itself has proven the
 *   previous Session dead AND the durable order has atomically retired it.**
 *
 * The order of operations is the feature:
 *
 *   renew the exact lease  →  resolve what Session (if any) this order already
 *   has  →  ask the provider  →  [expired? retire it durably, then loop]  →
 *   record the created id durably  →  bind under the exact lease  →  release
 *
 * Three rules that look like details and are not:
 *
 *  - The created id is persisted BEFORE anything else may fail. Provider
 *    idempotency retention is finite; the durable candidate is what makes a
 *    lost Session recoverable after it lapses, and what stops abandoned-media
 *    cleanup from deleting the photos under a live Session.
 *  - A `complete` Session is NEVER retired and never replaced. It may have
 *    been paid. Recovery there is a support conversation, not a new Session.
 *  - A retrieval outage is not proof of anything. It fails closed.
 *
 * Customer copy is decided here too, from whether a checkout URL was ever
 * released to this buyer — see `chargeRisk`. "No charge was made" is a claim
 * about the buyer's money, and it is only made where it is provable.
 */
import {
  CHECKOUT_SESSION_SUPERSEDE_LIMIT,
  checkoutProviderIdempotencyKey,
  hasCheckoutProviderEvidence,
  readCheckoutSessionCandidate,
  readCheckoutSessionProvisioning,
  type OrderRecord,
} from './orders.ts';

export interface ProviderCheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired' | null;
}

export interface ProviderCheckoutSessionRequest {
  order: OrderRecord;
  stripeProductId: string;
  baseUrl: string;
  gaClientId: string | null;
  idempotencyKey: string;
}

export interface CheckoutSessionProvisionDeps {
  createCheckoutSession(request: ProviderCheckoutSessionRequest): Promise<ProviderCheckoutSession>;
  retrieveCheckoutSession(stripeSessionId: string): Promise<ProviderCheckoutSession>;
  /** Atomic proof-of-ownership. Wired to orders.renewCheckoutLease. */
  renewCheckoutLease(
    orderId: string,
    checkoutLeaseId: string,
    checkoutFingerprint: string,
  ): Promise<OrderRecord | null>;
  /**
   * Commit durable pre-provider evidence for this exact attempt. Wired to
   * orders.beginCheckoutSessionProvisioning. A create is refused outright if
   * this does not commit, because without it a create that outlives its lease
   * has nothing protecting the private media it is about to become payable for.
   */
  beginCheckoutSessionProvisioning(
    orderId: string,
    checkout: { leaseId: string; fingerprint: string; checkoutSessionAttempt: number },
  ): Promise<OrderRecord | null>;
  /** Create-only durable record of a Session created but not yet bound. */
  recordCheckoutSessionCandidate(
    orderId: string,
    stripeSessionId: string,
    checkout: { checkoutAttemptId: string; fingerprint: string },
  ): Promise<OrderRecord | null>;
  /** Atomically retire an exact provider-confirmed expired Session. */
  supersedeCheckoutSession(
    orderId: string,
    expiredStripeSessionId: string,
    checkout: { leaseId: string; fingerprint: string },
  ): Promise<OrderRecord | null>;
  bindCheckoutSession(
    orderId: string,
    stripeSessionId: string,
    checkout: { leaseId: string; fingerprint: string },
  ): Promise<OrderRecord | null>;
  logError?(message: string, detail?: unknown): void;
}

export interface CheckoutSessionProvisionParams {
  /** The durable, already-reconciled order. */
  order: OrderRecord;
  leaseId: string;
  fingerprint: string;
  stripeProductId: string;
  baseUrl: string;
  gaClientId: string | null;
}

/**
 * Whether this order can still be said, provably, to have cost the buyer
 * nothing.
 *
 * `not_charged` requires that NO provider create was ever entered for this
 * order — not merely that no URL was released. Once the provider has been asked
 * to mint a Session, a provider object may exist whatever the local outcome
 * was: a create that threw may have succeeded server-side, and a local
 * persistence failure after a successful create says nothing at all about the
 * provider. Categorically denying a charge there claims more than this code can
 * see, so everything from the create onwards is `may_be_charged` and gets copy
 * that tells the buyer not to pay again and to reconcile with support.
 *
 * Durable evidence from an EARLIER request counts the same way. A bound
 * Session, a candidate, or a provisioning marker each mean a create was already
 * entered on some previous attempt.
 */
export type CheckoutChargeRisk = 'not_charged' | 'may_be_charged';

export type CheckoutSessionProvisionResult =
  | { status: 'released'; url: string; order: OrderRecord }
  | {
      status: 'refused';
      httpStatus: number;
      code: string;
      message: string;
      chargeRisk: CheckoutChargeRisk;
    };

export const CHECKOUT_NO_CHARGE_RETRY =
  'We could not securely save your order. No charge was made. Please retry in a moment, and contact support@herostorybooks.com if it keeps happening.';
export const CHECKOUT_RECONCILIATION_NO_CHARGE =
  'Checkout requires reconciliation. No checkout link was released and no charge was made.';
export const CHECKOUT_RECONCILIATION_SUPPORT =
  'We could not confirm the status of this checkout. Please do not pay again — contact support@herostorybooks.com with your order details and we will confirm exactly what happened and put it right.';
export const CHECKOUT_PAYMENT_MAY_BE_COMPLETE =
  'This checkout may already be complete. Please do not pay again — contact support@herostorybooks.com with your order details and we will confirm your order.';
export const CHECKOUT_ATTEMPT_ALREADY_RESOLVED =
  'This checkout attempt is already in progress or has already reached payment. No new charge was made — reload the page to start a fresh attempt, and contact support@herostorybooks.com if you were charged.';

function refused(
  httpStatus: number,
  code: string,
  message: string,
  chargeRisk: CheckoutChargeRisk,
): CheckoutSessionProvisionResult {
  return { status: 'refused', httpStatus, code, message, chargeRisk };
}

export async function provisionCheckoutSession(
  params: CheckoutSessionProvisionParams,
  deps: CheckoutSessionProvisionDeps,
): Promise<CheckoutSessionProvisionResult> {
  const log = deps.logError ?? (() => {});
  const orderId = params.order.id;

  // Was a checkout URL ever released to this buyer? A bound Session means yes:
  // the only way `stripeSessionId` gets set is the bind that immediately
  // precedes releasing the URL.
  let everExposed = typeof params.order.stripeSessionId === 'string'
    && params.order.stripeSessionId.length > 0;

  // Has the provider ever been asked to mint a Session for this order? Durable
  // evidence carried in on the record answers for previous requests; the flag
  // is raised the instant this request enters `createCheckoutSession`, BEFORE
  // it is known whether that call succeeded — because a create that throws is
  // exactly the case where a provider object may exist anyway.
  //
  // This is the sole gate on every "no charge was made" sentence below.
  let providerAttempted = hasCheckoutProviderEvidence(params.order);
  const risk = (): CheckoutChargeRisk =>
    (everExposed || providerAttempted ? 'may_be_charged' : 'not_charged');
  const reconciliationCopy = () => (risk() === 'may_be_charged'
    ? CHECKOUT_RECONCILIATION_SUPPORT
    : CHECKOUT_RECONCILIATION_NO_CHARGE);

  // An order carrying BOTH a binding and a candidate, or a provisioning marker
  // that does not describe this order's current attempt, is impossible state.
  // The parser already refuses to read either, so this is the runtime backstop
  // for a record handed in from memory rather than loaded from the store.
  if (readCheckoutSessionCandidate(params.order).status === 'invalid'
    || readCheckoutSessionProvisioning(params.order).status === 'invalid') {
    log(`[checkout] unusable Session evidence on ${orderId}; refusing before the provider`);
    return refused(409, 'checkout_session_candidate_invalid', reconciliationCopy(), risk());
  }

  let current: OrderRecord = params.order;

  // Bounded: each pass either releases, refuses, or retires exactly one dead
  // Session. Retirement is itself capped, so this cannot spin.
  for (let pass = 0; pass <= CHECKOUT_SESSION_SUPERSEDE_LIMIT + 1; pass += 1) {
    const boundSessionId = typeof current.stripeSessionId === 'string' && current.stripeSessionId
      ? current.stripeSessionId
      : null;
    if (boundSessionId) everExposed = true;

    // ── Establish authority immediately before touching the provider ──────
    // Skipped only for an already-bound Session, whose bind already fenced it
    // — and which `renewCheckoutLease` refuses by design while it is bound.
    if (!boundSessionId) {
      let renewed: OrderRecord | null;
      try {
        renewed = await deps.renewCheckoutLease(orderId, params.leaseId, params.fingerprint);
      } catch (error) {
        log(`[checkout] lease renewal failed for ${orderId}`, error);
        renewed = null;
      }
      if (!renewed) {
        log(`[checkout] ABORT BEFORE PROVIDER: lease no longer held for ${orderId}`);
        // The "no new charge was made" wording is only usable where no provider
        // create was ever entered for this order.
        return refused(409, 'checkout_lease_lost', providerAttempted
          ? CHECKOUT_RECONCILIATION_SUPPORT
          : CHECKOUT_ATTEMPT_ALREADY_RESOLVED, risk());
      }
      if (!renewed.checkoutLeaseId || !renewed.checkoutFingerprint || !renewed.checkoutAttemptId) {
        log(`[checkout] ABORT BEFORE PROVIDER: ${orderId} carries no checkout identity`);
        return refused(503, 'checkout_session_identity_missing', reconciliationCopy(), risk());
      }
      current = renewed;
    }

    const candidate = readCheckoutSessionCandidate(current);
    if (candidate.status === 'invalid') {
      log(`[checkout] unusable Session candidate on ${orderId}`);
      return refused(409, 'checkout_session_candidate_invalid', reconciliationCopy(), risk());
    }

    // ── Resolve which Session this order already has, if any ──────────────
    const existingId = boundSessionId
      ?? (candidate.status === 'resumable' ? candidate.candidate.stripeSessionId : null);
    const source: 'bound' | 'candidate' | 'new' = boundSessionId
      ? 'bound'
      : candidate.status === 'resumable' ? 'candidate' : 'new';

    let session: ProviderCheckoutSession;
    if (existingId) {
      try {
        session = await deps.retrieveCheckoutSession(existingId);
      } catch (error) {
        // An outage says nothing about whether the Session is alive. Creating
        // a replacement here is exactly how a duplicate charge happens.
        log(`[checkout] Session retrieval failed for ${orderId}`, error);
        return refused(503, 'checkout_session_retrieve_failed', reconciliationCopy(), risk());
      }
      if (session.id !== existingId) {
        log(`[checkout] provider answered ${session.id} for ${existingId} on ${orderId}`);
        return refused(
          503,
          source === 'bound' ? 'checkout_session_reconciliation_failed' : 'checkout_session_candidate_mismatch',
          reconciliationCopy(),
          risk(),
        );
      }
    } else {
      const attempt = current.checkoutSessionAttempt ?? 0;
      const idempotencyKey = checkoutProviderIdempotencyKey(orderId, attempt);

      // ── The barrier ────────────────────────────────────────────────────
      // Durable evidence that a create is about to happen, committed under
      // the exact live lease BEFORE the provider is touched. The candidate
      // below cannot cover this window — there is nothing to record until the
      // provider answers — and the provider call is the one step here that can
      // outlive its own lease. Without this, abandoned-media cleanup can claim
      // and delete the buyer's private media while the create is in flight,
      // and the candidate write then fails closed against the claimed
      // retention, stranding a payable Session with no media behind it.
      //
      // This is the last point at which "no charge was made" is provable, so
      // its own failure keeps that copy and every failure after it does not.
      let marked: OrderRecord | null;
      try {
        marked = await deps.beginCheckoutSessionProvisioning(orderId, {
          leaseId: params.leaseId,
          fingerprint: params.fingerprint,
          checkoutSessionAttempt: attempt,
        });
      } catch (error) {
        log(`[checkout] provisioning evidence failed for ${orderId}`, error);
        marked = null;
      }
      if (!marked) {
        log(`[checkout] ABORT BEFORE PROVIDER: no durable provisioning evidence for ${orderId}`);
        return refused(503, 'checkout_session_provisioning_failed', providerAttempted
          ? CHECKOUT_RECONCILIATION_SUPPORT
          : CHECKOUT_NO_CHARGE_RETRY, risk());
      }
      current = marked;

      // Everything from here on is ambiguous about the buyer's money.
      providerAttempted = true;
      try {
        session = await deps.createCheckoutSession({
          order: current,
          stripeProductId: params.stripeProductId,
          baseUrl: params.baseUrl,
          gaClientId: params.gaClientId,
          idempotencyKey,
        });
      } catch (error) {
        // A throw is NOT proof the provider minted nothing — the request may
        // have been served and the response lost. The marker stays, so a retry
        // reuses this exact idempotency key and the media survives until it.
        log(`[checkout] Session creation failed for ${orderId}`, error);
        return refused(503, 'checkout_session_create_failed', CHECKOUT_RECONCILIATION_SUPPORT, risk());
      }

      // Durable before anything else may fail. From here the Session exists at
      // the provider whatever happens next, and only this record lets a later
      // retry reconcile it by id rather than by a finite idempotency key.
      //
      // Deliberately NOT lease-gated: the worker that must record a candidate
      // is often the one that just lost its lease inside the create above, and
      // demanding the lease here would throw away the only evidence naming the
      // Session. Recording exposes nothing; the bind below still fences it.
      let recorded: OrderRecord | null;
      try {
        recorded = await deps.recordCheckoutSessionCandidate(orderId, session.id, {
          checkoutAttemptId: current.checkoutAttemptId!,
          fingerprint: params.fingerprint,
        });
      } catch (error) {
        log(`[checkout] Session candidate persistence failed for ${orderId}`, error);
        recorded = null;
      }
      if (!recorded) {
        log(`[checkout] Session ${session.id} created but not durably recorded for ${orderId}`);
        return refused(503, 'checkout_session_candidate_persist_failed', CHECKOUT_RECONCILIATION_SUPPORT, risk());
      }
      current = recorded;
    }

    // ── What did the provider actually say? ───────────────────────────────
    if (session.status === 'complete') {
      // Money may already have moved. Never retire, never replace, never deny.
      log(`[checkout] Session ${session.id} for ${orderId} is complete; refusing to replace it`);
      return refused(409, 'checkout_session_complete', CHECKOUT_PAYMENT_MAY_BE_COMPLETE, 'may_be_charged');
    }

    if (session.status === 'expired') {
      if ((current.checkoutSessionAttempt ?? 0) >= CHECKOUT_SESSION_SUPERSEDE_LIMIT) {
        log(`[checkout] supersede limit reached for ${orderId}; refusing to mint another Session`);
        return refused(409, 'checkout_session_supersede_limit', reconciliationCopy(), risk());
      }
      let retired: OrderRecord | null;
      try {
        retired = await deps.supersedeCheckoutSession(orderId, session.id, {
          leaseId: params.leaseId,
          fingerprint: params.fingerprint,
        });
      } catch (error) {
        log(`[checkout] supersession failed for ${orderId}`, error);
        retired = null;
      }
      if (!retired) {
        // Without a committed retirement there is no authority to create.
        log(`[checkout] ABORT: could not durably retire expired Session ${session.id} for ${orderId}`);
        return refused(409, 'checkout_session_supersede_failed', reconciliationCopy(), risk());
      }
      current = retired;
      continue;
    }

    if (session.status !== 'open') {
      log(`[checkout] Session ${session.id} for ${orderId} is not open`);
      return refused(409, 'checkout_session_not_open', reconciliationCopy(), risk());
    }

    // ── Open. Bind (unless already bound), then release ───────────────────
    let released: OrderRecord = current;
    if (source !== 'bound') {
      const bound = await deps.bindCheckoutSession(orderId, session.id, {
        leaseId: params.leaseId,
        fingerprint: params.fingerprint,
      });
      if (!bound) {
        log(`[checkout] Session ${session.id} created but durable binding failed for ${orderId}`);
        return refused(503, 'checkout_session_bind_failed', reconciliationCopy(), risk());
      }
      released = bound;
    }
    if (!session.url) {
      log(`[checkout] Session ${session.id} for ${orderId} carried no checkout URL`);
      return refused(
        503,
        source === 'bound' ? 'checkout_session_reconciliation_failed' : 'checkout_session_url_missing',
        reconciliationCopy(),
        risk(),
      );
    }
    return { status: 'released', url: session.url, order: released };
  }

  // Unreachable while the retirement cap holds; fail closed rather than trust that.
  log(`[checkout] provisioning did not converge for ${orderId}`);
  return refused(409, 'checkout_session_supersede_limit', reconciliationCopy(), risk());
}
