/*
 * L-4 Slice A1 — the confirmation-email transition model.
 *
 * The model exists to make one class of mistake unrepresentable: an automatic
 * second presentation of a confirmation whose first outcome is not decisively
 * known. Every window whose provider result is ambiguous terminates in a hold,
 * and the only automatic retry in the system is from a failure proven to have
 * preceded submission.
 *
 * Everything here is pure: no store, no provider, no clock, no environment.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT,
  CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL,
  CONFIRMATION_EMAIL_HELD_STATES,
  CONFIRMATION_EMAIL_LEGACY_T193_FLOOR_AT,
  CONFIRMATION_EMAIL_ACTORS,
  CONFIRMATION_EMAIL_EVENTS,
  CONFIRMATION_EMAIL_LEGACY_CLASSES,
  CONFIRMATION_EMAIL_STATES,
  appendConfirmationEmailAttempt,
  classifyLegacyConfirmationRecord,
  evaluateConfirmationEmailTransition,
  evaluateFirstDispatchIntentWrite,
  isConfirmationEmailHeldState,
  type ConfirmationEmailActor,
  type ConfirmationEmailAttemptRecord,
  type ConfirmationEmailEvent,
  type ConfirmationEmailHoldReason,
  type ConfirmationEmailLegacyClass,
  type ConfirmationEmailState,
  type ConfirmationEmailTransitionInput,
} from '../src/lib/confirmation-email-state.ts';
import {
  CONFIRMATION_EMAIL_CLAIM_STALE_MS,
  evaluateConfirmationEmailClaimability,
} from '../src/lib/confirmation-email-delivery.ts';
import { CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT } from '../src/lib/confirmation-email-sweep.ts';
import type { OrderRecord, ReviewAuditEventType } from '../src/lib/orders.ts';

const STATE_SOURCE = readFileSync(
  new URL('../src/lib/confirmation-email-state.ts', import.meta.url),
  'utf8',
);
const ORDERS_SOURCE = readFileSync(new URL('../src/lib/orders.ts', import.meta.url), 'utf8');

const ACTORS: readonly ConfirmationEmailActor[] = ['worker', 'reaper', 'operator'];
const EVENTS: readonly ConfirmationEmailEvent[] = [
  'claim_acquired',
  'dispatch_intent',
  'provider_accepted',
  'pre_dispatch_failure_proven',
  'ambiguous_outcome',
  'receipt_failed',
  'integrity_fence_failed',
  'deadline_elapsed',
  'snapshot_refused',
  'claim_released',
  'operator_bind_acceptance',
  'operator_prove_non_acceptance',
  'operator_authorized_resend',
];
const FROM_STATES: readonly (ConfirmationEmailState | null)[] = [null, ...CONFIRMATION_EMAIL_STATES];

const INTENT_AT = '2026-09-23T15:00:00.000Z';

/** Default inputs that satisfy every guard, so a refusal is about the row. */
function transitionInput(
  overrides: Partial<ConfirmationEmailTransitionInput> & Pick<ConfirmationEmailTransitionInput, 'from' | 'event' | 'actor'>,
): ConfirmationEmailTransitionInput {
  return {
    envelopeRequestPresent: true,
    legacyClass: 'LEGACY_NEVER_DISPATCHED',
    holdReason: null,
    claimTakeover: false,
    firstDispatchIntentAt: null,
    ...overrides,
  };
}

function decide(
  overrides: Partial<ConfirmationEmailTransitionInput> & Pick<ConfirmationEmailTransitionInput, 'from' | 'event' | 'actor'>,
) {
  return evaluateConfirmationEmailTransition(transitionInput(overrides));
}

/** Only the hold reason each event is allowed to carry. */
function holdReasonFor(event: ConfirmationEmailEvent): ConfirmationEmailHoldReason | null {
  if (event === 'ambiguous_outcome') return 'ambiguous_dispatch';
  if (event === 'receipt_failed') return 'receipt_write_failed';
  if (event === 'integrity_fence_failed') return 'digest_mismatch';
  return null;
}

// ── S1 — the table is closed ────────────────────────────────────────────────

/**
 * The §5.3 table, transcribed. Anything absent must be refused; the cross
 * product below is what proves there is no extra door.
 */
const ALLOWED_ROWS: ReadonlyArray<{
  readonly row: string;
  readonly from: ConfirmationEmailState | null;
  readonly event: ConfirmationEmailEvent;
  readonly actor: ConfirmationEmailActor;
  readonly to: ConfirmationEmailState | null;
  readonly permitsProviderCall: boolean;
}> = [
  { row: 'T1', from: null, event: 'claim_acquired', actor: 'worker', to: 'SNAPSHOTTED', permitsProviderCall: false },
  { row: 'T2', from: 'SNAPSHOTTED', event: 'claim_acquired', actor: 'worker', to: 'SNAPSHOTTED', permitsProviderCall: false },
  { row: 'T3', from: 'SNAPSHOTTED', event: 'dispatch_intent', actor: 'worker', to: 'DISPATCH_INTENT_RECORDED', permitsProviderCall: true },
  { row: 'T4', from: 'DISPATCH_INTENT_RECORDED', event: 'provider_accepted', actor: 'worker', to: 'ACCEPTED', permitsProviderCall: false },
  { row: 'T5', from: 'DISPATCH_INTENT_RECORDED', event: 'pre_dispatch_failure_proven', actor: 'worker', to: 'PROVABLY_PRE_DISPATCH_FAILED', permitsProviderCall: false },
  { row: 'T6', from: 'PROVABLY_PRE_DISPATCH_FAILED', event: 'claim_acquired', actor: 'worker', to: 'DISPATCH_INTENT_RECORDED', permitsProviderCall: true },
  { row: 'T7', from: 'DISPATCH_INTENT_RECORDED', event: 'ambiguous_outcome', actor: 'worker', to: 'RECONCILIATION_REQUIRED', permitsProviderCall: false },
  { row: 'T8', from: 'DISPATCH_INTENT_RECORDED', event: 'receipt_failed', actor: 'worker', to: 'RECONCILIATION_REQUIRED', permitsProviderCall: false },
  { row: 'T9', from: 'DISPATCH_INTENT_RECORDED', event: 'deadline_elapsed', actor: 'reaper', to: 'RECONCILIATION_REQUIRED', permitsProviderCall: false },
  { row: 'T10', from: 'RECONCILIATION_REQUIRED', event: 'operator_bind_acceptance', actor: 'operator', to: 'RECONCILED_ACCEPTED', permitsProviderCall: false },
  { row: 'T11', from: 'RECONCILIATION_REQUIRED', event: 'operator_prove_non_acceptance', actor: 'operator', to: 'SNAPSHOTTED', permitsProviderCall: false },
  { row: 'T12', from: 'RECONCILIATION_REQUIRED', event: 'operator_authorized_resend', actor: 'operator', to: 'OWNER_AUTHORIZED_RESEND_SENT', permitsProviderCall: false },
  { row: 'T13a', from: null, event: 'snapshot_refused', actor: 'worker', to: 'RECONCILIATION_REQUIRED', permitsProviderCall: false },
  { row: 'T13b', from: 'SNAPSHOTTED', event: 'snapshot_refused', actor: 'worker', to: 'RECONCILIATION_REQUIRED', permitsProviderCall: false },
  { row: 'F4/F5', from: 'DISPATCH_INTENT_RECORDED', event: 'integrity_fence_failed', actor: 'worker', to: 'RECONCILIATION_REQUIRED', permitsProviderCall: false },
  // I-5: a release is never a state change, from any state.
  ...FROM_STATES.map((from) => ({
    row: `I-5 release from ${from ?? 'none'}`,
    from,
    event: 'claim_released' as const,
    actor: 'worker' as const,
    to: from,
    permitsProviderCall: false,
  })),
];

function allowedKey(from: ConfirmationEmailState | null, event: string, actor: string): string {
  return `${from ?? 'none'}|${event}|${actor}`;
}

