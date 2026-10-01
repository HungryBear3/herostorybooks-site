/**
 * The confirmation-envelope snapshot producer (L-4 Slice A3-4 R2).
 *
 * With the writer armed, a paid order that is positively enrolled and provably
 * never dispatched has its confirmation envelope frozen once, written
 * write-once to the dedicated private store, and then committed as
 * `SNAPSHOTTED` plus its ref in one compare-and-swap that re-derives every
 * record predicate from the latest record. Nothing is sent and no claim is
 * held: sending a frozen envelope belongs to the frozen dispatcher (A3-5).
 *
 * Inert, and interlocked
 * ----------------------
 * The writer arms only when the supplied flag is exactly `true`, the process is
 * not a Vercel deployment, the configuration is complete, and the caller has
 * injected all three store adapters (`put`, `get`, `del`). No production or
 * development caller injects them, so for every default caller this module
 * stops at the gate. The build gate refuses the flag on every Vercel
 * Production build. This does not make local execution universally inert: a
 * local caller that injects adapters arms it.
 *
 * One frozen namespace, bound
 * ---------------------------
 * The namespace is read once, from the frozen snapshot of the supplied
 * environment, and turned into one order-namespace binding at the gate. Every
 * order read and every conditional commit of the attempt goes through the
 * namespace-bound order transaction (NBT) with that binding, and every result's
 * provenance is verified against it. The ambient namespace is read only inside
 * `readBoundaryNamespace`, and only ever compared: at the gate (CK-A), before
 * the write (CK-B), before the transaction (CK-C), inside every guarded bound
 * transaction immediately before its write (CK-G), and before transport on the
 * bound legacy continuation (CK-T). Under armed intent any disagreement is a
 * no-send deferral, never a fallback to the legacy send.
 *
 * The decision is pure
 * --------------------
 * The candidate is rendered exactly once (S3), outside every transaction, and
 * frozen with a key over the record fields the renderer reads. The CAS
 * callback, `decideSnapshotCommit`, is a synchronous, environment-free function
 * of the latest record, the frozen evidence and a frozen context; it rebuilds
 * the candidate from the frozen render and proves byte identity rather than
 * rendering again.
 *
 * Nothing here deletes, lists, sends or logs. It returns closed outcomes; the
 * delivery module logs order ids and closed codes only.
 */
import { buildConfirmationEmailEnvelope } from './confirmation-email-envelope.ts';
import type {
  BuildConfirmationEmailEnvelopeInput,
  BuildConfirmationEmailEnvelopeResult,
  ConfirmationEmailEnvelopeV1,
  ConfirmationEmailRequestV1,
  ConfirmationEnvelopeRefusalReason,
} from './confirmation-email-envelope.ts';
import { classifyLegacyConfirmationRecord, evaluateConfirmationEmailTransition } from './confirmation-email-state.ts';
import type {
  ConfirmationEmailLegacyClass,
  ConfirmationEmailTransitionDecision,
} from './confirmation-email-state.ts';
import {
  CONFIRMATION_ENVELOPE_ORDER_ID_RE,
  confirmationEnvelopeObjectPath,
  resolveConfirmationEnvelopeWriterConfig,
  resolveConfirmationEnvelopeWriterNamespace,
} from './confirmation-envelope-config.ts';
import { createConfirmationEnvelopeStore } from './confirmation-envelope-store.ts';
import type {
  ConfirmationEnvelopeObjectRef,
  ConfirmationEnvelopeStorageRefusal,
  ConfirmationEnvelopeStore,
  ConfirmationEnvelopeStoreIo,
} from './confirmation-envelope-store.ts';
import { materializeConfirmationEmailEnvelopeRef } from './confirmation-envelope-ref.ts';
import type {
  ConfirmationEmailEnvelopeRefV1,
  ConfirmationEnvelopeRefMaterialization,
  ConfirmationEnvelopeRefProblem,
} from './confirmation-envelope-ref.ts';
import { getBlobNamespace } from './blob-namespace.ts';
import {
  bindOrderNamespace,
  orderRecordPathInNamespace,
  readOrderVersionedInNamespace,
  withOrderTransactionInNamespace,
} from './orders.ts';
import type {
  BoundOrderRead,
  BoundOrderTransactionResult,
  OrderNamespaceBinding,
  OrderNamespaceProvenance,
  OrderRecord,
  OrderTransactionOutcome,
} from './orders.ts';
import {
  buildOrderConfirmationEmail,
  buildOrderConfirmationIdempotencyKey,
  getOrderSenderEmail,
  getSupportEmail,
} from './order-email.ts';
import type { ConfirmationEmailBlockReason, OrderTransactImpl } from './confirmation-email-delivery.ts';

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** Armed intent that refuses outright, with no read and no send (CD-1). */
export type ConfirmationEnvelopeWriterRefusalReason =
  | 'namespace_invalid'
  | 'namespace_disagreement'
  | 'order_binding_invalid';

/** Armed intent that disarms to the bound legacy continuation. `flag_off`
 *  here only ever means the supplied flag changed between two reads. */
export type ConfirmationEnvelopeWriterDisarmReason =
  | 'flag_off'
  | 'activation_interlock'
  | 'epoch_missing'
  | 'epoch_invalid'
  | 'epoch_before_floor'
  | 'binding_invalid'
  | 'store_io_not_injected'
  | 'store_unconfigured'
  | 'store_not_dedicated';

/** Every reason an attempt ends with no state change and no send. */
export type ConfirmationEnvelopeSnapshotDeferral =
  | 'write_failed_object_absent'
  | 'store_not_private'
  | 'existing_object_unverified'
  | 'cas_exhausted'
  | 'commit_ambiguous'
  | 'record_changed'
  | 'candidate_drift'
  | 'model_refused'
  | 'namespace_drift'
  | 'store_path_mismatch'
  | 'unexpected'
  | 'namespace_invalid'
  | 'namespace_disagreement'
  | 'order_binding_invalid'
  | 'transaction_provenance_mismatch';

