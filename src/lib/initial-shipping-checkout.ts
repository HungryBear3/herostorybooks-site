/** Initial expedited checkout orchestration: selection validation before the payable fingerprint,
 * immutable metadata, exact lock -> provenance marker before any provider create/URL release,
 * and itemized Stripe parameters. Standard checkout never enters this module.
 */
import type { ShippingReceipt } from './initial-shipping-client.ts';
import { validateShippingSelection } from './shipping-selection.ts';
import {
  INITIAL_SHIPPING_OPERATION, digestJson, isQuoteId, parseInitialShippingMetadata, providerBindingDigest, refuse,
  type CommercialPolicyResult, type InitialShippingFlags, type InitialShippingOrderMetadataV1,
  type InitialShippingProviderQualificationV1, type InitialShippingSettlementV1, type PlannedProduct,
} from './initial-shipping-contract.ts';
import { draftRefOf, lockShippingDraft, quoteInputFor, type DraftStore, type InitialShippingDraftV1 } from './initial-shipping-draft.ts';
import {
  ensureBoundMarker, ensureProvenanceMarker, openProvenanceAccess, readBoundMarker, readProvenanceMarker, type MarkerStore,
} from './initial-shipping-provenance.ts';

export interface ExpeditedGateContext {
  readonly flags: InitialShippingFlags;
  readonly commercial: CommercialPolicyResult;
  readonly provider: InitialShippingProviderQualificationV1 | null;
}

/** Parse the opaque selected quote ID from the final direct payload. Exactly zero or one occurrence. */
export function parseSelectedShippingQuoteId(values: readonly unknown[]): string | null {
  if (values.length === 0) return null;
  if (values.length !== 1 || !isQuoteId(values[0])) return refuse('selection_invalid');
  return values[0] as string;
}

/** Validates the private selection against server product facts; builds immutable public metadata. */
export function buildInitialShippingMetadata(args: {
  draft: InitialShippingDraftV1; selectedQuoteId: string; product: PlannedProduct; bookCents: number;
  ctx: ExpeditedGateContext; now: number;
}): InitialShippingOrderMetadataV1 {
  const { draft, ctx } = args;
  if (!ctx.flags.quotes || !ctx.flags.checkout) refuse('flag_off');
  if (!ctx.provider) return refuse('provider_unqualified');
  if ('reason' in ctx.commercial) return refuse(ctx.commercial.reason);
  if (draft.state !== 'selected' && draft.state !== 'locked') refuse('selection_invalid');
  if (draft.selectedQuoteId !== args.selectedQuoteId || !draft.quote) refuse('selection_invalid');
  if (JSON.stringify(draft.product) !== JSON.stringify(args.product)) refuse('product_drift');
  if (draft.providerBinding.accountBinding !== ctx.provider.accountBinding ||
    draft.providerBinding.endpointOrigin !== ctx.provider.endpointOrigin ||
    draft.providerBinding.configurationVersion !== ctx.provider.configurationVersion) refuse('provider_unqualified');
  const quote = (() => {
    try { return validateShippingSelection(draft.quote, quoteInputFor(draft, ctx.provider!), args.now); }
    catch (e) { return refuse(e instanceof Error && e.message === 'SHIPPING_QUOTE_EXPIRED' ? 'quote_expired' : 'selection_invalid'); }
  })();
  if (quote.expiresAtMs - args.now < ctx.commercial.policy.ttl.minimumQuoteRemainingMs) refuse('session_expired');
  if (!Number.isSafeInteger(args.bookCents) || args.bookCents <= 0) refuse('input_invalid');
  const deltaTaxIncludedCents = Math.max(0, Math.min(quote.deltaCents, quote.selected.taxCents - quote.baseline.taxCents));
  const metadata = parseInitialShippingMetadata({
    version: 1, operation: INITIAL_SHIPPING_OPERATION, draftRef: draftRefOf(draft.intakeId, draft.namespace),
    quoteId: quote.quoteId, quoteBindingDigest: digestJson(['quote', quote.binding, quote.quoteId]),
    product: { bookFormat: args.product.bookFormat, podPackageId: args.product.podPackageId,
      interiorPageCount: args.product.interiorPageCount, layoutVersion: args.product.layoutVersion,
      plannedProductVersion: args.product.plannedProductVersion },
    service: { baseline: quote.input.baselineService, selected: quote.input.selectedService, selectedLabel: 'Expedited' },
    currency: 'USD',
    totals: { bookCents: args.bookCents, deltaCents: quote.deltaCents, deltaTaxIncludedCents,
      selectedLandedCents: quote.selected.totalCents, totalCents: args.bookCents + quote.deltaCents },
    quoteWindow: { issuedAtMs: quote.issuedAtMs, expiresAtMs: quote.expiresAtMs },
    providerBindingDigest: providerBindingDigest(ctx.provider), pricingRuleVersion: ctx.commercial.policy.pricingRuleVersion,
  });
  return metadata ?? refuse('metadata_malformed');
}