test('S1: every transition outside the table is refused (exhaustive cross product)', () => {
  const allowed = new Map(ALLOWED_ROWS.map((r) => [allowedKey(r.from, r.event, r.actor), r]));
  let checked = 0;

  for (const from of FROM_STATES) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        checked += 1;
        const decision = decide({ from, event, actor, holdReason: holdReasonFor(event) });
        const expected = allowed.get(allowedKey(from, event, actor));
        if (!expected) {
          assert.equal(
            decision.allowed,
            false,
            `${allowedKey(from, event, actor)} is not in the table and must be refused`,
          );
          continue;
        }
        assert.equal(decision.allowed, true, `${expected.row} must be allowed`);
        if (decision.allowed !== true) continue;
        assert.equal(decision.to, expected.to, `${expected.row} target`);
        assert.equal(
          decision.permitsProviderCall,
          expected.permitsProviderCall,
          `${expected.row} provider authorization`,
        );
      }
    }
  }

  assert.equal(checked, FROM_STATES.length * EVENTS.length * ACTORS.length);
  assert.equal(checked, 312, 'the cross product must cover 8 states x 13 events x 3 actors');
});

test('S1: exactly two transitions in the whole model authorize a provider call', () => {
  const authorizing: string[] = [];
  for (const from of FROM_STATES) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        const decision = decide({ from, event, actor, holdReason: holdReasonFor(event) });
        if (decision.allowed === true && decision.permitsProviderCall) {
          authorizing.push(allowedKey(from, event, actor));
        }
      }
    }
  }
  assert.deepEqual(authorizing.sort(), [
    'PROVABLY_PRE_DISPATCH_FAILED|claim_acquired|worker',
    'SNAPSHOTTED|dispatch_intent|worker',
  ]);
});

// ── AM-1 (A3-6) — the operator doors release the claim; the reaper does not ──

test('AM-1: the claim is released by the worker outcomes, the releases and the three operator doors only', () => {
  const releasing: string[] = [];
  for (const from of FROM_STATES) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        const decision = decide({ from, event, actor, holdReason: holdReasonFor(event) });
        if (decision.allowed === true && decision.releasesClaim) releasing.push(allowedKey(from, event, actor));
      }
    }
  }
  assert.deepEqual(releasing.sort(), [
    'DISPATCH_INTENT_RECORDED|ambiguous_outcome|worker',
    'DISPATCH_INTENT_RECORDED|integrity_fence_failed|worker',
    'DISPATCH_INTENT_RECORDED|pre_dispatch_failure_proven|worker',
    'DISPATCH_INTENT_RECORDED|provider_accepted|worker',
    'RECONCILIATION_REQUIRED|operator_authorized_resend|operator',
    'RECONCILIATION_REQUIRED|operator_bind_acceptance|operator',
    'RECONCILIATION_REQUIRED|operator_prove_non_acceptance|operator',
    ...FROM_STATES.map((from) => allowedKey(from, 'claim_released', 'worker')),
  ].sort());
});

test('AM-1: T10–T12 release the claim and authorize no provider call; T9 and T8 keep the claim', () => {
  for (const [event, to] of [
    ['operator_bind_acceptance', 'RECONCILED_ACCEPTED'],
    ['operator_prove_non_acceptance', 'SNAPSHOTTED'],
    ['operator_authorized_resend', 'OWNER_AUTHORIZED_RESEND_SENT'],
  ] as const) {
    const decision = evaluateConfirmationEmailTransition({ from: 'RECONCILIATION_REQUIRED', event, actor: 'operator' });
    assert.deepEqual(decision, {
      allowed: true,
      to,
      holdReason: null,
      permitsProviderCall: false,
      writesFirstDispatchIntent: false,
      releasesClaim: true,
    }, event);
  }
  assert.deepEqual(
    evaluateConfirmationEmailTransition({ from: 'DISPATCH_INTENT_RECORDED', event: 'deadline_elapsed', actor: 'reaper' }),
    {
      allowed: true,
      to: 'RECONCILIATION_REQUIRED',
      holdReason: 'deadline_exceeded',
      permitsProviderCall: false,
      writesFirstDispatchIntent: false,
      releasesClaim: false,
    },
    'T9: the reaper keeps the claim as evidence',
  );
  const t8 = evaluateConfirmationEmailTransition({
    from: 'DISPATCH_INTENT_RECORDED', event: 'receipt_failed', actor: 'worker', holdReason: 'receipt_write_failed',
  });
  assert.equal(t8.allowed === true && t8.releasesClaim, false, 'T8 keeps the claim');
  // The doors are operator-only: no other actor opens them.
  for (const actor of ['worker', 'reaper'] as const) {
    const decision = evaluateConfirmationEmailTransition({ from: 'RECONCILIATION_REQUIRED', event: 'operator_authorized_resend', actor });
    assert.equal(decision.allowed, false, actor);
  }
});

test('S1: an unknown state or event is refused rather than defaulted', () => {
  const bogusState = decide({
    from: 'NOT_A_STATE' as ConfirmationEmailState,
    event: 'dispatch_intent',
    actor: 'worker',
  });
  assert.equal(bogusState.allowed, false);

  const bogusEvent = decide({
    from: 'SNAPSHOTTED',
    event: 'definitely_not_an_event' as ConfirmationEmailEvent,
    actor: 'worker',
  });
  assert.equal(bogusEvent.allowed, false);
});

test('S1: a hold event carrying a reason outside its permitted set is refused', () => {
  const ok = decide({
    from: 'DISPATCH_INTENT_RECORDED',
    event: 'ambiguous_outcome',
    actor: 'worker',
    holdReason: 'provider_body_conflict',
  });
  assert.equal(ok.allowed, true);
  if (ok.allowed === true) assert.equal(ok.holdReason, 'provider_body_conflict');

  const wrong = decide({
    from: 'DISPATCH_INTENT_RECORDED',
    event: 'ambiguous_outcome',
    actor: 'worker',
    holdReason: 'payload_purged',
  });
  assert.equal(wrong.allowed, false);
  if (wrong.allowed === false) assert.equal(wrong.reason, 'hold_reason_not_permitted');
});

test('S1: a 409 body conflict is a hold, never an acceptance and never a retry', () => {
  const decision = decide({
    from: 'DISPATCH_INTENT_RECORDED',
    event: 'ambiguous_outcome',
    actor: 'worker',
    holdReason: 'provider_body_conflict',
  });
  assert.equal(decision.allowed, true);
  if (decision.allowed !== true) return;
  assert.equal(decision.to, 'RECONCILIATION_REQUIRED');
  assert.equal(decision.permitsProviderCall, false);
  assert.notEqual(decision.to, 'ACCEPTED');
  assert.notEqual(decision.to, 'RECONCILED_ACCEPTED');
});

// ── S2 — dispatch intent is write-once ──────────────────────────────────────

test('S2: a recorded first dispatch intent can never be moved or cleared', () => {
  assert.deepEqual(evaluateFirstDispatchIntentWrite(null, INTENT_AT), { ok: true });
  assert.deepEqual(evaluateFirstDispatchIntentWrite(undefined, INTENT_AT), { ok: true });
  assert.deepEqual(evaluateFirstDispatchIntentWrite(INTENT_AT, INTENT_AT), { ok: true });

  for (const next of ['2026-09-23T16:00:00.000Z', '2026-09-23T14:00:00.000Z', null]) {
    const result = evaluateFirstDispatchIntentWrite(INTENT_AT, next);
    assert.equal(result.ok, false, `writing ${String(next)} over a recorded intent must abort`);
    if (result.ok === false) assert.equal(result.reason, 'first_dispatch_intent_immutable');
  }
});

test('S2: only the two dispatch-authorizing transitions write the first intent', () => {
  const writers: string[] = [];
  for (const from of FROM_STATES) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        const decision = decide({ from, event, actor, holdReason: holdReasonFor(event) });
        if (decision.allowed === true && decision.writesFirstDispatchIntent) {
          writers.push(allowedKey(from, event, actor));
        }
      }
    }
  }
  assert.deepEqual(writers.sort(), [
    'PROVABLY_PRE_DISPATCH_FAILED|claim_acquired|worker',
    'SNAPSHOTTED|dispatch_intent|worker',
  ]);
});

