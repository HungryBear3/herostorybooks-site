import { randomUUID } from 'node:crypto';

import { isAdminAuthedFromRequest } from '../admin-auth.ts';
import {
  bindClassroomCheckoutSession,
  checkoutProviderIdempotencyKey,
  classroomCheckoutEligible,
  classroomCheckoutReplayEligible,
  getOrder,
  recordClassroomFinancialEvent,
  reserveClassroomCheckoutTerms,
  type ClassroomCheckoutDispatchV1,
  type OrderRecord,
} from '../orders.ts';
import { assertClassroomAssemblyCurrent } from './assembly.ts';

/**
 * Classroom zero-total TEST checkout and settlement (local slice).
 *
 * Checkout: existing admin auth -> server-owned target order (never the
 * request) -> the retained pending/manual_hold classroom digital order and its
 * current manifest -> one provider Session under the existing per-order
 * idempotency key, bound to the same order in an orders transaction. Price and
 * format come from the durable order; the request body is never read.
 *
 * Settlement: called by the existing Stripe webhook route AFTER its existing
 * signature verification. The event body is only a pointer: every fact is
 * re-read from the provider Session, which must be exactly TEST
 * (livemode=false), complete, no_payment_required, amount_total 0, the order's
 * price as subtotal, usd, no PaymentIntent, and bound to this order, Session
 * and manifest. The manifest/roster is rechecked immediately before the
 * existing settleOrderPayment transaction. fulfillmentMode stays manual_hold;
 * no generation, email, print or analytics is scheduled.
 */
export const CLASSROOM_ZERO_TOTAL_KIND = 'hsb_classroom_zero_total_test';
export const CLASSROOM_CHECKOUT_TARGET_ENV = 'HSB_CLASSROOM_CHECKOUT_TARGET_JSON';

export interface ClassroomProviderSession {
  id: string;
  url?: string | null;
  livemode?: boolean | null;
  mode?: string | null;
  status?: string | null;
  payment_status?: string | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  payment_intent?: unknown;
  total_details?: { amount_discount?: number | null } | null;
}

export interface ClassroomZeroSessionRequest {
  order: OrderRecord;
  idempotencyKey: string;
  metadata: Record<string, string>;
  baseUrl: string;
}

export interface ClassroomCheckoutProvider {
  createZeroTotalSession(request: ClassroomZeroSessionRequest): Promise<ClassroomProviderSession>;
  retrieveSession(sessionId: string): Promise<ClassroomProviderSession>;
  /** Test clock only; production uses the real clock. */
  now?: Date;
  /** Test seam for controlled interleavings; absent in production. */
  barrier?: (point: string) => Promise<void>;
}

let providerOverride: ClassroomCheckoutProvider | null = null;

/** Native adapter seam for local tests; never set in production. */
export function __setClassroomCheckoutProviderForTests(provider: ClassroomCheckoutProvider | null): void {
  providerOverride = provider;
}

export function resolveClassroomCheckoutProvider(
  fallback: () => ClassroomCheckoutProvider | null,
): ClassroomCheckoutProvider | null {
  return providerOverride ?? fallback();
}

/** Server-owned target: {"schemaVersion":1,"enabled":true,"orderId":"ord_<16 hex>"}; anything else is null. */
export function classroomCheckoutTargetFromEnv(): { orderId: string } | null {
  try {
    const raw = process.env[CLASSROOM_CHECKOUT_TARGET_ENV];
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'enabled,orderId,schemaVersion') return null;
    if (value.schemaVersion !== 1 || value.enabled !== true) return null;
    if (typeof value.orderId !== 'string' || !ORDER_ID.test(value.orderId)) return null;
    return { orderId: value.orderId };
  } catch {
    return null;
  }
}

export interface ClassroomCheckoutDeps {
  authenticate?: (request: Request) => boolean;
  target: (() => { orderId: string } | null | Promise<{ orderId: string } | null>) | null;
  provider: ClassroomCheckoutProvider | null;
  baseUrl: (request: Request) => string;
}

const ORDER_ID = /^ord_[a-f0-9]{16}$/;
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };
const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: HEADERS });

function eligible(order: OrderRecord): boolean {
  return classroomCheckoutEligible(order);
}

