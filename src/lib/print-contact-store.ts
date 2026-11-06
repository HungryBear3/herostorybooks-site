/**
 * Private recipient name and delivery phone for print orders.
 *
 * The order store is public, so these fields never enter an order record, quote,
 * lock or purchase. Each record lives in the private story-media store, is
 * create-only, and is keyed by order and Stripe Session. No public ref or
 * contact-derived hash exists: print release and admin read the record directly.
 *
 * Every read is bound to the exact order, purchase, Session, PaymentIntent, quote
 * and destination the durable order records now. A record that differs in any of
 * them, or does not parse exactly, is refused rather than repaired.
 *
 * A legacy upgrade binds through its signed settlement receipt, never through the
 * printUpgrade* fields that later at-cost purchases reuse.
 *
 * There is no local fallback. Without the private credential nothing is stored
 * and every caller refuses before a provider collects contact. Tests substitute
 * an explicit synthetic store through the seam below.
 */
import { BlobNotFoundError, get, put } from '@vercel/blob';

import { withBlobNamespace } from './blob-namespace.ts';
import {
  getOrderAuthoritative,
  isPrintFormat,
  type LegacyPrintUpgradeSettlementV1,
  type OrderRecord,
  type PrintCopyPurchaseV1,
  type ShippingAddress,
} from './orders.ts';
import { storyMediaPrivateToken, storyMediaPrivateTokenProblem } from './story-media-store.ts';

const SETTLED_SCHEMA = 'hsb-print-contact/settled/v1';
const INTENDED_SCHEMA = 'hsb-print-contact/intended/v1';
const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,255}$/;
const QUOTE_ID = /^puq_[A-Za-z0-9_]{1,64}$/;
const OFFER_ID = /^puo_[A-Za-z0-9_]{1,64}$/;
const E164_PHONE = /^\+[1-9][0-9]{7,14}$/;
const SETTLED_KEYS = ['orderId', 'phone', 'purchaseKind', 'quoteId', 'recipientName', 'recordedAt', 'schema', 'shippingAddress', 'stripePaymentIntentId', 'stripeSessionId'];
const INTENDED_KEYS = ['createdAt', 'offerId', 'orderId', 'quoteId', 'recipientName', 'schema', 'shippingAddress'];
const LEGACY_SETTLEMENT_KEYS = ['paidAt', 'stripePaymentIntentId', 'stripeSessionId', 'version'];
const ADDRESS_KEYS = ['city', 'country', 'line1', 'line2', 'state', 'zip'];
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_ADDRESS_FIELD = 200;
const MAX_RECIPIENT_NAME = 120;

export type PrintContactPurchaseKind = 'order' | 'print_upgrade' | 'upgrade' | 'extra_copy';

export interface PrintContactStore {
  readonly kind: string;
  read(pathname: string): Promise<string | null>;
  createIfAbsent(pathname: string, body: string): Promise<'created' | 'exists'>;
}

/** The exact durable identity one private record belongs to. */
export interface PrintContactBinding {
  orderId: string;
  purchaseKind: PrintContactPurchaseKind;
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
  quoteId: string | null;
  shippingAddress: ShippingAddress;
}

export interface ResolvedPrintContact extends PrintContactBinding {
  recipientName: string;
  phone: string;
}

export type PrintContactRefusal =
  | 'print_contact_missing'
  | 'print_contact_recipient_missing'
  | 'print_contact_phone_missing'
  | 'print_contact_binding_mismatch'
  | 'print_contact_unavailable';

export type PrintContactResolution =
  | { ok: true; contact: ResolvedPrintContact }
  | { ok: false; reason: PrintContactRefusal };

export interface AdminPrintContactView {
  purchase: PrintContactPurchaseKind;
  stripeSessionId: string;
  status: 'complete' | 'recipient_missing' | 'phone_missing' | 'missing' | 'binding_mismatch' | 'unavailable';
  recipientName: string | null;
  phone: string | null;
}

export interface PrintContactSessionLike {
  id: string;
  payment_intent?: string | { id?: string | null } | null;
  shipping_details?: { name?: string | null } | null;
  collected_information?: { shipping_details?: { name?: string | null } | null } | null;
  customer_details?: { phone?: string | null } | null;
}

