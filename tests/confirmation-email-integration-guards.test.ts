/*
 * Integration guards for the L-4 Slice A1/A2 foundation.
 *
 * The accepted candidate adds a transition model, a frozen provider envelope,
 * and one unconditional claimability fence. It adds no wiring: nothing writes
 * the new record fields, no route calls the model, no provider path touches the
 * envelope. That inertness is the property that made it reviewable, and it is
 * not self-evident from any single file — it is a property of the whole tree.
 *
 * These three guards pin it:
 *
 *   I1-1  the sweep gets its shared block reason from the delivery layer and
 *         keeps no second list of its own;
 *   I1-2  the envelope/state modules and the new record fields are reachable
 *         only from the exact boundary that was accepted, and only as types
 *         where types were what was accepted;
 *   I1-3  every path that can reach the provider refuses a held record — the
 *         delivery fence, the scheduled sweep, and the post-webhook kickoff,
 *         driven off the model's own held set rather than a copy of it.
 *
 * A3-3 amends this file deliberately, in three narrow places, each marked
 * `A3-3` below:
 *
 *   - `CANDIDATE_TESTS` gains the A3-3 record-boundary suite;
 *   - the field-reader guard matches whole identifiers and pins the new
 *     `confirmationEmailEnvelopeRef` field under its own allowlist, so the
 *     retired inline envelope stays pinned independently of the ref that
 *     replaced it;
 *   - I1-3's "and only that" clause admits Requirement R2's `ACCEPTED` fence.
 *
 * I1-3 deliberately does not restate the A2 assertions in
 * `confirmation-email-recovery.test.ts`. A2 pins the four held states as
 * literals and proves the delivery fence and the sweep refuse them. This suite
 * pins the derivation — that both fences refuse whatever the model calls held,
 * so a fifth held state cannot be added to the model and silently escape them —
 * and adds the kickoff path, which A2 does not exercise at all.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIRMATION_EMAIL_CLAIM_STALE_MS,
  deliverOrderConfirmationEmail,
  evaluateConfirmationEmailClaimability,
} from '../src/lib/confirmation-email-delivery.ts';
import {
  CONFIRMATION_EMAIL_HELD_STATES,
  CONFIRMATION_EMAIL_STATES,
  isConfirmationEmailHeldState,
} from '../src/lib/confirmation-email-state.ts';
import {
  CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS,
  evaluateConfirmationEmailSweepEligibility,
} from '../src/lib/confirmation-email-sweep.ts';
import {
  _resetConfirmationEmailInFlightForTest,
  scheduleOrderConfirmationEmail,
} from '../src/lib/order-confirmation-kickoff.ts';
import {
  createOrderRecord,
  getOrderAuthoritative,
  persistOrder,
  type OrderRecord,
} from '../src/lib/orders.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NOW_MS = Date.parse('2026-09-23T18:00:00.000Z');
const ACTIVATION_MS = CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

/** The kickoff path claims and records against the durable store, so it runs on
 *  a real temporary one rather than an in-memory record. */
function localStore<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-confirmation-integration-'));
  return withEnv(
    {
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      BLOB_READ_WRITE_TOKEN: undefined,
      HSB_ORDER_STORE_DIR: dir,
      VERCEL: undefined,
      NODE_ENV: 'development',
    },
    fn,
  ).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** The schedulers are fire-and-forget, so wait on observable state. */
async function settle(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makePaidOrder(id: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.com' },
      { id, now: new Date(NOW_MS - 60 * 60 * 1000).toISOString() },
    ),
    paymentStatus: 'paid' as const,
    paidAt: new Date(NOW_MS - 30 * 60 * 1000).toISOString(),
    stripeSessionId: `cs_test_${id}`,
    ...overrides,
  } as OrderRecord;
}

function heldOrder(state: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return makePaidOrder(`ord_i1_${state.toLowerCase()}`, {
    confirmationEmailState: state,
    confirmationEmailFirstDispatchIntentAt: '2026-09-23T17:00:00.000Z',
    ...overrides,
  } as Partial<OrderRecord>);
}

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

// ── Source walker, shared by I1-2 ───────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.vercel', 'graphify-out',
  'test-results', 'playwright-report', 'blob-report', '.e2e-store', '.data',
]);

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) out.push(path.relative(REPO_ROOT, full));
    }
  };
  walk(REPO_ROOT);
  return out.sort();
}

interface ModuleReference {
  file: string;
  line: number;
  specifier: string;
  statement: string;
  typeOnly: boolean;
  bindings: string[];
}

