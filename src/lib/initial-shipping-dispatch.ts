/** Private committed authority + fresh final-artifact/provider preflight for an expedited print submit.
 * Produces a frozen in-memory authorization; `authorizationStillMatches` is the synchronous compare
 * run INSIDE the existing canonical CAS before the ambiguity marker. No job POST here.
 */
import { createHash } from 'node:crypto';
import { normalizeShippingContact, validateShippingSelection, type ShippingContact } from './shipping-selection.ts';
import { createPrivateShippingDraftAccess, draftRefOf, quoteInputFor } from './initial-shipping-draft.ts';
import { parseInitialShippingProviderQualification, planInitialShippingProduct, sha256 } from './initial-shipping-contract.ts';
import { parseBlobToken } from './checkout-blob-identity.ts';
import { getBlobNamespace, applyBlobNamespace } from './blob-namespace.ts';
import { produceShippingQuote } from './shipping-quote.ts';
import { podPackageIdForFormat, prepareExpeditedPrintTransport, type LuluJobResult } from './lulu.ts';
import type { OrderRecord } from './orders.ts';
import {
  deepFreeze, digestJson, readOrderInitialShipping, type InitialShippingHoldReason,
  type InitialShippingOrderMetadataV1, type InitialShippingProviderQualificationV1, providerBindingDigest,
} from './initial-shipping-contract.ts';
import type { DraftStore } from './initial-shipping-draft.ts';
import { receiptDigest, shippingCommitted, type SettlementOrderView } from './initial-shipping-settlement.ts';

export interface DispatchOrderView extends SettlementOrderView {
  readonly paymentStatus?: unknown; readonly bookFormat?: unknown;
  readonly printProofApprovedAt?: unknown; readonly printSubmissionAttemptedAt?: unknown;
}
export interface FinalArtifactFacts {
  readonly interiorPageCount: number; readonly podPackageId: string; readonly layoutVersion: string;
  readonly interiorSha256: string; readonly coverSha256: string; readonly proofSha256: string;
}
export interface ExpeditedDispatchAuthorization {
  readonly orderId: string; readonly metadataDigest: string; readonly receiptDigest: string; readonly draftRevision: number;
  readonly artifact: FinalArtifactFacts; readonly providerBindingDigest: string; readonly selectedService: string;
  readonly freshSelectedLandedCents: number; readonly contact: ShippingContact; readonly observedAtMs: number;
  readonly endpointOrigin: string; readonly accountBinding: string;
}
export type DispatchPreflight =
  | { readonly kind: 'standard' }
  | { readonly kind: 'authorized'; readonly authorization: ExpeditedDispatchAuthorization }
  | { readonly kind: 'hold'; readonly reason: InitialShippingHoldReason };

/** Before claim in approvePrintProof: refuse uncommitted/held/malformed expedited authority. */
export function preclaimShippingGate(order: DispatchOrderView): 'standard' | 'ok' | 'hold' {
  const c = shippingCommitted(order);
  return c === 'standard' ? 'standard' : c === 'committed' ? 'ok' : 'hold';
}