interface SettledRecord extends PrintContactBinding {
  schema: typeof SETTLED_SCHEMA;
  recipientName: string | null;
  phone: string | null;
  recordedAt: string;
}

interface IntendedRecord {
  schema: typeof INTENDED_SCHEMA;
  orderId: string;
  offerId: string;
  quoteId: string;
  shippingAddress: ShippingAddress;
  recipientName: string;
  createdAt: string;
}

/** Fixed message: this error reaches logs, so it never carries a value. */
export class PrintContactUnavailableError extends Error {
  constructor() {
    super('print_contact_storage_unavailable');
    this.name = 'PrintContactUnavailableError';
  }
}

/** Bytes beyond the ceiling are never retained, and invalid UTF-8 is refused. */
async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RECORD_BYTES) throw new PrintContactUnavailableError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

export interface PrintContactBlobIo {
  get: typeof get;
  put: typeof put;
}

export function createBlobPrintContactStore(token: string, io: PrintContactBlobIo = { get, put }): PrintContactStore {
  const read = async (pathname: string): Promise<string | null> => {
    let result: Awaited<ReturnType<typeof get>> | null;
    try {
      result = await io.get(pathname, { access: 'private', token, useCache: false });
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
    if (!result) return null;
    const statusCode: number = result.statusCode;
    if (statusCode === 404) return null;
    if (statusCode !== 200 || !result.stream) throw new PrintContactUnavailableError();
    const declaredSize = result.blob?.size;
    if (typeof declaredSize === 'number' && declaredSize > MAX_RECORD_BYTES) throw new PrintContactUnavailableError();
    return readBounded(result.stream);
  };
  return {
    kind: 'blob',
    read,
    async createIfAbsent(pathname, body) {
      try {
        await io.put(pathname, body, {
          access: 'private',
          token,
          allowOverwrite: false,
          addRandomSuffix: false,
          contentType: 'application/json',
        });
        return 'created';
      } catch (error) {
        // The SDK has no reliable conflict signal, so the stored object decides.
        if (await read(pathname) !== null) return 'exists';
        throw error;
      }
    },
  };
}

let storeOverride: PrintContactStore | null = null;

/** Test seam: an explicit isolated synthetic store. */
export function __setPrintContactStoreForTests(store: PrintContactStore | null): void {
  storeOverride = store;
}

/** Null when contact can be stored; a value-free problem string otherwise. */
export function printContactStorageProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (storeOverride) return null;
  return storyMediaPrivateTokenProblem(env);
}

function resolveStore(): PrintContactStore {
  if (storeOverride) return storeOverride;
  const token = storyMediaPrivateToken();
  if (!token) throw new PrintContactUnavailableError();
  return createBlobPrintContactStore(token);
}

async function readBody(pathname: string): Promise<string | null> {
  try {
    return await resolveStore().read(pathname);
  } catch {
    throw new PrintContactUnavailableError();
  }
}

async function createBody(pathname: string, body: string): Promise<'created' | 'exists'> {
  try {
    return await resolveStore().createIfAbsent(pathname, body);
  } catch {
    throw new PrintContactUnavailableError();
  }
}

function settledPath(orderId: string, stripeSessionId: string): string | null {
  if (!ORDER_ID.test(orderId) || !SESSION_ID.test(stripeSessionId)) return null;
  return withBlobNamespace(`private-contact/orders/${orderId}/sessions/${stripeSessionId}.json`);
}

function intendedPath(orderId: string, quoteId: string): string | null {
  if (!ORDER_ID.test(orderId) || !QUOTE_ID.test(quoteId)) return null;
  return withBlobNamespace(`private-contact/orders/${orderId}/intended/${quoteId}.json`);
}

/** The address with name and phone removed; the only shape public records hold. */
export function stripShippingContact(address: ShippingAddress): ShippingAddress {
  return {
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
  };
}

function sameAddress(left: ShippingAddress | null | undefined, right: ShippingAddress | null | undefined): boolean {
  if (!left || !right) return false;
  return JSON.stringify(stripShippingContact(left)) === JSON.stringify(stripShippingContact(right));
}

