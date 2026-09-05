/**
 * Prepared/committed intake-to-order binding saga core.
 *
 * This module deliberately has no provider, route, Stripe, Blob, email, or
 * promotion implementation. All I/O is injected. The order write is the commit
 * point: the exact finalized private-media tuple is mapped before that write,
 * and the intake is acknowledged only after exact order durability is known.
 */
import crypto from 'node:crypto';

import type {
  CheckoutFinalizeSelection,
  FinalizeIntakeParams,
  FinalizeIntakeResult,
} from './checkout-finalize.ts';
import type { FinalizedSelectionEntry } from './checkout-intake.ts';
import {
  checkoutIntakeOrderContractDigest,
  checkoutSessionAttemptStateValid,
  readCheckoutSessionCandidate,
  readCheckoutSessionProvisioning,
  type FamilyCharacter,
  type OrderRecord,
} from './orders.ts';

export type AuthoritativeOrderLookup =
  | { status: 'found'; order: OrderRecord }
  | { status: 'absent' }
  | { status: 'unknown' };

export type CreateIfAbsentOrderResult =
  | { status: 'created'; order: OrderRecord }
  | { status: 'existing'; order: OrderRecord }
  | { status: 'ambiguous' };

export interface PreparedIntakeOrderBindingDependencies {
  finalizeIntake(params: FinalizeIntakeParams): Promise<FinalizeIntakeResult>;
  /** Must use create-if-absent semantics equivalent to orders.persistNewOrder. */
  persistNewOrder(order: OrderRecord): Promise<CreateIfAbsentOrderResult>;
  /** Must distinguish authoritative absence from an unavailable/uncertain read. */
  readOrder(orderId: string): Promise<AuthoritativeOrderLookup>;
  markIntakeFinalized(params: {
    intakeId: string;
    capability: string;
    orderId: string;
  }): Promise<void>;
  abortIntakeFinalization(params: {
    intakeId: string;
    capability: string;
    checkoutAttemptId: string;
  }): Promise<{ aborted: boolean }>;
}

export interface PreparedIntakeOrderBindingParams {
  /** Complete non-media order, constructed in memory and not yet persisted. */
  draftOrder: OrderRecord;
  intakeId: string;
  capability: string;
  selection: CheckoutFinalizeSelection;
  familyCharacterIds: readonly string[];
}