function sessionMetadata(order: OrderRecord): Record<string, string> {
  const binding = order.groupBookAssembly!;
  return {
    kind: CLASSROOM_ZERO_TOTAL_KIND,
    orderId: order.id,
    cohortId: binding.cohortId,
    manifestDigest: binding.digest,
    manifestExpiresAt: binding.expiresAt,
  };
}

/** Exact binding of a provider Session to this order and manifest (any lifecycle state). */
function boundTo(session: ClassroomProviderSession, order: OrderRecord): string | null {
  const expected = sessionMetadata(order);
  if (session.livemode !== false) return 'livemode';
  if (session.mode !== 'payment') return 'mode';
  if (session.client_reference_id !== order.id) return 'client_reference';
  const metadata = session.metadata ?? {};
  for (const [key, value] of Object.entries(expected)) if (metadata[key] !== value) return `metadata_${key}`;
  if (session.amount_subtotal !== order.priceCents) return 'amount_subtotal';
  if (session.amount_total !== 0) return 'amount_total';
  if (session.currency !== 'usd') return 'currency';
  if (session.payment_intent !== null && session.payment_intent !== undefined) return 'payment_intent';
  return null;
}

async function currentAssembly(order: OrderRecord, now?: Date): Promise<string | null> {
  const check = await assertClassroomAssemblyCurrent(order.groupBookAssembly, now ? { now: () => now } : {});
  return check.ok === false ? check.reason : null;
}

/** Canonical serialization of the accepted binding (flat, key-sorted). */
function canonicalBinding(order: OrderRecord): string {
  const binding = (order.groupBookAssembly ?? null) as unknown as Record<string, unknown> | null;
  if (!binding) return 'null';
  return JSON.stringify(Object.keys(binding).sort().map((key) => [key, binding[key]]));
}

/** Per-attempt guard for a committing callback: exact accepted binding, then current assembly. */
async function guard(current: OrderRecord, acceptedBinding: string, now?: Date): Promise<string | null> {
  if (canonicalBinding(current) !== acceptedBinding) return 'binding_changed';
  return await currentAssembly(current, now);
}

