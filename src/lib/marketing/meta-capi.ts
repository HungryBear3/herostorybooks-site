/**
 * Privacy-safe Meta Conversions API candidate — server side.
 *
 * WHAT THIS IS ALLOWED TO SEND. One event, `Purchase`, and only from the
 * existing trusted path: the signature-verified Stripe webhook, after payment
 * convergence and after the durable payment write — the same gate
 * `src/lib/ga4-purchase.ts` already sits behind. There is no other caller and
 * no other event.
 *
 * WHAT IT NEVER SENDS. No `user_data`, no Advanced Matching, no hashed or
 * unhashed email/phone/name, no `external_id`, no `client_ip_address`, no
 * `client_user_agent`, no order id, no Stripe session or PaymentIntent id, no
 * customer email, no child or family data, no asset URL, and no dynamic URL.
 * `assertNoBlockedFields` (see ./event-contract.ts) walks the built payload and
 * throws rather than trimming, so a bad caller fails loudly instead of quietly
 * shipping less than it meant to.
 *
 * DEDUPLICATION. `event_id` is a SHA-256 digest of the Stripe Checkout Session
 * id, prefixed and truncated. It is stable across webhook replays — the same
 * session always produces the same event_id — so Meta collapses replays, and it
 * is not the session id, so Meta never receives HSB's transaction identity. An
 * in-process guard additionally refuses a second send for the same event_id
 * within one runtime, which covers the webhook's own replay branch calling this
 * twice inside one invocation.
 *
 * FAILURE POSTURE. Bounded timeout, no retry, every error swallowed by
 * `scheduleMetaCapiPurchase`, scheduled through `after()` so it runs past the
 * webhook response. Analytics cannot delay, fail, or mutate a payment,
 * confirmation, or fulfillment.
 *
 * DISABLED BY DEFAULT. Absent any of the three environment variables below, or
 * with the flag not exactly 'true', every entry point returns 'skipped' and no
 * network call is constructed.
 */

import { createHash } from 'node:crypto';

import {
  assertNoBlockedFields,
  isAllowlistedServerEvent,
  type MetaServerEvent,
} from './event-contract.ts';

/** Server-only. None of these may ever be given a NEXT_PUBLIC_ prefix. */
export const META_CAPI_DATASET_ID_ENV = 'META_CAPI_DATASET_ID';
export const META_CAPI_ACCESS_TOKEN_ENV = 'META_CAPI_ACCESS_TOKEN';
export const META_CAPI_FLAG_ENV = 'META_CAPI_ENABLED';

/** Pinned so a Graph API default version change cannot silently alter behaviour. */
export const META_GRAPH_API_VERSION = 'v21.0';

/** Bounded and short. A slow ad platform must not hold a serverless instance. */
export const META_CAPI_TIMEOUT_MS = 2_500;

/**
 * The only URL Meta is told about. A constant public origin — never the request
 * URL, never a path, never a query string.
 */
export const META_EVENT_SOURCE_URL = 'https://herostorybooks.com/';

export interface MetaCapiConfig {
  datasetId: string;
  accessToken: string;
  endpoint: string;
}

export interface MetaCapiPurchaseInput {
  /**
   * Stripe Checkout Session id. Used ONLY to derive the hashed event_id; it is
   * never placed in the payload and is asserted absent before sending.
   */
  stripeSessionId: string;
  amountCents: number;
  currency?: string | null;
  /** Stable product identifier, e.g. `book_premium`. Not an order id. */
  contentId: string;
  paymentStatus?: string | null;
  /** Unix seconds. Injected rather than read from the clock, so it is testable. */
  eventTimeSeconds: number;
}

export interface MetaCapiDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'warn'>;
  timeoutMs?: number;
  /** Test seam for the in-process idempotency guard. */
  sentEventIds?: Set<string>;
}

export type AfterImpl = (callback: () => void | Promise<void>) => void;

export type MetaCapiResult = 'sent' | 'skipped' | 'duplicate';

/** Only these Stripe payment states are a purchase. Mirrors ga4-purchase.ts. */
function isVerifiedPayment(status: string | null | undefined): boolean {
  return status === 'paid' || status === 'no_payment_required';
}

const DATASET_ID_RE = /^\d{8,20}$/;