/** The two hold reasons the producer commits. */
export type ConfirmationEnvelopeSnapshotHoldReason = 'snapshot_refused' | 'legacy_unresolved';

/** Why a hold was committed; surfaced only as a closed code in an errorLog. */
export type ConfirmationEnvelopeHoldCause =
  | 'legacy_identity_present'
  | 'envelope_build_refused'
  | 'ref_invalid'
  | 'existing_object_mismatch'
  | 'object_write_refused';

/** The two faults the bound order I/O raises before transport. */
export type ConfirmationOrderNamespaceFault = 'namespace_drift' | 'transaction_provenance_mismatch';

export class ConfirmationOrderNamespaceError extends Error {
  readonly reason: ConfirmationOrderNamespaceFault;

  constructor(reason: ConfirmationOrderNamespaceFault) {
    super(`confirmation order namespace fault: ${reason}`);
    this.name = 'ConfirmationOrderNamespaceError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Frozen evidence (architecture §5.1)
// ---------------------------------------------------------------------------

/** Everything S3 froze that is not derived from the record. */
export type SnapshotParams = Readonly<{
  createdAt: string;
  from: string;
  supportEmail: string;
  accountLabel: string;
  templateVersion: string;
  /** The armed writer's namespace; never an ambient read. */
  namespace: string;
}>;

/** The attempt's single render. */
export type FrozenRender = Readonly<{ subject: string; html: string; text: string }>;

/** The record-derived inputs frozen at S3. */
export type SnapshotFrame = Readonly<{
  orderId: string;
  params: SnapshotParams;
  render: FrozenRender;
  renderInputsKey: string;
  idempotencyKey: string;
}>;

export type SnapshotCandidate = Readonly<{
  orderId: string;
  objectPath: string;
  serialized: string;
  byteLength: number;
  idempotencyKey: string;
  ref: Readonly<ConfirmationEmailEnvelopeRefV1>;
  params: SnapshotParams;
  render: FrozenRender;
  renderInputsKey: string;
}>;

export type SnapshotEvidence = Readonly<
  | { kind: 'object_written'; candidate: SnapshotCandidate }
  | { kind: 'object_verified_equal'; candidate: SnapshotCandidate }
  | {
      kind: 'object_mismatch';
      candidate: SnapshotCandidate;
      refusal: 'object_mismatch' | 'too_large' | 'invalid_object' | 'digest_mismatch' | 'stored_created_at_invalid';
    }
  | { kind: 'own_bytes_refused'; candidate: SnapshotCandidate; refusal: 'path_invalid' | 'too_large' | 'invalid_object' | 'digest_mismatch' }
  | { kind: 'envelope_build_refused'; params: SnapshotParams; renderInputsKey: string; refusal: ConfirmationEnvelopeRefusalReason }
  | { kind: 'ref_invalid'; params: SnapshotParams; renderInputsKey: string; refusal: ConfirmationEnvelopeRefProblem }
  | { kind: 'legacy_unresolved' }
>;

/** The frozen context of one decision: no environment, no store, no clock. */
export type SnapshotDecisionContext = Readonly<{
  epochMs: number;
  nowIso: string;
  /** Delivery's pure claimability fence, partially applied to the attempt's
   *  frozen instant and stale-claim window. */
  evaluateClaimability: (order: OrderRecord) => ConfirmationEmailBlockReason | null;
}>;

export type SnapshotStageResult =
  | { status: 'snapshotted'; via: 'committed' | 'adopted_existing_object' | 'peer_committed' }
  | { status: 'held'; reason: ConfirmationEnvelopeSnapshotHoldReason; cause: ConfirmationEnvelopeHoldCause }
  | { status: 'blocked'; reason: ConfirmationEmailBlockReason }
  | { status: 'snapshot_deferred'; reason: ConfirmationEnvelopeSnapshotDeferral };

export type ConfirmationEnvelopeSnapshotOutcome = SnapshotStageResult | { status: 'not_enrolled' };

// ---------------------------------------------------------------------------
// The gate and the bound order I/O (architecture §4.4)
// ---------------------------------------------------------------------------

/** The raw NBT pair. Tests inject it; production uses the real NBT functions. */
export interface ConfirmationRawOrderIo {
  readonly read: (binding: OrderNamespaceBinding, orderId: string) => Promise<BoundOrderRead>;
  readonly transact: <T>(
    binding: OrderNamespaceBinding,
    orderId: string,
    mutate: (order: OrderRecord) => Promise<OrderTransactionOutcome<T>> | OrderTransactionOutcome<T>,
    opts: { notFound: () => T; maxAttempts?: number; beforeCommit?: () => boolean },
  ) => Promise<BoundOrderTransactionResult<T>>;
}

export interface ConfirmationEnvelopeWriterDeps {
  /** The supplied environment; the ambient environment when absent. */
  env?: NodeJS.ProcessEnv;
  /** All three adapters are required to arm (the SDK-binding interlock). */
  storeIo?: ConfirmationEnvelopeStoreIo;
  /** Tests only: the raw NBT pair. Default: the real NBT functions. */
  orderIo?: ConfirmationRawOrderIo;
}

/** Every order read and commit of one armed-intent attempt, bound and verified. */
export interface BoundOrderIo {
  readonly read: (orderId: string) => Promise<OrderRecord | null>;
  readonly snapshotTransact: (
    orderId: string,
    mutate: (latest: OrderRecord) => OrderTransactionOutcome<SnapshotStageResult>,
  ) => Promise<SnapshotStageResult>;
  /** The legacy claim: guarded by CK-G before every write. */
  readonly guardedTransact: OrderTransactImpl;
  /** The legacy receipt, and the existing post-send release: bound, unguarded. */
  readonly postTransportTransact: OrderTransactImpl;
  /** CK-T: a pure comparison immediately before transport. */
  readonly beforeTransport: () => 'namespace_drift' | null;
  readonly classifyFault: (error: unknown) => ConfirmationOrderNamespaceFault | null;
}

export interface ArmedConfirmationEnvelopeWriter {
  readonly epochMs: number;
  readonly namespace: string;
  readonly binding: OrderNamespaceBinding;
  readonly store: ConfirmationEnvelopeStore;
  readonly accountLabel: string;
  readonly templateVersion: string;
}

export type ConfirmationEnvelopeWriterGate =
  | { readonly kind: 'off' }
  | { readonly kind: 'refused'; readonly reason: ConfirmationEnvelopeWriterRefusalReason }
  | { readonly kind: 'disarmed'; readonly reason: ConfirmationEnvelopeWriterDisarmReason; readonly orderIo: BoundOrderIo }
  | { readonly kind: 'armed'; readonly writer: ArmedConfirmationEnvelopeWriter; readonly orderIo: BoundOrderIo };

export type ArmedConfirmationEnvelopeWriterGate = Extract<ConfirmationEnvelopeWriterGate, { kind: 'armed' }>;

const GATE_OFF: ConfirmationEnvelopeWriterGate = Object.freeze({ kind: 'off' });

const ORDER_NOT_FOUND: SnapshotStageResult = Object.freeze({ status: 'blocked', reason: 'order_not_found' });

/**
 * The ambient namespace, for comparison only. Its value is never used as a
 * path, a ref context or a binding; an unresolvable ambient namespace is a
 * disagreement, because it cannot be proven equal.
 */
function readBoundaryNamespace(): { readonly ok: true; readonly namespace: string } | { readonly ok: false } {
  try {
    return { ok: true, namespace: getBlobNamespace(process.env) };
  } catch {
    return { ok: false };
  }
}

/** CK-B, CK-C, CK-G and CK-T: does the ambient namespace still equal `namespace`? */
function boundaryAgrees(namespace: string): boolean {
  const boundary = readBoundaryNamespace();
  return boundary.ok === true && boundary.namespace === namespace;
}

/**
 * Accept a bound read or transaction result only if its provenance names the
 * frozen namespace and record path, lists only that path for every read and
 * every commit, counts its reads, and reports the outcome derived from the
 * result itself. A read also performed exactly one read and no commit.
 * Through the real NBT this cannot fail; it is the enforcement point for an
 * injected or faulty order I/O.
 */
export function verifyOrderProvenance(
  provenance: unknown,
  expectedOutcome: OrderNamespaceProvenance['outcome'],
  expected: { readonly namespace: string; readonly recordPath: string; readonly operation: 'read' | 'transaction' },
): void {
  let accepted = false;
  try {
    const p = provenance as OrderNamespaceProvenance;
    accepted = p !== null
      && typeof p === 'object'
      && p.namespace === expected.namespace
      && p.recordPath === expected.recordPath
      && Array.isArray(p.readPaths)
      && Array.isArray(p.commitPaths)
      && p.readPaths.every((path) => path === p.recordPath)
      && p.commitPaths.every((path) => path === p.recordPath)
      && Number.isSafeInteger(p.attempts)
      && p.attempts >= 1
      && p.readPaths.length === p.attempts
      && p.outcome === expectedOutcome
      && (expected.operation !== 'read' || (p.attempts === 1 && p.commitPaths.length === 0));
  } catch {
    accepted = false;
  }
  if (!accepted) throw new ConfirmationOrderNamespaceError('transaction_provenance_mismatch');
}

/**
 * The bound order I/O of one attempt. Every member binds to the one namespace
 * frozen at the gate, verifies the provenance of every raw result before using
 * it, and derives the expected outcome from the result it received.
 */
function createBoundOrderIo(
  binding: OrderNamespaceBinding,
  injected: ConfirmationRawOrderIo | undefined,
  namespace: string,
): BoundOrderIo {
  const raw: ConfirmationRawOrderIo = injected ?? { read: readOrderVersionedInNamespace, transact: withOrderTransactionInNamespace };
  const guard = () => boundaryAgrees(namespace);
  const expectedFor = (orderId: string, operation: 'read' | 'transaction') => ({
    namespace,
    recordPath: orderRecordPathInNamespace(binding, orderId),
    operation,
  });
  return Object.freeze({
    read: async (orderId: string) => {
      const r = await raw.read(binding, orderId);
      const expectedOutcome = r.found === null ? 'not_found' : 'read';
      verifyOrderProvenance(r.provenance, expectedOutcome, expectedFor(orderId, 'read'));
      return r.found === null ? null : r.found.order;
    },
    snapshotTransact: async (orderId: string, mutate: (latest: OrderRecord) => OrderTransactionOutcome<SnapshotStageResult>) => {
      const r = await raw.transact(binding, orderId, mutate, { notFound: () => ORDER_NOT_FOUND, beforeCommit: guard });
      verifyOrderProvenance(r.provenance, r.status, expectedFor(orderId, 'transaction'));
      if (r.status === 'commit_refused') throw new ConfirmationOrderNamespaceError('namespace_drift');
      return r.result;
    },
    guardedTransact: (async <T>(orderId: string, mutate: (order: OrderRecord) => OrderTransactionOutcome<T>, opts: { notFound: () => T }) => {
      const r = await raw.transact(binding, orderId, mutate, { notFound: opts.notFound, beforeCommit: guard });
      verifyOrderProvenance(r.provenance, r.status, expectedFor(orderId, 'transaction'));
      if (r.status === 'commit_refused') throw new ConfirmationOrderNamespaceError('namespace_drift');
      return r.result;
    }) as OrderTransactImpl,
    postTransportTransact: (async <T>(orderId: string, mutate: (order: OrderRecord) => OrderTransactionOutcome<T>, opts: { notFound: () => T }) => {
      const r = await raw.transact(binding, orderId, mutate, { notFound: opts.notFound });
      verifyOrderProvenance(r.provenance, r.status, expectedFor(orderId, 'transaction'));
      if (r.status === 'commit_refused') throw new ConfirmationOrderNamespaceError('transaction_provenance_mismatch');
      return r.result;
    }) as OrderTransactImpl,
    beforeTransport: () => (guard() ? null : 'namespace_drift'),
    classifyFault: (error: unknown) => (error instanceof ConfirmationOrderNamespaceError ? error.reason : null),
  });
}

const refusedGate = (reason: ConfirmationEnvelopeWriterRefusalReason): ConfirmationEnvelopeWriterGate =>
  Object.freeze({ kind: 'refused', reason });

const disarmedGate = (reason: ConfirmationEnvelopeWriterDisarmReason, orderIo: BoundOrderIo): ConfirmationEnvelopeWriterGate =>
  Object.freeze({ kind: 'disarmed', reason, orderIo });

/**
 * W0: resolve the writer for one delivery attempt. Reads no order, no `.env`,
 * and calls no SDK or order-store function.
 *
 *   1. Only the supplied flag is read; anything but `true` is `off`.
 *   2. The supplied environment is frozen into one snapshot.
 *   3. The namespace is settled first, from the snapshot: unresolvable is a
 *      refusal; CK-A disagreement with the ambient namespace is a refusal; the
 *      binding is made. Armed intent never falls back on a namespace problem.
 *   4. Then the remaining configuration verdicts disarm to the bound legacy
 *      continuation: the activation interlock, the epoch, the binding
 *      constants, the injected store adapters and the store credential.
 */
export function resolveConfirmationEnvelopeWriter(writerDeps?: ConfirmationEnvelopeWriterDeps): ConfirmationEnvelopeWriterGate {
  const supplied = writerDeps?.env ?? process.env;
  if (supplied.HSB_CONFIRMATION_ENVELOPE_WRITER !== 'true') return GATE_OFF;

  // The one writer snapshot: never logged, projected or returned.
  const snapshot = Object.freeze({ ...supplied }) as NodeJS.ProcessEnv;

  const ns = resolveConfirmationEnvelopeWriterNamespace(snapshot);
  if (ns.ok === false) return refusedGate('namespace_invalid');
  const boundary = readBoundaryNamespace();
  if (!(boundary.ok === true && boundary.namespace === ns.namespace)) return refusedGate('namespace_disagreement');
  const bound = bindOrderNamespace(ns.namespace);
  if (bound.ok === false) return refusedGate('order_binding_invalid');
  const orderIo = createBoundOrderIo(bound.binding, writerDeps?.orderIo, ns.namespace);

  const config = resolveConfirmationEnvelopeWriterConfig(snapshot);
  if (config.armed === false) {
    if (config.reason === 'namespace_invalid') return refusedGate('namespace_invalid');
    return disarmedGate(config.reason, orderIo);
  }
  if (config.namespace !== ns.namespace) return refusedGate('namespace_invalid');

  const storeIo = writerDeps?.storeIo;
  if (
    !storeIo
    || typeof storeIo.put !== 'function'
    || typeof storeIo.get !== 'function'
    || typeof storeIo.del !== 'function'
  ) {
    return disarmedGate('store_io_not_injected', orderIo);
  }

  const created = createConfirmationEnvelopeStore(snapshot, storeIo);
  if (created.ok === false) {
    if (created.refusal === 'namespace_invalid') return refusedGate('namespace_invalid');
    return disarmedGate(created.refusal === 'store_not_dedicated' ? 'store_not_dedicated' : 'store_unconfigured', orderIo);
  }

  const writer: ArmedConfirmationEnvelopeWriter = Object.freeze({
    epochMs: config.epochMs,
    namespace: ns.namespace,
    binding: bound.binding,
    store: Object.freeze(created.value),
    accountLabel: config.accountLabel,
    templateVersion: config.templateVersion,
  });
  return Object.freeze({ kind: 'armed', writer, orderIo });
}

// ---------------------------------------------------------------------------
// Enrollment, the render-input key and the request (architecture §4.3, §5.7)
// ---------------------------------------------------------------------------

/**
 * Positive enrollment only: a grammar-valid id, no state, no ref, and a paidAt
 * that is a strict canonical UTC instant at or after the epoch. No trim, no
 * repair, no zone-less acceptance.
 */
export function isConfirmationEnvelopeEnrolled(order: OrderRecord, epochMs: number): boolean {
  if (typeof order.id !== 'string' || !CONFIRMATION_ENVELOPE_ORDER_ID_RE.test(order.id)) return false;
  if (order.confirmationEmailState !== null && order.confirmationEmailState !== undefined) return false;
  if (order.confirmationEmailEnvelopeRef !== null && order.confirmationEmailEnvelopeRef !== undefined) return false;
  if (typeof order.paidAt !== 'string') return false;
  const paidAtMs = Date.parse(order.paidAt);
  if (!Number.isFinite(paidAtMs)) return false;
  if (new Date(paidAtMs).toISOString() !== order.paidAt) return false;
  return paidAtMs >= epochMs;
}

/** Every record field the request reads: the renderer's five, plus `email`. */
export const CONFIRMATION_RENDER_INPUT_KEYS = Object.freeze([
  'id',
  'email',
  'childName',
  'formatLabel',
  'bookFormat',
  'deliveryExpectation',
] as const);

/**
 * A key over exactly the render-input fields. The `typeof` tag keeps
 * `undefined` and `null` distinct, which the renderer also does.
 */
export function confirmationRenderInputsKey(order: OrderRecord): string {
  const record = order as unknown as Record<string, unknown>;
  return JSON.stringify(
    CONFIRMATION_RENDER_INPUT_KEYS.map((key) => [typeof record[key], record[key] === undefined ? null : record[key]]),
  );
}

/** The six fields the provider would receive, from the frozen render. */
export function composeConfirmationRequest(
  render: FrozenRender,
  params: Pick<SnapshotParams, 'from' | 'supportEmail'>,
  email: string,
): ConfirmationEmailRequestV1 {
  return {
    from: params.from,
    to: [email],
    subject: render.subject,
    html: render.html,
    text: render.text,
    replyTo: params.supportEmail,
  };
}

/**
 * The private-object ceiling, restated: the producer's runtime imports are
 * pinned, and this one constant is not among them. A producer test pins it
 * equal to `CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES`.
 */
export const SNAPSHOT_OBJECT_MAX_BYTES = 327_680 + 4_096;

// ---------------------------------------------------------------------------
// S3: the frame, the candidate and the pure classifiers
// ---------------------------------------------------------------------------

/**
 * S3. The only function that renders or reads a rendering input. It reads the
 * sender, the support address and (through the renderer) the public URL once,
 * and freezes everything the candidate needs. The namespace is the armed
 * writer's.
 */
function freezeSnapshotFrame(
  observed: OrderRecord,
  writer: ArmedConfirmationEnvelopeWriter,
  nowIso: string,
  resolveSender: (() => string) | undefined,
): SnapshotFrame {
  const from = resolveSender?.() ?? getOrderSenderEmail();
  const supportEmail = getSupportEmail();
  const rendered = buildOrderConfirmationEmail(observed, { supportEmail });
  return Object.freeze({
    orderId: observed.id,
    params: Object.freeze({
      createdAt: nowIso,
      from,
      supportEmail,
      accountLabel: writer.accountLabel,
      templateVersion: writer.templateVersion,
      namespace: writer.namespace,
    }),
    render: Object.freeze({ subject: rendered.subject, html: rendered.html, text: rendered.text }),
    renderInputsKey: confirmationRenderInputsKey(observed),
    idempotencyKey: buildOrderConfirmationIdempotencyKey(observed),
  });
}

function envelopeInputOf(frame: SnapshotFrame, email: string): BuildConfirmationEmailEnvelopeInput {
  return {
    orderId: frame.orderId,
    templateVersion: frame.params.templateVersion,
    createdAt: frame.params.createdAt,
    idempotencyKey: frame.idempotencyKey,
    providerBinding: { accountLabel: frame.params.accountLabel },
    request: composeConfirmationRequest(frame.render, frame.params, email),
  };
}

/** The ten-key ref for a built envelope at the frame's object path. */
function candidateRefOf(envelope: ConfirmationEmailEnvelopeV1, frame: SnapshotFrame): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    orderId: envelope.orderId,
    templateVersion: envelope.templateVersion,
    createdAt: envelope.createdAt,
    canonicalDigest: envelope.canonicalDigest,
    canonicalBytes: envelope.canonicalBytes,
    accountLabel: envelope.providerBinding.accountLabel,
    storageKind: 'private_blob',
    objectPath: confirmationEnvelopeObjectPath(frame.orderId, frame.params.namespace) ?? '',
    purgedAt: null,
  };
}