export async function classroomCheckoutResponse(request: Request, deps: ClassroomCheckoutDeps): Promise<Response> {
  const authenticate = deps.authenticate ?? isAdminAuthedFromRequest;
  if (!authenticate(request)) return reply(401, { error: 'Unauthorized' });
  if (!deps.target || !deps.provider) return reply(503, { error: 'classroom_checkout_unavailable' });
  let target: { orderId: string } | null;
  try {
    target = await deps.target();
  } catch {
    target = null;
  }
  if (!target || !ORDER_ID.test(target.orderId)) return reply(503, { error: 'classroom_checkout_unavailable' });
  const provider = deps.provider;

  try {
    const order = await getOrder(target.orderId);
    if (!order) return reply(404, { error: 'classroom_order_not_found' });
    if (!eligible(order)) return reply(409, { error: 'classroom_order_not_eligible' });
    // A reservation without a bound Session is an ambiguous provider create:
    // durably held, never automatically re-created (restart and provider
    // idempotency expiry included). Recovery is a separate operator action.
    if (!order.stripeSessionId && order.classroomCheckoutDispatch) return reply(409, { error: 'classroom_checkout_held' });
    const refusal = await currentAssembly(order, provider.now);
    if (refusal) return reply(409, { error: 'manifest_refused', reason: refusal });
    const acceptedBinding = canonicalBinding(order);

    let session: ClassroomProviderSession;
    if (order.stripeSessionId) {
      // Already bound: only the bound Session is ever released, and only while
      // full eligibility, accepted terms and accepted Session still match.
      if (!classroomCheckoutReplayEligible(order)) return reply(409, { error: 'classroom_session_not_open' });
      try {
        session = await provider.retrieveSession(order.stripeSessionId);
      } catch {
        return reply(502, { error: 'classroom_provider_unavailable' });
      }
      if (session.id !== order.stripeSessionId || boundTo(session, order) || session.status !== 'open' || !session.url) {
        return reply(409, { error: 'classroom_session_not_open' });
      }
      return reply(200, { state: 'replayed', orderId: order.id, url: session.url });
    }

    // Durable dispatch reservation BEFORE the provider create. The CAS lets
    // exactly one fresh claim commit; every other claim is refused as held.
    const dispatch: ClassroomCheckoutDispatchV1 = {
      schemaVersion: 1,
      attemptId: randomUUID(),
      idempotencyKey: checkoutProviderIdempotencyKey(order.id),
      reservedAt: new Date().toISOString(),
    };
    // Immutable accepted terms are appended in the SAME CAS as the dispatch.
    const reserved = await reserveClassroomCheckoutTerms(order.id, {
      dispatch,
      guard: async (current) => {
        // Exact context captured at entry: a price/format change since then refuses.
        if (current.priceCents !== order.priceCents || current.bookFormat !== order.bookFormat) return 'context_changed';
        const refusal = await guard(current, acceptedBinding, provider.now);
        if (refusal) return refusal;
        await (provider.barrier?.('checkout:reserve_guarded'));
        return null;
      },
    });
    if (reserved.ok === false) {
      const reason = (reserved as { reason: string }).reason;
      return reason === 'held'
        ? reply(409, { error: 'classroom_checkout_held' })
        : reply(409, { error: 'manifest_refused', reason });
    }
    const reservedOrder: OrderRecord = (reserved as { order: OrderRecord }).order;

    try {
      session = await provider.createZeroTotalSession({
        order: reservedOrder,
        idempotencyKey: dispatch.idempotencyKey,
        metadata: sessionMetadata(order),
        baseUrl: deps.baseUrl(request),
      });
    } catch {
      // Ambiguous: the provider may have accepted it. The reservation stays.
      return reply(502, { error: 'classroom_provider_ambiguous_held' });
    }
    if (typeof session?.id !== 'string' || !session.id.startsWith('cs_test_') || boundTo(session, order)
      || session.status !== 'open' || !session.url) {
      return reply(502, { error: 'classroom_provider_session_refused' });
    }
    await (provider.barrier?.('checkout:after_create'));

    const createdId = session.id;
    // Fresh per attempt (every CAS retry): full eligibility, terms, dispatch, binding, assembly.
    const bound = await bindClassroomCheckoutSession(order.id, {
      dispatchAttemptId: dispatch.attemptId,
      sessionId: createdId,
      guard: async (current) => {
        const refusal = await guard(current, acceptedBinding, provider.now);
        if (refusal) return refusal;
        await (provider.barrier?.('checkout:bind_guarded'));
        return null;
      },
    }).catch(() => ({ ok: false as const, reason: 'conflict' }));
    if (bound.ok === false) return reply(409, { error: 'classroom_checkout_refused', reason: (bound as { reason: string }).reason });
    return reply(200, { state: 'created', orderId: order.id, url: session.url });
  } catch {
    return reply(500, { error: 'classroom_checkout_failed' });
  }
}

interface VerifiedEvent {
  id?: string;
  account?: string | null;
  type: string;
  livemode?: boolean;
  data: { object: unknown };
}

/** True only for a verified checkout.session.completed tagged as a classroom zero-total Session. */
export function isClassroomZeroTotalEvent(event: VerifiedEvent): boolean {
  if (event.type !== 'checkout.session.completed') return false;
  const object = event.data?.object as { metadata?: Record<string, string> | null } | null;
  return object?.metadata?.kind === CLASSROOM_ZERO_TOTAL_KIND;
}

export interface ClassroomSettlementOutcome {
  status: number;
  body: Record<string, unknown>;
}

const refused = (reason: string, status = 409): ClassroomSettlementOutcome =>
  ({ status, body: { received: true, classroomSettlement: 'refused', reason } });

/** Settle one ALREADY signature-verified event. The event body is never trusted for facts. */
export async function settleClassroomZeroTotalEvent(
  event: VerifiedEvent,
  provider: Pick<ClassroomCheckoutProvider, 'retrieveSession' | 'now' | 'barrier'> | null,
): Promise<ClassroomSettlementOutcome> {
  // The provider argument is NEVER financial authority: only the Event id is
  // forwarded, and orders.ts independently retrieves the Event and Session
  // with its own fixed platform client before any append-once evidence.
  void provider;
  if (typeof event?.id !== 'string' || !event.id) return refused('event_identity');
  return await recordClassroomFinancialEvent(event.id);
}