test('S2: a re-entry to dispatch intent does not rewrite an already recorded instant', () => {
  const decision = decide({
    from: 'PROVABLY_PRE_DISPATCH_FAILED',
    event: 'claim_acquired',
    actor: 'worker',
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(decision.allowed, true);
  if (decision.allowed !== true) return;
  assert.equal(decision.to, 'DISPATCH_INTENT_RECORDED');
  assert.equal(decision.writesFirstDispatchIntent, true, 'write-once means write-if-null');
  assert.deepEqual(evaluateFirstDispatchIntentWrite(INTENT_AT, INTENT_AT), { ok: true });
});

// ── S3 — release erases nothing ─────────────────────────────────────────────

test('S3: releasing a claim from dispatch intent leaves the state and the intent alone', () => {
  const decision = decide({
    from: 'DISPATCH_INTENT_RECORDED',
    event: 'claim_released',
    actor: 'worker',
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(decision.allowed, true);
  if (decision.allowed !== true) return;
  assert.equal(decision.to, 'DISPATCH_INTENT_RECORDED', 'a release is not a rollback');
  assert.equal(decision.writesFirstDispatchIntent, false);
  assert.equal(decision.permitsProviderCall, false);
  assert.equal(decision.releasesClaim, true);
  assert.equal(decision.holdReason, null);
});

test('S3: no release from any state ever returns a record to SNAPSHOTTED', () => {
  for (const from of FROM_STATES) {
    const decision = decide({ from, event: 'claim_released', actor: 'worker' });
    assert.equal(decision.allowed, true);
    if (decision.allowed !== true) continue;
    assert.equal(decision.to, from, `release from ${from ?? 'none'} must be a no-op on state`);
  }
});

// ── S4 — a stale claim past dispatch intent is never taken over ─────────────

test('S4: a stale-claim takeover on a record that recorded dispatch intent is refused', () => {
  const decision = decide({
    from: 'DISPATCH_INTENT_RECORDED',
    event: 'claim_acquired',
    actor: 'worker',
    claimTakeover: true,
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed === false) {
    assert.equal(decision.reason, 'takeover_refused_after_dispatch_intent');
  }
});

test('S4: that record moves only by the reaper, to a hold — never back to a fresh attempt', () => {
  const reaped = decide({
    from: 'DISPATCH_INTENT_RECORDED',
    event: 'deadline_elapsed',
    actor: 'reaper',
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(reaped.allowed, true);
  if (reaped.allowed !== true) return;
  assert.equal(reaped.to, 'RECONCILIATION_REQUIRED');
  assert.equal(reaped.holdReason, 'deadline_exceeded');
  assert.equal(reaped.permitsProviderCall, false);

  for (const event of EVENTS) {
    for (const actor of ACTORS) {
      const decision = decide({
        from: 'DISPATCH_INTENT_RECORDED',
        event,
        actor,
        holdReason: holdReasonFor(event),
        firstDispatchIntentAt: INTENT_AT,
      });
      if (decision.allowed !== true) continue;
      assert.notEqual(
        decision.to,
        'SNAPSHOTTED',
        `${event}/${actor} must not walk dispatch intent back to a fresh attempt`,
      );
    }
  }
});

test('S4: a takeover of a SNAPSHOTTED record is safe only while no intent was ever recorded', () => {
  const neverDispatched = decide({
    from: 'SNAPSHOTTED',
    event: 'claim_acquired',
    actor: 'worker',
    claimTakeover: true,
    firstDispatchIntentAt: null,
  });
  assert.equal(neverDispatched.allowed, true);

  const afterIntent = decide({
    from: 'SNAPSHOTTED',
    event: 'claim_acquired',
    actor: 'worker',
    claimTakeover: true,
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(afterIntent.allowed, false);
  if (afterIntent.allowed === false) {
    assert.equal(afterIntent.reason, 'takeover_refused_after_dispatch_intent');
  }
});

// ── S5 — the absorbing states ───────────────────────────────────────────────

test('S5: ACCEPTED, RECONCILED_ACCEPTED and RECONCILIATION_REQUIRED admit no automatic exit', () => {
  const absorbing: ConfirmationEmailState[] = [
    'ACCEPTED',
    'RECONCILED_ACCEPTED',
    'RECONCILIATION_REQUIRED',
    'OWNER_AUTHORIZED_RESEND_SENT',
  ];
  for (const from of absorbing) {
    for (const event of EVENTS) {
      for (const actor of ['worker', 'reaper'] as const) {
        const decision = decide({ from, event, actor, holdReason: holdReasonFor(event) });
        if (decision.allowed !== true) continue;
        assert.equal(decision.to, from, `${from} moved by ${event}/${actor}`);
        assert.equal(decision.permitsProviderCall, false, `${from} authorized a call via ${event}/${actor}`);
      }
    }
  }
});

test('S5: only an operator leaves a hold, and no operator door is a provider call', () => {
  const doors = EVENTS.flatMap((event) => {
    const decision = decide({
      from: 'RECONCILIATION_REQUIRED',
      event,
      actor: 'operator',
      holdReason: holdReasonFor(event),
    });
    return decision.allowed === true && decision.to !== 'RECONCILIATION_REQUIRED'
      ? [{ event, to: decision.to, permitsProviderCall: decision.permitsProviderCall }]
      : [];
  });
  assert.deepEqual(
    doors.map((d) => d.event).sort(),
    ['operator_authorized_resend', 'operator_bind_acceptance', 'operator_prove_non_acceptance'],
  );
  assert.ok(doors.every((d) => d.permitsProviderCall === false));
});

test('S5: the operator non-acceptance door retains the first dispatch intent', () => {
  const decision = decide({
    from: 'RECONCILIATION_REQUIRED',
    event: 'operator_prove_non_acceptance',
    actor: 'operator',
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(decision.allowed, true);
  if (decision.allowed !== true) return;
  assert.equal(decision.to, 'SNAPSHOTTED');
  assert.equal(decision.writesFirstDispatchIntent, false, 'the true earliest intent is never rewritten');
});

// ── S6 — a purged payload is structurally unsendable ────────────────────────

test('S6: a tombstone turns every dispatch authorization into a payload_purged hold', () => {
  for (const [from, event] of [
    ['SNAPSHOTTED', 'dispatch_intent'],
    ['PROVABLY_PRE_DISPATCH_FAILED', 'claim_acquired'],
  ] as const) {
    const decision = decide({ from, event, actor: 'worker', envelopeRequestPresent: false });
    assert.equal(decision.allowed, true, `${from}/${event} must resolve, not throw`);
    if (decision.allowed !== true) continue;
    assert.equal(decision.to, 'RECONCILIATION_REQUIRED');
    assert.equal(decision.holdReason, 'payload_purged');
    assert.equal(decision.permitsProviderCall, false);
    assert.equal(decision.writesFirstDispatchIntent, false);
  }
});

test('S6: an unstated payload is treated as absent — the model fails closed', () => {
  const decision = evaluateConfirmationEmailTransition({
    from: 'SNAPSHOTTED',
    event: 'dispatch_intent',
    actor: 'worker',
  });
  assert.equal(decision.allowed, true);
  if (decision.allowed !== true) return;
  assert.equal(decision.permitsProviderCall, false, 'silence about the payload must not authorize a send');
  assert.equal(decision.holdReason, 'payload_purged');
});

test('S6: no transition anywhere in the model can send on a null payload', () => {
  for (const from of FROM_STATES) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        const decision = decide({
          from,
          event,
          actor,
          holdReason: holdReasonFor(event),
          envelopeRequestPresent: false,
        });
        if (decision.allowed !== true) continue;
        assert.equal(
          decision.permitsProviderCall,
          false,
          `${allowedKey(from, event, actor)} authorized a call with no payload`,
        );
      }
    }
  }
});

// ── S7 — legacy classification fails closed (W-10) ──────────────────────────

const T193_MS = Date.parse('2026-09-21T18:00:00.000Z');

function legacyOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord_legacy',
    paidAt: '2026-09-22T00:00:00.000Z',
    confirmationEmailSentAt: null,
    confirmationEmailFrom: null,
    confirmationEmailIdempotencyKey: null,
    emailResendClaimId: null,
    ...overrides,
  } as OrderRecord;
}

test('S7: a receipt is the only thing that classifies a legacy record as accepted', () => {
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder({ confirmationEmailSentAt: '2026-09-22T01:00:00.000Z' }), {
      t193AtMs: T193_MS,
    }),
    'LEGACY_ACCEPTED',
  );
});

test('S7: null identity proves never-dispatched only after T_193', () => {
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder(), { t193AtMs: T193_MS }),
    'LEGACY_NEVER_DISPATCHED',
  );

  // W-10: before the identity fields existed, the send used a two-key fallback
  // pair. A pre-cutover acceptance under `-fallback-v1` is invisible to today's
  // deduplication, so null identity proves nothing about it.
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder({ paidAt: '2026-09-21T13:00:00.000Z' }), {
      t193AtMs: T193_MS,
    }),
    'LEGACY_UNRESOLVED',
    'a pre-T_193 record with null identity is unresolved, not never-dispatched',
  );
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder({ paidAt: new Date(T193_MS - 1).toISOString() }), {
      t193AtMs: T193_MS,
    }),
    'LEGACY_UNRESOLVED',
    'the boundary is inclusive only on the safe side',
  );
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder({ paidAt: new Date(T193_MS).toISOString() }), {
      t193AtMs: T193_MS,
    }),
    'LEGACY_NEVER_DISPATCHED',
  );
});

