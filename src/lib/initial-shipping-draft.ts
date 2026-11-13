/** One private CAS draft record for initial expedited shipping: adapter, owner operations and lock.
 * Path is outside `intakes/` so intake cleanup never lists it. No delete, no list authority, no cleanup job.
 */
import { timingSafeEqual } from 'node:crypto';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { getBlobNamespace } from './blob-namespace.ts';
import { normalizeEtagForIfMatch } from './blob-etag.ts';
import { parseBlobToken } from './checkout-blob-identity.ts';
import { getRequiredIntakeBlobToken, readJsonTextWithLimit, createVercelIntakeStore, type IntakeStoreIo } from './checkout-intake.ts';

/** Bound once to the existing dedicated intake credential. Shipping records never enter the intake schema. */
export function createPrivateShippingDraftAccess(env: NodeJS.ProcessEnv = process.env, io: IntakeStoreIo = {}) {
  const token = getRequiredIntakeBlobToken(env);
  const namespace = getBlobNamespace(env);
  const { storeId } = parseBlobToken(token, 'intake');
  const getImpl = io.get ?? get; const putImpl = io.put ?? put;
  const primitives: DraftBlobPrimitives = {
    async get(pathname) {
      const result = await getImpl(pathname, { access: 'private', token, useCache: false });
      if (result === null) return null;
      if (!result?.stream) return refuse('store_unavailable');
      const body = await readJsonTextWithLimit(result.stream, MAX_BODY);
      const etag = normalizeEtagForIfMatch(result.blob.etag);
      if (!etag) return refuse('store_unavailable');
      return { body, etag };
    },
    async put(pathname, body, opts) {
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY || (!opts.create && !opts.ifMatch)) return refuse('draft_malformed');
      try {
        await putImpl(pathname, body, { access: 'private', token, addRandomSuffix: false,
          allowOverwrite: !opts.create, ...(opts.create ? {} : { ifMatch: opts.ifMatch }), contentType: 'application/json' });
        return 'ok';
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return 'precondition';
        throw error;
      }
    },
  };
  return Object.freeze({ namespace, storeId, store: createDraftStore(primitives, { namespace, storeId }),
    intake: createVercelIntakeStore(token, env, io),
    intact: () => { try { return token === getRequiredIntakeBlobToken(env) && namespace === getBlobNamespace(env); } catch { return false; } } });
}
import { applyBlobNamespace } from './blob-namespace.ts';
import { normalizeShippingContact, validateShippingSelection, type ShippingContact, type ShippingInput, type ShippingQuote } from './shipping-selection.ts';
import {
  INITIAL_SHIPPING_OPERATION, ORDER_ID, exactObject, isHex64, isQuoteId, refuse, sha256,
  type InitialShippingProviderQualificationV1, type PlannedProduct,
} from './initial-shipping-contract.ts';

export type DraftState = 'editing' | 'quoted' | 'selected' | 'locked' | 'payment_recorded' | 'held';
export interface DraftLock {
  readonly canonicalOrderId: string; readonly checkoutIntentFingerprint: string; readonly quoteId: string;
  readonly binding: string; readonly lockedRevision: number;
}
export interface DraftPaymentEvidence {
  readonly accountBinding: string; readonly livemode: boolean; readonly sessionId: string; readonly paymentIntentId: string;
  readonly amountTotalCents: number; readonly amountSubtotalCents: number; readonly currency: 'usd';
  readonly eventId: string; readonly eventType: 'checkout.session.completed'; readonly eventCreatedMs: number;
}
export interface InitialShippingDraftV1 {
  readonly version: 1; readonly operation: typeof INITIAL_SHIPPING_OPERATION; readonly intakeId: string;
  readonly ownerHash: string; readonly namespace: string; readonly storeId: string; readonly revision: number;
  readonly createdAt: number; readonly editableUntil: number; readonly contact: ShippingContact | null;
  readonly product: PlannedProduct; readonly providerBinding: { readonly endpointOrigin: string; readonly accountBinding: string; readonly configurationVersion: string };
  readonly quote: ShippingQuote | null; readonly selectedQuoteId: string | null; readonly state: DraftState;
  readonly lock: DraftLock | null; readonly payment: DraftPaymentEvidence | null;
  readonly holdReason: string | null; readonly completionMetricIntentAt: number | null;
}
const DRAFT_KEYS = ['version', 'operation', 'intakeId', 'ownerHash', 'namespace', 'storeId', 'revision', 'createdAt',
  'editableUntil', 'contact', 'product', 'providerBinding', 'quote', 'selectedQuoteId', 'state', 'lock', 'payment',
  'holdReason', 'completionMetricIntentAt'] as const;
const INTAKE_ID = /^intake_[a-f0-9]{32}$/; // existing checkout-intake grammar