/**
 * Pure. A build result and a ref result become either the deep-frozen
 * candidate or record-derived evidence (`envelope_build_refused`,
 * `ref_invalid`) that goes straight to S6.
 */
export function classifySnapshotFreeze(
  frame: SnapshotFrame,
  built: BuildConfirmationEmailEnvelopeResult,
  refResult: ConfirmationEnvelopeRefMaterialization | null,
): SnapshotCandidate | SnapshotEvidence {
  const params = Object.freeze(frame.params);
  if (built.ok === false) {
    return Object.freeze({ kind: 'envelope_build_refused', params, renderInputsKey: frame.renderInputsKey, refusal: built.refusal });
  }
  if (refResult === null) {
    return Object.freeze({ kind: 'ref_invalid', params, renderInputsKey: frame.renderInputsKey, refusal: 'ref_not_object' });
  }
  if (refResult.ok === false) {
    return Object.freeze({ kind: 'ref_invalid', params, renderInputsKey: frame.renderInputsKey, refusal: refResult.problem });
  }
  const serialized = JSON.stringify(built.envelope);
  return Object.freeze({
    orderId: frame.orderId,
    objectPath: confirmationEnvelopeObjectPath(frame.orderId, params.namespace) ?? '',
    serialized,
    byteLength: Buffer.byteLength(serialized, 'utf8'),
    idempotencyKey: frame.idempotencyKey,
    ref: Object.freeze(refResult.ref),
    params,
    render: Object.freeze(frame.render),
    renderInputsKey: frame.renderInputsKey,
  });
}