/** After slow cover generation, immediately before the attempt-marker transaction. */
export async function preflightExpeditedDispatch(args: {
  order: DispatchOrderView; artifact: FinalArtifactFacts; draftStore: DraftStore | null; intakeId: string | null;
  provider: InitialShippingProviderQualificationV1 | null; now: () => number;
  /** Fresh discovery+landed cost for the final count/package/contact on the captured provider account. */
  freshSelectedCost: (req: { podPackageId: string; pageCount: number; service: string; contact: ShippingContact }) => Promise<{ available: boolean; totalCents: number }>;
}): Promise<DispatchPreflight> {
  const read = readOrderInitialShipping(args.order);
  if (read.kind === 'absent') return { kind: 'standard' };
  if (read.kind === 'malformed') return { kind: 'hold', reason: 'metadata_malformed' };
  if (shippingCommitted(args.order) !== 'committed') return { kind: 'hold', reason: read.settlement.reason ?? 'refund_or_terminal' };
  const m = read.metadata;
  if (!args.provider || providerBindingDigest(args.provider) !== m.providerBindingDigest) return { kind: 'hold', reason: 'dispatch_account_drift' };
  if (!args.draftStore || !args.intakeId) return { kind: 'hold', reason: 'dispatch_private_unavailable' };
  let draft;
  try { draft = await args.draftStore.read(args.intakeId); } catch { return { kind: 'hold', reason: 'dispatch_private_unavailable' }; }
  const d = draft?.record;
  if (!d || d.state !== 'payment_recorded' || !d.payment || !d.contact || d.lock?.canonicalOrderId !== args.order.id ||
    d.lock.quoteId !== m.quoteId || receiptDigest(d.payment) !== read.settlement.receiptDigest) return { kind: 'hold', reason: 'dispatch_private_unavailable' };
  if (d.providerBinding.accountBinding !== args.provider.accountBinding || d.providerBinding.endpointOrigin !== args.provider.endpointOrigin) {
    return { kind: 'hold', reason: 'dispatch_account_drift' };
  }
  const a = args.artifact;
  if (a.interiorPageCount !== m.product.interiorPageCount || a.podPackageId !== m.product.podPackageId || a.layoutVersion !== m.product.layoutVersion ||
    ![a.interiorSha256, a.coverSha256, a.proofSha256].every((h) => /^[a-f0-9]{64}$/.test(h))) return { kind: 'hold', reason: 'dispatch_artifact_drift' };
  let contact: ShippingContact;
  try { contact = normalizeShippingContact(d.contact); } catch { return { kind: 'hold', reason: 'dispatch_private_unavailable' }; }
  let fresh;
  try { fresh = await args.freshSelectedCost({ podPackageId: a.podPackageId, pageCount: a.interiorPageCount, service: m.service.selected, contact }); }
  catch { return { kind: 'hold', reason: 'dispatch_service_unavailable' }; }
  if (!fresh || fresh.available !== true || !Number.isSafeInteger(fresh.totalCents)) return { kind: 'hold', reason: 'dispatch_service_unavailable' };
  if (fresh.totalCents > m.totals.selectedLandedCents) return { kind: 'hold', reason: 'dispatch_cost_exceeded' };
  return { kind: 'authorized', authorization: deepFreeze({
    orderId: args.order.id, metadataDigest: digestJson(m), receiptDigest: read.settlement.receiptDigest!, draftRevision: d.revision,
    artifact: { ...a }, providerBindingDigest: m.providerBindingDigest, selectedService: m.service.selected,
    freshSelectedLandedCents: fresh.totalCents, contact, observedAtMs: args.now(),
    endpointOrigin: args.provider.endpointOrigin, accountBinding: args.provider.accountBinding,
  }) };
}

// Conservative print-only ceilings. Streaming hashes retain five signature bytes,
// not a PDF-sized accumulator. Unsupported local/private URLs hold for an operator.
export const DISPATCH_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const DISPATCH_ARTIFACT_TIMEOUT_MS = 20_000;
class ShippingDispatchHold extends Error {
  readonly reason: InitialShippingHoldReason;
  constructor(reason: InitialShippingHoldReason) { super(reason); this.reason = reason; }
}
export function dispatchFailureReason(error: unknown): InitialShippingHoldReason {
  return error instanceof ShippingDispatchHold ? error.reason : 'dispatch_private_unavailable';
}
const hold = (reason: InitialShippingHoldReason): never => { throw new ShippingDispatchHold(reason); };

function artifactIdentity(order: OrderRecord): string {
  return digestJson([order.id, order.bookFormat, order.layoutVersion, order.proofVersion, order.proofSourceFingerprint,
    order.proofReviewedVersion, order.proofReviewedAt, order.proofApprovedAt, order.reviewStatus, order.pageArtifacts,
    order.storyArtifactUrl, order.printInteriorArtifactUrl, order.printInteriorMd5, order.printInteriorPageCount,
    order.printInteriorProofVersion, order.printCoverArtifactUrl, order.printCoverMd5, order.printTitle,
    order.checkoutIntake, order.checkoutIntentFingerprint, order.stripeSessionId, order.stripePaymentIntentId]);
}