/** Payable-fingerprint contribution: present only for expedited, so standard fingerprint bytes are unchanged. */
export function shippingFingerprintTuple(m: InitialShippingOrderMetadataV1 | undefined): Record<string, unknown> {
  if (!m) return {};
  return { initialShipping: [m.quoteId, m.quoteBindingDigest, m.service.selected, m.totals.bookCents, m.totals.deltaCents, m.totals.totalCents] };
}

export const initialSettlement = (now: Date): InitialShippingSettlementV1 =>
  Object.freeze({ version: 1, state: 'unverified', receiptDigest: null, reason: null, updatedAt: now.toISOString() });

/** Omitted store => bound production order-store access (namespace must equal the draft's); null => unavailable. */
async function provenanceGate(store: MarkerStore | null | undefined, namespace: string | undefined, draftNamespace: string,
  orderId: string, mode: 'ensure' | 'read', transport?: import('./orders.ts').InitialShippingProvenanceTransport): Promise<boolean> {
  if (store === null) return false;
  if (store === undefined) {
    const access = openProvenanceAccess(transport);
    if (!access || access.namespace !== draftNamespace) return false;
    const ok = mode === 'ensure' ? (await ensureBoundMarker(access, orderId)) === 'confirmed' : (await readBoundMarker(access, orderId)) === 'present';
    return ok && access.intact();
  }
  const ns = namespace ?? draftNamespace;
  return mode === 'ensure' ? (await ensureProvenanceMarker(store, ns, orderId)) === 'confirmed' : (await readProvenanceMarker(store, ns, orderId)) === 'present';
}

/** locked -> provenance_confirmed: run after canonical order resolution and before any provider create/URL release. */
export async function confirmExpeditedPreProvider(args: {
  provenanceTransport?: import('./orders.ts').InitialShippingProvenanceTransport;
  draftStore: DraftStore; markerStore?: MarkerStore | null; namespace?: string; intakeId: string; capability: string;
  canonicalOrderId: string; checkoutIntentFingerprint: string; metadata: InitialShippingOrderMetadataV1; now: number;
}): Promise<InitialShippingDraftV1> {
  if (args.now >= args.metadata.quoteWindow.expiresAtMs) refuse('session_expired');
  const locked = await lockShippingDraft(args.draftStore, { intakeId: args.intakeId, capability: args.capability,
    canonicalOrderId: args.canonicalOrderId, checkoutIntentFingerprint: args.checkoutIntentFingerprint,
    quoteId: args.metadata.quoteId, now: args.now });
  if (!(await provenanceGate(args.markerStore, args.namespace, locked.namespace, args.canonicalOrderId, 'ensure', args.provenanceTransport))) refuse('provenance_unavailable');
  return locked;
}