test('S7: an unknown T_193 classifies every open record as unresolved', () => {
  // OD-3: if the deployment instant cannot be proven, T_193 is +infinity. No
  // timestamp is invented to fill the gap.
  assert.equal(classifyLegacyConfirmationRecord(legacyOrder(), { t193AtMs: null }), 'LEGACY_UNRESOLVED');
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder({ confirmationEmailSentAt: '2026-09-22T01:00:00.000Z' }), {
      t193AtMs: null,
    }),
    'LEGACY_ACCEPTED',
    'a durable receipt still stands on its own',
  );
});

test('S7: any surviving identity, claim, or unusable paidAt is unresolved', () => {
  const cfg = { t193AtMs: T193_MS };
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder({ confirmationEmailFrom: 'orders@example.com' }), cfg),
    'LEGACY_UNRESOLVED',
  );
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ confirmationEmailIdempotencyKey: 'order-confirmation-ord_legacy-primary-v1' }),
      cfg,
    ),
    'LEGACY_UNRESOLVED',
  );
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder({ emailResendClaimId: 'claim_1' }), cfg),
    'LEGACY_UNRESOLVED',
  );
  for (const paidAt of [null, undefined, '', 'yesterday']) {
    assert.equal(
      classifyLegacyConfirmationRecord(legacyOrder({ paidAt } as Partial<OrderRecord>), cfg),
      'LEGACY_UNRESOLVED',
      `paidAt=${String(paidAt)} must not be read as post-cutover`,
    );
  }
});

test('S7: a T_193 below the sweep activation floor is unusable and fails closed', () => {
  assert.equal(
    CONFIRMATION_EMAIL_LEGACY_T193_FLOOR_AT,
    CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT,
    'the floor must track the one activation instant the sweep already pins',
  );
  const floorMs = Date.parse(CONFIRMATION_EMAIL_LEGACY_T193_FLOOR_AT);
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder(), { t193AtMs: floorMs - 1 }),
    'LEGACY_UNRESOLVED',
  );
  assert.equal(
    classifyLegacyConfirmationRecord(legacyOrder(), { t193AtMs: Number.NaN }),
    'LEGACY_UNRESOLVED',
  );
});

test('S7: the classifier reads no clock and invents no timestamp', () => {
  assert.doesNotMatch(STATE_SOURCE, /Date\.now|new Date\(\)|process\.env/);
});

// ── S8 — bounded attempt history ────────────────────────────────────────────

function attempt(n: number): ConfirmationEmailAttemptRecord {
  return {
    attemptId: `attempt_${n}`,
    claimId: `claim_${n}`,
    intentAt: new Date(Date.parse(INTENT_AT) + n * 1000).toISOString(),
    outcome: 'ambiguous',
  };
}

test('S8: history below the cap is plain append-only', () => {
  let history: readonly ConfirmationEmailAttemptRecord[] = [];
  for (let n = 0; n < CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT; n += 1) {
    history = appendConfirmationEmailAttempt(history, attempt(n));
  }
  assert.equal(history.length, CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT);
  assert.equal(history[0]?.attemptId, 'attempt_0');
  assert.equal(history.at(-1)?.attemptId, `attempt_${CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT - 1}`);
  assert.ok(history.every((entry) => entry.elidedCount == null));
});

test('S8: overflow keeps the first entry, the newest tail, and one elision marker', () => {
  let history: readonly ConfirmationEmailAttemptRecord[] = [];
  for (let n = 0; n < 25; n += 1) history = appendConfirmationEmailAttempt(history, attempt(n));

  assert.equal(history.length, CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT);
  assert.equal(
    history[0]?.attemptId,
    'attempt_0',
    'the first entry corroborates the first dispatch intent and is never dropped',
  );

  const markers = history.filter((entry) => entry.attemptId === 'elided');
  assert.equal(markers.length, 1);
  assert.equal(history[1]?.attemptId, 'elided');
  assert.equal(markers[0]?.elidedCount, 25 - 1 - CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL);

  const tail = history.slice(-CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL);
  assert.equal(tail.length, CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL);
  assert.equal(tail[0]?.attemptId, `attempt_${25 - CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL}`);
  assert.equal(tail.at(-1)?.attemptId, 'attempt_24');
});

test('S8: the elided count accumulates and never double-counts the marker', () => {
  let history: readonly ConfirmationEmailAttemptRecord[] = [];
  for (let n = 0; n < 100; n += 1) history = appendConfirmationEmailAttempt(history, attempt(n));

  assert.equal(history.length, CONFIRMATION_EMAIL_ATTEMPT_HISTORY_LIMIT);
  assert.equal(history.filter((entry) => entry.attemptId === 'elided').length, 1);
  assert.equal(
    history[1]?.elidedCount,
    100 - 1 - CONFIRMATION_EMAIL_ATTEMPT_HISTORY_TAIL,
    'every dropped attempt must still be counted exactly once',
  );
  assert.equal(history[0]?.attemptId, 'attempt_0');
  assert.equal(history.at(-1)?.attemptId, 'attempt_99');
});

test('S8: appending does not mutate the history it was handed', () => {
  const original: readonly ConfirmationEmailAttemptRecord[] = [attempt(0)];
  const next = appendConfirmationEmailAttempt(original, attempt(1));
  assert.equal(original.length, 1);
  assert.equal(next.length, 2);
});

// ── The held-state set shared with the claimability fence ───────────────────

test('the held states are exactly the four a rollback must keep blocked', () => {
  assert.deepEqual([...CONFIRMATION_EMAIL_HELD_STATES].sort(), [
    'DISPATCH_INTENT_RECORDED',
    'OWNER_AUTHORIZED_RESEND_SENT',
    'RECONCILED_ACCEPTED',
    'RECONCILIATION_REQUIRED',
  ]);
  for (const state of CONFIRMATION_EMAIL_HELD_STATES) {
    assert.equal(isConfirmationEmailHeldState(state), true);
  }
  for (const state of ['SNAPSHOTTED', 'ACCEPTED', 'PROVABLY_PRE_DISPATCH_FAILED']) {
    assert.equal(isConfirmationEmailHeldState(state), false);
  }
  for (const value of [null, undefined, '', 'reconciliation_required', 42]) {
    assert.equal(isConfirmationEmailHeldState(value), false, `${String(value)} must not read as held`);
  }
});

// ── The additive order-record surface ───────────────────────────────────────