const SPECIFIER_RE = /confirmation-email-(?:envelope|state)(?:\.ts)?$/;

/**
 * Every import/export/require/dynamic-import in `file` whose specifier names one
 * of the two new modules, with the statement reconstructed far enough back to
 * tell `import type` from a runtime import.
 */
function findModuleReferences(file: string): ModuleReference[] {
  const lines = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
  const refs: ModuleReference[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const quoted = lines[i].match(/['"]([^'"]*confirmation-email-(?:envelope|state)(?:\.ts)?)['"]/);
    if (!quoted) continue;
    const specifier = quoted[1];
    if (!SPECIFIER_RE.test(specifier)) continue;

    // Walk back to the line the statement starts on: an import/export
    // declaration, or any line carrying require( / import( on the same line.
    let start = i;
    while (
      start > 0
      && !/^\s*(?:import|export)\b/.test(lines[start])
      && !/\b(?:require|import)\s*\(/.test(lines[start])
    ) start -= 1;

    const statement = lines.slice(start, i + 1).join('\n');
    const braced = statement.match(/\{([\s\S]*?)\}/);
    const bindings = braced
      ? braced[1].split(',').map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : [];

    refs.push({
      file,
      line: start + 1,
      specifier,
      statement,
      // The conservative reading: only the explicit `import type` /
      // `export type` form counts as erased. Anything else is runtime.
      typeOnly: /^\s*(?:import|export)\s+type\b/.test(statement),
      bindings,
    });
  }

  return refs;
}

// ── I1-1 — the sweep delegates; it keeps no second list ─────────────────────

/** Every reason the shared fence can produce from a record that exists. */
const BLOCK_REASON_FIXTURES: Array<{ reason: string; order: OrderRecord }> = [
  { reason: 'not_paid', order: makePaidOrder('ord_i1_notpaid', { paymentStatus: 'pending' } as Partial<OrderRecord>) },
  { reason: 'refunded', order: makePaidOrder('ord_i1_refunded', { refundedAt: '2026-09-23T12:00:00.000Z' }) },
  { reason: 'already_sent', order: makePaidOrder('ord_i1_sent', { confirmationEmailSentAt: '2026-09-23T12:00:00.000Z' }) },
  { reason: 'held_for_reconciliation', order: heldOrder('RECONCILIATION_REQUIRED') },
  {
    reason: 'claim_other_kind',
    order: makePaidOrder('ord_i1_otherkind', {
      emailResendClaimId: 'claim_x',
      emailResendClaimKind: 'shipped',
      emailResendClaimAt: new Date(NOW_MS - 1000).toISOString(),
    }),
  },
  {
    reason: 'claim_active',
    order: makePaidOrder('ord_i1_active', {
      emailResendClaimId: 'claim_live',
      emailResendClaimKind: 'order_confirmation',
      emailResendClaimAt: new Date(NOW_MS - 1000).toISOString(),
    }),
  },
];

test('I1-1: the sweep surfaces the delivery fence verdict verbatim, reason for reason', () => {
  for (const { reason, order } of BLOCK_REASON_FIXTURES) {
    assert.equal(
      evaluateConfirmationEmailClaimability(order, { nowMs: NOW_MS, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS }),
      reason,
      `fixture for ${reason} does not produce it`,
    );
    assert.deepEqual(
      evaluateConfirmationEmailSweepEligibility(order, {
        nowMs: NOW_MS,
        graceMs: 0,
        claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
        activationPaidAtMs: ACTIVATION_MS,
      }),
      { eligible: false, reason },
      `the sweep must report the shared fence's own reason for ${reason}`,
    );
  }
});

test('I1-1: the sweep holds no second copy of the shared block reasons', () => {
  const source = readRepoFile('src/lib/confirmation-email-sweep.ts');

  assert.match(
    source,
    /import\s*\{[\s\S]*?evaluateConfirmationEmailClaimability[\s\S]*?\}\s*from\s*'\.\/confirmation-email-delivery\.ts'/,
    'the sweep must import the shared fence from the delivery module',
  );

  const fence = source.slice(source.indexOf('export function evaluateConfirmationEmailSweepEligibility'));
  const body = fence.slice(0, fence.indexOf('\nexport '));
  assert.match(body, /evaluateConfirmationEmailClaimability\(/, 'eligibility must call the shared fence');

  // Sweep-owned reasons are its own; the delivery layer's reasons must reach it
  // only through the imported `ConfirmationEmailBlockReason` union.
  const SWEEP_OWNED = ['missing_paidat', 'invalid_paidat', 'future_paidat', 'before_activation', 'below_grace'];
  for (const reason of BLOCK_REASON_FIXTURES.map((f) => f.reason)) {
    assert.ok(
      !SWEEP_OWNED.includes(reason),
      `${reason} is a delivery-layer reason and must not be sweep-owned`,
    );
    assert.doesNotMatch(
      source,
      new RegExp(`['"\`]${reason}['"\`]`),
      `the sweep restates the block reason ${reason} instead of delegating for it`,
    );
  }

  // And it does not re-derive the conditions behind them either.
  assert.doesNotMatch(body, /paymentStatus/, 'the sweep must not re-check payment itself');
  assert.doesNotMatch(body, /refundedAt|stripeRefundId|refundClaimId/, 'the sweep must not re-check refunds itself');
  assert.doesNotMatch(body, /confirmationEmailSentAt/, 'the sweep must not re-check the receipt itself');
  assert.doesNotMatch(body, /confirmationEmailState|isConfirmationEmailHeldState/, 'the sweep must not re-check the hold itself');
  assert.doesNotMatch(body, /emailResendClaim/, 'the sweep must not re-check the claim itself');
});

// ── I1-2 — the foundation is inert, at exactly the accepted boundary ────────

/** Runtime reach into the new modules is permitted from exactly one place. */
const RUNTIME_IMPORT_ALLOWLIST: Record<string, { specifier: RegExp; bindings: string[] }> = {
  'src/lib/confirmation-email-delivery.ts': {
    specifier: /confirmation-email-state(?:\.ts)?$/,
    bindings: ['isConfirmationEmailHeldState'],
  },
  // A3-2: the private envelope store validates what it returns.
  'src/lib/confirmation-envelope-config.ts': {
    specifier: /confirmation-email-envelope(?:\.ts)?$/,
    bindings: ['CONFIRMATION_ENVELOPE_LIMITS'],
  },
  'src/lib/confirmation-envelope-store.ts': {
    specifier: /confirmation-email-envelope(?:\.ts)?$/,
    bindings: ['CONFIRMATION_ENVELOPE_VERSION', 'digestConfirmationRequest',
               'ConfirmationEmailEnvelopeV1', 'ConfirmationEmailRequestV1'],
  },
};

/** Type-only reach is permitted from `orders.ts`, which declares the fields. */
const TYPE_IMPORT_ALLOWLIST = new Set(['src/lib/orders.ts']);

/** The candidate's own suites may import the modules however they need to. */
const CANDIDATE_TESTS = new Set([
  'tests/confirmation-email-envelope.test.ts',
  'tests/confirmation-email-state.test.ts',
  'tests/confirmation-email-recovery.test.ts',
  'tests/confirmation-email-integration-guards.test.ts',
  'tests/confirmation-envelope-config.test.ts',
  'tests/confirmation-envelope-store.test.ts',
  // A3-3: the record-boundary suite exercises the retired field, the ref and
  // the operator view directly, so it must be able to name all of them.
  'tests/confirmation-envelope-record-boundary.test.ts',
]);

test('I1-2: nothing outside the accepted boundary reaches the envelope or state modules', () => {
  const offenders: string[] = [];

  for (const file of listSourceFiles()) {
    for (const ref of findModuleReferences(file)) {
      const where = `${ref.file}:${ref.line} -> ${ref.specifier}`;
      if (CANDIDATE_TESTS.has(file)) continue;

      const runtimeRule = RUNTIME_IMPORT_ALLOWLIST[file];
      if (runtimeRule && !ref.typeOnly) {
        if (!runtimeRule.specifier.test(ref.specifier)) {
          offenders.push(`${where} — runtime import of a module this file may not reach at runtime`);
        } else if (
          ref.bindings.length !== runtimeRule.bindings.length
          || !ref.bindings.every((binding) => runtimeRule.bindings.includes(binding))
        ) {
          offenders.push(`${where} — runtime bindings ${JSON.stringify(ref.bindings)} exceed the accepted ${JSON.stringify(runtimeRule.bindings)}`);
        }
        continue;
      }

      if (ref.typeOnly && (TYPE_IMPORT_ALLOWLIST.has(file) || runtimeRule)) continue;

      offenders.push(
        ref.typeOnly
          ? `${where} — type-only import from a file outside the accepted type boundary`
          : `${where} — runtime import; the L-4 foundation is inert and may only be reached as types`,
      );
    }
  }

  assert.deepEqual(offenders, [], `the L-4 foundation is no longer inert:\n${offenders.join('\n')}`);
});

test('I1-2: the accepted type-only boundary in orders.ts is present and still type-only', () => {
  const refs = findModuleReferences('src/lib/orders.ts');
  assert.equal(refs.length, 2, 'orders.ts must carry exactly the two accepted imports');
  for (const ref of refs) {
    assert.equal(ref.typeOnly, true, `${ref.specifier} must be imported as types only`);
  }
  assert.deepEqual(
    refs.map((ref) => ref.specifier).sort(),
    ['./confirmation-email-envelope.ts', './confirmation-email-state.ts'],
    'both accepted type-only imports must remain',
  );
});

test('I1-2: the delivery module reaches the state module for the held set and nothing else', () => {
  const refs = findModuleReferences('src/lib/confirmation-email-delivery.ts');
  assert.equal(refs.length, 1, 'delivery must carry exactly one reference to the new modules');
  assert.equal(refs[0].typeOnly, false, 'the held-set predicate is a runtime value, as accepted');
  assert.deepEqual(refs[0].bindings, ['isConfirmationEmailHeldState']);
  assert.match(refs[0].specifier, /confirmation-email-state(?:\.ts)?$/);
});

/** Every field the candidate added to `OrderRecord`. Nothing writes them yet;
 *  that is what makes the foundation inert rather than merely unused. */
const NEW_RECORD_FIELDS = [
  'confirmationEmailState',
  'confirmationEmailEnvelope',
  'confirmationEmailFirstDispatchIntentAt',
  'confirmationEmailAttemptId',
  'confirmationEmailDispatchDeadlineAt',
  'confirmationEmailProviderMessageId',
  'confirmationEmailAcceptedAt',
  'confirmationEmailAttempts',
  'confirmationEmailHoldReason',
] as const;

const FIELD_READER_ALLOWLIST = new Set([
  'src/lib/orders.ts',                      // the declaration itself
  'src/lib/confirmation-email-state.ts',    // the model that defines them
  'src/lib/confirmation-email-envelope.ts',
  'src/lib/confirmation-email-delivery.ts', // reads confirmationEmailState for the hold
  ...CANDIDATE_TESTS,
]);

/**
 * A3-3. The record-level ref that replaces the inline envelope, and the exact
 * files allowed to name it.
 *
 * Kept separate from `FIELD_READER_ALLOWLIST` on purpose. `admin-order-dto.ts`
 * must read the ref to build the operator view; it must NOT thereby become able
 * to name the retired inline envelope, the transition state, or the attempt
 * history. A shared allowlist would have granted all of those in one entry.
 */
const CONFIRMATION_REF_FIELD = 'confirmationEmailEnvelopeRef';

const CONFIRMATION_REF_READER_ALLOWLIST = new Set([
  'src/lib/orders.ts',            // declares the field and enforces the write boundary
  'src/lib/admin-order-dto.ts',   // reads it to build the positive operator view
  ...CANDIDATE_TESTS,
]);

/**
 * A3-3. Does `source` name `field` as a whole identifier?
 *
 * `String.includes` cannot separate `confirmationEmailEnvelope` from
 * `confirmationEmailEnvelopeRef`: the retired field's name is a prefix of the
 * new one, so every file naming the ref was reported as touching request bytes.
 * Excluding a trailing identifier character fixes that without weakening
 * anything — a longer identifier is a DIFFERENT field, and every real reference
 * to the retired field (`.confirmationEmailEnvelope;`,
 * `['confirmationEmailEnvelope']`, `confirmationEmailEnvelope:`) still matches.
 */
function namesRecordField(source: string, field: string): boolean {
  return new RegExp(`${field}(?![A-Za-z0-9_$])`).test(source);
}

test('I1-2: no persistence writer, route, kickoff or provider path touches the new fields', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    if (FIELD_READER_ALLOWLIST.has(file)) continue;
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const field of NEW_RECORD_FIELDS) {
      // A3-3: whole-identifier match, so the ref does not read as the retired
      // inline envelope whose name it extends.
      if (namesRecordField(source, field)) offenders.push(`${file} references ${field}`);
    }
  }
  assert.deepEqual(offenders, [], `the L-4 record fields are wired somewhere:\n${offenders.join('\n')}`);
});