/** Rechecked immediately before a new/replacement provider create AND before releasing an existing session URL. */
export async function assertExpeditedProviderRelease(args: {
  provenanceTransport?: import('./orders.ts').InitialShippingProvenanceTransport;
  markerStore?: MarkerStore | null; namespace?: string; orderId: string; metadata: InitialShippingOrderMetadataV1;
  draft: InitialShippingDraftV1 | null; ctx: ExpeditedGateContext; now: number; sessionExpiresAtMs?: number | null;
}): Promise<void> {
  if (!args.ctx.provider) refuse('provider_unqualified');
  if ('reason' in args.ctx.commercial) return refuse(args.ctx.commercial.reason);
  if (!args.draft || args.draft.state !== 'locked' || args.draft.lock?.canonicalOrderId !== args.orderId ||
    args.draft.lock.quoteId !== args.metadata.quoteId) refuse('lock_conflict');
  if (!(await provenanceGate(args.markerStore, args.namespace, args.draft!.namespace, args.orderId, 'read', args.provenanceTransport))) refuse('provenance_unavailable');
  if (args.now >= args.metadata.quoteWindow.expiresAtMs) refuse('session_expired');
  if (args.sessionExpiresAtMs != null && (args.sessionExpiresAtMs > args.metadata.quoteWindow.expiresAtMs || args.now >= args.sessionExpiresAtMs)) refuse('session_expired');
}

/** Exact itemized Stripe Checkout params for expedited. priceCents stays the book price. */
export function buildExpeditedStripeSessionParams(args: {
  orderId: string; metadata: InitialShippingOrderMetadataV1; bookProductName: string; ctx: ExpeditedGateContext; now: number;
  successUrl: string; cancelUrl: string; customerEmail: string; bookProductId?: string;
}): Record<string, unknown> {
  const { metadata: m, ctx } = args;
  if ('reason' in ctx.commercial) return refuse(ctx.commercial.reason);
  const expiresAtSec = Math.floor((args.now + ctx.commercial.policy.ttl.sessionTtlMs) / 1000);
  if (expiresAtSec * 1000 > m.quoteWindow.expiresAtMs) refuse('ttl_policy_unqualified');
  return {
    mode: 'payment',
    ...(args.bookProductId ? { allow_promotion_codes: true } : {}),
    payment_method_types: [...ctx.commercial.policy.paymentMethodTypes],
    customer_email: args.customerEmail,
    client_reference_id: args.orderId,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    expires_at: expiresAtSec,
    line_items: [
      { quantity: 1, price_data: { currency: 'usd', unit_amount: m.totals.bookCents, ...(args.bookProductId ? { product: args.bookProductId } : { product_data: { name: args.bookProductName } }) } },
      { quantity: 1, price_data: { currency: 'usd', unit_amount: m.totals.deltaCents,
        product_data: { name: 'Expedited shipping upgrade', description: 'Standard shipping included; this is the added cost for Expedited (shipping tax included).' } } },
    ],
    metadata: { orderId: args.orderId, hsbShipping: 'initial_expedited_v1', hsbShippingQuote: m.quoteId, hsbShippingBinding: m.quoteBindingDigest.slice(0, 32) },
    payment_intent_data: { metadata: { orderId: args.orderId, hsbShipping: 'initial_expedited_v1' } },
  };
}
import { createPrivateShippingDraftAccess, putShippingContact, quoteShippingDraft, selectShippingQuote, clearShippingSelection, type DraftOwnerDeps } from './initial-shipping-draft.ts';
import { assertCapability, assertIntakeUsable, parseIntakeRecord, readJsonTextWithLimit, type IntakeStoreIo } from './checkout-intake.ts';
import { assertBrowserMutationRequest } from './checkout-request-guard.ts';
import { checkoutAttemptLeaseCookieFromHeader, checkoutAttemptLeaseHeaderMatchesCookie, CHECKOUT_ATTEMPT_LEASE_HEADER } from './checkout-attempt-lease.ts';
import { isDirectUploadServerEnabled } from './checkout-direct-flags.ts';
import { parseInitialShippingCommercialPolicy, readOrderInitialShipping, InitialShippingError, exactObject, parseInitialShippingProviderQualification, planInitialShippingProduct, readInitialShippingFlags, sha256, INITIAL_SHIPPING_OWNER_COPY } from './initial-shipping-contract.ts';
import { podPackageIdForFormat } from './lulu.ts';
import { getBookFormatMeta, getStoryPageCount, type OrderRecord } from './orders.ts';
import { getPrintInteriorPageCount } from './pdf-builder.ts';
import type { StoryContent } from './fulfillment-types.ts';
import { SHIPPING_PRICING_RULES } from './analytics-event-contract.ts';
import { produceShippingQuote } from './shipping-quote.ts';