test('every new order field is optional, so a record at the pin still type-checks', () => {
  const atThePin: OrderRecord = {
    id: 'ord_pin',
    childName: 'Luna',
    email: 'buyer@example.com',
    bookFormat: 'digital',
    paymentStatus: 'paid',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  } as OrderRecord;
  assert.equal(atThePin.confirmationEmailState, undefined);
  assert.equal(atThePin.confirmationEmailEnvelope, undefined);
  assert.equal(atThePin.confirmationEmailFirstDispatchIntentAt, undefined);
  assert.equal(atThePin.confirmationEmailAttemptId, undefined);
  assert.equal(atThePin.confirmationEmailDispatchDeadlineAt, undefined);
  assert.equal(atThePin.confirmationEmailProviderMessageId, undefined);
  assert.equal(atThePin.confirmationEmailAcceptedAt, undefined);
  assert.equal(atThePin.confirmationEmailAttempts, undefined);
  assert.equal(atThePin.confirmationEmailHoldReason, undefined);
});

test('the new order fields are declared, optional, and nullable in the record source', () => {
  for (const field of [
    'confirmationEmailState',
    'confirmationEmailEnvelope',
    'confirmationEmailFirstDispatchIntentAt',
    'confirmationEmailAttemptId',
    'confirmationEmailDispatchDeadlineAt',
    'confirmationEmailProviderMessageId',
    'confirmationEmailAcceptedAt',
    'confirmationEmailAttempts',
    'confirmationEmailHoldReason',
  ]) {
    assert.ok(
      new RegExp(`\\n  ${field}\\?:[^\\n]*\\| null;`).test(ORDERS_SOURCE),
      `${field} must be an additive optional nullable field`,
    );
  }
});

test('the confirmation audit event types exist for the slices that will emit them', () => {
  const events: ReviewAuditEventType[] = [
    'confirmation_snapshotted',
    'confirmation_dispatch_intent',
    'confirmation_accepted',
    'confirmation_held',
    'confirmation_reconciled',
    'confirmation_owner_resend',
    'confirmation_payload_purged',
  ];
  for (const event of events) {
    assert.ok(
      new RegExp(`\\n  \\| '${event}'`).test(ORDERS_SOURCE),
      `${event} must be a declared audit type`,
    );
  }
});

// ── Purity of the module itself ─────────────────────────────────────────────

test('the state module cannot send, persist, log, or read a credential', () => {
  assert.doesNotMatch(STATE_SOURCE, /console\.|fetch\(|await |process\.env|apiKey|API_KEY/i);
  assert.doesNotMatch(STATE_SOURCE, /^import (?!type ).* from '\.\//m, 'only type imports from siblings');
});

// ── T1 — the first touch is decided by the legacy class, never by default ───

test('T1: the first claim routes by legacy class, and an unclassified record is refused', () => {
  const snapshotted = decide({
    from: null,
    event: 'claim_acquired',
    actor: 'worker',
    legacyClass: 'LEGACY_NEVER_DISPATCHED',
  });
  assert.equal(snapshotted.allowed, true);
  if (snapshotted.allowed === true) {
    assert.equal(snapshotted.to, 'SNAPSHOTTED');
    assert.equal(snapshotted.holdReason, null);
  }

  const accepted = decide({
    from: null,
    event: 'claim_acquired',
    actor: 'worker',
    legacyClass: 'LEGACY_ACCEPTED',
  });
  assert.equal(accepted.allowed, true);
  if (accepted.allowed === true) {
    assert.equal(accepted.to, 'ACCEPTED');
    assert.equal(accepted.permitsProviderCall, false);
  }

  const unresolved = decide({
    from: null,
    event: 'claim_acquired',
    actor: 'worker',
    legacyClass: 'LEGACY_UNRESOLVED',
  });
  assert.equal(unresolved.allowed, true);
  if (unresolved.allowed === true) {
    assert.equal(unresolved.to, 'RECONCILIATION_REQUIRED');
    assert.equal(unresolved.holdReason, 'legacy_unresolved');
    assert.equal(unresolved.permitsProviderCall, false);
  }

  const unclassified = evaluateConfirmationEmailTransition({
    from: null,
    event: 'claim_acquired',
    actor: 'worker',
    envelopeRequestPresent: true,
  });
  assert.equal(unclassified.allowed, false, 'an unclassified legacy record must not default to sendable');
  if (unclassified.allowed === false) assert.equal(unclassified.reason, 'legacy_class_required');
});

// ── R2 — fail-closed against invalid runtime values ─────────────────────────
//
// TypeScript describes what a caller *should* pass. It does not validate what
// `JSON.parse` produced: `orders.ts` casts a parsed record straight to
// `OrderRecord`, so every field below can be any JSON value at runtime. Two
// defects followed from trusting the declarations.
//
// P2-1: the transition key rendered a null state as the string "none", so a
// persisted state of "none" aliased the legitimate first-touch row; and the
// legacy-target lookup was a plain object index, so an inherited property name
// such as "constructor" produced an allowed decision with undefined targets.
//
// P2-2: presence was tested by truthiness, so an empty-string marker read as
// "absent" — and absence of a dispatch marker is exactly what authorizes a
// takeover and a never-dispatched classification.

const UNKNOWN_STRINGS = [
  'none',
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '',
  ' ',
  'SNAPSHOTTED ',
  'snapshotted',
  'NOT_A_STATE',
  ' NO_STATE',
] as const;

test('R2/P2-1: the exported vocabularies are exactly what the tests enumerate', () => {
  assert.deepEqual([...CONFIRMATION_EMAIL_EVENTS], [...EVENTS]);
  assert.deepEqual([...CONFIRMATION_EMAIL_ACTORS], [...ACTORS]);
  assert.deepEqual([...CONFIRMATION_EMAIL_LEGACY_CLASSES].sort(), [
    'LEGACY_ACCEPTED',
    'LEGACY_NEVER_DISPATCHED',
    'LEGACY_UNRESOLVED',
  ]);
});

test('R2/P2-1: a persisted state of "none" does not alias the first-touch row', () => {
  const decision = decide({
    from: 'none' as ConfirmationEmailState,
    event: 'claim_acquired',
    actor: 'worker',
    legacyClass: 'LEGACY_NEVER_DISPATCHED',
  });
  assert.equal(decision.allowed, false, '"none" must never reach SNAPSHOTTED');
  if (decision.allowed === false) assert.equal(decision.reason, 'unrecognized_input');
});

test('R2/P2-1: "none" does not alias the null row for a release either', () => {
  const decision = decide({
    from: 'none' as ConfirmationEmailState,
    event: 'claim_released',
    actor: 'worker',
  });
  assert.equal(decision.allowed, false);
});

test('R2/P2-1: every unknown state string is refused, for every event and actor', () => {
  for (const from of UNKNOWN_STRINGS) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        const decision = decide({
          from: from as ConfirmationEmailState,
          event,
          actor,
          holdReason: holdReasonFor(event),
          legacyClass: 'LEGACY_NEVER_DISPATCHED',
        });
        assert.equal(
          decision.allowed,
          false,
          `state ${JSON.stringify(from)} + ${event}/${actor} must be refused`,
        );
        if (decision.allowed === false) assert.equal(decision.reason, 'unrecognized_input');
      }
    }
  }
});

test('R2/P2-1: non-string runtime state values are refused', () => {
  for (const from of [0, 1, true, false, {}, []] as unknown[]) {
    const decision = decide({
      from: from as ConfirmationEmailState,
      event: 'dispatch_intent',
      actor: 'worker',
    });
    assert.equal(decision.allowed, false, `state ${String(from)} must be refused`);
  }
});

test('R2/P2-1: every unknown event string is refused from every state', () => {
  for (const event of UNKNOWN_STRINGS) {
    for (const from of FROM_STATES) {
      const decision = decide({
        from,
        event: event as ConfirmationEmailEvent,
        actor: 'worker',
        legacyClass: 'LEGACY_NEVER_DISPATCHED',
      });
      assert.equal(decision.allowed, false, `event ${JSON.stringify(event)} must be refused`);
      if (decision.allowed === false) assert.equal(decision.reason, 'unrecognized_input');
    }
  }
});