test('A3-3: the envelope ref is named only by the record boundary and the operator view', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    if (CONFIRMATION_REF_READER_ALLOWLIST.has(file)) continue;
    if (namesRecordField(readFileSync(path.join(REPO_ROOT, file), 'utf8'), CONFIRMATION_REF_FIELD)) {
      offenders.push(`${file} references ${CONFIRMATION_REF_FIELD}`);
    }
  }
  assert.deepEqual(offenders, [], `the A3-3 ref field is read outside its boundary:\n${offenders.join('\n')}`);
});

test('A3-3: the retired inline envelope is still pinned independently of the ref', () => {
  // The whole point of the whole-identifier matcher: it must not have become a
  // hole. A file cleared to read the ref stays unable to name the retired field.
  assert.equal(namesRecordField(`order.${CONFIRMATION_REF_FIELD} = null;`, 'confirmationEmailEnvelope'), false);
  assert.equal(namesRecordField('delete order.confirmationEmailEnvelope;', 'confirmationEmailEnvelope'), true);
  assert.equal(namesRecordField("order['confirmationEmailEnvelope']", 'confirmationEmailEnvelope'), true);
  assert.equal(namesRecordField('confirmationEmailEnvelope: null,', 'confirmationEmailEnvelope'), true);

  // And `admin-order-dto.ts`, the file the amendment exists for, names exactly
  // the ref and not the retired field.
  const dto = readRepoFile('src/lib/admin-order-dto.ts');
  assert.equal(namesRecordField(dto, CONFIRMATION_REF_FIELD), true);
  assert.equal(namesRecordField(dto, 'confirmationEmailEnvelope'), false);
});