function isSnapshotCandidate(value: SnapshotCandidate | SnapshotEvidence): value is SnapshotCandidate {
  return 'serialized' in value;
}

/** Build, materialize and classify one candidate from a frame and an address. */
function assembleSnapshotCandidate(frame: SnapshotFrame, email: string): SnapshotCandidate | SnapshotEvidence {
  const built = buildConfirmationEmailEnvelope(envelopeInputOf(frame, email));
  const refResult = built.ok === true
    ? materializeConfirmationEmailEnvelopeRef(candidateRefOf(built.envelope, frame), {
      orderId: frame.orderId,
      namespace: frame.params.namespace,
    })
    : null;
  return classifySnapshotFreeze(frame, built, refResult);
}

/** S3 pre-checks on our own bytes, before any SDK call. */
function ownBytesRefusal(candidate: SnapshotCandidate): 'invalid_object' | 'too_large' | null {
  if (!candidate.serialized.isWellFormed()) return 'invalid_object';
  if (candidate.byteLength > SNAPSHOT_OBJECT_MAX_BYTES) return 'too_large';
  return null;
}

type ClassifiedStorage =
  | { readonly ok: true; readonly evidence: SnapshotEvidence }
  | { readonly ok: false; readonly deferral: 'store_path_mismatch' };