/** Only transport/clock seams: tests do not replace ownership, normalization or quote decisions. */
export interface ShippingRouteOptions {
  env?: NodeJS.ProcessEnv; now?: () => number; blob?: IntakeStoreIo; fetch?: typeof globalThis.fetch;
}
function shippingRequestJson(text: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(text);
  // JSON.parse alone silently adopts duplicate keys, including escaped aliases.
  const stack: Array<Set<string> | null> = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const t = token[0];
    if (t === '{') stack.push(new Set());
    else if (t === '[') stack.push(null);
    else if (t === '}' || t === ']') stack.pop();
    else if (/^\s*:/.test(text.slice(token.index! + t.length))) {
      const keys = stack.at(-1); const key = JSON.parse(t) as string;
      if (!keys || keys.has(key)) refuse('input_invalid');
      keys.add(key);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('input_invalid');
  return raw as Record<string, unknown>;
}
function currentShippingProduct(format: unknown): PlannedProduct {
  const product = planInitialShippingProduct(format, podPackageIdForFormat);
  // Use the current PDF planner, not a browser page count or a second layout formula.
  const interiorPageCount = getPrintInteriorPageCount(
    { pages: Array.from({ length: getStoryPageCount(product.bookFormat) }) } as StoryContent,
    { bookFormat: product.bookFormat, layoutVersion: product.layoutVersion } as OrderRecord);
  if (interiorPageCount !== product.interiorPageCount) return refuse('product_drift');
  return product;
}
function qualifiedShippingProvider(env: NodeJS.ProcessEnv): InitialShippingProviderQualificationV1 {
  let raw: unknown;
  try { raw = JSON.parse(env.HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION ?? 'null'); } catch { return refuse('provider_unqualified'); }
  const provider = parseInitialShippingProviderQualification(raw);
  // Lulu transport reads process.env. Bind qualification to that exact configured account and baseline.
  const origin = (process.env.LULU_API_URL ?? 'https://api.lulu.com').replace(/\/$/, '');
  if (!provider || !process.env.LULU_CLIENT_KEY || !process.env.LULU_CLIENT_SECRET ||
    provider.endpointOrigin !== origin || provider.accountBinding !== sha256(process.env.LULU_CLIENT_KEY) ||
    provider.baselineService !== (process.env.LULU_SHIPPING_LEVEL ?? 'MAIL')) return refuse('provider_unqualified');
  return provider;
}

/** Real POST dispatcher. No public GET, no customer data in errors, logs or analytics. */
export function createShippingRouteHandler(options: ShippingRouteOptions = {}): (request: Request) => Promise<Response> {
  const env = options.env ?? process.env; const now = options.now ?? Date.now;
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  return async (request) => {
    if (!isDirectUploadServerEnabled(env) || !readInitialShippingFlags(env).quotes) return reply({ error: 'not_found' }, 404);
    try {
      if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
      assertBrowserMutationRequest(request);
      if (!checkoutAttemptLeaseHeaderMatchesCookie(checkoutAttemptLeaseCookieFromHeader(request.headers.get('cookie')),
        request.headers.get(CHECKOUT_ATTEMPT_LEASE_HEADER))) refuse('owner_invalid');
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !request.body) refuse('input_invalid');
      let body: Record<string, unknown>;
      try { body = shippingRequestJson(await readJsonTextWithLimit(request.body!, 16 * 1024)); } catch { return reply({ error: 'input_invalid' }, 400); }
      const extras = body.op === 'put_contact' ? ['contact', 'bookFormat'] : body.op === 'select' ? ['quoteId'] : [];
      if (!['put_contact', 'quote', 'select', 'clear'].includes(body.op as string) ||
        !exactObject(body, ['op', 'intakeId', 'capability', ...extras]) || typeof body.intakeId !== 'string' ||
        !/^intake_[a-f0-9]{32}$/.test(body.intakeId) || typeof body.capability !== 'string' || body.capability.length < 32 || body.capability.length > 256) refuse('input_invalid');
      const intakeId = body.intakeId as string; const capability = body.capability as string;
      const product = body.op === 'put_contact' ? currentShippingProduct(body.bookFormat) : null;
      const provider = qualifiedShippingProvider(env);
      const providerSnapshot = JSON.stringify(provider);
      const transportSnapshot = sha256(JSON.stringify([process.env.LULU_CLIENT_KEY, process.env.LULU_CLIENT_SECRET, process.env.LULU_API_URL, process.env.LULU_SHIPPING_LEVEL]));
      const access = createPrivateShippingDraftAccess(env, options.blob);
      const deps: DraftOwnerDeps = { ...access, now, verifyIntake: async (id, cap) => {
        if (!access.intact() || !isDirectUploadServerEnabled(env) || !readInitialShippingFlags(env).quotes ||
          JSON.stringify(qualifiedShippingProvider(env)) !== providerSnapshot ||
          sha256(JSON.stringify([process.env.LULU_CLIENT_KEY, process.env.LULU_CLIENT_SECRET, process.env.LULU_API_URL, process.env.LULU_SHIPPING_LEVEL])) !== transportSnapshot) refuse('owner_invalid');
        const snapshot = await access.intake.read(id);
        if (!snapshot) return refuse('owner_invalid');
        const record = parseIntakeRecord(snapshot.record, { namespace: access.namespace });
        if (record.intakeId !== id) refuse('owner_invalid');
        assertCapability(record, cap); assertIntakeUsable(record, now());
        return { ok: true, expiresAtMs: Date.parse(record.expiresAt) };
      } };
      await deps.verifyIntake(intakeId, capability);
      let result: InitialShippingDraftV1;
      if (body.op === 'put_contact') {
        result = await putShippingContact(deps, { intakeId, capability, contact: body.contact, product: product!, provider });
      } else {
        const current = await access.store.read(intakeId);
        if (!current) {
          if (body.op !== 'clear') return refuse('draft_absent');
          // Only the authenticated private adapter's authoritative null is empty.
          // Reauthorize after that awaited read; unknown reads still throw.
          await deps.verifyIntake(intakeId, capability);
          if (!access.intact() || !isDirectUploadServerEnabled(env) || !readInitialShippingFlags(env).quotes ||
            JSON.stringify(qualifiedShippingProvider(env)) !== providerSnapshot ||
            sha256(JSON.stringify([process.env.LULU_CLIENT_KEY, process.env.LULU_CLIENT_SECRET, process.env.LULU_API_URL, process.env.LULU_SHIPPING_LEVEL])) !== transportSnapshot) refuse('owner_invalid');
          return reply({ version: 1, state: 'empty' });
        }
        if (current.record.ownerHash !== sha256(capability)) refuse('owner_invalid');
        const expected = currentShippingProduct(current.record.product.bookFormat);
        if (JSON.stringify(expected) !== JSON.stringify(current.record.product)) refuse('product_drift');
        if (JSON.stringify(current.record.providerBinding) !== JSON.stringify({ endpointOrigin: provider.endpointOrigin,
          accountBinding: provider.accountBinding, configurationVersion: provider.configurationVersion })) refuse('provider_unqualified');
        if (body.op === 'quote') result = await quoteShippingDraft(deps, { intakeId, capability, provider,
          produce: async (input, cap) => {
            const quote = await produceShippingQuote(input, { now, fetch: options.fetch, authorityExpiresAtMs: cap });
            if (JSON.stringify(currentShippingProduct(current.record.product.bookFormat)) !== JSON.stringify(expected)) refuse('product_drift');
            return quote;
          } });
        else if (body.op === 'select') {
          if (!current.record.quote) refuse('selection_invalid');
          validateShippingSelection(current.record.quote, quoteInputFor(current.record, provider), now());
          result = await selectShippingQuote(deps, { intakeId, capability, quoteId: body.quoteId });
        } else result = await clearShippingSelection(deps, { intakeId, capability });
      }
      const bookCents = getBookFormatMeta(result.product.bookFormat).priceCents;
      // Same validated integer-cent receipt and included-tax clamp as immutable metadata.
      // Explicit public fields only; never spread the private receipt/draft.
      const pricedQuote = result.quote ? validateShippingSelection(result.quote, quoteInputFor(result, provider), result.quote.issuedAtMs) : null;
      const deltaCents = pricedQuote?.deltaCents ?? 0;
      const deltaTaxIncludedCents = pricedQuote
        ? Math.max(0, Math.min(deltaCents, pricedQuote.selected.taxCents - pricedQuote.baseline.taxCents)) : 0;
      // Projection only: missing/unrecognized analytics labels never change sale authority.
      let pricingRuleVersion: 'landed-delta-v1' | null = null;
      try {
        const policy = parseInitialShippingCommercialPolicy(JSON.parse(env.HSB_INITIAL_EXPEDITED_COMMERCIAL_POLICY ?? 'null'));
        if (policy.qualified && SHIPPING_PRICING_RULES.some(rule => rule === policy.policy.pricingRuleVersion)) pricingRuleVersion = 'landed-delta-v1';
      } catch { /* no label when policy is unavailable */ }
      return reply({ ...(pricingRuleVersion ? { pricingRuleVersion } : {}), bookFormat: result.product.bookFormat, revision: result.revision,
        bookCents, deltaCents, deltaTaxIncludedCents, totalCents: bookCents + deltaCents,
        contact: result.contact, selectedQuoteId: result.selectedQuoteId,
        quote: result.quote ? { quoteId: result.quote.quoteId, service: result.quote.input.selectedService,
          label: 'Expedited', deltaCents: result.quote.deltaCents, expiresAtMs: result.quote.expiresAtMs,
          transitDays: result.quote.transitDays } : null, estimate: INITIAL_SHIPPING_OWNER_COPY } satisfies ShippingReceipt & { contact: typeof result.contact });
    } catch (error) {
      return reply({ error: error instanceof InitialShippingError ? error.code : 'shipping_request_rejected' },
        error instanceof InitialShippingError && error.code === 'store_unavailable' ? 503 : 400);
    }
  };
}