export function draftPath(intakeId: string, namespace: string): string {
  if (!INTAKE_ID.test(intakeId)) refuse('input_invalid');
  return applyBlobNamespace(`checkout-shipping-drafts/${intakeId}.json`, namespace);
}
export const draftRefOf = (intakeId: string, namespace: string): string => sha256(draftPath(intakeId, namespace));

/** Strict parse: wrong key, identity, state shape or quote receipt are malformed (never absent). */
export function parseDraft(body: string, expect: { intakeId: string; namespace: string; storeId: string }): InitialShippingDraftV1 {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return refuse('draft_malformed'); }
  const r = exactObject(raw, DRAFT_KEYS);
  if (!r || r.version !== 1 || r.operation !== INITIAL_SHIPPING_OPERATION || r.intakeId !== expect.intakeId ||
    r.namespace !== expect.namespace || r.storeId !== expect.storeId || !isHex64(r.ownerHash) ||
    !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Number.isSafeInteger(r.createdAt) ||
    !Number.isSafeInteger(r.editableUntil) || !['editing', 'quoted', 'selected', 'locked', 'payment_recorded', 'held'].includes(r.state as string)) {
    return refuse('draft_malformed');
  }
  const d = r as unknown as InitialShippingDraftV1;
  if (d.contact !== null) { try { normalizeShippingContact(d.contact); } catch { refuse('draft_malformed'); } }
  if ((d.state === 'editing') !== (d.quote === null) && d.state === 'editing') refuse('draft_malformed');
  if (d.selectedQuoteId !== null && (!isQuoteId(d.selectedQuoteId) || d.quote?.quoteId !== d.selectedQuoteId)) refuse('draft_malformed');
  if (['locked', 'payment_recorded'].includes(d.state) && (!d.lock || !ORDER_ID.test(d.lock.canonicalOrderId) ||
    d.lock.quoteId !== d.selectedQuoteId)) refuse('draft_malformed');
  if (d.state === 'payment_recorded' && !d.payment) refuse('draft_malformed');
  return d;
}

