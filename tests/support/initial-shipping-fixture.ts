// Synthetic fakes for initial expedited shipping tests: transport/storage only. No real provider/store.
import { __setOrderStoreAdapterFactoryForTests, __resetOrderStoreAdapterFactoryForTests, type OrderStoreAdapter } from '../../src/lib/orders.ts';
export function syntheticOrderBlob() {
  const files = new Map<string, { body: string; version: number }>();
  const faults = { markerUnknown: false };
  const adapter: OrderStoreAdapter = {
    kind: 'test-memory',
    async readVersioned(path) {
      if (faults.markerUnknown && path.includes('order-provenance/')) throw new Error('synthetic unknown');
      const f = files.get(path); return f ? { body: f.body, version: String(f.version) } : null;
    },
    async createIfAbsent(path, body) {
      if (faults.markerUnknown && path.includes('order-provenance/')) throw new Error('synthetic unknown');
      if (files.has(path)) return { ok: false, reason: 'exists' };
      files.set(path, { body, version: 1 }); return { ok: true, version: '1' };
    },
    async replaceIfVersion(path, body, version) {
      const f = files.get(path);
      if (!f || String(f.version) !== version) return { ok: false, reason: 'version_conflict' };
      files.set(path, { body, version: f.version + 1 }); return { ok: true, version: String(f.version + 1) };
    },
  };
  __setOrderStoreAdapterFactoryForTests(() => adapter);
  return { files, faults, adapter, close: __resetOrderStoreAdapterFactoryForTests };
}
import { clearTokenCache } from '../../src/lib/lulu.ts';
import { produceShippingQuote } from '../../src/lib/shipping-quote.ts';
import type { DraftBlobPrimitives } from '../../src/lib/initial-shipping-draft.ts';
import type { MarkerStore } from '../../src/lib/initial-shipping-provenance.ts';
import type { InitialShippingProviderQualificationV1 } from '../../src/lib/initial-shipping-contract.ts';

export const INTAKE = 'intake_' + 'a'.repeat(32);
export const CAP = 'synthetic-capability-' + 'c'.repeat(40);
// Canonical ord_[a-f0-9]{16} grammar, built at runtime so no production-shaped literal is committable (REQ16).
export const synthOrderId = (c: string) => 'ord_' + c.repeat(16);
export const ORDER = synthOrderId('a');
export const FP = 'f'.repeat(64);
export const NS = '';
export const STORE_ID = 'store_synthetic';
export const CONTACT = { name: 'Synthetic Recipient', phone: '+13125550101', line1: '123 Example Lane', line2: null,
  city: 'Chicago', state: 'IL', zip: '60601', country: 'US', isBusiness: false, isPostbox: false };
export const PROVIDER: InitialShippingProviderQualificationV1 = Object.freeze({ version: 1, endpointOrigin: 'https://api.sandbox.lulu.com',
  accountBinding: 'b'.repeat(64), configurationVersion: 'cfg-1', baselineService: 'MAIL', selectedService: 'EXPEDITED',
  selectedServiceLabel: 'Expedited', stripeAccountBinding: 'd'.repeat(64), stripeLivemode: false });
export const POLICY_RAW = { version: 1, pricingRuleVersion: 'landed-delta-v1',
  promotion: { mode: 'book_only_verified', approvalRef: 'synthetic-approval' },
  ttl: { sessionTtlMs: 30 * 60 * 1000, minimumQuoteRemainingMs: 31 * 60 * 1000 },
  tax: { rule: 'landed_delta_tax_included_v1' }, paymentMethodTypes: ['card'] };

/** In-memory private Blob with ETags and fault injection. */
export function fakeBlob() {
  const files = new Map<string, { body: string; etag: number }>();
  let n = 0;
  const faults: { getThrow?: boolean; putThrowBefore?: boolean; putThrowAfter?: boolean; staleOnce?: boolean } = {};
  const io: DraftBlobPrimitives = {
    async get(p) { if (faults.getThrow) throw new Error('synthetic outage'); const f = files.get(p); return f ? { body: f.body, etag: `"${f.etag}"` } : null; },
    async put(p, body, opts) {
      if (faults.putThrowBefore) throw new Error('synthetic ambiguous');
      const cur = files.get(p);
      if (opts.create && cur) return 'precondition';
      if (!opts.create && (!cur || String(cur.etag) !== opts.ifMatch)) return 'precondition';
      if (faults.staleOnce) { faults.staleOnce = false; files.set(p, { body: cur!.body, etag: ++n }); return 'precondition'; }
      files.set(p, { body, etag: ++n });
      if (faults.putThrowAfter) throw new Error('synthetic lost response');
      return 'ok';
    },
  };
  return { io, files, faults };
}

