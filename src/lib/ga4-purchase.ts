import { createHash } from 'node:crypto';

import {
  validateUtmTuple,
  type GovernedUtmTuple,
} from './marketing/utm-contract.ts';

export interface Ga4PurchaseInput {
  transactionId: string;
  amountCents: number;
  currency?: string | null;
  itemId: string;
  itemName: string;
  paymentStatus?: string | null;
  clientId?: string | null;
  /**
   * Governed campaign attribution, already validated by
   * src/lib/marketing/utm-contract.ts. Re-validated here regardless, because
   * this is the last boundary before the value leaves for Google and a caller
   * is not a trust boundary.
   */
  campaign?: GovernedUtmTuple | null;
}

interface Ga4PurchaseDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'warn'>;
}

export type AfterImpl = (callback: () => void | Promise<void>) => void;

function configured(env: NodeJS.ProcessEnv) {
  const measurementId = (env.GA4_MEASUREMENT_ID || env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '').trim();
  const apiSecret = (env.GA4_API_SECRET || '').trim();
  return measurementId && apiSecret ? { measurementId, apiSecret } : null;
}

function isVerifiedPayment(status: string | null | undefined): boolean {
  return status === 'paid' || status === 'no_payment_required';
}

/**
 * GA4's reserved campaign parameter names, populated ONLY from a tuple that
 * passes the governed contract here, at the last boundary before the request.
 * A tuple that does not validate contributes nothing rather than partially.
 */
function campaignParams(campaign: GovernedUtmTuple | null | undefined): Record<string, string> {
  if (!campaign) return {};
  const result = validateUtmTuple(campaign);
  if (!result.ok || !result.tuple) return {};
  const tuple = result.tuple;
  const params: Record<string, string> = {
    campaign_source: tuple.utm_source,
    campaign_medium: tuple.utm_medium,
    campaign_name: tuple.utm_campaign,
  };
  if (tuple.utm_content) params.campaign_content = tuple.utm_content;
  return params;
}

export function sanitizeGaClientId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{1,20}\.\d{1,20}$/.test(trimmed) ? trimmed : null;
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
  const clientId = sanitizeGaClientId(input.clientId)
    ?? `hsb.${createHash('sha256').update(input.transactionId).digest('hex').slice(0, 24)}`;
  const endpoint = new URL('https://www.google-analytics.com/mp/collect');
  endpoint.searchParams.set('measurement_id', config.measurementId);
  endpoint.searchParams.set('api_secret', config.apiSecret);

  const response = await (deps.fetchImpl ?? fetch)(endpoint, {
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
          ...campaignParams(input.campaign),
          items: [{
            item_id: input.itemId,
            item_name: input.itemName,
            price: value,
            quantity: 1,
          }],
        },
      }],
    }),
  });

  if (!response.ok) throw new Error(`GA4 Measurement Protocol returned ${response.status}`);
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