/** Server-owned admission and renewable authority for the existing order provisioner.
 * Only Blob transport is injectable; flags, policy, product, intake and provenance remain real.
 */
export async function openInitialShippingCheckout(args: {
  intakeId: string; capability: string; quoteId: string; bookFormat: string; bookCents: number; blob?: IntakeStoreIo;
  provenanceTransport?: import('./orders.ts').InitialShippingProvenanceTransport;
}) {
  const env = process.env;
  const context = (): ExpeditedGateContext => {
    let raw: unknown; try { raw = JSON.parse(env.HSB_INITIAL_EXPEDITED_COMMERCIAL_POLICY ?? 'null'); } catch { raw = null; }
    return { flags: readInitialShippingFlags(env), provider: qualifiedShippingProvider(env), commercial: parseInitialShippingCommercialPolicy(raw) };
  };
  const captured = JSON.stringify(context());
  const access = createPrivateShippingDraftAccess(env, args.blob);
  const owner = async (orderId?: string) => {
    if (!access.intact() || !isDirectUploadServerEnabled(env) || JSON.stringify(context()) !== captured) refuse('owner_invalid');
    const snapshot = await access.intake.read(args.intakeId);
    if (!access.intact() || !isDirectUploadServerEnabled(env) || JSON.stringify(context()) !== captured) refuse('owner_invalid');
    if (!snapshot) return refuse('owner_invalid');
    const record = parseIntakeRecord(snapshot.record, { namespace: access.namespace });
    assertCapability(record, args.capability);
    if (record.intakeId !== args.intakeId || record.cleanupClaim || Date.parse(record.expiresAt) <= Date.now() ||
      (record.finalizedOrderId && record.finalizedOrderId !== orderId) ||
      (record.finalization && record.finalization.orderId !== orderId)) refuse('owner_invalid');
  };
  const selected = await access.store.read(args.intakeId);
  await owner(selected?.record.lock?.canonicalOrderId);
  if (!selected || selected.record.ownerHash !== sha256(args.capability)) return refuse('owner_invalid');
  const metadata = buildInitialShippingMetadata({ draft: selected.record, selectedQuoteId: args.quoteId,
    product: currentShippingProduct(args.bookFormat), bookCents: args.bookCents, ctx: context(), now: selected.record.lock ? selected.record.quote!.issuedAtMs : Date.now() });
  if (Date.now() >= metadata.quoteWindow.expiresAtMs) refuse('session_expired');
  let canonical: string | undefined;
  let fingerprint: string | undefined;
  const check = async (order: OrderRecord, sessionExpiresAtMs?: number) => {
    const terms = readOrderInitialShipping(order);
    if (!canonical || order.id !== canonical || order.checkoutIntentFingerprint !== fingerprint ||
      terms.kind !== 'present' || JSON.stringify(terms.metadata) !== JSON.stringify(metadata)) refuse('metadata_malformed');
    await owner(order.id);
    const current = await access.store.read(args.intakeId);
    if (!current || current.record.ownerHash !== sha256(args.capability) || current.record.lock?.checkoutIntentFingerprint !== fingerprint) refuse('lock_conflict');
    // Validate the exact receipt/product again, but existing URLs need not have a fresh 30-minute window.
    const rebuilt = buildInitialShippingMetadata({ draft: current!.record, selectedQuoteId: args.quoteId,
      product: currentShippingProduct(args.bookFormat), bookCents: order.priceCents, ctx: context(), now: metadata.quoteWindow.issuedAtMs });
    if (JSON.stringify(rebuilt) !== JSON.stringify(metadata)) refuse('selection_invalid');
    await assertExpeditedProviderRelease({ provenanceTransport: args.provenanceTransport, orderId: order.id, metadata, draft: current!.record, ctx: context(),
      now: Date.now(), sessionExpiresAtMs });
    await owner(order.id);
    if (Date.now() >= metadata.quoteWindow.expiresAtMs || (sessionExpiresAtMs != null && Date.now() >= sessionExpiresAtMs)) refuse('session_expired');
  };
  return {
    metadata,
    async confirm(order: OrderRecord) {
      canonical = order.id; fingerprint = order.checkoutIntentFingerprint!;
      await owner(order.id);
      await confirmExpeditedPreProvider({ provenanceTransport: args.provenanceTransport, draftStore: access.store, intakeId: args.intakeId, capability: args.capability,
        canonicalOrderId: order.id, checkoutIntentFingerprint: fingerprint, metadata, now: Date.now() });
      await check(order);
    },
    check,
    async createParams(order: OrderRecord, productId: string, baseUrl: string) {
      await check(order);
      const ctx = context();
      if ('reason' in ctx.commercial) return refuse(ctx.commercial.reason);
      if (metadata.quoteWindow.expiresAtMs - Date.now() < ctx.commercial.policy.ttl.minimumQuoteRemainingMs) refuse('session_expired');
      return buildExpeditedStripeSessionParams({ orderId: order.id, metadata, bookProductName: order.formatLabel,
        bookProductId: productId, ctx, now: Date.now(), customerEmail: order.email,
        successUrl: `${baseUrl}/thank-you?orderId=${order.id}&sessionId={CHECKOUT_SESSION_ID}`, cancelUrl: `${baseUrl}/checkout` });
    },
  };
}
export type InitialShippingCheckoutAuthority = Awaited<ReturnType<typeof openInitialShippingCheckout>>;

export const expectedExpeditedSubtotalCents = (m: InitialShippingOrderMetadataV1): number => m.totals.bookCents + m.totals.deltaCents;