async function artifactDigest(order: OrderRecord, value: string | null | undefined, md5: string | null | undefined,
  token: string, namespace: string, generated?: Buffer): Promise<string> {
  let url: URL;
  try {
    const { storeId } = parseBlobToken(token, 'dispatch');
    url = new URL(value!);
    const prefix = '/' + applyBlobNamespace(`orders/${order.id}/`, namespace);
    const leaf = url.pathname.slice(prefix.length);
    if (url.origin !== `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com` || url.username || url.password ||
      url.search || url.hash || !url.pathname.startsWith(prefix) || !/^[a-zA-Z0-9._-]+\.pdf$/.test(leaf) ||
      url.href !== value || (md5 != null && !/^[a-f0-9]{32}$/.test(md5))) throw new Error();
  } catch { return hold('dispatch_artifact_drift'); }
  const hash = createHash('sha256'); const legacy = createHash('md5'); let size = 0; let signature = Buffer.alloc(0);
  const consume = (chunk: Uint8Array) => {
    if (chunk.byteLength > DISPATCH_ARTIFACT_MAX_BYTES - size) hold('dispatch_artifact_drift');
    size += chunk.byteLength;
    if (signature.length < 5) signature = Buffer.concat([signature, Buffer.from(chunk.subarray(0, 5 - signature.length))]);
    hash.update(chunk); legacy.update(chunk);
  };
  const finish = () => {
    if (signature.toString('ascii') !== '%PDF-' || (md5 != null && legacy.digest('hex') !== md5)) hold('dispatch_artifact_drift');
    return hash.digest('hex');
  };
  if (generated) { consume(generated); return finish(); }
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); void reader?.cancel().catch(() => {}); reject(new ShippingDispatchHold('dispatch_artifact_drift'));
  }, DISPATCH_ARTIFACT_TIMEOUT_MS); });
  try {
    const response = await Promise.race([globalThis.fetch(url!.href, { redirect: 'error', cache: 'no-store', signal: controller.signal }), deadline]);
    const lengthText = response.headers.get('content-length'); const length = Number(lengthText);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url!.href) ||
      response.headers.get('content-type')?.split(';')[0].trim() !== 'application/pdf' ||
      !lengthText || !/^\d+$/.test(lengthText) || !Number.isSafeInteger(length) || length < 5 || length > DISPATCH_ARTIFACT_MAX_BYTES || !response.body) {
      void response.body?.cancel().catch(() => {}); hold('dispatch_artifact_drift');
    }
    reader = response.body!.getReader();
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
      consume(chunk.value); if (size > length) hold('dispatch_artifact_drift');
    }
    if (size !== length) hold('dispatch_artifact_drift');
    return finish();
  } catch { controller.abort(); void reader?.cancel().catch(() => {}); return hold('dispatch_artifact_drift'); }
  finally { clearTimeout(timer); reader?.releaseLock(); }
}

interface ProductionGrant {
  identity: string; intact: () => boolean; submit: (body: Record<string, unknown>) => Promise<LuluJobResult>;
  used: boolean;
}
// A helper-generated or deserialized authorization is NOT a production capability.
const grants = new WeakMap<ExpeditedDispatchAuthorization, ProductionGrant>();
export function productionAuthorizationMatches(auth: ExpeditedDispatchAuthorization, order: OrderRecord): boolean {
  const grant = grants.get(auth);
  return Boolean(grant && !grant.used && grant.intact() && grant.identity === artifactIdentity(order) &&
    order.reviewStatus === 'approved' && order.proofApprovedAt && !order.refundedAt && !order.refundClaimId && !order.stripeRefundId &&
    authorizationStillMatches(auth, order, auth.artifact, Date.now()));
}