/** OrderStoreAdapter-shaped marker store: null = absent; throws on outage. */
export function fakeMarkerStore() {
  const files = new Map<string, string>();
  const faults: { readThrow?: boolean; createThrowAfter?: boolean; createThrowBefore?: boolean } = {};
  const store: MarkerStore = {
    async readVersioned(p) { if (faults.readThrow) throw new Error('outage'); const b = files.get(p); return b === undefined ? null : { body: b, version: '1' }; },
    async createIfAbsent(p, body) {
      if (faults.createThrowBefore) throw new Error('ambiguous');
      if (files.has(p)) return { ok: false, reason: 'exists' } as const;
      files.set(p, body);
      if (faults.createThrowAfter) throw new Error('lost response');
      return { ok: true } as never;
    },
  };
  return { store, files, faults };
}

const decimal = (n: number) => (n / 100).toFixed(2);
const block = (excl: number, tax: number) => ({ total_cost_excl_tax: decimal(excl), total_tax: decimal(tax), total_cost_incl_tax: decimal(excl + tax) });
export function luluCost(shipping: number, tax: number) {
  return { currency: 'USD', line_item_costs: [{ ...block(1000, 100), quantity: 1 }], shipping_cost: block(shipping, tax),
    fulfillment_cost: block(100, 10), total_cost_excl_tax: decimal(1000 + shipping + 100),
    total_tax: decimal(100 + tax + 10), total_cost_incl_tax: decimal(1000 + shipping + 100 + 100 + tax + 10) };
}
/** Fake Lulu transport: MAIL landed 1760, EXPEDITED landed 2180 => delta 420 (tax delta 20). */
export function fakeLuluFetch(seen: string[] = [], selectedTax = 70): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url); seen.push(u);
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : {};
    if (u.endsWith('/shipping-options/')) return new Response(JSON.stringify(['MAIL', 'EXPEDITED'].map((level, i) => ({ id: i + 1, level, postbox_ok: true, transit_time: i ? 2 : 8 }))));
    if (u.endsWith('/openid-connect/token')) return new Response(JSON.stringify({ access_token: 'synthetic-only-token', expires_in: 3600 }));
    if (u.endsWith('/print-job-cost-calculations/')) return new Response(JSON.stringify(body.shipping_option === 'MAIL' ? luluCost(500, 50) : luluCost(900, selectedTax)));
    throw new Error('UNEXPECTED_SYNTHETIC_FETCH');
  }) as typeof fetch;
}
/** SDK-boundary fake shared by the real intake and shipping adapters. */
export function fakePrivateSdk() {
  const files = new Map<string, { body: string; etag: string }>();
  const calls: Array<{ op: string; path: string; options: any }> = [];
  let sequence = 0;
  const faults = { lostWrite: false, unavailable: false };
  const io = {
    get: (async (path: string, options: any) => {
      calls.push({ op: 'get', path, options });
      if (faults.unavailable) throw new Error('synthetic outage');
      const f = files.get(path);
      return f ? { stream: new Response(f.body).body, blob: { etag: f.etag, pathname: path } } : null;
    }) as NonNullable<import('../../src/lib/checkout-intake.ts').IntakeStoreIo['get']>,
    put: (async (path: string, body: string, options: any) => {
      calls.push({ op: 'put', path, options });
      if (faults.unavailable) throw new Error('synthetic outage');
      const f = files.get(path);
      if ((!options.allowOverwrite && f) || (options.ifMatch && String(options.ifMatch).replace(/^"|"$/g, '') !== f?.etag)) {
        const { BlobPreconditionFailedError } = await import('@vercel/blob');
        throw new BlobPreconditionFailedError();
      }
      files.set(path, { body, etag: String(++sequence) });
      if (faults.lostWrite) throw new Error('synthetic lost response');
      return { pathname: path };
    }) as NonNullable<import('../../src/lib/checkout-intake.ts').IntakeStoreIo['put']>,
  };
  return { files, calls, io, faults };
}

