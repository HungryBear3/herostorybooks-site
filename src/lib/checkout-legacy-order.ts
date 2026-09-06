/**
 * The legacy public checkout entrypoint: everything `/api/order` decides
 * between "the durable owner record exists" and "start uploading media".
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES IN THE ROUTE
 * ----------------------------------------------------
 * The route used to answer this itself, and answered it wrongly. It read
 * `persistedDraft.stripeSessionId`, retrieved that Session from the provider
 * inline, and returned either its URL or a flat 409 — all BEFORE the shared
 * provisioning machine, and therefore with none of it:
 *
 *  - an EXPIRED Session tombstoned the attempt permanently. The browser keeps
 *    the same `checkoutAttemptId` on purpose, so every retry found the same
 *    dead Session and returned the same 409. That buyer could never check out.
 *  - a Session created but never bound (`checkoutSessionCandidate`) was
 *    invisible to it, so the request fell through to the media/CAS path and
 *    then asked the provider for another one.
 *  - "already reached payment" was asserted for `complete`, `expired` and every
 *    unknown status alike — a claim about the buyer's money made from a status
 *    that does not support it.
 *
 * So the decision lives here, it is exactly one decision, and its only two
 * outcomes are "this order has no provider history — continue to media" and
 * "hand the durable record to the shared machine". The route keeps no session
 * state of its own; both checkout paths now recover identically.
 *
 * The lease identity handed to the machine is the DURABLE record's, not the
 * fresh one this request minted. That is the same thing the direct path does
 * (`order.checkoutLeaseId` after its commit), and it is what lets supersession
 * of a dead bound Session commit at all: `supersedeExpiredCheckoutSession`
 * requires the exact lease the record holds. It is safe because
 * `persistOrResumeCheckoutOrder` has already proven this request carries the
 * same `checkoutAttemptId` AND the same request fingerprint as that record —
 * i.e. it is the same logical attempt, from the same buyer, with byte-identical
 * inputs. Two such workers racing is the ordinary concurrent-retry case the
 * machine already converges.
 */
import {
  hasCheckoutProviderEvidence,
  type OrderRecord,
} from './orders.ts';
import {
  CHECKOUT_RECONCILIATION_SUPPORT,
  provisionCheckoutSession,
  type CheckoutChargeRisk,
  type CheckoutSessionProvisionDeps,
} from './checkout-session-provisioning.ts';

export interface LegacyCheckoutEntrypointDeps extends CheckoutSessionProvisionDeps {
  /** Create-or-exact-resume the durable owner record. Wired to orders. */
  persistOrResumeCheckoutOrder(order: OrderRecord): Promise<OrderRecord>;
}

export interface LegacyCheckoutEntrypointParams {
  /** The in-memory draft this request built, not yet durable. */
  draftOrder: OrderRecord;
  stripeProductId: string;
  baseUrl: string;
  gaClientId: string | null;
}

export type LegacyCheckoutEntrypointResult =
  /** No provider history: upload media, commit it, then provision. */
  | { status: 'continue'; order: OrderRecord }
  | { status: 'released'; url: string; order: OrderRecord }
  | {
      status: 'refused';
      httpStatus: number;
      code: string;
      message: string;
      chargeRisk: CheckoutChargeRisk;
    };