/** Paid obligations are reconciled even with sales flags OFF. No browser lease/capability. */
export async function prepareProductionDispatch(order: OrderRecord, generatedCover?: Buffer): Promise<DispatchPreflight> {
  const read = readOrderInitialShipping(order);
  if (read.kind === 'absent') return { kind: 'standard' };
  if (read.kind === 'malformed') return { kind: 'hold', reason: 'metadata_malformed' };
  try {
    if (preclaimShippingGate(order) !== 'ok') hold(read.settlement.reason ?? 'refund_or_terminal');
    const m = read.metadata;
    const keys = ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_API_URL', 'LULU_SHIPPING_LEVEL',
      'LULU_SOFTCOVER_POD_PACKAGE_ID', 'LULU_HARDCOVER_POD_PACKAGE_ID', 'HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION',
      'BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_ACCESS_MODE'] as const;
    const captured = keys.map(k => process.env[k]); const namespace = getBlobNamespace();
    const provider = parseInitialShippingProviderQualification(JSON.parse(process.env.HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION ?? 'null'));
    if (!provider || !process.env.LULU_CLIENT_KEY || !process.env.LULU_CLIENT_SECRET ||
      provider.endpointOrigin !== (process.env.LULU_API_URL ?? 'https://api.lulu.com').replace(/\/$/, '') ||
      provider.accountBinding !== sha256(process.env.LULU_CLIENT_KEY) || providerBindingDigest(provider) !== m.providerBindingDigest ||
      provider.baselineService !== (process.env.LULU_SHIPPING_LEVEL ?? 'MAIL')) hold('dispatch_account_drift');
    const access = createPrivateShippingDraftAccess(); const intakeId = order.checkoutIntake?.intakeId;
    if (!intakeId || draftRefOf(intakeId, access.namespace) !== m.draftRef) hold('dispatch_private_unavailable');
    const intact = () => access.intact() && getBlobNamespace() === namespace && keys.every((k,i) => process.env[k] === captured[i]);
    const validate = async () => {
      const snapshot = await access.store.read(intakeId!); const d = snapshot?.record;
      if (!intact() || !d || d.state !== 'payment_recorded' || !d.payment || !d.quote ||
        d.lock?.canonicalOrderId !== order.id || d.lock.checkoutIntentFingerprint !== order.checkoutIntentFingerprint ||
        d.lock.quoteId !== m.quoteId || d.selectedQuoteId !== m.quoteId || d.lock.binding !== d.quote.binding || d.lock.lockedRevision !== d.revision ||
        d.providerBinding.configurationVersion !== provider!.configurationVersion ||
        d.payment.sessionId !== order.stripeSessionId || d.payment.paymentIntentId !== order.stripePaymentIntentId ||
        receiptDigest(d.payment) !== read.settlement.receiptDigest) hold('dispatch_private_unavailable');
      const q = validateShippingSelection(d!.quote!, quoteInputFor(d!, provider!), m.quoteWindow.issuedAtMs);
      if (digestJson(['quote', q.binding, q.quoteId]) !== m.quoteBindingDigest || q.deltaCents !== m.totals.deltaCents ||
        q.selected.totalCents !== m.totals.selectedLandedCents || q.issuedAtMs !== m.quoteWindow.issuedAtMs || q.expiresAtMs !== m.quoteWindow.expiresAtMs ||
        order.priceCents !== m.totals.bookCents || Object.entries(m.product).some(([k,v]) => d!.product[k as keyof typeof d.product] !== v)) hold('dispatch_private_unavailable');
      return snapshot!;
    };
    await validate();
    const product = planInitialShippingProduct(order.bookFormat, podPackageIdForFormat);
    if (Object.entries(m.product).some(([k,v]) => product[k as keyof typeof product] !== v) ||
      order.printInteriorPageCount !== product.interiorPageCount || order.layoutVersion !== product.layoutVersion ||
      !order.proofApprovedAt || order.reviewStatus !== 'approved' || order.proofVersion !== order.printInteriorProofVersion ||
      order.proofVersion !== order.proofReviewedVersion) hold('dispatch_artifact_drift');
    const token = process.env.BLOB_READ_WRITE_TOKEN!;
    const artifact: FinalArtifactFacts = { interiorPageCount: order.printInteriorPageCount, podPackageId: product.podPackageId, layoutVersion: product.layoutVersion,
      interiorSha256: await artifactDigest(order, order.printInteriorArtifactUrl, order.printInteriorMd5, token, namespace),
      coverSha256: await artifactDigest(order, order.printCoverArtifactUrl, order.printCoverMd5, token, namespace, generatedCover),
      proofSha256: await artifactDigest(order, order.storyArtifactUrl, null, token, namespace) };
    // Resolve authentication before the canonical attempt fence, never await it after the fence.
    const transport = await prepareExpeditedPrintTransport(provider!);
    const result = await preflightExpeditedDispatch({ order, artifact, draftStore: access.store, intakeId: intakeId!, provider, now: Date.now,
      freshSelectedCost: async req => {
        if (!intact()) hold('dispatch_account_drift');
        const quote = await produceShippingQuote({ ...quoteInputFor((await validate()).record, provider!),
          podPackageId: req.podPackageId, pageCount: req.pageCount, address: req.contact });
        if (!intact()) hold('dispatch_account_drift');
        return { available: true, totalCents: quote.selected.totalCents };
      } });
    await validate();
    if (!intact()) hold('dispatch_account_drift');
    if (result.kind === 'authorized') grants.set(result.authorization, { identity: artifactIdentity(order), intact, submit: transport, used: false });
    return result;
  } catch (error) { return { kind: 'hold', reason: dispatchFailureReason(error) }; }
}