test('I1-2: the delivery module touches only the hold field, and only to read it', () => {
  const source = readRepoFile('src/lib/confirmation-email-delivery.ts');
  for (const field of NEW_RECORD_FIELDS) {
    if (field === 'confirmationEmailState') continue;
    assert.ok(!source.includes(field), `delivery must not reference ${field} at all`);
  }
  // A commit object assigning the field would be a write; only the read exists.
  assert.doesNotMatch(source, /confirmationEmailState\s*:/, 'delivery must not write the state field');
  assert.match(
    source,
    /isConfirmationEmailHeldState\(order\.confirmationEmailState\)/,
    'the hold must be read through the shared predicate',
  );
});

test('I1-2: no module combines the confirmation modules with an outbox module', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const confirmation = /['"][^'"]*confirmation-email-[a-z-]+(?:\.ts)?['"]/.test(source);
    const outbox = /['"][^'"]*(?:post-payment-)?outbox[a-z-]*(?:\.ts)?['"]/.test(source);
    if (confirmation && outbox) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `a barrel or module joins confirmation and outbox exports: ${offenders.join(', ')}`);
});

// ── I1-3 — every provider-reaching path refuses a held record ──────────────

test('I1-3: the held set is exactly the four ambiguous states, and all are real states', () => {
  assert.deepEqual([...CONFIRMATION_EMAIL_HELD_STATES], [
    'DISPATCH_INTENT_RECORDED',
    'RECONCILIATION_REQUIRED',
    'RECONCILED_ACCEPTED',
    'OWNER_AUTHORIZED_RESEND_SENT',
  ]);
  for (const state of CONFIRMATION_EMAIL_HELD_STATES) {
    assert.ok((CONFIRMATION_EMAIL_STATES as readonly string[]).includes(state), `${state} is not a modelled state`);
    assert.equal(isConfirmationEmailHeldState(state), true);
  }
});