/** Resolve config, or null when the candidate must stay dark. */
export function resolveMetaCapiConfig(env: NodeJS.ProcessEnv = process.env): MetaCapiConfig | null {
  if (env[META_CAPI_FLAG_ENV] !== 'true') return null;
  const datasetId = (env[META_CAPI_DATASET_ID_ENV] ?? '').trim();
  const accessToken = (env[META_CAPI_ACCESS_TOKEN_ENV] ?? '').trim();
  if (!DATASET_ID_RE.test(datasetId) || accessToken.length === 0) return null;
  return {
    datasetId,
    accessToken,
    endpoint: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${datasetId}/events`,
  };
}

/**
 * Stable, non-reversible dedupe identity.
 *
 * Not an HMAC: there is no key to hold, and adding a secret would make the id
 * environment-dependent, which would break dedupe across a key rotation — the
 * one property this value exists to provide. It is a pseudonym, not a secret,
 * and it is the only thing derived from the session id that ever leaves HSB.
 */
export function deriveMetaEventId(stripeSessionId: string): string {
  const digest = createHash('sha256').update(`hsb:meta:purchase:${stripeSessionId}`).digest('hex');
  return `hsb_${digest.slice(0, 32)}`;
}

export interface MetaCapiEventPayload {
  data: [{
    event_name: MetaServerEvent;
    event_time: number;
    event_id: string;
    action_source: 'website';
    event_source_url: string;
    custom_data: { currency: string; value: number; content_ids: string[]; content_type: 'product' };
  }];
}

/**
 * Build the payload. Throws on anything the contract forbids, including a
 * non-allowlisted event name and any identifier-shaped value that slipped into
 * `contentId`.
 */
export function buildMetaCapiPurchaseEvent(input: MetaCapiPurchaseInput): MetaCapiEventPayload {
  const eventName: MetaServerEvent = 'Purchase';
  if (!isAllowlistedServerEvent(eventName)) throw new Error(`Meta server event not allowlisted: ${eventName}`);

  const payload: MetaCapiEventPayload = {
    data: [{
      event_name: eventName,
      event_time: Math.trunc(input.eventTimeSeconds),
      event_id: deriveMetaEventId(input.stripeSessionId),
      action_source: 'website',
      event_source_url: META_EVENT_SOURCE_URL,
      custom_data: {
        currency: (input.currency || 'usd').toUpperCase(),
        value: Math.max(0, Math.trunc(input.amountCents)) / 100,
        content_ids: [input.contentId],
        content_type: 'product',
      },
    }],
  };

  // The guard bans `transaction_id` and `session_id` as field names and rejects
  // Stripe-shaped values anywhere, so this cannot pass if the session id leaked
  // into the payload through any path.
  assertNoBlockedFields(payload);
  return payload;
}

/** Process-lifetime dedupe guard. Backstop, not the primary mechanism. */
const processSentEventIds = new Set<string>();

/**
 * Send one Purchase. Returns 'skipped' when unconfigured or unpaid, 'duplicate'
 * when this runtime already sent the same event_id, 'sent' otherwise.
 */
export async function sendMetaCapiPurchase(
  input: MetaCapiPurchaseInput,
  deps: MetaCapiDeps = {},
): Promise<MetaCapiResult> {
  if (!isVerifiedPayment(input.paymentStatus)) return 'skipped';

  const config = resolveMetaCapiConfig(deps.env ?? process.env);
  if (!config) return 'skipped';

  const payload = buildMetaCapiPurchaseEvent(input);
  const eventId = payload.data[0].event_id;
  const seen = deps.sentEventIds ?? processSentEventIds;
  if (seen.has(eventId)) return 'duplicate';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? META_CAPI_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header, never query string: a token in a URL ends up in access logs.
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Meta Conversions API returned ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }

  // Marked only after a successful send. A timeout or 5xx therefore does not
  // burn the id — but there is deliberately no retry here either, because a
  // retry without a durable idempotency store is how one purchase becomes two.
  seen.add(eventId);
  return 'sent';
}

/**
 * Fire-and-forget wrapper for the Stripe webhook. Mirrors
 * `scheduleGa4Purchase`: deferred past the response, every failure swallowed
 * and logged, never able to change payment, email, or fulfillment state.
 */
export function scheduleMetaCapiPurchase(
  input: MetaCapiPurchaseInput,
  afterImpl: AfterImpl,
  deps: MetaCapiDeps = {},
): void {
  const warn = (error: unknown) => (deps.log ?? console).warn(
    '[analytics] Meta Conversions API purchase failed; payment flow unaffected',
    { message: error instanceof Error ? error.message : String(error) },
  );
  try {
    afterImpl(async () => {
      try {
        await sendMetaCapiPurchase(input, deps);
      } catch (error) {
        warn(error);
      }
    });
  } catch (error) {
    warn(error);
  }
}

/** Test-only reset of the process-lifetime guard. */
export function __resetMetaCapiProcessGuardForTests(): void {
  processSentEventIds.clear();
}