/** Pure. A successful write is evidence only if it names the candidate's path and size. */
export function classifySnapshotWrite(
  candidate: SnapshotCandidate,
  result: { readonly ok: true; readonly value: ConfirmationEnvelopeObjectRef },
): ClassifiedStorage {
  if (result.value.objectPath !== candidate.objectPath || result.value.storedBytes !== candidate.byteLength) {
    return { ok: false, deferral: 'store_path_mismatch' };
  }
  return { ok: true, evidence: Object.freeze({ kind: 'object_written', candidate }) };
}

/** Pure. A successful byte-exact verify is evidence only if it names the candidate's path and size. */
export function classifySnapshotVerify(
  candidate: SnapshotCandidate,
  result: { readonly ok: true; readonly value: ConfirmationEnvelopeObjectRef },
): ClassifiedStorage {
  if (result.value.objectPath !== candidate.objectPath || result.value.storedBytes !== candidate.byteLength) {
    return { ok: false, deferral: 'store_path_mismatch' };
  }
  return { ok: true, evidence: Object.freeze({ kind: 'object_verified_equal', candidate }) };
}

// ---------------------------------------------------------------------------
// S6: the decision (architecture §5.3) — synchronous and environment-free
// ---------------------------------------------------------------------------

const SNAPSHOT_HOLD_CAUSES = Object.freeze({
  object_mismatch: 'existing_object_mismatch',
  own_bytes_refused: 'object_write_refused',
  envelope_build_refused: 'envelope_build_refused',
  ref_invalid: 'ref_invalid',
} as const);

