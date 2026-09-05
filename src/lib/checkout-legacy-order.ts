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
  CHECKOUT_NO_CHARGE_RETRY,
  CHECKOUT_RECONCILIATION_NO_CHARGE,
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
    // Provably before any provider attempt of any kind: nothing in this request
    // has touched the provider, and no durable evidence was read. This is one
    // of the few places the no-charge sentence is actually earned.
    return {
      status: 'refused',
      httpStatus: 503,
      code: 'checkout_order_persist_failed',
      message: CHECKOUT_NO_CHARGE_RETRY,
      chargeRisk: 'not_charged',
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
    // reconciled by anything here, and must not be guessed at.
    log(`[order] ABORT BEFORE PROVIDER: ${persisted.id} carries provider evidence but no checkout identity`);
    return {
      status: 'refused',
      httpStatus: 503,
      code: 'checkout_session_identity_missing',
      message: CHECKOUT_RECONCILIATION_NO_CHARGE,
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