test('I1-3: both fences refuse whatever the model calls held, and only that', () => {
  const cfg = { nowMs: NOW_MS, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS };
  const sweepCfg = { ...cfg, graceMs: 0, activationPaidAtMs: ACTIVATION_MS };

  // Derived from the model, not from a copied list: a fifth held state added to
  // the model is covered here the moment it exists.
  //
  // A3-3 amends the "and only that" half. Requirement R2 (architecture §3.9)
  // adds one non-hold refusal to the delivery fence: `ACCEPTED` is a success,
  // not a hold, and it is deliberately absent from the held set — which left the
  // `confirmationEmailSentAt` check as the only thing stopping an `ACCEPTED`
  // record with no receipt from being re-sent. The hold derivation itself is
  // unchanged and still covers a fifth held state the moment the model has one;
  // only this one state's expected verdict moves, and it moves to a REFUSAL.
  for (const state of CONFIRMATION_EMAIL_STATES) {
    const order = heldOrder(state);
    const expected = isConfirmationEmailHeldState(state)
      ? 'held_for_reconciliation'
      : state === 'ACCEPTED' ? 'already_sent' : null;
    assert.equal(
      evaluateConfirmationEmailClaimability(order, cfg),
      expected,
      `delivery fence disagrees with the model for ${state}`,
    );
    assert.deepEqual(
      evaluateConfirmationEmailSweepEligibility(order, sweepCfg),
      expected ? { eligible: false, reason: expected } : { eligible: true, ageMs: NOW_MS - Date.parse(order.paidAt!) },
      `sweep eligibility disagrees with the model for ${state}`,
    );
    // I1-1's property still holds through the new fence: the sweep reports the
    // delivery layer's own verdict rather than a second copy of it.
    assert.equal(
      evaluateConfirmationEmailClaimability(order, cfg),
      expected,
      `the sweep and the fence must agree on ${state}`,
    );
  }
});