// ---- adapter over existing private Blob primitives (injected; tests use a fake store) ----
export interface DraftBlobPrimitives {
  /** Private, uncached read. null = authoritative absence. Throw = unavailable (never absence). */
  get(pathname: string): Promise<{ body: string; etag: string } | null>;
  /** create: overwrite false. replace: overwrite true + ifMatch. 'precondition' only on store-side refusal. Throw = ambiguous. */
  put(pathname: string, body: string, opts: { readonly create: boolean; readonly ifMatch?: string }): Promise<'ok' | 'precondition'>;
}
export type DraftWrite = 'written' | 'conflict' | 'ambiguous';
export interface DraftStore {
  read(intakeId: string): Promise<{ record: InitialShippingDraftV1; etag: string } | null>;
  createIfAbsent(record: InitialShippingDraftV1): Promise<DraftWrite>;
  updateIfMatch(record: InitialShippingDraftV1, etag: string): Promise<DraftWrite>;
}
const MAX_BODY = 64 * 1024;
export function createDraftStore(io: DraftBlobPrimitives, identity: { namespace: string; storeId: string }): DraftStore {
  const ns = identity.namespace; const storeId = identity.storeId; // snapshot at construction
  const read = async (intakeId: string) => {
    let got: { body: string; etag: string } | null;
    try { got = await io.get(draftPath(intakeId, ns)); } catch { return refuse('store_unavailable'); }
    if (got === null) return null;
    if (typeof got.body !== 'string' || got.body.length > MAX_BODY || typeof got.etag !== 'string' || !got.etag) refuse('draft_malformed');
    return { record: parseDraft(got.body, { intakeId, namespace: ns, storeId }), etag: got.etag.replace(/^W\//, '').replace(/"/g, '') };
  };
  /** After an ambiguous write, adopt only exact expected content; unknown otherwise. */
  const settle = async (record: InitialShippingDraftV1): Promise<DraftWrite> => {
    try {
      const again = await read(record.intakeId);
      return again && JSON.stringify(again.record) === JSON.stringify(record) ? 'written' : 'ambiguous';
    } catch { return 'ambiguous'; }
  };
  return {
    read,
    async createIfAbsent(record) {
      if (record.namespace !== ns || record.storeId !== storeId) refuse('draft_conflict');
      try {
        const r = await io.put(draftPath(record.intakeId, ns), JSON.stringify(record), { create: true });
        return r === 'ok' ? 'written' : 'conflict';
      } catch { return settle(record); }
    },
    async updateIfMatch(record, etag) {
      if (record.namespace !== ns || record.storeId !== storeId) refuse('draft_conflict');
      try {
        const r = await io.put(draftPath(record.intakeId, ns), JSON.stringify(record), { create: false, ifMatch: etag });
        return r === 'ok' ? 'written' : 'conflict';
      } catch { return settle(record); }
    },
  };
}

// ---- owner authority ----
export interface IntakeOwnerCheck { readonly ok: boolean; readonly expiresAtMs: number }
export interface DraftOwnerDeps {
  readonly store: DraftStore; readonly namespace: string; readonly storeId: string; readonly now: () => number;
  /** Real intake capability + usable/unexpired check (existing intake authority); never a browser cookie alone. */
  readonly verifyIntake: (intakeId: string, capability: string) => Promise<IntakeOwnerCheck>;
}
function ownerMatches(capability: string, ownerHash: string): boolean {
  const a = Buffer.from(sha256(capability), 'utf8'); const b = Buffer.from(ownerHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
async function authorize(deps: DraftOwnerDeps, intakeId: string, capability: unknown): Promise<IntakeOwnerCheck> {
  if (typeof capability !== 'string' || capability.length < 32 || capability.length > 256 || !INTAKE_ID.test(intakeId)) refuse('owner_invalid');
  const check = await deps.verifyIntake(intakeId, capability as string);
  if (!check.ok || !Number.isSafeInteger(check.expiresAtMs) || deps.now() >= check.expiresAtMs) refuse('owner_invalid');
  return check;
}
const MAX_CAS = 4;
async function mutate(deps: DraftOwnerDeps, intakeId: string, capability: string,
  fn: (d: InitialShippingDraftV1) => InitialShippingDraftV1): Promise<InitialShippingDraftV1> {
  for (let i = 0; i < MAX_CAS; i++) {
    const cur = await deps.store.read(intakeId);
    if (!cur) return refuse('draft_absent');
    if (!ownerMatches(capability, cur.record.ownerHash)) refuse('owner_invalid');
    await authorize(deps, intakeId, capability);
    const next = fn(cur.record);
    const w = await deps.store.updateIfMatch(next, cur.etag);
    if (w === 'written') return next;
    if (w === 'ambiguous') refuse('store_unavailable');
  }
  return refuse('draft_conflict');
}
const editable = (d: InitialShippingDraftV1, now: number) => {
  if (['locked', 'payment_recorded', 'held'].includes(d.state)) refuse('draft_locked');
  if (now >= d.editableUntil) refuse('draft_expired');
};

/** put_contact: create or edit. A contact/format change increments revision and clears quote/selection. */
export async function putShippingContact(deps: DraftOwnerDeps, args: {
  intakeId: string; capability: unknown; contact: unknown; product: PlannedProduct; provider: InitialShippingProviderQualificationV1;
}): Promise<InitialShippingDraftV1> {
  const owner = await authorize(deps, args.intakeId, args.capability);
  const contact = (() => { try { return normalizeShippingContact(args.contact); } catch { return refuse('input_invalid'); } })();
  const now = deps.now();
  const providerBinding = { endpointOrigin: args.provider.endpointOrigin, accountBinding: args.provider.accountBinding,
    configurationVersion: args.provider.configurationVersion };
  const existing = await deps.store.read(args.intakeId);
  if (!existing) {
    const record: InitialShippingDraftV1 = { version: 1, operation: INITIAL_SHIPPING_OPERATION, intakeId: args.intakeId,
      ownerHash: sha256(args.capability as string), namespace: deps.namespace, storeId: deps.storeId, revision: 1,
      createdAt: now, editableUntil: owner.expiresAtMs, contact, product: args.product, providerBinding, quote: null,
      selectedQuoteId: null, state: 'editing', lock: null, payment: null, holdReason: null, completionMetricIntentAt: null };
    const w = await deps.store.createIfAbsent(record);
    if (w === 'written') return record;
    if (w === 'ambiguous') refuse('store_unavailable');
  }
  return mutate(deps, args.intakeId, args.capability as string, (d) => {
    editable(d, now);
    const same = JSON.stringify(d.contact) === JSON.stringify(contact) && JSON.stringify(d.product) === JSON.stringify(args.product) &&
      JSON.stringify(d.providerBinding) === JSON.stringify(providerBinding);
    if (same) return d;
    return { ...d, revision: d.revision + 1, contact, product: args.product, providerBinding,
      quote: null, selectedQuoteId: null, state: 'editing' };
  });
}

export function quoteInputFor(d: InitialShippingDraftV1, provider: Pick<InitialShippingProviderQualificationV1, 'baselineService' | 'selectedService'>): ShippingInput {
  if (!d.contact) return refuse('input_invalid');
  return { draftId: `${d.intakeId}-r${d.revision}`, ownerBinding: d.ownerHash, operation: INITIAL_SHIPPING_OPERATION,
    plannedProductVersion: d.product.plannedProductVersion, bookFormat: d.product.bookFormat, podPackageId: d.product.podPackageId,
    pageCount: d.product.interiorPageCount, quantity: 1, currency: 'USD', baselineService: provider.baselineService,
    selectedService: provider.selectedService, address: d.contact };
}

/** quote: editing -> quoted, fenced on unchanged revision/contact/product/account after the awaited provider work. */
export async function quoteShippingDraft(deps: DraftOwnerDeps, args: {
  intakeId: string; capability: unknown; provider: InitialShippingProviderQualificationV1;
  produce: (input: ShippingInput, authorityExpiresAtMs: number) => Promise<ShippingQuote>;
}): Promise<InitialShippingDraftV1> {
  await authorize(deps, args.intakeId, args.capability);
  const before = await deps.store.read(args.intakeId);
  if (!before) return refuse('draft_absent');
  if (!ownerMatches(args.capability as string, before.record.ownerHash)) refuse('owner_invalid');
  editable(before.record, deps.now());
  const input = quoteInputFor(before.record, args.provider);
  let quote: ShippingQuote;
  try { quote = await args.produce(input, before.record.editableUntil); } catch { return refuse('quote_unavailable'); }
  return mutate(deps, args.intakeId, args.capability as string, (d) => {
    editable(d, deps.now());
    if (d.revision !== before.record.revision || JSON.stringify(quoteInputFor(d, args.provider)) !== JSON.stringify(input)) refuse('quote_stale');
    try { validateShippingSelection(quote, input, deps.now()); } catch { refuse('quote_unavailable'); }
    return { ...d, quote, selectedQuoteId: null, state: 'quoted' };
  });
}

/** select: quoted -> selected only by explicit owner choice of the exact server-held quote ID. clear: back to standard. */
export async function selectShippingQuote(deps: DraftOwnerDeps, args: { intakeId: string; capability: unknown; quoteId: unknown }) {
  await authorize(deps, args.intakeId, args.capability);
  if (!isQuoteId(args.quoteId)) refuse('selection_invalid');
  return mutate(deps, args.intakeId, args.capability as string, (d) => {
    editable(d, deps.now());
    if (!d.quote || d.quote.quoteId !== args.quoteId) refuse('selection_invalid');
    if (deps.now() >= d.quote!.expiresAtMs) refuse('quote_expired');
    try { validateShippingSelection(d.quote, quoteInputFor(d, d.quote!.input), deps.now()); }
    catch { refuse('selection_invalid'); }
    return { ...d, selectedQuoteId: d.quote!.quoteId, state: 'selected' };
  });
}
export async function clearShippingSelection(deps: DraftOwnerDeps, args: { intakeId: string; capability: unknown }) {
  await authorize(deps, args.intakeId, args.capability);
  return mutate(deps, args.intakeId, args.capability as string, (d) => {
    editable(d, deps.now());
    return { ...d, revision: d.revision + 1, quote: null, selectedQuoteId: null, state: 'editing' };
  });
}

/** selected -> locked to exactly one canonical order/fingerprint/quote. Idempotent for the same tuple; conflict refuses. */
export async function lockShippingDraft(store: DraftStore, args: {
  intakeId: string; capability: string; canonicalOrderId: string; checkoutIntentFingerprint: string; quoteId: string; now: number;
}): Promise<InitialShippingDraftV1> {
  if (!ORDER_ID.test(args.canonicalOrderId) || !/^[a-f0-9]{64}$/.test(args.checkoutIntentFingerprint)) refuse('input_invalid');
  for (let i = 0; i < MAX_CAS; i++) {
    const cur = await store.read(args.intakeId);
    if (!cur) return refuse('draft_absent');
    const d = cur.record;
    if (!ownerMatches(args.capability, d.ownerHash)) refuse('owner_invalid');
    if (d.lock) {
      if (d.lock.canonicalOrderId === args.canonicalOrderId && d.lock.checkoutIntentFingerprint === args.checkoutIntentFingerprint &&
        d.lock.quoteId === args.quoteId) return d;
      return refuse('lock_conflict');
    }
    if (d.state !== 'selected' || d.selectedQuoteId !== args.quoteId || !d.quote) refuse('selection_invalid');
    if (args.now >= d.quote!.expiresAtMs) refuse('quote_expired');
    const next: InitialShippingDraftV1 = { ...d, state: 'locked', lock: { canonicalOrderId: args.canonicalOrderId,
      checkoutIntentFingerprint: args.checkoutIntentFingerprint, quoteId: args.quoteId, binding: d.quote!.binding, lockedRevision: d.revision } };
    const w = await store.updateIfMatch(next, cur.etag);
    if (w === 'written') return next;
    if (w === 'ambiguous') refuse('store_unavailable');
  }
  return refuse('draft_conflict');
}