function deferredDecision(reason: ConfirmationEnvelopeSnapshotDeferral): OrderTransactionOutcome<SnapshotStageResult> {
  return { abort: { status: 'snapshot_deferred', reason } };
}

/** Deep equality over the ten primitive ref members. */
function refsEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]);
}

/** Step 1: an identical `SNAPSHOTTED` peer is already exactly this commit. */
function isIdenticalPeer(latest: OrderRecord, candidate: SnapshotCandidate): boolean {
  return latest.confirmationEmailState === 'SNAPSHOTTED'
    && refsEqual(latest.confirmationEmailEnvelopeRef, candidate.ref)
    && latest.confirmationEmailFrom === candidate.params.from
    && latest.confirmationEmailIdempotencyKey === candidate.idempotencyKey;
}

/** Step 5b: the candidate rebuilt from `latest` and the frozen evidence only. */
function candidateRebuildMatches(latest: OrderRecord, candidate: SnapshotCandidate): boolean {
  const rebuilt = assembleSnapshotCandidate(
    {
      orderId: latest.id,
      params: candidate.params,
      render: candidate.render,
      renderInputsKey: candidate.renderInputsKey,
      idempotencyKey: buildOrderConfirmationIdempotencyKey(latest),
    },
    latest.email,
  );
  if (!isSnapshotCandidate(rebuilt)) return false;
  return rebuilt.serialized.isWellFormed()
    && rebuilt.serialized === candidate.serialized
    && rebuilt.byteLength === candidate.byteLength
    && refsEqual(rebuilt.ref, candidate.ref)
    && rebuilt.idempotencyKey === candidate.idempotencyKey
    && rebuilt.objectPath === candidate.objectPath
    && latest.id === candidate.orderId;
}

/** Step 5: render inputs for every render-bearing kind; byte identity for the
 *  storage-derived kinds; the key alone for the two record-derived refusals. */
function snapshotIdentityHolds(latest: OrderRecord, evidence: SnapshotEvidence): boolean {
  if (evidence.kind === 'legacy_unresolved') return true;
  const frozenKey = evidence.kind === 'envelope_build_refused' || evidence.kind === 'ref_invalid'
    ? evidence.renderInputsKey
    : evidence.candidate.renderInputsKey;
  if (confirmationRenderInputsKey(latest) !== frozenKey) return false;
  if (evidence.kind === 'envelope_build_refused' || evidence.kind === 'ref_invalid') return true;
  return candidateRebuildMatches(latest, evidence.candidate);
}

/** The model, for the first touch of a stateless record (T1). */
function claimAcquiredDecision(legacyClass: ConfirmationEmailLegacyClass): ConfirmationEmailTransitionDecision {
  return evaluateConfirmationEmailTransition({ from: null, event: 'claim_acquired', actor: 'worker', legacyClass });
}

/** The model, for a snapshot that cannot be frozen (T13). */
function snapshotRefusedDecision(): ConfirmationEmailTransitionDecision {
  return evaluateConfirmationEmailTransition({ from: null, event: 'snapshot_refused', actor: 'worker' });
}

function holdPermitted(decision: ConfirmationEmailTransitionDecision): boolean {
  return decision.allowed === true && decision.to === 'RECONCILIATION_REQUIRED' && decision.permitsProviderCall === false;
}

/** A hold carries no ref, no identity and no claim. */
function holdCommit(
  latest: OrderRecord,
  decision: ConfirmationEmailTransitionDecision,
  ctx: SnapshotDecisionContext,
  reason: ConfirmationEnvelopeSnapshotHoldReason,
  cause: ConfirmationEnvelopeHoldCause,
): OrderTransactionOutcome<SnapshotStageResult> {
  if (decision.allowed !== true || !holdPermitted(decision)) return deferredDecision('model_refused');
  return {
    commit: {
      ...latest,
      confirmationEmailState: decision.to,
      confirmationEmailHoldReason: decision.holdReason,
      updatedAt: ctx.nowIso,
    },
    result: { status: 'held', reason, cause },
  };
}