/** The webhook wires both schedulers; a held record must defeat each of them. */
for (const scheduler of ['setImmediate', 'after'] as const) {
  test(`I1-3: the post-webhook ${scheduler} kickoff never reaches transport for a held record`, async () => {
    await localStore(async () => {
      for (const state of CONFIRMATION_EMAIL_HELD_STATES) {
        _resetConfirmationEmailInFlightForTest();
        const order = heldOrder(state);
        await persistOrder(order);
        const before = JSON.stringify(await getOrderAuthoritative(order.id));

        let sends = 0;
        const errors: string[] = [];
        const queue: Array<() => void | Promise<void>> = [];

        scheduleOrderConfirmationEmail(order, {
          // A transport seam that cannot be touched quietly.
          send: async () => {
            sends += 1;
            throw new Error('a held record reached the confirmation transport');
          },
          setImmediateImpl: (cb) => {
            if (scheduler === 'setImmediate') queue.push(cb);
            return null;
          },
          afterImpl: scheduler === 'after' ? (cb) => { queue.push(cb); } : null,
          log: () => {},
          errorLog: (line) => { errors.push(line); },
        });

        assert.equal(queue.length, 1, `${scheduler} did not schedule exactly one run for ${state}`);
        await queue.shift()!();
        await settle(() => errors.length > 0, `${scheduler} kickoff to report the hold for ${state}`);

        assert.equal(sends, 0, `${state} reached the provider through the ${scheduler} kickoff`);
        assert.ok(
          errors.some((line) => line.includes('confirmation_email_blocked:held_for_reconciliation')),
          `${state} did not report the hold; got ${JSON.stringify(errors)}`,
        );
        assert.equal(
          JSON.stringify(await getOrderAuthoritative(order.id)),
          before,
          `${state} was mutated by a refused ${scheduler} kickoff`,
        );
      }
    });
  });
}

test('I1-3: the shared delivery entry point refuses a held record before any claim', async () => {
  await localStore(async () => {
    for (const state of CONFIRMATION_EMAIL_HELD_STATES) {
      const order = heldOrder(state);
      await persistOrder(order);
      let sends = 0;

      const outcome = await deliverOrderConfirmationEmail(order.id, {
        send: async () => {
          sends += 1;
          throw new Error('a held record reached the confirmation transport');
        },
        now: () => NOW_MS,
      });

      assert.deepEqual(outcome, { status: 'blocked', reason: 'held_for_reconciliation' });
      assert.equal(sends, 0);
      const latest = await getOrderAuthoritative(order.id);
      assert.equal(latest?.emailResendClaimId ?? null, null, `${state} was claimed despite the hold`);
    }
  });
});

test('I1-3: a non-held record still reaches transport, so the guards prove a fence not a freeze', async () => {
  await localStore(async () => {
    _resetConfirmationEmailInFlightForTest();
    const order = makePaidOrder('ord_i1_open', { confirmationEmailState: 'PROVABLY_PRE_DISPATCH_FAILED' } as Partial<OrderRecord>);
    await persistOrder(order);
    let sends = 0;

    const outcome = await deliverOrderConfirmationEmail(order.id, {
      send: async () => { sends += 1; return { skipped: false as const, id: 'msg_open' }; },
      now: () => NOW_MS,
      log: () => {},
      errorLog: () => {},
    });

    assert.deepEqual(outcome, { status: 'sent' });
    assert.equal(sends, 1, 'a record outside the held set must still be deliverable');
  });
});
