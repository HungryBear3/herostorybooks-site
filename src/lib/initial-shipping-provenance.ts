/** H3: one immutable, order-ID-keyed, nonsensitive provenance marker in the EXISTING order store.
 * Body is exactly {schema, orderId, operation}. Create-only; never erased; not a registry.
 * Uses the existing OrderStoreAdapter contract (same credential/access policy as order records).
 */
import { applyBlobNamespace } from './blob-namespace.ts';
import {
  createInitialShippingProvenanceAccess,
  type InitialShippingProvenanceAccess,
  type InitialShippingProvenanceTransport,
  type OrderStoreAdapter,
} from './orders.ts';
import { INITIAL_SHIPPING_OPERATION, ORDER_ID, exactObject } from './initial-shipping-contract.ts';

export const PROVENANCE_SCHEMA = 'hsb.initial-shipping-provenance.v1' as const;
export type MarkerStore = Pick<OrderStoreAdapter, 'readVersioned' | 'createIfAbsent'>;

export function provenancePath(orderId: string, namespace: string): string {
  if (!ORDER_ID.test(orderId)) throw new Error('provenance_order_id_invalid');
  return applyBlobNamespace(`order-provenance/initial-shipping/${orderId}.json`, namespace);
}
const markerBody = (orderId: string) => JSON.stringify({ schema: PROVENANCE_SCHEMA, orderId, operation: INITIAL_SHIPPING_OPERATION });
function isExactMarker(body: string, orderId: string): boolean {
  try {
    const r = exactObject(JSON.parse(body), ['schema', 'orderId', 'operation']);
    return !!r && r.schema === PROVENANCE_SCHEMA && r.orderId === orderId && r.operation === INITIAL_SHIPPING_OPERATION;
  } catch { return false; }
}

export type MarkerRead = 'present' | 'absent' | 'hold';
/** Read by order ID. null from the store is authoritative absence; throw/malformed/wrong identity is HOLD. */
export async function readProvenanceMarker(store: MarkerStore, namespace: string, orderId: string): Promise<MarkerRead> {
  let got: { body: string } | null;
  try { got = await store.readVersioned(provenancePath(orderId, namespace)); } catch { return 'hold'; }
  if (got === null) return 'absent';
  return typeof got.body === 'string' && isExactMarker(got.body, orderId) ? 'present' : 'hold';
}

/** Create-only + exact readback/adoption. Ambiguous create is reread; still unknown is HOLD. Never overwrites. */
export async function ensureProvenanceMarker(store: MarkerStore, namespace: string, orderId: string): Promise<'confirmed' | 'hold'> {
  let created: Awaited<ReturnType<MarkerStore['createIfAbsent']>> | null = null;
  try { created = await store.createIfAbsent(provenancePath(orderId, namespace), markerBody(orderId)); } catch { created = null; }
  void created; // outcome is never trusted alone: exact readback decides
  return (await readProvenanceMarker(store, namespace, orderId)) === 'present' ? 'confirmed' : 'hold';
}

/** Production access bound to the captured order-store context; null => unavailable (HOLD). */
export type ProvenanceAccess = InitialShippingProvenanceAccess;
export function openProvenanceAccess(
  transport?: InitialShippingProvenanceTransport,
): ProvenanceAccess | null {
  try { return createInitialShippingProvenanceAccess(transport); } catch { return null; }
}
/** Exact read through the bound access; any throw, drift or non-exact body is HOLD. */
export async function readBoundMarker(access: ProvenanceAccess, orderId: string): Promise<MarkerRead> {
  let got: { body: string } | null;
  try { got = await access.read(orderId); } catch { return 'hold'; }
  if (!access.intact()) return 'hold';
  if (got === null) return 'absent';
  return typeof got.body === 'string' && isExactMarker(got.body, orderId) ? 'present' : 'hold';
}
/** Create-only via bound access; confirmation comes solely from exact reread in the same context. */
export async function ensureBoundMarker(access: ProvenanceAccess, orderId: string): Promise<'confirmed' | 'hold'> {
  if (!ORDER_ID.test(orderId)) return 'hold';
  try { await access.create(orderId, markerBody(orderId)); } catch { /* uncertain: reread decides */ }
  if (!access.intact()) return 'hold';
  return (await readBoundMarker(access, orderId)) === 'present' ? 'confirmed' : 'hold';
}
export async function classifyBoundRecovery(access: ProvenanceAccess | null, orderId: string): Promise<RecoveryClassification> {
  if (typeof orderId !== 'string') return { allow: false, code: 'initial_shipping_provenance_hold' };
  if (!ORDER_ID.test(orderId)) return { allow: true };
  if (!access) return { allow: false, code: 'initial_shipping_provenance_hold' };
  const r = await readBoundMarker(access, orderId);
  if (r === 'absent') return { allow: true };
  return { allow: false, code: r === 'present' ? 'initial_shipping_recovery_unsupported' : 'initial_shipping_provenance_hold' };
}

export type RecoveryClassification = { readonly allow: true } | { readonly allow: false; readonly code: 'initial_shipping_recovery_unsupported' | 'initial_shipping_provenance_hold' };
/** Generic recovery guard: consulted by input.id independently of any supplied JSON shipping fields. */
export async function classifyRecoveryProvenance(store: MarkerStore | null, namespace: string, orderId: string): Promise<RecoveryClassification> {
  if (typeof orderId !== 'string') return { allow: false, code: 'initial_shipping_provenance_hold' };
  // The expedited lane only ever binds canonical checkout IDs, so a non-canonical legacy ID cannot carry a marker.
  if (!ORDER_ID.test(orderId)) return { allow: true };
  if (!store) return { allow: false, code: 'initial_shipping_provenance_hold' };
  const r = await readProvenanceMarker(store, namespace, orderId);
  if (r === 'absent') return { allow: true };
  return { allow: false, code: r === 'present' ? 'initial_shipping_recovery_unsupported' : 'initial_shipping_provenance_hold' };
}