function snapshottedCommit(
  latest: OrderRecord,
  evidence: Extract<SnapshotEvidence, { kind: 'object_written' | 'object_verified_equal' }>,
  legacyClass: ConfirmationEmailLegacyClass,
  ctx: SnapshotDecisionContext,
): OrderTransactionOutcome<SnapshotStageResult> {
  const decision = claimAcquiredDecision(legacyClass);
  if (
    decision.allowed !== true
    || decision.to !== 'SNAPSHOTTED'
    || decision.holdReason !== null
    || decision.permitsProviderCall !== false
    || decision.releasesClaim !== false
  ) {
    return deferredDecision('model_refused');
  }
  const { candidate } = evidence;
  return {
    commit: {
      ...latest,
      confirmationEmailState: decision.to,
      confirmationEmailHoldReason: decision.holdReason,
      confirmationEmailEnvelopeRef: candidate.ref,
      confirmationEmailFrom: candidate.params.from,
      confirmationEmailIdempotencyKey: candidate.idempotencyKey,
      updatedAt: ctx.nowIso,
    },
    result: { status: 'snapshotted', via: evidence.kind === 'object_written' ? 'committed' : 'adopted_existing_object' },
  };
}

/**
 * The CAS callback. Pure and synchronous: a deterministic function of the
 * latest record, the frozen evidence and the frozen context, re-deriving every
 * record predicate on every invocation (peer, fence, enrollment, legacy class,
 * candidate identity, model) before choosing the one commit it may make.
 */
export function decideSnapshotCommit(
  latest: OrderRecord,
  evidence: SnapshotEvidence,
  ctx: SnapshotDecisionContext,
): OrderTransactionOutcome<SnapshotStageResult> {
  if ((evidence.kind === 'object_written' || evidence.kind === 'object_verified_equal') && isIdenticalPeer(latest, evidence.candidate)) {
    return { abort: { status: 'snapshotted', via: 'peer_committed' } };
  }
  const blocked = ctx.evaluateClaimability(latest);
  if (blocked) return { abort: { status: 'blocked', reason: blocked } };
  if (!isConfirmationEnvelopeEnrolled(latest, ctx.epochMs)) return deferredDecision('record_changed');

  const legacyClass = classifyLegacyConfirmationRecord(latest, { t193AtMs: ctx.epochMs });
  if (legacyClass === 'LEGACY_UNRESOLVED') {
    return holdCommit(latest, claimAcquiredDecision(legacyClass), ctx, 'legacy_unresolved', 'legacy_identity_present');
  }
  if (evidence.kind === 'legacy_unresolved') return deferredDecision('record_changed');

  if (!snapshotIdentityHolds(latest, evidence)) return deferredDecision('candidate_drift');

  if (evidence.kind === 'object_written' || evidence.kind === 'object_verified_equal') {
    return snapshottedCommit(latest, evidence, legacyClass, ctx);
  }
  return holdCommit(latest, snapshotRefusedDecision(), ctx, 'snapshot_refused', SNAPSHOT_HOLD_CAUSES[evidence.kind]);
}

// ---------------------------------------------------------------------------
// S4–S7: the attempt
// ---------------------------------------------------------------------------

const deferred = (reason: ConfirmationEnvelopeSnapshotDeferral): SnapshotStageResult =>
  Object.freeze({ status: 'snapshot_deferred', reason });

const LEGACY_UNRESOLVED_EVIDENCE: SnapshotEvidence = Object.freeze({ kind: 'legacy_unresolved' });

/** The adapter's conflict-exhaustion error, recognized by its class name only. */
function isVersionConflict(error: unknown): boolean {
  try {
    return error instanceof Error && error.name === 'OrderVersionConflictError';
  } catch {
    return false;
  }
}

/**
 * S6, the production commit stage. CK-C immediately before the transaction;
 * then one bound transaction whose callback is exactly the pure decision, and
 * whose every write is guarded by CK-G. Exported so the drift matrix can drive
 * every evidence kind through the real NBT and the real guard.
 */
export async function runSnapshotCommitStage(
  orderId: string,
  evidence: SnapshotEvidence,
  ctx: SnapshotDecisionContext,
  gate: ArmedConfirmationEnvelopeWriterGate,
): Promise<SnapshotStageResult> {
  if (!boundaryAgrees(gate.writer.namespace)) return deferred('namespace_drift');
  try {
    return await gate.orderIo.snapshotTransact(orderId, (latest) => decideSnapshotCommit(latest, evidence, ctx));
  } catch (error) {
    const fault = gate.orderIo.classifyFault(error);
    if (fault) return deferred(fault);
    if (isVersionConflict(error)) return deferred('cas_exhausted');
    return deferred('commit_ambiguous');
  }
}

const mismatchEvidence = (
  candidate: SnapshotCandidate,
  refusal: Extract<SnapshotEvidence, { kind: 'object_mismatch' }>['refusal'],
): SnapshotEvidence => Object.freeze({ kind: 'object_mismatch', candidate, refusal });

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

type StorageObservation = SnapshotEvidence | { readonly deferral: ConfirmationEnvelopeSnapshotDeferral };

/**
 * S5 after a write that did not prove a fresh object: one authenticated read,
 * then, for an object whose createdAt is canonical and not before payment, one
 * byte-exact verify of the candidate rebuilt from the frozen frame with only
 * that createdAt borrowed. Adoption needs raw-byte equality; nothing is
 * deleted; mismatched bytes are never returned.
 */