export type PreparedIntakeOrderBindingResult =
  | { status: 'committed'; order: OrderRecord }
  | { status: 'intake_finalize_failed'; orderId: string; code: string }
  | { status: 'preparation_failed'; orderId: string; code: string }
  | { status: 'order_conflict'; orderId: string }
  | {
      status: 'order_persistence_failed';
      orderId: string;
      reconciliation: 'absent' | 'unknown';
      reservation: 'aborted' | 'abort_failed' | 'preserved';
    }
  | { status: 'intake_mark_pending'; order: OrderRecord };

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function containsForbiddenCapability(value: unknown, capability: string): boolean {
  if (capability.length === 0) return true;
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string' && serialized.includes(capability)) return true;
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === 'string') {
        if (current.includes(capability)) return true;
        continue;
      }
      if (!current || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      for (const key of Object.keys(current)) {
        if (key.toLowerCase().includes('capability') || key.includes(capability)) return true;
        pending.push((current as Record<string, unknown>)[key]);
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Fold intake identity into the existing normalized non-media contract. */
export function intakeBoundCheckoutFingerprint(
  baseCheckoutFingerprint: string,
  intakeId: string,
  finalizationFingerprint: string,
): string {
  return crypto.createHash('sha256').update([
    'checkout-intake-order-binding:v1',
    baseCheckoutFingerprint,
    intakeId,
    finalizationFingerprint,
  ].join('\n')).digest('hex');
}

function prepareOrder(
  draft: OrderRecord,
  intakeId: string,
  result: FinalizeIntakeResult,
  familyCharacterIds: readonly string[],
): OrderRecord | null {
  const entries = result.finalization.selection;
  if (result.resolved.fingerprint !== result.finalization.fingerprint
    || !same(result.resolved.entries, entries)
    || result.finalization.orderId !== draft.id
    || result.finalization.checkoutAttemptId !== draft.checkoutAttemptId
    || !draft.checkoutFingerprint) return null;

  const byCategory = (category: FinalizedSelectionEntry['category']) =>
    entries.filter((candidate) => candidate.category === category);
  const primary = byCategory('primary_hero_photo');
  const families = byCategory('family_pet_reference');
  const guided = byCategory('guided_still').sort(
    (a, b) => (a.guidedStillIndex ?? -1) - (b.guidedStillIndex ?? -1),
  );
  const voices = byCategory('voice_inspiration');
  const documents = byCategory('document_inspiration');
  if (primary.length > 1 || voices.length > 1 || documents.length > 1
    || (voices.length > 0 && documents.length > 0)
    || !Array.isArray(draft.familyCharacters)) return null;

  const familyCharacters = structuredClone(draft.familyCharacters) as FamilyCharacter[];
  const occupied = new Set<number>();
  for (const media of families) {
    const index = media.familyCharacterIndex;
    if (index === null || index < 0 || index >= familyCharacters.length
      || occupied.has(index)
      || familyCharacterIds[index] !== media.familyCharacterId) return null;
    occupied.add(index);
    familyCharacters[index] = { ...familyCharacters[index]!, checkoutIntakeMedia: structuredClone(media) };
  }

  const safeDraft = structuredClone(draft) as OrderRecord & Record<string, unknown>;

  const preparedUpdatedAt = new Date(Math.max(
    Date.parse(draft.updatedAt),
    Date.parse(result.finalization.reservedAt),
  )).toISOString();
  const prepared: OrderRecord = {
    ...safeDraft,
    updatedAt: preparedUpdatedAt,
    checkoutFingerprint: intakeBoundCheckoutFingerprint(
      draft.checkoutFingerprint,
      intakeId,
      result.finalization.fingerprint,
    ),
    checkoutIntake: {
      intakeId,
      fingerprint: result.finalization.fingerprint,
      orderContractDigest: '',
      selection: structuredClone(entries),
    },
    checkoutIntakeMediaRetention: {
      status: 'active',
      activatedAt: result.finalization.reservedAt,
    },
    familyCharacters,
    primaryHeroIntakeMedia: primary[0] ? structuredClone(primary[0]) : null,
    guidedStillIntakeMedia: structuredClone(guided),
    voiceIntakeMedia: voices[0] ? structuredClone(voices[0]) : null,
    documentIntakeMedia: documents[0] ? structuredClone(documents[0]) : null,
    // Dedicated private-intake pathnames must never enter legacy public URL/path fields.
    photoBlobPath: null,
    photoBlobUrl: null,
    voiceBlobPath: null,
    voiceBlobUrl: null,
  };
  const digest = checkoutIntakeOrderContractDigest(prepared);
  if (!digest || !prepared.checkoutIntake) return null;
  prepared.checkoutIntake.orderContractDigest = digest;
  return prepared;
}

/**
 * Normalize exact pre-Stripe reconciliation while permitting only the durable
 * checkout-retry bookkeeping the SERVER writes on this order's behalf.
 *
 * A fresh request always builds a pristine prepared draft. It has no way to
 * know that the durable order has since renewed a lease, recorded a Session
 * candidate, entered a provider create, or retired a dead Session and moved to
 * its replacement — all of which are written by the checkout machinery, never
 * by anything a caller sends. Comparing those fields would report every second
 * recovery of an order as a conflict and strand the buyer, which is exactly
 * what `checkoutSessionAttempt` / `supersededCheckoutSessionIds` did.
 *
 * Each exemption is CLASSIFIED, not blanket:
 *
 *  - the lease pair is unconditional; it is pure liveness and carries no
 *    identity a comparison could protect;
 *  - the candidate, the provisioning marker, and the attempt/superseded pair
 *    are exempted only when they read as THIS order's own, internally
 *    consistent, server-written evidence. Their parsers already pin them to
 *    this record's attempt id, fingerprint and generation.
 *
 * Anything malformed, internally inconsistent, or naming another attempt stays
 * in the comparison and is reported as an order conflict — the fail-closed
 * answer for evidence this code cannot account for. Every other field,
 * including everything about the customer, the payment, the media, the
 * fulfillment and the refund lifecycle, is compared byte for byte.
 */
function preStripeComparableOrder(order: OrderRecord): unknown {
  const comparable = JSON.parse(JSON.stringify(order)) as Record<string, unknown>;
  delete comparable.createdAt;
  delete comparable.updatedAt;
  delete comparable.checkoutLeaseId;
  delete comparable.checkoutLeaseExpiresAt;
  if (readCheckoutSessionCandidate(order).status !== 'invalid') {
    delete comparable.checkoutSessionCandidate;
  }
  if (readCheckoutSessionProvisioning(order).status !== 'invalid') {
    delete comparable.checkoutSessionProvisioning;
  }
  // The counter and its audit trail move together — one supersession appends
  // exactly one id and bumps the counter by exactly one — so they are exempted
  // together or not at all. A record where they disagree is unaccountable
  // evidence about how many payable Sessions this order has had.
  if (checkoutSessionAttemptStateValid(order)) {
    delete comparable.checkoutSessionAttempt;
    delete comparable.supersededCheckoutSessionIds;
  }
  return comparable;
}

function boundSessionComparableOrder(order: OrderRecord): unknown {
  const comparable = preStripeComparableOrder(order) as Record<string, unknown>;
  delete comparable.stripeSessionId;
  return comparable;
}

/** Exact dimensions on which an existing committed order may be resumed. */
export function exactIntakeBoundOrder(actual: OrderRecord, expected: OrderRecord): boolean {
  const expectedDigest = expected.checkoutIntake?.orderContractDigest;
  return typeof expectedDigest === 'string'
    && /^[a-f0-9]{64}$/.test(expectedDigest)
    && actual.checkoutIntake?.orderContractDigest === expectedDigest
    && checkoutIntakeOrderContractDigest(expected) === expectedDigest
    && checkoutIntakeOrderContractDigest(actual) === expectedDigest
    && actual.checkoutIntakeMediaRetention?.status === 'active'
    && expected.checkoutIntakeMediaRetention?.status === 'active'
    && actual.paymentStatus === 'pending'
    && expected.paymentStatus === 'pending'
    && (actual.stripeSessionId ?? null) === null
    && (expected.stripeSessionId ?? null) === null
    && (actual.stripePaymentIntentId ?? null) === null
    && (expected.stripePaymentIntentId ?? null) === null
    && same(preStripeComparableOrder(actual), preStripeComparableOrder(expected));
}

/**
 * Exact immutable-order match for an attempt whose Checkout Session was
 * already durably bound. The session id itself is verified against Stripe by
 * the outer saga before any URL is released.
 */
export function exactIntakeBoundSessionOrder(actual: OrderRecord, expected: OrderRecord): boolean {
  const expectedDigest = expected.checkoutIntake?.orderContractDigest;
  return typeof expectedDigest === 'string'
    && /^[a-f0-9]{64}$/.test(expectedDigest)
    && actual.checkoutIntake?.orderContractDigest === expectedDigest
    && checkoutIntakeOrderContractDigest(expected) === expectedDigest
    && checkoutIntakeOrderContractDigest(actual) === expectedDigest
    && actual.checkoutIntakeMediaRetention?.status === 'active'
    && expected.checkoutIntakeMediaRetention?.status === 'active'
    && actual.paymentStatus === 'pending'
    && expected.paymentStatus === 'pending'
    && typeof actual.stripeSessionId === 'string'
    && actual.stripeSessionId.length > 0
    && (expected.stripeSessionId ?? null) === null
    && (actual.stripePaymentIntentId ?? null) === null
    && (expected.stripePaymentIntentId ?? null) === null
    && same(boundSessionComparableOrder(actual), boundSessionComparableOrder(expected));
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'intake_finalization_unavailable';
}

export async function runPreparedIntakeOrderBinding(
  params: PreparedIntakeOrderBindingParams,
  dependencies: PreparedIntakeOrderBindingDependencies,
): Promise<PreparedIntakeOrderBindingResult> {
  const checkoutAttemptId = params.draftOrder.checkoutAttemptId;
  if (!checkoutAttemptId) {
    return { status: 'preparation_failed', orderId: params.draftOrder.id, code: 'checkout_attempt_missing' };
  }
  if (containsForbiddenCapability(params.draftOrder, params.capability)
    || containsForbiddenCapability(params.selection, params.capability)) {
    return {
      status: 'preparation_failed',
      orderId: params.draftOrder.id,
      code: 'capability_key_forbidden',
    };
  }

  let finalized: FinalizeIntakeResult;
  try {
    finalized = await dependencies.finalizeIntake({
      intakeId: params.intakeId,
      capability: params.capability,
      checkoutAttemptId,
      orderId: params.draftOrder.id,
      selection: params.selection,
      familyCharacterIds: params.familyCharacterIds,
    });
  } catch (error) {
    return {
      status: 'intake_finalize_failed',
      orderId: params.draftOrder.id,
      code: errorCode(error),
    };
  }

  let prepared: OrderRecord | null;
  try {
    prepared = prepareOrder(
      params.draftOrder,
      params.intakeId,
      finalized,
      params.familyCharacterIds,
    );
  } catch {
    prepared = null;
  }
  if (containsForbiddenCapability(finalized.finalization.selection, params.capability)
    || containsForbiddenCapability(finalized.resolved.entries, params.capability)
    || (prepared !== null && containsForbiddenCapability(prepared, params.capability))) {
    return {
      status: 'preparation_failed',
      orderId: params.draftOrder.id,
      code: 'capability_key_forbidden',
    };
  }
  if (!prepared) {
    try {
      await dependencies.abortIntakeFinalization({
        intakeId: params.intakeId,
        capability: params.capability,
        checkoutAttemptId,
      });
    } catch {
      // Preparation still fails closed if reservation release is unavailable.
    }
    return { status: 'preparation_failed', orderId: params.draftOrder.id, code: 'finalized_tuple_invalid' };
  }

  let committed: OrderRecord;
  let persistence: CreateIfAbsentOrderResult;
  try {
    persistence = await dependencies.persistNewOrder(prepared);
  } catch {
    persistence = { status: 'ambiguous' };
  }

  if (persistence.status === 'created' || persistence.status === 'existing') {
    committed = persistence.order;
    if (!exactIntakeBoundOrder(committed, prepared)
      && !exactIntakeBoundSessionOrder(committed, prepared)) {
      return { status: 'order_conflict', orderId: prepared.id };
    }
  } else {
    let lookup: AuthoritativeOrderLookup;
    try {
      lookup = await dependencies.readOrder(prepared.id);
    } catch {
      lookup = { status: 'unknown' };
    }
    if (lookup.status === 'found') {
      if (!exactIntakeBoundOrder(lookup.order, prepared)
        && !exactIntakeBoundSessionOrder(lookup.order, prepared)) {
        return { status: 'order_conflict', orderId: prepared.id };
      }
      committed = lookup.order;
    } else if (lookup.status === 'absent') {
      try {
        const abort = await dependencies.abortIntakeFinalization({
          intakeId: params.intakeId,
          capability: params.capability,
          checkoutAttemptId,
        });
        return {
          status: 'order_persistence_failed', orderId: prepared.id,
          reconciliation: 'absent', reservation: abort.aborted ? 'aborted' : 'abort_failed',
        };
      } catch {
        return {
          status: 'order_persistence_failed', orderId: prepared.id,
          reconciliation: 'absent', reservation: 'abort_failed',
        };
      }
    } else {
      return {
        status: 'order_persistence_failed', orderId: prepared.id,
        reconciliation: 'unknown', reservation: 'preserved',
      };
    }
  }

  try {
    await dependencies.markIntakeFinalized({
      intakeId: params.intakeId,
      capability: params.capability,
      orderId: prepared.id,
    });
  } catch {
    return { status: 'intake_mark_pending', order: committed };
  }
  return { status: 'committed', order: committed };
}