const KEYS = ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_API_URL'] as const;
export async function withLuluEnv(run: () => Promise<void>) {
  const old = KEYS.map((k) => [k, process.env[k]] as const);
  process.env.LULU_CLIENT_KEY = 'synthetic-client'; process.env.LULU_CLIENT_SECRET = 'synthetic-secret';
  process.env.LULU_API_URL = 'https://api.sandbox.lulu.com';
  clearTokenCache();
  try { await run(); } finally { clearTokenCache(); for (const [k, v] of old) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
export const realProducer = (now: () => number, fetchImpl = fakeLuluFetch()) =>
  (input: Parameters<typeof produceShippingQuote>[0], cap: number) => produceShippingQuote(input, { now, fetch: fetchImpl, authorityExpiresAtMs: cap });

/** Fresh quote/lock/payment/projection through real producers and canonical transactions.
 * Caller owns the synthetic order adapter; no consumed confirmation is reset. */
export async function presentationOrder(orders: ReturnType<typeof syntheticOrderBlob>, id = ORDER, paid = true) {
  const { createDraftStore, putShippingContact, quoteShippingDraft, selectShippingQuote } = await import('../../src/lib/initial-shipping-draft.ts');
  const { planInitialShippingProduct, parseInitialShippingCommercialPolicy } = await import('../../src/lib/initial-shipping-contract.ts');
  const { buildInitialShippingMetadata, confirmExpeditedPreProvider, buildExpeditedStripeSessionParams, initialSettlement } = await import('../../src/lib/initial-shipping-checkout.ts');
  const { createOrderRecord, settleOrderPayment, withOrderTransaction, readOrderVersioned } = await import('../../src/lib/orders.ts');
  const { settleExpeditedPayment } = await import('../../src/lib/initial-shipping-settlement.ts');
  const now = Date.now(); const blob = fakeBlob();
  const store = createDraftStore(blob.io, { namespace: NS, storeId: STORE_ID });
  const product = planInitialShippingProduct('classic', () => '0850X0850.FC.STD.PB.080CW444.GXX');
  const ctx = { flags: { quotes: true, checkout: true }, commercial: parseInitialShippingCommercialPolicy(POLICY_RAW), provider: PROVIDER };
  const deps = { store, namespace: NS, storeId: STORE_ID, now: () => now, verifyIntake: async () => ({ ok: true, expiresAtMs: now + 86_400_000 }) };
  await putShippingContact(deps, { intakeId: INTAKE, capability: CAP, contact: CONTACT, product, provider: PROVIDER });
  const q = await quoteShippingDraft(deps, { intakeId: INTAKE, capability: CAP, provider: PROVIDER, produce: realProducer(deps.now) });
  const selected = await selectShippingQuote(deps, { intakeId: INTAKE, capability: CAP, quoteId: q.quote!.quoteId });
  const metadata = buildInitialShippingMetadata({ draft: selected, selectedQuoteId: selected.selectedQuoteId!, product, bookCents: 3999, ctx, now });
  await confirmExpeditedPreProvider({ draftStore: store, markerStore: fakeMarkerStore().store, namespace: NS, intakeId: INTAKE, capability: CAP,
    canonicalOrderId: id, checkoutIntentFingerprint: FP, metadata, now });
  const order = { ...createOrderRecord({ childName: 'Synthetic', email: 'buyer@example.invalid', bookFormat: 'classic' }, { id }),
    priceCents: 3999, stripeSessionId: 'cs_synthetic', initialShipping: metadata, initialShippingSettlement: initialSettlement(new Date(now)) };
  orders.files.set(`orders/${id}.json`, { body: JSON.stringify(order), version: 1 });
  if (paid) {
    await settleOrderPayment(id, { stripeSessionId: 'cs_synthetic', stripePaymentIntentId: 'pi_synthetic', settledAmountCents: 4419 });
    const params = buildExpeditedStripeSessionParams({ orderId: id, metadata, bookProductName: 'Book', ctx, now,
      successUrl: 'https://example.invalid/s', cancelUrl: 'https://example.invalid/c', customerEmail: order.email });
    await settleExpeditedPayment({ draftStore: store, intakeId: INTAKE, now: () => now,
      event: { id: 'evt_synthetic', type: 'checkout.session.completed', created: Math.floor(now / 1000) + 1, livemode: false,
        data: { object: { id: 'cs_synthetic', payment_intent: 'pi_synthetic', payment_status: 'paid', mode: 'payment', currency: 'usd',
          amount_total: 4419, amount_subtotal: 4419, client_reference_id: id, metadata: params.metadata, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 } } } },
      expectation: { orderId: id, metadata, stripeAccountBinding: PROVIDER.stripeAccountBinding, stripeLivemode: false,
        accountBindingOf: () => PROVIDER.stripeAccountBinding, expectedSessionId: 'cs_synthetic' },
      applyToOrder: (mutate) => withOrderTransaction<'committed' | 'aborted' | 'unavailable'>(id, current => {
        const settlement = mutate(current);
        return settlement ? { commit: { ...current, initialShippingSettlement: settlement }, result: 'committed' as const } : { abort: 'aborted' as const };
      }, { notFound: () => 'unavailable' as const }),
    });
  }
  return (await readOrderVersioned(id))!.order;
}