async function observeExistingObject(
  observed: OrderRecord,
  store: ConfirmationEnvelopeStore,
  frame: SnapshotFrame,
  candidate: SnapshotCandidate,
  writeRefusal: ConfirmationEnvelopeStorageRefusal,
): Promise<StorageObservation> {
  const stored = await store.read(observed.id);
  if (stored.ok === false) {
    switch (stored.refusal) {
      case 'invalid_object':
      case 'digest_mismatch':
      case 'too_large':
        return mismatchEvidence(candidate, stored.refusal);
      case 'not_found':
        return { deferral: writeRefusal === 'write_failed' ? 'write_failed_object_absent' : 'existing_object_unverified' };
      default:
        return { deferral: 'existing_object_unverified' };
    }
  }
  const createdAt = stored.value.createdAt;
  if (!isCanonicalInstant(createdAt) || Date.parse(createdAt) < Date.parse(observed.paidAt!)) {
    return mismatchEvidence(candidate, 'stored_created_at_invalid');
  }
  const adopted = assembleSnapshotCandidate(
    Object.freeze({ ...frame, params: Object.freeze({ ...frame.params, createdAt }) }),
    observed.email,
  );
  if (!isSnapshotCandidate(adopted)) return mismatchEvidence(candidate, 'stored_created_at_invalid');
  const verified = await store.verifyStoredBytes(observed.id, adopted.serialized);
  if (verified.ok === true) {
    const accepted = classifySnapshotVerify(adopted, verified);
    return accepted.ok === true ? accepted.evidence : { deferral: accepted.deferral };
  }
  switch (verified.refusal) {
    case 'object_mismatch':
    case 'too_large':
    case 'invalid_object':
    case 'digest_mismatch':
      return mismatchEvidence(adopted, verified.refusal);
    default:
      return { deferral: 'existing_object_unverified' };
  }
}

/** S4 and S5: at most one put, one read and one verify, all before S6. */
async function observeSnapshotStorage(
  observed: OrderRecord,
  store: ConfirmationEnvelopeStore,
  frame: SnapshotFrame,
  candidate: SnapshotCandidate,
): Promise<StorageObservation> {
  const written = await store.write(observed.id, candidate.serialized);
  if (written.ok === true) {
    const accepted = classifySnapshotWrite(candidate, written);
    return accepted.ok === true ? accepted.evidence : { deferral: accepted.deferral };
  }
  switch (written.refusal) {
    case 'store_not_private':
      // No readback and no fallback: the store is public.
      return { deferral: 'store_not_private' };
    case 'path_invalid':
    case 'too_large':
    case 'invalid_object':
    case 'digest_mismatch':
      return Object.freeze({ kind: 'own_bytes_refused', candidate, refusal: written.refusal });
    case 'object_exists':
    case 'write_failed':
      return observeExistingObject(observed, store, frame, candidate, written.refusal);
    default:
      return { deferral: 'unexpected' };
  }
}

export interface SnapshotConfirmationEnvelopeOptions {
  /** The delivery's single clock reading. */
  readonly nowMs: number;
  /** Delivery's pure fence, partially applied to `nowMs`. */
  readonly evaluateClaimability: (order: OrderRecord) => ConfirmationEmailBlockReason | null;
  /** The primary sender, read once at S3 when supplied. */
  readonly resolveSender?: () => string;
}

/**
 * One armed attempt on an order the caller has already read through the bound
 * order I/O (S0) and fenced. Never throws.
 *
 *   S1  not enrolled             → `not_enrolled` (the caller continues legacy, bound)
 *   S2  legacy identity present  → S6 with record-derived evidence, no write
 *   S3  freeze the frame and the candidate, once
 *   CK-B, S4 write once, S5 read and verify once
 *   S6  CK-C, then the bound decision transaction (CK-G inside it)
 *   S7  every throw becomes a closed deferral
 */
export async function snapshotConfirmationEnvelope(
  observed: OrderRecord,
  gate: ArmedConfirmationEnvelopeWriterGate,
  opts: SnapshotConfirmationEnvelopeOptions,
): Promise<ConfirmationEnvelopeSnapshotOutcome> {
  try {
    const { writer } = gate;
    if (!isConfirmationEnvelopeEnrolled(observed, writer.epochMs)) return { status: 'not_enrolled' };

    const nowIso = new Date(opts.nowMs).toISOString();
    const ctx: SnapshotDecisionContext = Object.freeze({
      epochMs: writer.epochMs,
      nowIso,
      evaluateClaimability: opts.evaluateClaimability,
    });

    if (classifyLegacyConfirmationRecord(observed, { t193AtMs: writer.epochMs }) === 'LEGACY_UNRESOLVED') {
      return await runSnapshotCommitStage(observed.id, LEGACY_UNRESOLVED_EVIDENCE, ctx, gate);
    }

    const frame = freezeSnapshotFrame(observed, writer, nowIso, opts.resolveSender);
    const frozen = assembleSnapshotCandidate(frame, observed.email);
    if (!isSnapshotCandidate(frozen)) return await runSnapshotCommitStage(observed.id, frozen, ctx, gate);

    const ownBytes = ownBytesRefusal(frozen);
    if (ownBytes) {
      return await runSnapshotCommitStage(observed.id, Object.freeze({ kind: 'own_bytes_refused', candidate: frozen, refusal: ownBytes }), ctx, gate);
    }

    // CK-B: no write unless the ambient namespace still agrees.
    if (!boundaryAgrees(writer.namespace)) return deferred('namespace_drift');

    const observation = await observeSnapshotStorage(observed, writer.store, frame, frozen);
    if ('deferral' in observation) return deferred(observation.deferral);
    return await runSnapshotCommitStage(observed.id, observation, ctx, gate);
  } catch {
    return deferred('unexpected');
  }
}