test('R2/P2-1: every unknown actor string is refused for every legitimate event', () => {
  for (const actor of UNKNOWN_STRINGS) {
    for (const event of EVENTS) {
      const decision = decide({
        from: 'SNAPSHOTTED',
        event,
        actor: actor as ConfirmationEmailActor,
        holdReason: holdReasonFor(event),
      });
      assert.equal(decision.allowed, false, `actor ${JSON.stringify(actor)} must be refused`);
      if (decision.allowed === false) assert.equal(decision.reason, 'unrecognized_input');
    }
  }
});

test('R2/P2-1: an inherited property name is not a legacy class', () => {
  for (const legacyClass of UNKNOWN_STRINGS) {
    const decision = decide({
      from: null,
      event: 'claim_acquired',
      actor: 'worker',
      legacyClass: legacyClass as ConfirmationEmailLegacyClass,
    });
    assert.equal(
      decision.allowed,
      false,
      `legacyClass ${JSON.stringify(legacyClass)} must be refused, not looked up on the prototype`,
    );
    if (decision.allowed === false) assert.equal(decision.reason, 'unrecognized_input');
  }
});

test('R2/P2-1: no refused decision ever carries an undefined target', () => {
  for (const legacyClass of ['constructor', '__proto__', 'toString'] as const) {
    const decision = decide({
      from: null,
      event: 'claim_acquired',
      actor: 'worker',
      legacyClass: legacyClass as unknown as ConfirmationEmailLegacyClass,
    });
    assert.equal(decision.allowed, false);
    assert.equal('to' in decision, false, 'a refusal has no target at all');
  }
});

test('R2/P2-1: the legitimate first-touch rows are untouched by the validation', () => {
  for (const [legacyClass, to] of [
    ['LEGACY_NEVER_DISPATCHED', 'SNAPSHOTTED'],
    ['LEGACY_ACCEPTED', 'ACCEPTED'],
    ['LEGACY_UNRESOLVED', 'RECONCILIATION_REQUIRED'],
  ] as const) {
    const decision = decide({ from: null, event: 'claim_acquired', actor: 'worker', legacyClass });
    assert.equal(decision.allowed, true, `${legacyClass} must still route`);
    if (decision.allowed === true) assert.equal(decision.to, to);
  }
});

test('R2/P2-1: the table still admits exactly the 23 rows it admitted before', () => {
  let allowed = 0;
  for (const from of FROM_STATES) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        const decision = decide({ from, event, actor, holdReason: holdReasonFor(event) });
        if (decision.allowed === true) allowed += 1;
      }
    }
  }
  assert.equal(allowed, ALLOWED_ROWS.length);
  assert.equal(allowed, 23, 'the correction must not widen or narrow the accepted table');
});

// ── P2-2 — a present-but-invalid marker is not absence ──────────────────────

const MALFORMED_MARKERS = [
  '',
  ' ',
  '	',
  'not-a-date',
  '2026-09-23',
  '2026-09-23T15:00:00Z',
  0,
  1,
  true,
  false,
  {},
  [],
] as const;

test('R2/P2-2: an initial dispatch-intent write accepts only a canonical instant', () => {
  assert.deepEqual(evaluateFirstDispatchIntentWrite(null, INTENT_AT), { ok: true });
  assert.deepEqual(evaluateFirstDispatchIntentWrite(undefined, INTENT_AT), { ok: true });

  for (const next of MALFORMED_MARKERS) {
    const result = evaluateFirstDispatchIntentWrite(null, next as unknown as string);
    assert.equal(result.ok, false, `an initial write of ${JSON.stringify(next)} must be refused`);
    if (result.ok === false) assert.equal(result.reason, 'first_dispatch_intent_invalid');
  }
  const nullWrite = evaluateFirstDispatchIntentWrite(null, null);
  assert.equal(nullWrite.ok, false, 'this field is never written null; it is write-once');
  if (nullWrite.ok === false) assert.equal(nullWrite.reason, 'first_dispatch_intent_invalid');
});

test('R2/P2-2: a present-but-malformed recorded intent refuses every write, including identity', () => {
  for (const current of MALFORMED_MARKERS) {
    const identity = evaluateFirstDispatchIntentWrite(
      current as unknown as string,
      current as unknown as string,
    );
    assert.equal(identity.ok, false, `a corrupt marker ${JSON.stringify(current)} must stop the writer`);
    if (identity.ok === false) assert.equal(identity.reason, 'first_dispatch_intent_invalid');

    const move = evaluateFirstDispatchIntentWrite(current as unknown as string, INTENT_AT);
    assert.equal(move.ok, false);
  }
});

test('R2/P2-2: the accepted write-once behavior on a valid marker is unchanged', () => {
  assert.deepEqual(evaluateFirstDispatchIntentWrite(INTENT_AT, INTENT_AT), { ok: true });
  for (const next of ['2026-09-23T16:00:00.000Z', '2026-09-23T14:00:00.000Z', null]) {
    const result = evaluateFirstDispatchIntentWrite(INTENT_AT, next);
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'first_dispatch_intent_immutable');
  }
});

test('R2/P2-2: a takeover is refused for any non-nullish intent marker, however malformed', () => {
  for (const marker of MALFORMED_MARKERS) {
    const decision = decide({
      from: 'SNAPSHOTTED',
      event: 'claim_acquired',
      actor: 'worker',
      claimTakeover: true,
      firstDispatchIntentAt: marker as unknown as string,
    });
    assert.equal(
      decision.allowed,
      false,
      `a takeover with marker ${JSON.stringify(marker)} must be refused`,
    );
    if (decision.allowed === false) {
      assert.equal(decision.reason, 'takeover_refused_after_dispatch_intent');
    }
  }
});

test('R2/P2-2: a genuinely absent marker still permits the safe takeover (D4 preserved)', () => {
  for (const marker of [null, undefined]) {
    const decision = decide({
      from: 'SNAPSHOTTED',
      event: 'claim_acquired',
      actor: 'worker',
      claimTakeover: true,
      firstDispatchIntentAt: marker,
    });
    assert.equal(decision.allowed, true, 'never-dispatched is exactly when takeover is safe');
  }
});

test('R2/P2-2: after T11 a retained valid marker still blocks takeover but not an ordinary claim', () => {
  const t11 = decide({
    from: 'RECONCILIATION_REQUIRED',
    event: 'operator_prove_non_acceptance',
    actor: 'operator',
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(t11.allowed, true);
  if (t11.allowed !== true) return;
  assert.equal(t11.to, 'SNAPSHOTTED');
  assert.equal(t11.writesFirstDispatchIntent, false);

  const takeover = decide({
    from: 'SNAPSHOTTED',
    event: 'claim_acquired',
    actor: 'worker',
    claimTakeover: true,
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(takeover.allowed, false, 'a stale claim past recorded intent is never stolen');

  const ordinary = decide({
    from: 'SNAPSHOTTED',
    event: 'claim_acquired',
    actor: 'worker',
    claimTakeover: false,
    firstDispatchIntentAt: INTENT_AT,
  });
  assert.equal(ordinary.allowed, true, 'T11 must not deadlock the record it releases');
});

test('R2/P2-2: a blank identity marker is not absence of identity', () => {
  const cfg = { t193AtMs: T193_MS };
  for (const marker of MALFORMED_MARKERS) {
    for (const field of [
      'confirmationEmailFrom',
      'confirmationEmailIdempotencyKey',
      'emailResendClaimId',
    ] as const) {
      assert.equal(
        classifyLegacyConfirmationRecord(
          legacyOrder({ [field]: marker } as unknown as Partial<OrderRecord>),
          cfg,
        ),
        'LEGACY_UNRESOLVED',
        `${field}=${JSON.stringify(marker)} is present evidence, not absence`,
      );
    }
  }
});

test('R2/P2-2: a malformed receipt marker holds rather than claiming acceptance', () => {
  const cfg = { t193AtMs: T193_MS };
  for (const marker of MALFORMED_MARKERS) {
    assert.equal(
      classifyLegacyConfirmationRecord(
        legacyOrder({ confirmationEmailSentAt: marker } as unknown as Partial<OrderRecord>),
        cfg,
      ),
      'LEGACY_UNRESOLVED',
      `a receipt of ${JSON.stringify(marker)} proves neither acceptance nor absence`,
    );
  }
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ confirmationEmailSentAt: '2026-09-22T01:00:00.000Z' }),
      cfg,
    ),
    'LEGACY_ACCEPTED',
    'a real receipt still classifies as accepted',
  );
});