export async function resumeOrContinueLegacyCheckout(
  params: LegacyCheckoutEntrypointParams,
  deps: LegacyCheckoutEntrypointDeps,
): Promise<LegacyCheckoutEntrypointResult> {
  const log = deps.logError ?? (() => {});
  const draft = params.draftOrder;

  // ── The durable owner record, before any media and any provider call ──
  let persisted: OrderRecord;
  try {
    persisted = await deps.persistOrResumeCheckoutOrder(draft);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[order] ABORT BEFORE MEDIA/PROVIDER: durable draft persistence failed for ${draft.id}: ${message}`);
    // This request has certainly not touched the provider. That is NOT the same
    // as no provider call having happened for this order, and the difference is
    // the whole point of this catch.
    //
    // `persistOrResumeCheckoutOrder` does two things: it creates the owner
    // record, and — on a retry, which is the ordinary case here, since the
    // browser deliberately reuses its `checkoutAttemptId` — it reads back the
    // existing one. When it throws, the failure is exactly that this code
    // cannot see the durable record: whether that record carries a bound
    // Session, a candidate, or a provisioning marker from an earlier request is
    // precisely what is unknown. A store or parser outage is not evidence of
    // absence, so this may not tell the buyer their money is untouched.
    return {
      status: 'refused',
      httpStatus: 503,
      code: 'checkout_order_persist_failed',
      message: CHECKOUT_RECONCILIATION_SUPPORT,
      chargeRisk: 'may_be_charged',
    };
  }

  // ── No provider history? Then this is an ordinary first pass ──────────
  if (!hasCheckoutProviderEvidence(persisted)) {
    return { status: 'continue', order: persisted };
  }

  // ── Otherwise: recovery, through the one machine that knows how ───────
  const leaseId = persisted.checkoutLeaseId ?? draft.checkoutLeaseId;
  const fingerprint = persisted.checkoutFingerprint ?? draft.checkoutFingerprint;
  if (!leaseId || !fingerprint) {
    // A record carrying provider evidence but no checkout identity cannot be
    // reconciled by anything here, and must not be guessed at. This branch is
    // only reachable BECAUSE there is provider evidence, so the copy may not
    // deny a charge — a Session for this order may exist and may be payable.
    log(`[order] ABORT BEFORE PROVIDER: ${persisted.id} carries provider evidence but no checkout identity`);
    return {
      status: 'refused',
      httpStatus: 503,
      code: 'checkout_session_identity_missing',
      message: CHECKOUT_RECONCILIATION_SUPPORT,
      chargeRisk: 'may_be_charged',
    };
  }

  const provisioned = await provisionCheckoutSession({
    order: persisted,
    leaseId,
    fingerprint,
    stripeProductId: params.stripeProductId,
    baseUrl: params.baseUrl,
    gaClientId: params.gaClientId,
  }, deps);

  if (provisioned.status === 'refused') return provisioned;
  return { status: 'released', url: provisioned.url, order: provisioned.order };
}

/**
 * The legacy path's whole pre-media orchestration, as a function that can
 * actually be executed.
 *
 * `/api/order` cannot be imported under `node:test` — it pulls in `next/server`
 * and the Stripe SDK — so for as long as the decision above was made inline in
 * the handler, no test could show that the handler REACHES it. That gap was
 * real: wrapping the route's resume block in `if (false)` removed the entire
 * pre-media recovery and every test still passed, because they proved the
 * entrypoint's behaviour in isolation and the route's shape lexically.
 *
 * So the decision and its two exits live here, the route is a thin adapter that
 * supplies its response type, its dependencies and its media continuation, and
 * the behaviour is driven end-to-end in checkout-legacy-order-entrypoint.test.
 * `continueWithMedia` — the route's uploads, its final order CAS and its
 * provisioning hand-off — is reached ONLY for an order with no provider
 * history. Anything resumable is answered here, before a single byte of media
 * is uploaded, and a mutation that skips the resume shows up immediately as an
 * order with provider history reaching the media stage.
 *
 * Generic in the response type so the route keeps returning real
 * `NextResponse`s and this module keeps knowing nothing about Next.
 */
export interface LegacyCheckoutRouteDeps<TResponse> extends LegacyCheckoutEntrypointDeps {
  /** Build the route's response object. Wired to NextResponse.json. */
  json(body: Record<string, unknown>, httpStatus: number): TResponse;
  /**
   * Everything the route does when — and only when — this order has no provider
   * history: media uploads, the final order CAS, then the shared provisioner.
   */
  continueWithMedia(order: OrderRecord): Promise<TResponse>;
}

export async function runLegacyCheckoutRoute<TResponse>(
  params: LegacyCheckoutEntrypointParams,
  deps: LegacyCheckoutRouteDeps<TResponse>,
): Promise<TResponse> {
  const resumed = await resumeOrContinueLegacyCheckout(params, deps);

  if (resumed.status === 'refused') {
    return deps.json({ error: resumed.message, code: resumed.code }, resumed.httpStatus);
  }
  if (resumed.status === 'released') {
    return deps.json({ ok: true, redirectTo: resumed.url }, 200);
  }
  return deps.continueWithMedia(resumed.order);
}