function sameBinding(left: PrintContactBinding, right: PrintContactBinding): boolean {
  return left.orderId === right.orderId
    && left.purchaseKind === right.purchaseKind
    && left.stripeSessionId === right.stripeSessionId
    && left.stripePaymentIntentId === right.stripePaymentIntentId
    && left.quoteId === right.quoteId
    && sameAddress(left.shippingAddress, right.shippingAddress);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.join(',');
}

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function canonicalIso(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function addressField(value: unknown): boolean {
  return typeof value === 'string' && value.length <= MAX_ADDRESS_FIELD;
}

function validAddress(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const address = value as Record<string, unknown>;
  return exactKeys(address, ADDRESS_KEYS)
    && addressField(address.line1)
    && (address.line2 === null || addressField(address.line2))
    && addressField(address.city)
    && addressField(address.state)
    && addressField(address.zip)
    && addressField(address.country);
}

function normalizeRecipientName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.length <= MAX_RECIPIENT_NAME ? name : null;
}

function validRecipient(value: unknown): boolean {
  return typeof value === 'string' && normalizeRecipientName(value) === value;
}

function validSettled(value: Record<string, unknown>): boolean {
  const kind = value.purchaseKind;
  const quoted = kind === 'upgrade' || kind === 'extra_copy';
  return exactKeys(value, SETTLED_KEYS)
    && value.schema === SETTLED_SCHEMA
    && (quoted || kind === 'order' || kind === 'print_upgrade')
    && typeof value.orderId === 'string' && ORDER_ID.test(value.orderId)
    && typeof value.stripeSessionId === 'string' && SESSION_ID.test(value.stripeSessionId)
    && (value.stripePaymentIntentId === null
      || (typeof value.stripePaymentIntentId === 'string' && PAYMENT_INTENT_ID.test(value.stripePaymentIntentId)))
    && (quoted ? typeof value.quoteId === 'string' && QUOTE_ID.test(value.quoteId) : value.quoteId === null)
    && validAddress(value.shippingAddress)
    && (value.recipientName === null || validRecipient(value.recipientName))
    && (value.phone === null || (typeof value.phone === 'string' && E164_PHONE.test(value.phone)))
    && canonicalIso(value.recordedAt);
}

function parseSettled(body: string): SettledRecord | null {
  const value = parseObject(body);
  return value && validSettled(value) ? value as unknown as SettledRecord : null;
}

function parseIntended(body: string): IntendedRecord | null {
  const value = parseObject(body);
  if (!value
    || !exactKeys(value, INTENDED_KEYS)
    || value.schema !== INTENDED_SCHEMA
    || typeof value.orderId !== 'string' || !ORDER_ID.test(value.orderId)
    || typeof value.offerId !== 'string' || !OFFER_ID.test(value.offerId)
    || typeof value.quoteId !== 'string' || !QUOTE_ID.test(value.quoteId)
    || !validAddress(value.shippingAddress)
    || !validRecipient(value.recipientName)
    || !canonicalIso(value.createdAt)) return null;
  return value as unknown as IntendedRecord;
}

/** E.164 or null. Null is the honest missing state; nothing invents a number. */
export function normalizePrintContactPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^\+?[0-9 ()./-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  let candidate: string | null = null;
  if (trimmed.startsWith('+')) candidate = `+${digits}`;
  else if (digits.length === 10 && /^[2-9]/.test(digits)) candidate = `+1${digits}`;
  else if (digits.length === 11 && /^1[2-9]/.test(digits)) candidate = `+${digits}`;
  return candidate && E164_PHONE.test(candidate) ? candidate : null;
}

/** The recipient comes from shipping details only, never the payer or cardholder. */
export function sessionPrintContactFacts(session: PrintContactSessionLike): { recipientName: string | null; phone: string | null } {
  const details = session.shipping_details ?? session.collected_information?.shipping_details ?? null;
  return {
    recipientName: normalizeRecipientName(details?.name),
    phone: normalizePrintContactPhone(session.customer_details?.phone),
  };
}

function sessionPaymentIntentId(session: PrintContactSessionLike): string | null {
  if (typeof session.payment_intent === 'string') return session.payment_intent || null;
  return session.payment_intent?.id || null;
}

export interface RecordSettledPrintContactInput extends Omit<PrintContactBinding, 'shippingAddress'> {
  shippingAddress: ShippingAddress | null | undefined;
  recipientName: string | null;
  phone: string | null;
  now?: string;
}

export type RecordSettledPrintContactResult = 'stored' | 'replayed' | 'nothing_collected';