test('R2/P2-2: genuinely absent identity on a post-cutover record is still never-dispatched', () => {
  const cfg = { t193AtMs: T193_MS };
  assert.equal(classifyLegacyConfirmationRecord(legacyOrder(), cfg), 'LEGACY_NEVER_DISPATCHED');
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({
        confirmationEmailFrom: undefined,
        confirmationEmailIdempotencyKey: undefined,
        emailResendClaimId: undefined,
        confirmationEmailSentAt: undefined,
      } as Partial<OrderRecord>),
      cfg,
    ),
    'LEGACY_NEVER_DISPATCHED',
    'undefined is absence under the record contract, exactly like null',
  );
});

// ── R3 — `paidAt` must be a canonical instant, not merely parseable ─────────
//
// `Date.parse` is a repair tool, not a validator. It silently normalizes an
// impossible calendar date (September 31 becomes October 1) and it reads a
// timezone-less date-time in the host timezone, so the same stored string
// classifies differently on a machine in Chicago than on one in UTC.
//
// Neither is positive evidence that an order's entire paid lifetime ran after
// the cutover — and that evidence is the whole basis for LEGACY_NEVER_DISPATCHED,
// which opens T1 to SNAPSHOTTED and puts the record back on the send path.
// Anything that is not exactly what `toISOString()` would emit is held.

/** Canonical, and safely after the cutover. */
const PAID_AT_CANONICAL = '2026-09-22T00:00:00.000Z';

/**
 * Impossible calendar dates that `Date.parse` normalizes FORWARD past the
 * cutover, so the normalization is what decides the classification.
 *
 * `2026-02-30` is deliberately not used here: it normalizes to March 2 2026,
 * which is before the cutover, so it already classified as unresolved — by
 * arithmetic accident rather than by validation. Its 2027 counterpart
 * normalizes to March 2 2027 and does expose the defect.
 */
const IMPOSSIBLE_DATES = [
  '2026-09-31T00:00:00.000Z',
  '2027-02-30T00:00:00.000Z',
  '2027-02-31T00:00:00.000Z',
  '2026-11-31T00:00:00.000Z',
  '2026-13-01T00:00:00.000Z',
  '2026-10-00T00:00:00.000Z',
] as const;

/** Timezone-less: the host timezone decides what instant this names. */
const TIMEZONE_LESS = [
  '2026-09-21T17:00:00.000',
  '2026-09-22T00:00:00.000',
  '2026-09-22T00:00:00',
] as const;

/** Date-only: no time component at all. */
const DATE_ONLY = ['2026-09-22', '2026-09-23', '2026/09/22'] as const;

/** Parseable, unambiguous, and still not the canonical representation. */
const NONCANONICAL_FORMS = [
  '2026-09-22T00:00:00+02:00',
  '2026-09-22T02:00:00+02:00',
  '2026-09-21T19:00:00-05:00',
  '2026-09-22T00:00:00Z',
  '2026-09-22T00:00:00.00Z',
  '2026-09-22T00:00:00.0000Z',
  '2026-09-22t00:00:00.000z',
  '2026-09-22T00:00:00.000z',
  '2026-09-22T00:00:00.000+00:00',
  ' 2026-09-22T00:00:00.000Z',
  '2026-09-22T00:00:00.000Z ',
  'Tue, 22 Sep 2026 00:00:00 GMT',
  'September 22, 2026 00:00:00 UTC',
] as const;

test('R3: an impossible calendar date is normalized by Date.parse and must not classify', () => {
  for (const paidAt of IMPOSSIBLE_DATES) {
    assert.equal(
      classifyLegacyConfirmationRecord(legacyOrder({ paidAt }), { t193AtMs: T193_MS }),
      'LEGACY_UNRESOLVED',
      `paidAt=${paidAt} normalizes to a different day; that is repair, not evidence`,
    );
  }
});

test('R3: the impossible-date fixtures really do parse past the cutover', () => {
  // Without this the test above could pass for the wrong reason — a date that
  // normalizes to before T_193 would be unresolved on the comparison alone.
  for (const paidAt of IMPOSSIBLE_DATES) {
    const parsed = Date.parse(paidAt);
    if (!Number.isFinite(parsed)) continue;
    assert.ok(
      parsed >= T193_MS,
      `${paidAt} must normalize to a post-cutover instant for this regression to bite`,
    );
    assert.notEqual(new Date(parsed).toISOString(), paidAt, `${paidAt} must not be canonical`);
  }
});

test('R3: a timezone-less date-time is never positive evidence', () => {
  for (const paidAt of TIMEZONE_LESS) {
    assert.equal(
      classifyLegacyConfirmationRecord(legacyOrder({ paidAt }), { t193AtMs: T193_MS }),
      'LEGACY_UNRESOLVED',
      `paidAt=${paidAt} names a different instant in every timezone`,
    );
  }
});

test('R3: a date-only string is never positive evidence', () => {
  for (const paidAt of DATE_ONLY) {
    assert.equal(
      classifyLegacyConfirmationRecord(legacyOrder({ paidAt }), { t193AtMs: T193_MS }),
      'LEGACY_UNRESOLVED',
      `paidAt=${paidAt} has no time component`,
    );
  }
});

test('R3: a parseable but noncanonical form is held, including non-UTC offsets', () => {
  for (const paidAt of NONCANONICAL_FORMS) {
    assert.equal(
      classifyLegacyConfirmationRecord(legacyOrder({ paidAt }), { t193AtMs: T193_MS }),
      'LEGACY_UNRESOLVED',
      `paidAt=${JSON.stringify(paidAt)} is not what toISOString emits`,
    );
  }
});

test('R3: the rule is exactly byte-identity with the canonical representation', () => {
  for (const paidAt of [...NONCANONICAL_FORMS, ...DATE_ONLY, ...TIMEZONE_LESS]) {
    const parsed = Date.parse(paidAt);
    if (!Number.isFinite(parsed)) continue;
    assert.notEqual(
      new Date(parsed).toISOString(),
      paidAt,
      `${JSON.stringify(paidAt)} must differ from its canonical form for this row to mean anything`,
    );
  }
  assert.equal(new Date(Date.parse(PAID_AT_CANONICAL)).toISOString(), PAID_AT_CANONICAL);
});

test('R3: non-string, blank and malformed paidAt values remain unresolved', () => {
  for (const paidAt of ['', ' ', 'yesterday', 'not-a-date', 0, 1, true, false, {}, [], null, undefined]) {
    assert.equal(
      classifyLegacyConfirmationRecord(
        legacyOrder({ paidAt } as unknown as Partial<OrderRecord>),
        { t193AtMs: T193_MS },
      ),
      'LEGACY_UNRESOLVED',
      `paidAt=${JSON.stringify(paidAt)} must not classify`,
    );
  }
});

test('R3: a canonical instant exactly at the cutover is still never-dispatched', () => {
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ paidAt: new Date(T193_MS).toISOString() }),
      { t193AtMs: T193_MS },
    ),
    'LEGACY_NEVER_DISPATCHED',
  );
});

test('R3: a canonical instant one millisecond before the cutover is unresolved', () => {
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ paidAt: new Date(T193_MS - 1).toISOString() }),
      { t193AtMs: T193_MS },
    ),
    'LEGACY_UNRESOLVED',
  );
});

