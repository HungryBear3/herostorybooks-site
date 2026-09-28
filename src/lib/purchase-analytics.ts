/**
 * Purchase analytics from the signed Stripe webhook — the only authoritative
 * purchase writer. No browser or success-page code may send a purchase.
 *
 * The webhook schedules this only after its exact settled-payment check and
 * the durable payment transition have both succeeded. From there:
 *
 *  - The settlement facts are re-checked before anything is built: a Checkout
 *    Session id as `transaction_id`, a non-negative integer amount, USD, a
 *    settled payment status, and one catalog item.
 *  - Provider-signed metadata is re-validated with the same contracts the
 *    checkout API used; unknown keys are never read, a GA session survives
 *    only with the client id it belongs to, and attribution must pass the
 *    attribution contract again.
 *  - Nothing is sent outside a production deployment, or without explicit
 *    Measurement Protocol configuration.
 *  - Every outcome is a typed value. A failure is a bounded code — never an
 *    error message, a URL, or the API secret — and nothing here can throw into,
 *    delay, or change the webhook's acknowledgement, the order, or fulfillment.
 *
 * Replays never reach this module: only the pending → paid transition (and a
 * first print-upgrade settlement) schedules it. The Checkout Session id is the
 * deterministic transaction_id, so GA4's transaction dedup covers the one
 * remaining window — two concurrent first deliveries of the same event.
 */
import { attributionFromStripeMetadata, type AttributionState } from './attribution-contract.ts';
import { sanitizeGaClientId, sanitizeGaSessionId, sanitizeGaSessionNumber } from './ga-cookie-identity.ts';
import { Ga4PurchaseError, sendGa4Purchase, type Ga4PurchaseFailureCode } from './ga4-purchase.ts';

export interface TrustedPurchaseSettlement {
  /** Stripe Checkout Session id: the deterministic GA4 transaction_id. */
  transactionId: string;
  amountCents: number | null | undefined;
  currency: string | null | undefined;
  paymentStatus: string | null | undefined;
  /** One catalog item; the display name is derived here, never passed in. */
  itemId: string;
  /** Provider-signed Checkout Session metadata, re-validated before use. */
  metadata: unknown;
}

export interface TrustedPurchaseAnalytics {
  gaClientId: string | null;
  gaSessionId: string | null;
  gaSessionNumber: string | null;
  attribution: AttributionState | null;
}

export type PurchaseAnalyticsSkipReason = 'unverified_settlement' | 'not_production' | 'not_configured';

export type PurchaseAnalyticsOutcome =
  | { status: 'sent' }
  | { status: 'skipped'; reason: PurchaseAnalyticsSkipReason }
  | { status: 'failed'; code: Ga4PurchaseFailureCode | 'ga4_unexpected' };

export interface PurchaseAnalyticsDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}

export interface SchedulePurchaseAnalyticsDeps extends PurchaseAnalyticsDeps {
  setImmediateImpl?: (callback: () => void) => unknown;
  afterImpl?: ((callback: () => void | Promise<void>) => void) | null;
  /** One pre-sanitized line per dispatch. */
  log?: (line: string) => void;
}

const CHECKOUT_SESSION_ID_RE = /^cs_(?:test|live)_[A-Za-z0-9]{1,255}$/;
const MAX_AMOUNT_CENTS = 1_000_000;
const PURCHASE_ITEMS: Readonly<Record<string, string>> = Object.freeze({
  book_digital: 'HeroStoryBooks digital',
  book_classic: 'HeroStoryBooks classic',
  book_premium: 'HeroStoryBooks premium',
  print_upgrade_classic: 'Print upgrade: classic',
  print_upgrade_premium: 'Print upgrade: premium',
});

const NO_ANALYTICS: TrustedPurchaseAnalytics = Object.freeze({
  gaClientId: null,
  gaSessionId: null,
  gaSessionNumber: null,
  attribution: null,
});