/**
 * Create-only. A replay must carry the exact same binding; a null contact field
 * is no new evidence, and a different value refuses.
 */
export async function recordSettledPrintContact(input: RecordSettledPrintContactInput): Promise<RecordSettledPrintContactResult> {
  if (!input.shippingAddress || (!input.recipientName && !input.phone)) return 'nothing_collected';
  const pathname = settledPath(input.orderId, input.stripeSessionId);
  if (!pathname) throw new PrintContactUnavailableError();
  const record: SettledRecord = {
    schema: SETTLED_SCHEMA,
    orderId: input.orderId,
    purchaseKind: input.purchaseKind,
    stripeSessionId: input.stripeSessionId,
    stripePaymentIntentId: input.stripePaymentIntentId,
    quoteId: input.quoteId,
    shippingAddress: stripShippingContact(input.shippingAddress),
    recipientName: input.recipientName,
    phone: input.phone,
    recordedAt: input.now ?? new Date().toISOString(),
  };
  const body = JSON.stringify(record);
  if (!parseSettled(body)) throw new PrintContactUnavailableError();
  if (await createBody(pathname, body) === 'created') return 'stored';
  const stored = await readBody(pathname);
  const existing = stored === null ? null : parseSettled(stored);
  if (!existing
    || !sameBinding(existing, record)
    || (record.recipientName !== null && existing.recipientName !== record.recipientName)
    || (record.phone !== null && existing.phone !== record.phone)) {
    throw new PrintContactUnavailableError();
  }
  return 'replayed';
}

type LegacyUpgradeAuthority =
  | { status: 'none' }
  | { status: 'held' }
  | { status: 'bound'; settlement: LegacyPrintUpgradeSettlementV1 };

function validLegacySettlement(value: unknown): value is LegacyPrintUpgradeSettlementV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settlement = value as Record<string, unknown>;
  return exactKeys(settlement, LEGACY_SETTLEMENT_KEYS)
    && settlement.version === 1
    && typeof settlement.stripeSessionId === 'string' && SESSION_ID.test(settlement.stripeSessionId)
    && (settlement.stripePaymentIntentId === null
      || (typeof settlement.stripePaymentIntentId === 'string' && PAYMENT_INTENT_ID.test(settlement.stripePaymentIntentId)))
    && canonicalIso(settlement.paidAt);
}

/**
 * Evidence of a legacy upgrade without an exact signed receipt is held: there is
 * no backfill, and the original digital checkout is never a substitute. A receipt
 * must match its one audit event and name no other purchase on this order.
 */
function legacyUpgradeAuthority(order: OrderRecord): LegacyUpgradeAuthority {
  const settlement = order.legacyPrintUpgradeSettlement ?? null;
  const purchases = order.printCopyPurchases ?? [];
  const paidEvents = (order.auditEvents ?? []).filter((event) => event.type === 'print_upgrade_paid');
  if (settlement === null) {
    const upgradeSession = order.printUpgradeStripeSessionId;
    const unexplainedUpgrade = order.printUpgradeStatus === 'paid'
      && order.printUpgradeSourceFormat === 'digital'
      && Boolean(upgradeSession)
      && !purchases.some((purchase) => purchase.stripeSessionId === upgradeSession);
    return paidEvents.length > 0 || order.printUpgradePaymentIntentId || unexplainedUpgrade
      ? { status: 'held' }
      : { status: 'none' };
  }
  if (!validLegacySettlement(settlement) || paidEvents.length !== 1) return { status: 'held' };
  const { stripeSessionId, stripePaymentIntentId, paidAt } = settlement;
  const samePayment = (paymentIntent: string | null | undefined) =>
    stripePaymentIntentId !== null && paymentIntent === stripePaymentIntentId;
  if (paidEvents[0].at !== paidAt
    || paidEvents[0].meta?.stripeSessionId !== stripeSessionId
    || stripeSessionId === order.stripeSessionId
    || samePayment(order.stripePaymentIntentId)
    || purchases.some((purchase) => purchase.stripeSessionId === stripeSessionId || samePayment(purchase.stripePaymentIntentId))) {
    return { status: 'held' };
  }
  return { status: 'bound', settlement };
}