test('R3: an ordinary canonical post-cutover instant still classifies never-dispatched', () => {
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ paidAt: PAID_AT_CANONICAL }),
      { t193AtMs: T193_MS },
    ),
    'LEGACY_NEVER_DISPATCHED',
  );
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ paidAt: '2026-12-25T13:45:06.007Z' }),
      { t193AtMs: T193_MS },
    ),
    'LEGACY_NEVER_DISPATCHED',
  );
});

test('R3: the receipt contract is unchanged by the paidAt correction', () => {
  // A canonical receipt is decided before paidAt is ever consulted, so even an
  // uninterpretable paidAt cannot turn an accepted record into a hold.
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ confirmationEmailSentAt: '2026-09-22T01:00:00.000Z', paidAt: '2026-09-31T00:00:00.000Z' }),
      { t193AtMs: T193_MS },
    ),
    'LEGACY_ACCEPTED',
  );
  assert.equal(
    classifyLegacyConfirmationRecord(
      legacyOrder({ confirmationEmailSentAt: '' } as unknown as Partial<OrderRecord>),
      { t193AtMs: T193_MS },
    ),
    'LEGACY_UNRESOLVED',
  );
});

test('R3: classification does not depend on the host timezone', () => {
  // A canonical instant is absolute, and every non-canonical form is refused
  // before its value is ever compared — so there is nothing left for the host
  // timezone to influence. This asserts the property in-process; the suite is
  // additionally executed under TZ=UTC and TZ=America/Chicago.
  const offsetMinutes = new Date(Date.parse(PAID_AT_CANONICAL)).getTimezoneOffset();
  const cases: ReadonlyArray<[string, string]> = [
    [PAID_AT_CANONICAL, 'LEGACY_NEVER_DISPATCHED'],
    [new Date(T193_MS).toISOString(), 'LEGACY_NEVER_DISPATCHED'],
    [new Date(T193_MS - 1).toISOString(), 'LEGACY_UNRESOLVED'],
    ['2026-09-21T17:00:00.000', 'LEGACY_UNRESOLVED'],
    ['2026-09-31T00:00:00.000Z', 'LEGACY_UNRESOLVED'],
    ['2026-09-22', 'LEGACY_UNRESOLVED'],
  ];
  for (const [paidAt, expected] of cases) {
    assert.equal(
      classifyLegacyConfirmationRecord(legacyOrder({ paidAt }), { t193AtMs: T193_MS }),
      expected,
      `paidAt=${paidAt} must classify identically at UTC offset ${offsetMinutes}`,
    );
  }
});

test('R3: paidAt is validated, never repaired — the classifier still invents nothing', () => {
  assert.doesNotMatch(STATE_SOURCE, /Date\.now|new Date\(\)|\.trim\(\)|normalize\(/);
  assert.match(
    STATE_SOURCE,
    /isCanonicalIsoInstant\(order\.paidAt\)/,
    'paidAt must go through the same canonical validator as every other instant',
  );
});

// ── A3-3 R2 — an ACCEPTED record is never claimable ─────────────────────────
//
// Architecture §3.9, finding F-8. `ACCEPTED` is a success, so it is deliberately
// NOT a member of `CONFIRMATION_EMAIL_HELD_STATES` — which left
// `evaluateConfirmationEmailClaimability` gating only on
// `confirmationEmailSentAt`. A record in `ACCEPTED` with no receipt is reachable
// through a partial or hand-edited record, and it was claimable and would have
// been re-sent to the buyer.
//
// Named `A3-3 R2` to distinguish it from this file's existing `R2` section,
// which is about fail-closed handling of invalid runtime values.

const R2_FENCE_CFG = { nowMs: Date.parse('2026-09-26T18:00:00.000Z'), claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS };

/** Paid, unrefunded, unclaimed — so only the confirmation fence can refuse. */
function r2Order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord_r2fence',
    paymentStatus: 'paid',
    paidAt: '2026-09-26T17:00:00.000Z',
    confirmationEmailSentAt: null,
    emailResendClaimId: null,
    ...overrides,
  } as OrderRecord;
}

test('A3-3 R2: ACCEPTED with a null receipt is refused as already_sent', () => {
  assert.equal(
    evaluateConfirmationEmailClaimability(r2Order({ confirmationEmailState: 'ACCEPTED' }), R2_FENCE_CFG),
    'already_sent',
  );
  // Presence of the receipt is not what does it: every absent-receipt spelling
  // is refused on the state alone.
  for (const sentAt of [null, undefined, ''] as const) {
    assert.equal(
      evaluateConfirmationEmailClaimability(
        r2Order({ confirmationEmailState: 'ACCEPTED', confirmationEmailSentAt: sentAt } as Partial<OrderRecord>),
        R2_FENCE_CFG,
      ),
      'already_sent',
      `sentAt=${String(sentAt)} must still be refused`,
    );
  }
});

test('A3-3 R2: the fence is on the state, ahead of the receipt check', () => {
  const source = readFileSync(
    new URL('../src/lib/confirmation-email-delivery.ts', import.meta.url),
    'utf8',
  );
  const fence = source.slice(source.indexOf('export function evaluateConfirmationEmailClaimability'));
  const body = fence.slice(0, fence.indexOf('\n}'));
  const stateAt = body.indexOf("order.confirmationEmailState === 'ACCEPTED'");
  const receiptAt = body.indexOf('order.confirmationEmailSentAt');
  assert.ok(stateAt > 0, 'the ACCEPTED fence must exist');
  assert.ok(receiptAt > 0, 'the receipt check must still exist');
  assert.ok(stateAt < receiptAt, 'the state fence must precede the receipt check so it cannot be skipped');
});

test('A3-3 R2: the held set is deliberately not modified', () => {
  // ACCEPTED is a success, not a hold, and the held set is the exported list
  // other callers consume. R2 adds a refusal; it does not reclassify the state.
  assert.equal((CONFIRMATION_EMAIL_HELD_STATES as readonly string[]).includes('ACCEPTED'), false);
  assert.equal(isConfirmationEmailHeldState('ACCEPTED'), false);
});

test('A3-3 R2: no other state disposition moved', () => {
  // Every non-ACCEPTED, non-held state stays claimable, so the new line refuses
  // exactly one thing.
  //
  // A3-4 R2 AM-ST1 (fence F1, the same move AM-R1 and GA-11 make):
  // SNAPSHOTTED and PROVABLY_PRE_DISPATCH_FAILED hold a frozen envelope that
  // only the frozen dispatcher (A3-5) may send, so the legacy path refuses both
  // as awaiting_frozen_dispatch — never as a hold. R2's ACCEPTED line is unchanged.
  for (const state of CONFIRMATION_EMAIL_STATES) {
    const expected = state === 'ACCEPTED'
      ? 'already_sent'
      : isConfirmationEmailHeldState(state)
        ? 'held_for_reconciliation'
        : state === 'SNAPSHOTTED' || state === 'PROVABLY_PRE_DISPATCH_FAILED'
          ? 'awaiting_frozen_dispatch'
          : null;
    assert.equal(
      evaluateConfirmationEmailClaimability(r2Order({ confirmationEmailState: state }), R2_FENCE_CFG),
      expected,
      `${state} changed disposition`,
    );
  }
  // And a record with no confirmation state at all is untouched.
  assert.equal(evaluateConfirmationEmailClaimability(r2Order(), R2_FENCE_CFG), null);
});

test('A3-3 R2: the existing fences still win ahead of it', () => {
  // Order matters for the reported reason: payment and refunds are evaluated
  // first, and R2 must not have moved in front of them.
  assert.equal(
    evaluateConfirmationEmailClaimability(
      r2Order({ confirmationEmailState: 'ACCEPTED', paymentStatus: 'pending' } as Partial<OrderRecord>),
      R2_FENCE_CFG,
    ),
    'not_paid',
  );
  assert.equal(
    evaluateConfirmationEmailClaimability(
      r2Order({ confirmationEmailState: 'ACCEPTED', refundedAt: '2026-09-26T17:30:00.000Z' }),
      R2_FENCE_CFG,
    ),
    'refunded',
  );
});
