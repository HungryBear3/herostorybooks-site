import { createHash } from 'node:crypto';

import type { AttributionState, AttributionTouch } from './attribution-contract.ts';
import {
  HSB_GA4_MEASUREMENT_ID,
  sanitizeGaClientId,
  sanitizeGaSessionId,
  sanitizeGaSessionNumber,
} from './ga-cookie-identity.ts';

export { sanitizeGaClientId };

export interface Ga4PurchaseInput {
  transactionId: string;
  amountCents: number;
  currency?: string | null;
  itemId: string;
  itemName: string;
  paymentStatus?: string | null;
  clientId?: string | null;
  /**
   * GA session identity captured at checkout from the property's own
   * `_ga_<container>` cookie. Sent only alongside a real client id and only to
   * the property that issued the cookie; otherwise withheld.
   */
  sessionId?: string | null;
  sessionNumber?: string | null;
  /** Revalidated first / last non-direct touch, sent as bounded `hsb_*` params. */
  attribution?: AttributionState | null;
}

interface Ga4PurchaseDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'warn'>;
  /** Upper bound on the Measurement Protocol round trip. */
  timeoutMs?: number;
}

export type AfterImpl = (callback: () => void | Promise<void>) => void;

export const GA4_PURCHASE_TIMEOUT_MS = 5_000;

/**
 * GA4 reports a server-sent event in session and realtime views only with a
 * positive engagement time. One millisecond marks the purchase reportable
 * without claiming any engagement the server did not observe.
 */
const PURCHASE_ENGAGEMENT_TIME_MSEC = 1;

export type Ga4PurchaseFailureCode =
  | 'ga4_http_4xx'
  | 'ga4_http_5xx'
  | 'ga4_http_other'
  | 'ga4_timeout'
  | 'ga4_network';

/**
 * A Measurement Protocol failure reduced to a bounded code. The request URL
 * carries the API secret, so neither it nor any transport error text is kept.
 */
export class Ga4PurchaseError extends Error {
  readonly code: Ga4PurchaseFailureCode;

  constructor(code: Ga4PurchaseFailureCode) {
    super(code);
    this.name = 'Ga4PurchaseError';
    this.code = code;
  }
}

function configured(env: NodeJS.ProcessEnv) {
  const measurementId = (env.GA4_MEASUREMENT_ID || env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '').trim();
  const apiSecret = (env.GA4_API_SECRET || '').trim();
  return measurementId && apiSecret ? { measurementId, apiSecret } : null;
}

function isVerifiedPayment(status: string | null | undefined): boolean {
  return status === 'paid' || status === 'no_payment_required';
}

/**
 * Measurement Protocol reserves the `ga_` parameter prefix, so the captured
 * ga_session_id / ga_session_number travel under MP's own `session_id` and a
 * `session_number` companion. A session only means something to the property
 * whose cookie issued it and to the client it belongs to.
 */
function sessionParams(
  input: Ga4PurchaseInput,
  measurementId: string,
  clientId: string | null,
): Record<string, number> {
  if (!clientId || measurementId !== HSB_GA4_MEASUREMENT_ID) return {};
  const sessionId = sanitizeGaSessionId(input.sessionId);
  const sessionNumber = sanitizeGaSessionNumber(input.sessionNumber);
  if (!sessionId || !sessionNumber) return {};
  return { session_id: Number(sessionId), session_number: Number(sessionNumber) };
}

function touchParams(prefix: 'hsb_ft' | 'hsb_lt', touch: AttributionTouch | null | undefined): Record<string, string> {
  if (!touch) return {};
  if (touch.source === null) {
    return {
      [`${prefix}_source`]: '(direct)',
      [`${prefix}_medium`]: '(none)',
      [`${prefix}_landing`]: touch.landingPath,
    };
  }
  const params: Record<string, string> = { [`${prefix}_source`]: touch.source };
  if (touch.medium) params[`${prefix}_medium`] = touch.medium;
  if (touch.campaign) params[`${prefix}_campaign`] = touch.campaign;
  if (touch.content) params[`${prefix}_content`] = touch.content;
  if (touch.term) params[`${prefix}_term`] = touch.term;
  params[`${prefix}_landing`] = touch.landingPath;
  return params;
}

function isTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
}

/**
 * Sends GA4's recommended purchase event from trusted Stripe webhook data.
 * Stripe Checkout Session IDs are stable across webhook replays and GA4
 * deduplicates ecommerce purchases with the same transaction_id.
 */
export async function sendGa4Purchase(
  input: Ga4PurchaseInput,
  deps: Ga4PurchaseDeps = {},
): Promise<'sent' | 'skipped'> {
  if (!isVerifiedPayment(input.paymentStatus)) return 'skipped';

  const config = configured(deps.env ?? process.env);
  if (!config) return 'skipped';

  const value = Math.max(0, Math.trunc(input.amountCents)) / 100;
  const currency = (input.currency || 'usd').toUpperCase();
  const realClientId = sanitizeGaClientId(input.clientId);
  const clientId = realClientId
    ?? `hsb.${createHash('sha256').update(input.transactionId).digest('hex').slice(0, 24)}`;
  const endpoint = new URL('https://www.google-analytics.com/mp/collect');
  endpoint.searchParams.set('measurement_id', config.measurementId);
  endpoint.searchParams.set('api_secret', config.apiSecret);

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        events: [{
          name: 'purchase',
          params: {
            transaction_id: input.transactionId,
            value,
            currency,
            items: [{
              item_id: input.itemId,
              item_name: input.itemName,
              price: value,
              quantity: 1,
            }],
            engagement_time_msec: PURCHASE_ENGAGEMENT_TIME_MSEC,
            ...sessionParams(input, config.measurementId, realClientId),
            ...touchParams('hsb_ft', input.attribution?.firstTouch),
            ...touchParams('hsb_lt', input.attribution?.lastNonDirectTouch),
          },
        }],
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? GA4_PURCHASE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Ga4PurchaseError(isTimeout(error) ? 'ga4_timeout' : 'ga4_network');
  }

  if (!response.ok) {
    throw new Ga4PurchaseError(
      response.status >= 500 ? 'ga4_http_5xx' : response.status >= 400 ? 'ga4_http_4xx' : 'ga4_http_other',
    );
  }
  return 'sent';
}

/** Schedule analytics after the webhook response and swallow every failure. */
export function scheduleGa4Purchase(
  input: Ga4PurchaseInput,
  afterImpl: AfterImpl,
  deps: Ga4PurchaseDeps = {},
): void {
  const warn = (error: unknown) => (deps.log ?? console).warn(
    '[analytics] GA4 purchase event failed; payment flow unaffected',
    {
      transactionId: input.transactionId,
      message: error instanceof Error ? error.message : String(error),
    },
  );
  try {
    afterImpl(async () => {
      try {
        await sendGa4Purchase(input, deps);
      } catch (error) {
        warn(error);
      }
    });
  } catch (error) {
    warn(error);
  }
}