/**
 * The purchase whose contact ships this order's own print job. An extra copy can
 * never become it: purchases bind through their own receipts, and a legacy
 * upgrade binds only through the settlement that paid for it.
 */
export function orderPrintContactBinding(order: OrderRecord): PrintContactBinding | null {
  if (!order.shippingAddress) return null;
  const legacy = legacyUpgradeAuthority(order);
  if (legacy.status === 'held') return null;
  const settlement = legacy.status === 'bound' ? legacy.settlement : null;
  const stripeSessionId = settlement ? settlement.stripeSessionId : order.stripeSessionId;
  if (!stripeSessionId) return null;
  return {
    orderId: order.id,
    purchaseKind: settlement ? 'print_upgrade' : 'order',
    stripeSessionId,
    stripePaymentIntentId: (settlement ? settlement.stripePaymentIntentId : order.stripePaymentIntentId) ?? null,
    quoteId: null,
    shippingAddress: stripShippingContact(order.shippingAddress),
  };
}

function purchasePrintContactBinding(order: OrderRecord, purchase: PrintCopyPurchaseV1): PrintContactBinding {
  return {
    orderId: order.id,
    purchaseKind: purchase.kind,
    stripeSessionId: purchase.stripeSessionId,
    stripePaymentIntentId: purchase.stripePaymentIntentId ?? null,
    quoteId: purchase.quoteId,
    shippingAddress: stripShippingContact(purchase.shippingAddress),
  };
}

function assertSessionPayment(binding: PrintContactBinding, session: PrintContactSessionLike): void {
  if (binding.stripePaymentIntentId !== null && sessionPaymentIntentId(session) !== binding.stripePaymentIntentId) {
    throw new PrintContactUnavailableError();
  }
}

/** Signed retail or legacy upgrade Session for the order's own print job. */
export async function captureOrderPrintContact(
  order: OrderRecord,
  session: PrintContactSessionLike,
): Promise<RecordSettledPrintContactResult> {
  const binding = orderPrintContactBinding(order);
  if (!binding || binding.stripeSessionId !== session.id) return 'nothing_collected';
  assertSessionPayment(binding, session);
  return recordSettledPrintContact({ ...binding, ...sessionPrintContactFacts(session) });
}

/** Written before the public quote commits, so no new quote lacks its recipient. */
export async function writeIntendedPrintRecipient(input: {
  orderId: string;
  offerId: string;
  quoteId: string;
  address: ShippingAddress & { name: string };
  now: string;
}): Promise<void> {
  const pathname = intendedPath(input.orderId, input.quoteId);
  const recipientName = normalizeRecipientName(input.address.name);
  if (!pathname || !recipientName) throw new PrintContactUnavailableError();
  const record: IntendedRecord = {
    schema: INTENDED_SCHEMA,
    orderId: input.orderId,
    offerId: input.offerId,
    quoteId: input.quoteId,
    shippingAddress: stripShippingContact(input.address),
    recipientName,
    createdAt: input.now,
  };
  const body = JSON.stringify(record);
  if (!parseIntended(body) || await createBody(pathname, body) !== 'created') {
    throw new PrintContactUnavailableError();
  }
}

async function purchaseRecipient(order: OrderRecord, purchase: PrintCopyPurchaseV1): Promise<string | null> {
  // A purchase settled before this boundary still carries its name inline.
  const inline = normalizeRecipientName(purchase.shippingAddress.name);
  if (inline) return inline;
  const pathname = intendedPath(order.id, purchase.quoteId);
  const body = pathname ? await readBody(pathname) : null;
  if (body !== null) {
    const intended = parseIntended(body);
    if (!intended
      || intended.orderId !== order.id
      || intended.offerId !== purchase.offerId
      || intended.quoteId !== purchase.quoteId
      || !sameAddress(intended.shippingAddress, purchase.shippingAddress)) {
      throw new PrintContactUnavailableError();
    }
    return intended.recipientName;
  }
  // A quote issued before this boundary may still carry its name inline.
  const quote = (order.printUpgradeQuotes ?? []).find((candidate) => candidate.quoteId === purchase.quoteId);
  return normalizeRecipientName(quote?.shippingAddress.name);
}