/** Only the real default print adapter consumes this one-shot, process-local capability. */
export async function submitAuthorizedExpedited(order: OrderRecord, auth?: ExpeditedDispatchAuthorization): Promise<LuluJobResult> {
  const grant = auth && grants.get(auth);
  if (!auth || !grant || !order.printSubmissionAttemptedAt || order.printSubmissionProofVersion !== order.proofVersion ||
    !productionAuthorizationMatches(auth, { ...order, printSubmissionAttemptedAt: null })) throw new Error('shipping_dispatch_authorization_required');
  grant.used = true; // Lost response / provider error never permits another POST with this grant.
  const body = expeditedPrintJobBody(auth, { interiorUrl: order.printInteriorArtifactUrl!, coverUrl: order.printCoverArtifactUrl! },
    process.env.HSB_SUPPORT_EMAIL || process.env.EMAIL_FROM || order.email);
  body.line_items = [{ title: order.printTitle, external_id: order.id, pod_package_id: auth.artifact.podPackageId, quantity: 1,
    interior: { source_url: order.printInteriorArtifactUrl, source_md5_sum: order.printInteriorMd5 },
    cover: { source_url: order.printCoverArtifactUrl, source_md5_sum: order.printCoverMd5 } }];
  return grant.submit(body);
}

export const AUTHORIZATION_MAX_AGE_MS = 10 * 60 * 1000;
/** Synchronous, I/O-free compare inside the canonical CAS. false => no attempt marker and no submit. */
export function authorizationStillMatches(auth: ExpeditedDispatchAuthorization, current: DispatchOrderView,
  currentArtifact: Pick<FinalArtifactFacts, 'interiorSha256' | 'coverSha256' | 'proofSha256' | 'interiorPageCount'>, nowMs: number): boolean {
  if (current.id !== auth.orderId || current.paymentStatus !== 'paid' || current.printSubmissionAttemptedAt != null) return false;
  if (shippingCommitted(current) !== 'committed') return false;
  const read = readOrderInitialShipping(current);
  if (read.kind !== 'present' || digestJson(read.metadata) !== auth.metadataDigest || read.settlement.receiptDigest !== auth.receiptDigest) return false;
  if (currentArtifact.interiorSha256 !== auth.artifact.interiorSha256 || currentArtifact.coverSha256 !== auth.artifact.coverSha256 ||
    currentArtifact.proofSha256 !== auth.artifact.proofSha256 || currentArtifact.interiorPageCount !== auth.artifact.interiorPageCount) return false;
  return nowMs >= auth.observedAtMs && nowMs - auth.observedAtMs <= AUTHORIZATION_MAX_AGE_MS;
}

/** Exact Lulu print-job body for an authorized expedited submission. Real name/phone/private address only. */
export function expeditedPrintJobBody(auth: ExpeditedDispatchAuthorization, files: { interiorUrl: string; coverUrl: string }, contactEmail: string): Record<string, unknown> {
  const c = auth.contact;
  return {
    external_id: auth.orderId,
    contact_email: contactEmail,
    shipping_level: auth.selectedService,
    shipping_address: { name: c.name, phone_number: c.phone, street1: c.line1, ...(c.line2 ? { street2: c.line2 } : {}),
      city: c.city, state_code: c.state, postcode: c.zip, country_code: c.country },
    line_items: [{ external_id: `${auth.orderId}-book`, title: 'HeroStoryBooks', quantity: 1,
      printable_normalization: { pod_package_id: auth.artifact.podPackageId, cover: { source_url: files.coverUrl }, interior: { source_url: files.interiorUrl } } }],
  };
}