function ownString(record: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** Re-validate the analytics context the checkout API wrote into Session metadata. */
export function readTrustedPurchaseAnalytics(metadata: unknown, now: number): TrustedPurchaseAnalytics {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return { ...NO_ANALYTICS };
  const record = metadata as Record<string, unknown>;
  const gaClientId = sanitizeGaClientId(ownString(record, 'gaClientId'));
  const sessionId = sanitizeGaSessionId(ownString(record, 'gaSessionId'));
  const sessionNumber = sanitizeGaSessionNumber(ownString(record, 'gaSessionNumber'));
  const paired = Boolean(gaClientId && sessionId && sessionNumber);
  return {
    gaClientId,
    gaSessionId: paired ? sessionId : null,
    gaSessionNumber: paired ? sessionNumber : null,
    attribution: attributionFromStripeMetadata(record, { now }),
  };
}

function verifiedSettlement(input: TrustedPurchaseSettlement): { amountCents: number; itemName: string } | null {
  if (typeof input.transactionId !== 'string' || !CHECKOUT_SESSION_ID_RE.test(input.transactionId)) return null;
  const amountCents = input.amountCents;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents)) return null;
  if (amountCents < 0 || amountCents > MAX_AMOUNT_CENTS) return null;
  if (input.currency !== 'usd') return null;
  const settled = input.paymentStatus === 'paid'
    || (input.paymentStatus === 'no_payment_required' && amountCents === 0);
  if (!settled) return null;
  if (!Object.prototype.hasOwnProperty.call(PURCHASE_ITEMS, input.itemId)) return null;
  return { amountCents, itemName: PURCHASE_ITEMS[input.itemId] };
}

/** Build and send the trusted GA4 purchase. Resolves with a typed outcome; never rejects. */
export async function dispatchTrustedPurchaseAnalytics(
  input: TrustedPurchaseSettlement,
  deps: PurchaseAnalyticsDeps = {},
): Promise<PurchaseAnalyticsOutcome> {
  try {
    const settlement = verifiedSettlement(input);
    if (!settlement) return { status: 'skipped', reason: 'unverified_settlement' };
    const env = deps.env ?? process.env;
    if (env.VERCEL_ENV !== 'production') return { status: 'skipped', reason: 'not_production' };
    const context = readTrustedPurchaseAnalytics(input.metadata, deps.now ?? Date.now());
    const result = await sendGa4Purchase({
      transactionId: input.transactionId,
      amountCents: settlement.amountCents,
      currency: 'usd',
      itemId: input.itemId,
      itemName: settlement.itemName,
      paymentStatus: input.paymentStatus,
      clientId: context.gaClientId,
      sessionId: context.gaSessionId,
      sessionNumber: context.gaSessionNumber,
      attribution: context.attribution,
    }, { env, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
    return result === 'sent' ? { status: 'sent' } : { status: 'skipped', reason: 'not_configured' };
  } catch (error) {
    return { status: 'failed', code: error instanceof Ga4PurchaseError ? error.code : 'ga4_unexpected' };
  }
}

function describeOutcome(outcome: PurchaseAnalyticsOutcome): string {
  switch (outcome.status) {
    case 'sent':
      return 'sent';
    case 'skipped':
      return `skipped:${outcome.reason}`;
    default:
      return `failed:${outcome.code}`;
  }
}

/**
 * Defer the dispatch past the webhook response. Both schedulers are armed —
 * `setImmediate` runs in `next start`, `after()` keeps a serverless
 * invocation alive — and they share one run, so the purchase is dispatched
 * exactly once per call whichever fires first. Nothing here can throw.
 */
export function scheduleTrustedPurchaseAnalytics(
  input: TrustedPurchaseSettlement,
  deps: SchedulePurchaseAnalyticsDeps = {},
): void {
  const transaction = typeof input.transactionId === 'string' && CHECKOUT_SESSION_ID_RE.test(input.transactionId)
    ? input.transactionId
    : '(invalid)';
  const emit = (outcome: PurchaseAnalyticsOutcome) => {
    const line = `[purchase-analytics] ga4=${describeOutcome(outcome)} transaction=${transaction}`;
    try {
      if (deps.log) deps.log(line);
      else if (outcome.status === 'failed') console.warn(line);
      else console.info(line);
    } catch {
      /* logging never reaches the webhook */
    }
  };

  let run: Promise<void> | null = null;
  const start = (): Promise<void> => {
    if (!run) run = dispatchTrustedPurchaseAnalytics(input, deps).then(emit, () => {});
    return run;
  };

  try {
    (deps.setImmediateImpl ?? setImmediate)(() => { void start(); });
  } catch {
    /* the after() path below still runs the dispatch */
  }
  try {
    deps.afterImpl?.(() => start());
  } catch {
    /* `after` outside a request scope: the setImmediate run still happens */
  }
}