/** Signed at-cost Session; repeatable until the settled record exists. */
export async function capturePrintUpgradeContact(
  orderId: string,
  session: PrintContactSessionLike,
): Promise<RecordSettledPrintContactResult> {
  const order = await getOrderAuthoritative(orderId);
  const purchase = order?.printCopyPurchases?.find((candidate) => candidate.stripeSessionId === session.id);
  if (!order || !purchase) return 'nothing_collected';
  const binding = purchasePrintContactBinding(order, purchase);
  assertSessionPayment(binding, session);
  return recordSettledPrintContact({
    ...binding,
    recipientName: await purchaseRecipient(order, purchase),
    phone: sessionPrintContactFacts(session).phone,
  });
}

export function printContactMatchesOrder(contact: ResolvedPrintContact, order: OrderRecord): boolean {
  const binding = orderPrintContactBinding(order);
  return Boolean(binding) && sameBinding(contact, binding);
}

type LoadedSettled =
  | { status: 'found'; record: SettledRecord }
  | { status: 'absent' }
  | { status: 'mismatch' };

async function loadSettled(binding: PrintContactBinding): Promise<LoadedSettled> {
  const pathname = settledPath(binding.orderId, binding.stripeSessionId);
  if (!pathname) return { status: 'absent' };
  const body = await readBody(pathname);
  if (body === null) return { status: 'absent' };
  const record = parseSettled(body);
  if (!record || !sameBinding(record, binding)) return { status: 'mismatch' };
  return { status: 'found', record };
}

/** Fulfillment authority. Never throws; every failure is a closed refusal. */
export async function resolveOrderPrintContact(order: OrderRecord): Promise<PrintContactResolution> {
  if (legacyUpgradeAuthority(order).status === 'held') return { ok: false, reason: 'print_contact_binding_mismatch' };
  const binding = orderPrintContactBinding(order);
  if (!binding) return { ok: false, reason: 'print_contact_missing' };
  let loaded: LoadedSettled;
  try {
    loaded = await loadSettled(binding);
  } catch {
    return { ok: false, reason: 'print_contact_unavailable' };
  }
  if (loaded.status === 'absent') return { ok: false, reason: 'print_contact_missing' };
  if (loaded.status === 'mismatch') return { ok: false, reason: 'print_contact_binding_mismatch' };
  const { recipientName, phone } = loaded.record;
  if (!recipientName) return { ok: false, reason: 'print_contact_recipient_missing' };
  if (!phone) return { ok: false, reason: 'print_contact_phone_missing' };
  return { ok: true, contact: { ...binding, recipientName, phone } };
}

async function adminView(binding: PrintContactBinding, legacyName: unknown): Promise<AdminPrintContactView> {
  const blank = { purchase: binding.purchaseKind, stripeSessionId: binding.stripeSessionId, recipientName: null, phone: null };
  let loaded: LoadedSettled;
  try {
    loaded = await loadSettled(binding);
  } catch {
    return { ...blank, status: 'unavailable' };
  }
  if (loaded.status === 'absent') {
    // A purchase settled before this boundary keeps its stored name visible.
    const recipientName = normalizeRecipientName(legacyName);
    return recipientName ? { ...blank, recipientName, status: 'phone_missing' } : { ...blank, status: 'missing' };
  }
  if (loaded.status === 'mismatch') return { ...blank, status: 'binding_mismatch' };
  const { recipientName, phone } = loaded.record;
  const status = !recipientName ? 'recipient_missing' : !phone ? 'phone_missing' : 'complete';
  return { ...blank, recipientName, phone, status };
}

/** Callers must already hold admin authority. Never hydrates an order DTO. */
export async function loadAdminPrintContacts(order: OrderRecord): Promise<AdminPrintContactView[]> {
  const views: AdminPrintContactView[] = [];
  if (isPrintFormat(order.bookFormat)) {
    const binding = orderPrintContactBinding(order);
    if (binding) {
      views.push(await adminView(binding, order.shippingAddress?.name));
    } else if (order.stripeSessionId) {
      const status = legacyUpgradeAuthority(order).status === 'held' ? 'binding_mismatch' : 'missing';
      views.push({ purchase: 'order', stripeSessionId: order.stripeSessionId, status, recipientName: null, phone: null });
    }
  }
  for (const purchase of order.printCopyPurchases ?? []) {
    views.push(await adminView(purchasePrintContactBinding(order, purchase), purchase.shippingAddress.name));
  }
  return views;
}
