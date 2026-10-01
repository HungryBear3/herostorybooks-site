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
 *
 * A3-4 R2 amends this file to admit exactly one new runtime reader, the
 * snapshot producer, and pins that producer's shape. Positive allowlists only;
 * each change is marked `A3-4 R2` below:
 *
 *   GA-1  runtime rules are per specifier: exactly one rule matches, bindings
 *         are set-equal to it, and there is at most one statement per rule;
 *   GA-2  runtime reach into the model modules is a named import declaration;
 *   GA-3  record fields are granted per file (`RECORD_FIELD_GRANTS`), not
 *         through `FIELD_READER_ALLOWLIST`;
 *   GA-4  the producer may name the envelope ref, which it writes only after
 *         proving it against the private object;
 *   GA-5  `CANDIDATE_TESTS` gains the producer suite, and every entry must be a
 *         test file;
 *   GA-6  the producer names exactly its granted fields and reaches the model
 *         modules through exactly two runtime imports;
 *   GA-7  producer source pins: (a) transition vocabulary, (b) the exact
 *         runtime import table, (c) no transport, deletion or listing reach,
 *         (d) a synchronous, store-free, environment-free decision closure,
 *         (e) one ambient namespace read, compared only, and one binding,
 *         (f) two environment reads and one render, (g) the bound order I/O;
 *   GA-8  only the producer and the candidate suites import the envelope store;
 *   GA-9  the delivery module reaches the producer through one pinned import
 *         and keeps its writer-off order bindings; the three delivery and
 *         outbox prohibitions are unchanged;
 *   GA-10 the I1-1 fixtures gain `awaiting_frozen_dispatch`;
 *   GA-11 I1-3 "and only that" refuses `SNAPSHOTTED` and PPDF as
 *         `awaiting_frozen_dispatch`;
 *   GA-12 the "still reaches transport" proof uses a stateless record, and a
 *         sibling proves the frozen states never reach transport;
 *   GA-13 every checker is a pure function exercised on synthetic offenders.
 *
 * A3-5 amends this file to admit the frozen dispatcher as one more runtime
 * reader with its own per-file rules and field grant, adds its two suites to
 * `CANDIDATE_TESTS`, and pins it (GD-1 … GD-5, RL-2) at the end of the file.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

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
  return findModuleReferencesIn(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}

/** A3-4 R2 GA-13: the same scan over a source string, so synthetic cases use it. */
function findModuleReferencesIn(file: string, source: string): ModuleReference[] {
  const lines = source.split('\n');
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
  // A3-4 R2 GA-10: a frozen envelope waits for the frozen dispatcher (fence F1).
  {
    reason: 'awaiting_frozen_dispatch',
    order: makePaidOrder('ord_i1_snapshotted', { confirmationEmailState: 'SNAPSHOTTED' } as Partial<OrderRecord>),
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

/** A3-4 R2 GA-1: one runtime rule — a specifier and its exact bindings. */
interface RuntimeRule {
  specifier: RegExp;
  bindings: string[];
}

/** Runtime reach into the new modules is permitted from exactly these places,
 *  per specifier (A3-4 R2 GA-1: a non-empty array of rules per file). */
const RUNTIME_IMPORT_ALLOWLIST: Record<string, RuntimeRule[]> = {
  'src/lib/confirmation-email-delivery.ts': [{
    specifier: /confirmation-email-state(?:\.ts)?$/,
    bindings: ['isConfirmationEmailHeldState'],
  }],
  // A3-2: the private envelope store validates what it returns.
  'src/lib/confirmation-envelope-config.ts': [{
    specifier: /confirmation-email-envelope(?:\.ts)?$/,
    bindings: ['CONFIRMATION_ENVELOPE_LIMITS'],
  }],
  'src/lib/confirmation-envelope-store.ts': [{
    specifier: /confirmation-email-envelope(?:\.ts)?$/,
    bindings: ['CONFIRMATION_ENVELOPE_VERSION', 'digestConfirmationRequest',
               'ConfirmationEmailEnvelopeV1', 'ConfirmationEmailRequestV1'],
  }],
  // A3-4 R2: the snapshot producer builds the envelope and asks the model.
  // Its types arrive through separate `import type` statements; an inline
  // `type` inside one of these imports is an extra binding and fails.
  'src/lib/confirmation-envelope-producer.ts': [
    {
      specifier: /confirmation-email-envelope(?:\.ts)?$/,
      bindings: ['buildConfirmationEmailEnvelope'],
    },
    {
      specifier: /confirmation-email-state(?:\.ts)?$/,
      bindings: ['classifyLegacyConfirmationRecord', 'evaluateConfirmationEmailTransition'],
    },
  ],
  // A3-5: the frozen dispatcher asks the model, carries the first-intent
  // instant, appends the attempt and recomputes the request digest.
  'src/lib/confirmation-email-dispatch.ts': [
    {
      specifier: /confirmation-email-envelope(?:\.ts)?$/,
      bindings: ['digestConfirmationRequest'],
    },
    {
      specifier: /confirmation-email-state(?:\.ts)?$/,
      bindings: ['appendConfirmationEmailAttempt', 'evaluateConfirmationEmailTransition', 'evaluateFirstDispatchIntentWrite'],
    },
  ],
};

const PRODUCER = 'src/lib/confirmation-envelope-producer.ts';
const DISPATCH = 'src/lib/confirmation-email-dispatch.ts';
const DELIVERY = 'src/lib/confirmation-email-delivery.ts';
const KICKOFF = 'src/lib/order-confirmation-kickoff.ts';
const SWEEP = 'src/lib/confirmation-email-sweep.ts';

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
  // NBT-R1: the NBT suite directly exercises the state/ref boundary, so it
  // must be able to name those fields. No production file gains permission.
  'tests/order-transaction-namespace-binding.test.ts',
  // A3-4 R2 GA-5: the producer suite drives the producer, the store, the ref
  // and the record fields directly.
  'tests/confirmation-envelope-producer.test.ts',
  // A3-5: the frozen-dispatch suites drive the dispatcher and read the record
  // fields it commits.
  'tests/confirmation-email-frozen-dispatch.test.ts',
  'tests/confirmation-email-dispatch-classification.test.ts',
]);

/** A3-4 R2 GA-5: a candidate exemption is only ever a test file. */
const CANDIDATE_TEST_SHAPE = /^tests\/[a-z0-9-]+\.test\.ts$/;

function candidateTestShapeOffenders(candidates: ReadonlySet<string>): string[] {
  return [...candidates].filter((entry) => !CANDIDATE_TEST_SHAPE.test(entry));
}

/** Set equality of two binding lists (duplicates count, as the original did). */
function sameBindings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((binding) => expected.includes(binding))
    && expected.every((binding) => actual.includes(binding));
}

/**
 * A3-4 R2 GA-1, GA-2, GA-13. Every reference in `file` to the model modules,
 * judged against that file's rules:
 *
 *   - a runtime reference must be a named import declaration (GA-2);
 *   - exactly one of the file's rules may match its specifier;
 *   - its bindings must be set-equal to that rule's bindings;
 *   - each rule may be met by at most one runtime statement.
 */
function runtimeReachOffenders(file: string, refs: readonly ModuleReference[]): string[] {
  if (CANDIDATE_TESTS.has(file)) return [];
  const offenders: string[] = [];
  const rules = RUNTIME_IMPORT_ALLOWLIST[file];
  const statementsPerRule = new Map<RuntimeRule, number>();

  for (const ref of refs) {
    const where = `${ref.file}:${ref.line} -> ${ref.specifier}`;
    if (rules && !ref.typeOnly) {
      if (!/^\s*import\s*\{/.test(ref.statement)) {
        offenders.push(`${where} — runtime reach must be a named import declaration`);
        continue;
      }
      const matching = rules.filter((rule) => rule.specifier.test(ref.specifier));
      if (matching.length !== 1) {
        offenders.push(`${where} — runtime import of a module this file may not reach at runtime`);
        continue;
      }
      const rule = matching[0];
      if (!sameBindings(ref.bindings, rule.bindings)) {
        offenders.push(`${where} — runtime bindings ${JSON.stringify(ref.bindings)} are not the accepted ${JSON.stringify(rule.bindings)}`);
      }
      const count = (statementsPerRule.get(rule) ?? 0) + 1;
      statementsPerRule.set(rule, count);
      if (count > 1) offenders.push(`${where} — more than one runtime statement for one rule`);
      continue;
    }

    if (ref.typeOnly && (TYPE_IMPORT_ALLOWLIST.has(file) || rules)) continue;

    offenders.push(
      ref.typeOnly
        ? `${where} — type-only import from a file outside the accepted type boundary`
        : `${where} — runtime import; the L-4 foundation is inert and may only be reached as types`,
    );
  }
  return offenders;
}

test('I1-2: nothing outside the accepted boundary reaches the envelope or state modules', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) offenders.push(...runtimeReachOffenders(file, findModuleReferences(file)));
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
  // A3-4 R2 GA-4: the snapshot producer writes only a ref it has just proven
  // against the private object, byte for byte.
  'src/lib/confirmation-envelope-producer.ts',
  // A3-5: the frozen dispatcher reads the ref and fences the envelope on it.
  'src/lib/confirmation-email-dispatch.ts',
  ...CANDIDATE_TESTS,
]);

/**
 * A3-4 R2 GA-3. Per-file grants of individual record fields.
 *
 * The producer is deliberately NOT in `FIELD_READER_ALLOWLIST`: that list
 * grants every field at once, and the producer may name exactly the state and
 * the hold reason it commits. The retired inline envelope, the dispatch-intent
 * marker and the attempt history stay out of its reach.
 */
const RECORD_FIELD_GRANTS: Record<string, readonly string[]> = {
  'src/lib/confirmation-envelope-producer.ts': ['confirmationEmailState', 'confirmationEmailHoldReason'],
  // A3-5: the dispatcher commits the transition fields. The retired inline
  // envelope stays out of its reach.
  'src/lib/confirmation-email-dispatch.ts': [
    'confirmationEmailState',
    'confirmationEmailFirstDispatchIntentAt',
    'confirmationEmailAttemptId',
    'confirmationEmailDispatchDeadlineAt',
    'confirmationEmailProviderMessageId',
    'confirmationEmailAcceptedAt',
    'confirmationEmailAttempts',
    'confirmationEmailHoldReason',
  ],
};

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

/**
 * A3-4 R2 GA-3, GA-4, GA-13. Every record field `source` names that `file` may
 * not name: a `NEW_RECORD_FIELDS` member outside the file's grant (unless the
 * file is in `FIELD_READER_ALLOWLIST`), and the ref field outside
 * `CONFIRMATION_REF_READER_ALLOWLIST`. Whole-identifier match (A3-3).
 */
function fieldNameOffenders(file: string, source: string): string[] {
  const offenders: string[] = [];
  if (!FIELD_READER_ALLOWLIST.has(file)) {
    const grant = RECORD_FIELD_GRANTS[file] ?? [];
    for (const field of NEW_RECORD_FIELDS) {
      if (!grant.includes(field) && namesRecordField(source, field)) offenders.push(`${file} references ${field}`);
    }
  }
  if (!CONFIRMATION_REF_READER_ALLOWLIST.has(file) && namesRecordField(source, CONFIRMATION_REF_FIELD)) {
    offenders.push(`${file} references ${CONFIRMATION_REF_FIELD}`);
  }
  return offenders;
}

const isRefOffender = (offender: string) => offender.endsWith(` references ${CONFIRMATION_REF_FIELD}`);

test('I1-2: no persistence writer, route, kickoff or provider path touches the new fields', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    // A3-3: whole-identifier match, so the ref does not read as the retired
    // inline envelope whose name it extends. A3-4 R2: per-file grants.
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    offenders.push(...fieldNameOffenders(file, source).filter((offender) => !isRefOffender(offender)));
  }
  assert.deepEqual(offenders, [], `the L-4 record fields are wired somewhere:\n${offenders.join('\n')}`);
});

test('A3-3: the envelope ref is named only by the record boundary and the operator view', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    offenders.push(...fieldNameOffenders(file, source).filter(isRefOffender));
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
  //
  // A3-4 R2 GA-11: fence F1. `SNAPSHOTTED` and `PROVABLY_PRE_DISPATCH_FAILED`
  // hold a frozen envelope that only the frozen dispatcher (A3-5) may send, so
  // the legacy path refuses both as `awaiting_frozen_dispatch` — never as a
  // hold, and never as claimable.
  for (const state of CONFIRMATION_EMAIL_STATES) {
    const order = heldOrder(state);
    const expected = isConfirmationEmailHeldState(state)
      ? 'held_for_reconciliation'
      : state === 'ACCEPTED'
        ? 'already_sent'
        : state === 'SNAPSHOTTED' || state === 'PROVABLY_PRE_DISPATCH_FAILED'
          ? 'awaiting_frozen_dispatch'
          : null;
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
  // A3-4 R2 GA-12: PPDF is now fenced by F1, so the open record is a plain
  // stateless paid order with the writer flag absent. The legacy send is
  // preserved and asserted.
  await withEnv({ HSB_CONFIRMATION_ENVELOPE_WRITER: undefined }, () => localStore(async () => {
    _resetConfirmationEmailInFlightForTest();
    const order = makePaidOrder('ord_i1_open');
    await persistOrder(order);
    const transport = recordingTransport();

    const outcome = await deliverOrderConfirmationEmail(order.id, {
      send: transport.send,
      now: () => NOW_MS,
      log: () => {},
      errorLog: () => {},
    });

    assert.deepEqual(outcome, { status: 'sent' });
    assert.equal(transport.calls(), 1, 'a record outside the held set must still be deliverable');
  }));
});

// ── A3-4 R2 GA-12 sibling: the frozen-state paths never reach transport ─────

/** A synthetic, non-network recorder for the legacy send. */
function recordingTransport() {
  let calls = 0;
  return {
    send: async () => { calls += 1; return { skipped: false as const, id: 'msg_synthetic' }; },
    calls: () => calls,
  };
}

/** A transport that cannot be touched quietly. */
function throwingTransport() {
  let calls = 0;
  return {
    send: async (): Promise<never> => {
      calls += 1;
      throw new Error('TransportTouched: a frozen-envelope record reached the confirmation transport');
    },
    calls: () => calls,
  };
}

/** Synthetic store seams: any call is unscripted and throws. */
function strictSyntheticStoreIo() {
  const calls: string[] = [];
  const unscripted = (op: string) => async (): Promise<never> => {
    calls.push(op);
    throw new Error(`SyntheticUnscriptedCall: ${op}`);
  };
  return { calls, io: { put: unscripted('put'), get: unscripted('get'), del: unscripted('del') } };
}

/**
 * The in-memory bound order I/O: the raw NBT pair (`read`, `transact`) over a
 * map keyed by the full flat record path, returning NBT-shaped provenance built
 * from the paths it actually used.
 */
function boundOrderIo(seed: OrderRecord[]) {
  const cells = new Map<string, string>();
  for (const order of seed) cells.set(`orders/${order.id}.json`, JSON.stringify(order));
  let calls = 0;
  const provenance = (recordPath: string, outcome: string, reads: number, commits: number) => ({
    namespace: '',
    recordPath,
    readPaths: Array.from({ length: reads }, () => recordPath),
    commitPaths: Array.from({ length: commits }, () => recordPath),
    attempts: reads,
    outcome,
  });
  const read = async (_binding: unknown, orderId: string) => {
    calls += 1;
    const recordPath = `orders/${orderId}.json`;
    const body = cells.get(recordPath);
    return body === undefined
      ? { found: null, provenance: provenance(recordPath, 'not_found', 1, 0) }
      : { found: { order: JSON.parse(body) as OrderRecord, version: 'v1' }, provenance: provenance(recordPath, 'read', 1, 0) };
  };
  const transact = async (
    _binding: unknown,
    orderId: string,
    mutate: (order: OrderRecord) => unknown,
    opts: { notFound: () => unknown; beforeCommit?: () => boolean },
  ) => {
    calls += 1;
    const recordPath = `orders/${orderId}.json`;
    const body = cells.get(recordPath);
    if (body === undefined) return { status: 'not_found', result: opts.notFound(), provenance: provenance(recordPath, 'not_found', 1, 0) };
    const outcome = mutate(JSON.parse(body) as OrderRecord) as { abort?: unknown; commit?: OrderRecord; result?: unknown };
    if ('abort' in outcome) return { status: 'aborted', result: outcome.abort, provenance: provenance(recordPath, 'aborted', 1, 0) };
    if (opts.beforeCommit && opts.beforeCommit() !== true) {
      return { status: 'commit_refused', provenance: provenance(recordPath, 'commit_refused', 1, 0) };
    }
    cells.set(recordPath, JSON.stringify(outcome.commit));
    return { status: 'committed', result: outcome.result, provenance: provenance(recordPath, 'committed', 1, 1) };
  };
  return { io: { read, transact }, calls: () => calls, bodyOf: (orderId: string) => cells.get(`orders/${orderId}.json`) };
}

const WRITER_EPOCH = '2026-09-22T00:00:00.000Z';

/** A complete synthetic armed writer environment; flat namespace, no Vercel. */
function armedWriterEnv(): NodeJS.ProcessEnv {
  return {
    HSB_CONFIRMATION_ENVELOPE_WRITER: 'true',
    HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: WRITER_EPOCH,
    HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: 'vercel_blob_rw_SYNTHETICenvStore01_SYNTHETICsecret000001',
  } as unknown as NodeJS.ProcessEnv;
}

const FROZEN_STATES = ['SNAPSHOTTED', 'PROVABLY_PRE_DISPATCH_FAILED'] as const;

test('I1-3/A3-4 R2: the frozen-envelope states never reach transport through delivery or either kickoff', async () => {
  // Ambient agreement with the flat writer namespace, and no ambient flag.
  await withEnv({ HSB_CONFIRMATION_ENVELOPE_WRITER: undefined, HSB_BLOB_NAMESPACE: undefined, VERCEL_ENV: undefined },
    () => localStore(async () => {
      for (const writer of ['absent', 'armed'] as const) {
        for (const state of FROZEN_STATES) {
          for (const path_ of ['delivery', 'setImmediate', 'after'] as const) {
            const label = `${state} via ${path_} with the writer ${writer}`;
            _resetConfirmationEmailInFlightForTest();
            const order = makePaidOrder(`ord_i1_frozen_${writer}_${path_}_${state.toLowerCase()}`, {
              confirmationEmailState: state,
            } as Partial<OrderRecord>);
            const store = strictSyntheticStoreIo();
            const orderIo = boundOrderIo([order]);
            const envelopeWriter = writer === 'armed'
              ? { env: armedWriterEnv(), storeIo: store.io, orderIo: orderIo.io }
              : undefined;
            if (writer === 'absent') await persistOrder(order);
            const before = writer === 'absent'
              ? JSON.stringify(await getOrderAuthoritative(order.id))
              : orderIo.bodyOf(order.id);
            const transport = throwingTransport();
            const logs: string[] = [];
            const errors: string[] = [];

            if (path_ === 'delivery') {
              const outcome = await deliverOrderConfirmationEmail(order.id, {
                send: transport.send,
                now: () => NOW_MS,
                log: (line) => { logs.push(line); },
                errorLog: (line) => { errors.push(line); },
                ...(envelopeWriter ? { envelopeWriter } : {}),
              } as Parameters<typeof deliverOrderConfirmationEmail>[1]);
              assert.deepEqual(outcome, { status: 'blocked', reason: 'awaiting_frozen_dispatch' }, label);
              assert.deepEqual(errors, [], `${label}: a frozen-state refusal is not an error`);
            } else {
              const queue: Array<() => void | Promise<void>> = [];
              scheduleOrderConfirmationEmail(order, {
                send: transport.send,
                setImmediateImpl: (cb) => {
                  if (path_ === 'setImmediate') queue.push(cb);
                  return null;
                },
                afterImpl: path_ === 'after' ? (cb) => { queue.push(cb); } : null,
                log: (line) => { logs.push(line); },
                errorLog: (line) => { errors.push(line); },
                ...(envelopeWriter ? { envelopeWriter } : {}),
              } as Parameters<typeof scheduleOrderConfirmationEmail>[1]);
              assert.equal(queue.length, 1, `${label}: exactly one scheduled run`);
              await queue.shift()!();
              await settle(() => logs.length + errors.length > 0, label);
              assert.ok(
                logs.some((line) => line.includes(`awaiting frozen dispatch for ${order.id}`)),
                `${label}: expected the benign awaiting log, got ${JSON.stringify({ logs, errors })}`,
              );
              assert.deepEqual(errors, [], `${label}: a frozen-state refusal is not an error`);
            }

            assert.equal(transport.calls(), 0, `${label} reached the transport`);
            assert.deepEqual(store.calls, [], `${label} touched the envelope store`);
            const after = writer === 'absent'
              ? JSON.stringify(await getOrderAuthoritative(order.id))
              : orderIo.bodyOf(order.id);
            assert.equal(after, before, `${label} mutated the record`);
          }
        }
      }
    }));
});

// ══ A3-4 R2 — the snapshot producer, pinned (GA-5 … GA-9, GA-13) ═══════════
//
// Every pin below is a pure checker over source text. The real-tree tests and
// the synthetic cases (GA-13) call the same functions, so a checker that has
// stopped seeing an offender is visible as a synthetic case that passed.

// ── Source tools ────────────────────────────────────────────────────────────

interface ImportStatement {
  kind: 'named' | 'type' | 'namespace' | 'default' | 'export-from' | 'side-effect' | 'dynamic' | 'require';
  specifier: string;
  statement: string;
  /** Braced specifiers as written; an inline `type X` keeps its `type ` prefix. */
  bindings: string[];
}

/** Every module edge in `source`: declarations, re-exports, side-effect,
 *  dynamic and `require` forms. */
function importStatementsIn(source: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  const declaration = /^[ \t]*(import|export)\s+(type\s+)?([^;()=]*?)\s+from\s+(['"])([^'"]+)\4/gm;
  for (const match of source.matchAll(declaration)) {
    const [statement, keyword, typeKeyword, clause, , specifier] = match;
    const braced = clause.match(/\{([\s\S]*?)\}/);
    const bindings = braced
      ? braced[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : [];
    let kind: ImportStatement['kind'];
    if (keyword === 'export') kind = 'export-from';
    else if (typeKeyword) kind = 'type';
    else if (/^\s*\{[\s\S]*\}\s*$/.test(clause)) kind = 'named';
    else if (/\*\s*as\s/.test(clause)) kind = 'namespace';
    else kind = 'default';
    out.push({ kind, specifier, statement, bindings });
  }
  for (const match of source.matchAll(/^[ \t]*import\s+(['"])([^'"]+)\1/gm)) {
    out.push({ kind: 'side-effect', specifier: match[2], statement: match[0], bindings: [] });
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    out.push({ kind: 'dynamic', specifier: match[2], statement: match[0], bindings: [] });
  }
  for (const match of source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    out.push({ kind: 'require', specifier: match[2], statement: match[0], bindings: [] });
  }
  return out;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countOf = (text: string, pattern: RegExp) => [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].length;

/**
 * Module-level declarations of `source`, by name: every `function` (to its
 * column-0 closing brace, which is how this repository formats a top-level
 * function — the equivalent of brace matching here) and every `const` (to the
 * first line that ends the statement at bracket depth zero).
 */
function moduleLevelDeclarations(source: string): Map<string, string> {
  const lines = source.split('\n');
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i += 1) {
    const fn = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (fn) {
      let j = i;
      while (j < lines.length && !/^}\s*$/.test(lines[j])) j += 1;
      out.set(fn[1], lines.slice(i, j + 1).join('\n'));
      continue;
    }
    const constant = lines[i].match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/);
    if (constant) {
      let depth = 0;
      let j = i;
      for (; j < lines.length; j += 1) {
        for (const ch of lines[j].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')) {
          if ('([{'.includes(ch)) depth += 1;
          else if (')]}'.includes(ch)) depth -= 1;
        }
        if (depth <= 0 && /;\s*$/.test(lines[j])) break;
      }
      out.set(constant[1], lines.slice(i, j + 1).join('\n'));
    }
  }
  return out;
}

/** The argument list of the call whose `(` is at `openIndex`. */
function callArguments(source: string, openIndex: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if ('([{'.includes(ch)) {
      depth += 1;
      if (depth === 1) continue;
    } else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return args;
}

// ── GA-7a: transition vocabulary ────────────────────────────────────────────

const PRODUCER_FORBIDDEN_LITERALS = [
  'DISPATCH_INTENT_RECORDED', 'ACCEPTED', 'RECONCILED_ACCEPTED', 'OWNER_AUTHORIZED_RESEND_SENT',
  'PROVABLY_PRE_DISPATCH_FAILED', 'dispatch_intent', 'provider_accepted', 'pre_dispatch_failure_proven',
  'ambiguous_outcome', 'receipt_failed', 'integrity_fence_failed', 'deadline_elapsed',
] as const;
const PRODUCER_REQUIRED_LITERALS = ['claim_acquired', 'snapshot_refused'] as const;

function producerVocabularyOffenders(source: string): string[] {
  const offenders: string[] = [];
  for (const literal of PRODUCER_FORBIDDEN_LITERALS) {
    if (new RegExp(`['"]${literal}['"]`).test(source)) offenders.push(`GA-7a: forbidden literal '${literal}'`);
  }
  for (const literal of PRODUCER_REQUIRED_LITERALS) {
    if (!new RegExp(`'${literal}'`).test(source)) offenders.push(`GA-7a: missing required literal '${literal}'`);
  }
  return offenders;
}

// ── GA-7b: the exact runtime import table ───────────────────────────────────

/** The modules the producer may reach at run time at all. The envelope-ref
 *  specifier is written only as a regex literal: B9 refuses a quoted one. */
const PRODUCER_RUNTIME_MODULES: readonly RegExp[] = [
  /^\.\/confirmation-email-envelope(?:\.ts)?$/,
  /^\.\/confirmation-email-state(?:\.ts)?$/,
  /^\.\/confirmation-envelope-config(?:\.ts)?$/,
  /^\.\/confirmation-envelope-store(?:\.ts)?$/,
  /^\.\/confirmation-envelope-ref(?:\.ts)?$/,
  /^\.\/blob-namespace(?:\.ts)?$/,
  /^\.\/orders(?:\.ts)?$/,
  /^\.\/order-email(?:\.ts)?$/,
];

interface ProducerImportRow {
  module: string;
  specifier: RegExp;
  bindings: string[];
}

const PRODUCER_RUNTIME_IMPORT_TABLE: ProducerImportRow[] = [
  { module: 'envelope', specifier: /^\.\/confirmation-email-envelope(?:\.ts)?$/, bindings: ['buildConfirmationEmailEnvelope'] },
  {
    module: 'state',
    specifier: /^\.\/confirmation-email-state(?:\.ts)?$/,
    bindings: ['classifyLegacyConfirmationRecord', 'evaluateConfirmationEmailTransition'],
  },
  {
    module: 'config',
    specifier: /^\.\/confirmation-envelope-config(?:\.ts)?$/,
    bindings: [
      'resolveConfirmationEnvelopeWriterConfig', 'resolveConfirmationEnvelopeWriterNamespace',
      'CONFIRMATION_ENVELOPE_ORDER_ID_RE', 'confirmationEnvelopeObjectPath',
    ],
  },
  { module: 'store', specifier: /^\.\/confirmation-envelope-store(?:\.ts)?$/, bindings: ['createConfirmationEnvelopeStore'] },
  { module: 'ref', specifier: /^\.\/confirmation-envelope-ref(?:\.ts)?$/, bindings: ['materializeConfirmationEmailEnvelopeRef'] },
  // GA-7e: the ambient namespace is read for comparison only.
  { module: 'blob-namespace', specifier: /^\.\/blob-namespace(?:\.ts)?$/, bindings: ['getBlobNamespace'] },
  // GA-7g: the NBT API and nothing else from the order module (D-49).
  {
    module: 'orders',
    specifier: /^\.\/orders(?:\.ts)?$/,
    bindings: ['bindOrderNamespace', 'orderRecordPathInNamespace', 'readOrderVersionedInNamespace', 'withOrderTransactionInNamespace'],
  },
  // GA-7f: the three rendering inputs are read at S3 only.
  {
    module: 'order-email',
    specifier: /^\.\/order-email(?:\.ts)?$/,
    bindings: ['buildOrderConfirmationEmail', 'buildOrderConfirmationIdempotencyKey', 'getOrderSenderEmail', 'getSupportEmail'],
  },
];

const NBT_BINDINGS = ['bindOrderNamespace', 'orderRecordPathInNamespace', 'readOrderVersionedInNamespace', 'withOrderTransactionInNamespace'];

function producerImportTableOffenders(source: string): string[] {
  const offenders: string[] = [];
  const perRow = new Map<ProducerImportRow, number>();
  for (const statement of importStatementsIn(source)) {
    if (statement.kind === 'type') continue;
    if (statement.kind !== 'named') {
      offenders.push(`GA-7b: runtime reach to ${statement.specifier} is not a named import declaration`);
      continue;
    }
    if (!PRODUCER_RUNTIME_MODULES.some((module) => module.test(statement.specifier))) {
      offenders.push(`GA-7b: the producer may not reach ${statement.specifier} at runtime`);
      continue;
    }
    const row = PRODUCER_RUNTIME_IMPORT_TABLE.find((candidate) => candidate.specifier.test(statement.specifier));
    if (!row) continue;
    perRow.set(row, (perRow.get(row) ?? 0) + 1);
    if (!sameBindings(statement.bindings, row.bindings)) {
      offenders.push(`GA-7b: ${row.module} bindings ${JSON.stringify(statement.bindings)} are not ${JSON.stringify(row.bindings)}`);
    }
  }
  for (const row of PRODUCER_RUNTIME_IMPORT_TABLE) {
    const count = perRow.get(row) ?? 0;
    if (count !== 1) offenders.push(`GA-7b: ${row.module} must be reached by exactly one runtime import, found ${count}`);
  }
  return offenders;
}

// ── GA-7c: no transport, deletion or listing reach ──────────────────────────

const PRODUCER_TRANSPORT_RE =
  /\bsendOrderConfirmationEmail\b|\bsendWithFallback\b|\bdispatchFrozenConfirmationRequest\b|\bResend\b|\bfetch\s*\(|\.delete\s*\(|\blist\s*\(/;

function producerTransportOffenders(source: string): string[] {
  const match = source.match(PRODUCER_TRANSPORT_RE);
  return match ? [`GA-7c: transport, deletion or listing reach: ${match[0]}`] : [];
}

// ── GA-7d: the synchronous, store-free, environment-free decision ───────────

const DECIDE_FORBIDDEN_RE =
  /\bawait\b|\basync\b|\bPromise\b|\.then\s*\(|\bstore\b|\.write\s*\(|\.read\s*\(|\.verifyStoredBytes\s*\(|\bDate\.now\b|new Date\s*\(|setTimeout|setImmediate/;
/** Closure members other than the decision itself may evaluate a deterministic
 *  `new Date(<instant>)` (enrollment clause 4); only the clock form is barred. */
const CLOSURE_MEMBER_FORBIDDEN_RE =
  /\bawait\b|\basync\b|\bPromise\b|\.then\s*\(|\bstore\b|\.write\s*\(|\.read\s*\(|\.verifyStoredBytes\s*\(|\bDate\.now\b|new Date\s*\(\s*\)|setTimeout|setImmediate/;
const CLOSURE_ENVIRONMENT_TOKENS = [
  'process.env', 'buildOrderConfirmationEmail', 'getSupportEmail', 'getOrderSenderEmail', 'getBlobNamespace',
  'resolveSender', 'createConfirmationEnvelopeStore', 'resolveConfirmationEnvelopeWriterConfig',
  'resolveConfirmationEnvelopeWriterNamespace',
];
/** Revision 4: the guard and NBT names. The CK-G guard is handed to the
 *  transaction by the S6 stage, never by the decision. */
const CLOSURE_BINDING_TOKENS = [
  'readBoundaryNamespace', 'boundaryAgrees', 'bindOrderNamespace', 'readOrderVersionedInNamespace',
  'withOrderTransactionInNamespace', 'snapshotTransact', 'guardedTransact', 'postTransportTransact',
];

function tokenPattern(tokens: readonly string[]): RegExp | null {
  if (tokens.length === 0) return null;
  return new RegExp(tokens.map((token) => `\\b${escapeRegExp(token)}\\b`).join('|'));
}

/** `decideSnapshotCommit` plus every module-level declaration it reaches by name. */
function decisionClosure(source: string): Map<string, string> {
  const declarations = moduleLevelDeclarations(source);
  const closure = new Map<string, string>();
  const decide = declarations.get('decideSnapshotCommit');
  if (decide === undefined) return closure;
  closure.set('decideSnapshotCommit', decide);
  const queue = ['decideSnapshotCommit'];
  while (queue.length > 0) {
    const text = closure.get(queue.shift()!)!;
    for (const [name, declaration] of declarations) {
      if (closure.has(name)) continue;
      if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text)) {
        closure.set(name, declaration);
        queue.push(name);
      }
    }
  }
  return closure;
}

const SNAPSHOT_CALLBACK_RE = [
  /^\(\s*latest(?:\s*:\s*[\w<>]+)?\s*\)\s*=>\s*decideSnapshotCommit\(\s*latest\s*,\s*evidence\s*,\s*ctx\s*\)$/,
  /^\(\s*latest(?:\s*:\s*[\w<>]+)?\s*\)\s*=>\s*\{\s*return\s+decideSnapshotCommit\(\s*latest\s*,\s*evidence\s*,\s*ctx\s*\);?\s*\}$/,
];

function decisionClosureOffenders(source: string): string[] {
  const offenders: string[] = [];
  if (countOf(source, /\bfunction\s+decideSnapshotCommit\b/) !== 1) {
    offenders.push('GA-7d: exactly one decideSnapshotCommit declaration is required');
  }
  if (!/^(?:export\s+)?function decideSnapshotCommit\(\s*latest\b[^,]*,\s*evidence\b[^,]*,\s*ctx\b/m.test(source)) {
    offenders.push('GA-7d: decideSnapshotCommit must be a module-level function of (latest, evidence, ctx)');
  }
  const environment = tokenPattern([...CLOSURE_ENVIRONMENT_TOKENS, ...CLOSURE_BINDING_TOKENS]);
  for (const [name, text] of decisionClosure(source)) {
    const timing = (name === 'decideSnapshotCommit' ? DECIDE_FORBIDDEN_RE : CLOSURE_MEMBER_FORBIDDEN_RE).exec(text);
    if (timing) offenders.push(`GA-7d: closure member ${name} matches ${timing[0]}`);
    const reach = environment?.exec(text);
    if (reach) offenders.push(`GA-7d: closure member ${name} matches ${reach[0]}`);
  }
  const calls = [...source.matchAll(/\bsnapshotTransact\s*\(/g)];
  if (calls.length === 0) offenders.push('GA-7d: no snapshotTransact( call');
  for (const call of calls) {
    const args = callArguments(source, call.index! + call[0].length - 1);
    const callback = (args[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!SNAPSHOT_CALLBACK_RE.some((pattern) => pattern.test(callback))) {
      offenders.push(`GA-7d: a snapshotTransact( callback is not one decideSnapshotCommit( expression: ${callback.slice(0, 80)}`);
    }
  }
  return offenders;
}

// ── GA-7e / GA-7f: one ambient namespace read, compared only; two env reads ─

/** The GA-7e call-site pins: one `getBlobNamespace(process.env)` inside
 *  `readBoundaryNamespace`, called only by the gate and the agreement check;
 *  one `bindOrderNamespace(` inside the gate, on the snapshot's namespace. */
function namespaceCallSiteOffenders(source: string, declarations: Map<string, string>): string[] {
  const offenders: string[] = [];
  const reader = declarations.get('readBoundaryNamespace') ?? '';
  const gate = declarations.get('resolveConfirmationEnvelopeWriter') ?? '';
  const agrees = declarations.get('boundaryAgrees') ?? '';

  if (countOf(source, /\bgetBlobNamespace\s*\(/) !== 1 || !reader.includes('getBlobNamespace(process.env)')) {
    offenders.push('GA-7e: the producer must hold exactly one getBlobNamespace( call, getBlobNamespace(process.env) in readBoundaryNamespace');
  }
  const callers = countOf(source, /\breadBoundaryNamespace\s*\(/) - countOf(source, /\bfunction\s+readBoundaryNamespace\s*\(/);
  const allowedCalls = countOf(gate, /\breadBoundaryNamespace\s*\(/) + countOf(agrees, /\breadBoundaryNamespace\s*\(/);
  if (callers !== allowedCalls || countOf(gate, /\breadBoundaryNamespace\s*\(/) < 1 || countOf(agrees, /\breadBoundaryNamespace\s*\(/) < 1) {
    offenders.push('GA-7e: readBoundaryNamespace( may be called only by resolveConfirmationEnvelopeWriter and boundaryAgrees');
  }
  if (
    countOf(source, /\bbindOrderNamespace\s*\(/) !== 1
    || !gate.includes('bindOrderNamespace(ns.namespace)')
    || !/const ns = resolveConfirmationEnvelopeWriterNamespace\(snapshot\)/.test(gate)
  ) {
    offenders.push('GA-7e: exactly one bindOrderNamespace(ns.namespace), in the gate, on the frozen snapshot namespace');
  }
  return offenders;
}

function namespaceSourceOffenders(source: string): string[] {
  const offenders: string[] = [];
  const declarations = moduleLevelDeclarations(source);
  offenders.push(...namespaceCallSiteOffenders(source, declarations));
  const ambient = source.match(/\bwithBlobNamespace\b|\bapplyBlobNamespace\b|\bgetOrderBlobPath\b/);
  if (ambient) offenders.push(`GA-7e: ambient namespace or path token ${ambient[0]}`);
  if (!/namespace:\s*writer\.namespace\b/.test(declarations.get('freezeSnapshotFrame') ?? '')) {
    offenders.push('GA-7e: the frozen frame must take its namespace from the armed writer');
  }

  // GA-7f: the environment is read in exactly two places.
  const reader = declarations.get('readBoundaryNamespace') ?? '';
  const gate = declarations.get('resolveConfirmationEnvelopeWriter') ?? '';
  if (
    countOf(source, /\bprocess\.env\b/) !== 2
    || !reader.includes('getBlobNamespace(process.env)')
    || !gate.includes('writerDeps?.env ?? process.env')
  ) {
    offenders.push('GA-7f: process.env must appear exactly twice: the boundary read and the supplied-environment default');
  }
  const frame = declarations.get('freezeSnapshotFrame') ?? '';
  for (const name of ['buildOrderConfirmationEmail', 'getOrderSenderEmail', 'getSupportEmail']) {
    const call = new RegExp(`\\b${name}\\s*\\(`);
    if (countOf(source, call) !== 1 || countOf(frame, call) !== 1) {
      offenders.push(`GA-7f: ${name}( must be called exactly once, inside freezeSnapshotFrame`);
    }
  }
  return offenders;
}

// ── GA-7g: the bound order I/O ──────────────────────────────────────────────

const BOUND_ORDER_IO_MEMBERS = ['read', 'snapshotTransact', 'guardedTransact', 'postTransportTransact', 'beforeTransport', 'classifyFault'];

function boundOrderIoOffenders(source: string): string[] {
  const offenders: string[] = [];
  const declarations = moduleLevelDeclarations(source);
  const io = declarations.get('createBoundOrderIo');
  if (io === undefined) return ['GA-7g: createBoundOrderIo is missing'];

  // The raw NBT entry points appear only in the order import and in createBoundOrderIo.
  let outside = source.replace(io, '');
  for (const statement of importStatementsIn(source)) {
    if (/^\.\/orders(?:\.ts)?$/.test(statement.specifier)) outside = outside.replace(statement.statement, '');
  }
  const leaked = outside.match(/\b(?:readOrderVersionedInNamespace|withOrderTransactionInNamespace)\b/);
  if (leaked) offenders.push(`GA-7g: ${leaked[0]} is referenced outside createBoundOrderIo`);

  const literalStart = io.indexOf('return Object.freeze({');
  const literal = literalStart === -1 ? '' : io.slice(literalStart);
  const members = [...literal.matchAll(/^ {4}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => ({ name: match[1], at: match.index! }));
  if (!sameBindings(members.map((member) => member.name), BOUND_ORDER_IO_MEMBERS)) {
    offenders.push(`GA-7g: createBoundOrderIo must return exactly ${BOUND_ORDER_IO_MEMBERS.join(', ')}`);
  }
  const segment = (name: string) => {
    const index = members.findIndex((member) => member.name === name);
    if (index === -1) return '';
    return literal.slice(members[index].at, index + 1 < members.length ? members[index + 1].at : undefined);
  };

  if (countOf(source, /\bbeforeCommit\s*:/) !== 2) offenders.push('GA-7g: beforeCommit: must appear exactly twice');
  for (const name of ['snapshotTransact', 'guardedTransact']) {
    if (!/\bbeforeCommit:\s*guard\b/.test(segment(name))) offenders.push(`GA-7g: ${name} must pass beforeCommit: guard`);
  }
  if (/\bbeforeCommit\b/.test(segment('postTransportTransact'))) {
    offenders.push('GA-7g: postTransportTransact must pass no beforeCommit');
  }

  for (const name of ['read', 'snapshotTransact', 'guardedTransact', 'postTransportTransact']) {
    const text = segment(name);
    const verify = text.search(/\bverifyOrderProvenance\(\s*r\.provenance\b/);
    if (countOf(text, /\braw\.(?:read|transact)\s*\(/) !== 1 || verify === -1) {
      offenders.push(`GA-7g: ${name} must pass its one raw result to verifyOrderProvenance( before use`);
      continue;
    }
    const used = text.search(/\br\.found\.order\b|\br\.result\b/);
    if (used !== -1 && used < verify) offenders.push(`GA-7g: ${name} uses its raw result before verifyOrderProvenance(`);
  }
  if (!segment('read').includes("const expectedOutcome = r.found === null ? 'not_found' : 'read';")
    || !/verifyOrderProvenance\(\s*r\.provenance\s*,\s*expectedOutcome\b/.test(segment('read'))) {
    offenders.push('GA-7g: read must derive its expected provenance outcome from the result it received');
  }
  if (/verifyOrderProvenance\(\s*r\.provenance\s*,\s*'read'/.test(source)) {
    offenders.push("GA-7g: read passes the literal 'read' unconditionally (the Revision-4A contradiction)");
  }
  const ambient = source.match(/\bwithOrderTransaction\b|\breadOrderVersioned\b|\bcommitOrderConditional\b|\bgetOrder\b|\bgetOrderAuthoritative\b/);
  if (ambient) offenders.push(`GA-7g: the producer references the ambient order API ${ambient[0]}`);
  return offenders;
}

// ── GA-8 / GA-9: store importers and the delivery pins ──────────────────────

const STORE_SPECIFIER_RE = /confirmation-envelope-store(?:\.ts)?$/;
const CONFIG_SPECIFIER_RE = /confirmation-envelope-config(?:\.ts)?$/;
const PRODUCER_SPECIFIER_RE = /confirmation-envelope-producer(?:\.ts)?$/;

function storeImporterOffenders(file: string, source: string): string[] {
  if (file === PRODUCER || CANDIDATE_TESTS.has(file)) return [];
  return importStatementsIn(source)
    .filter((statement) => STORE_SPECIFIER_RE.test(statement.specifier))
    .map((statement) => `${file} -> ${statement.specifier} (${statement.kind})`);
}

const DELIVERY_PRODUCER_BINDINGS = ['resolveConfirmationEnvelopeWriter', 'snapshotConfirmationEnvelope'];
const DELIVERY_ORDER_BINDINGS = ['getOrderAuthoritative', 'withOrderTransaction'];

/** GA-9: one named runtime import of the producer's two entry points, no store
 *  or config reach, no namespace or environment read. */
function deliveryProducerImportOffenders(source: string): string[] {
  const offenders: string[] = [];
  const statements = importStatementsIn(source);
  const producerEdges = statements.filter((statement) => PRODUCER_SPECIFIER_RE.test(statement.specifier));
  const runtime = producerEdges.filter((statement) => statement.kind !== 'type');
  if (runtime.length !== 1 || runtime[0].kind !== 'named' || !sameBindings(runtime[0].bindings, DELIVERY_PRODUCER_BINDINGS)) {
    offenders.push(`GA-9: delivery must import exactly ${DELIVERY_PRODUCER_BINDINGS.join(', ')} from the producer, once`);
  }
  if (countOf(source, /['"][^'"]*confirmation-envelope-producer(?:\.ts)?['"]/) !== producerEdges.length) {
    offenders.push('GA-9: delivery names the producer module outside its import statements');
  }
  for (const statement of statements) {
    if (STORE_SPECIFIER_RE.test(statement.specifier) || CONFIG_SPECIFIER_RE.test(statement.specifier)) {
      offenders.push(`GA-9: delivery reaches ${statement.specifier}`);
    }
  }
  const ambient = source.match(/\bgetBlobNamespace\b|\bwithBlobNamespace\b|\bprocess\.env\b/);
  if (ambient) offenders.push(`GA-9: delivery reads ${ambient[0]}`);
  return offenders;
}

/** GA-9 / GA-7g: delivery's runtime order bindings stay the writer-off pair. */
function deliveryOrderBindingOffenders(source: string): string[] {
  const runtime = importStatementsIn(source).filter(
    (statement) => /^\.\/orders(?:\.ts)?$/.test(statement.specifier) && statement.kind !== 'type',
  );
  const bindings = runtime.flatMap((statement) => statement.bindings.filter((binding) => !binding.startsWith('type ')));
  const offenders: string[] = [];
  if (runtime.length !== 1 || !sameBindings(bindings, DELIVERY_ORDER_BINDINGS)) {
    offenders.push(`GA-9: delivery's runtime order bindings are ${JSON.stringify(bindings)}, not ${JSON.stringify(DELIVERY_ORDER_BINDINGS)}`);
  }
  for (const binding of NBT_BINDINGS) {
    if (new RegExp(`\\b${binding}\\b`).test(source)) offenders.push(`GA-9: delivery names the NBT binding ${binding}`);
  }
  return offenders;
}

// ── Real-tree pins ──────────────────────────────────────────────────────────

test('A3-4 R2 GA-5 (GD-13): every candidate exemption is a test file, and none shadows a production pin', () => {
  assert.deepEqual(candidateTestShapeOffenders(CANDIDATE_TESTS), []);
  const pinned = new Set([...Object.keys(RUNTIME_IMPORT_ALLOWLIST), ...Object.keys(RECORD_FIELD_GRANTS)]);
  assert.deepEqual([...CANDIDATE_TESTS].filter((entry) => pinned.has(entry)), []);
  assert.ok(CANDIDATE_TESTS.has('tests/confirmation-envelope-producer.test.ts'));
  // NBT-R1's explicit permission for its suite is preserved, not revoked.
  assert.ok(CANDIDATE_TESTS.has('tests/order-transaction-namespace-binding.test.ts'));
});

test('A3-4 R2 GA-6 (GD-2): the producer names exactly its granted fields and reaches the model twice', () => {
  const source = readRepoFile(PRODUCER);
  for (const field of ['confirmationEmailState', 'confirmationEmailHoldReason', CONFIRMATION_REF_FIELD]) {
    assert.equal(namesRecordField(source, field), true, `the producer must name ${field}`);
  }
  for (const field of NEW_RECORD_FIELDS) {
    if (field === 'confirmationEmailState' || field === 'confirmationEmailHoldReason') continue;
    assert.equal(namesRecordField(source, field), false, `the producer must not name ${field}`);
  }
  const refs = findModuleReferences(PRODUCER);
  assert.equal(refs.filter((ref) => !ref.typeOnly).length, 2, 'exactly two runtime references to the model modules');
  assert.deepEqual(runtimeReachOffenders(PRODUCER, refs), []);
  assert.deepEqual(fieldNameOffenders(PRODUCER, source), []);
});

test('A3-4 R2 GA-7a (GD-3): the producer carries no dispatch vocabulary and both of its own events', () => {
  assert.deepEqual(producerVocabularyOffenders(readRepoFile(PRODUCER)), []);
});

test('A3-4 R2 GA-7b (GD-4): the producer runtime import table is exact', () => {
  assert.deepEqual(producerImportTableOffenders(readRepoFile(PRODUCER)), []);
});

test('A3-4 R2 GA-7c (GD-5): the producer has no transport, deletion or listing reach', () => {
  assert.deepEqual(producerTransportOffenders(readRepoFile(PRODUCER)), []);
});

test('A3-4 R2 GA-8 (GD-6): only the producer and the candidate suites import the envelope store', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) offenders.push(...storeImporterOffenders(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('A3-4 R2 GA-9 (GD-7): the delivery module reaches the producer through one pinned import', () => {
  assert.deepEqual(deliveryProducerImportOffenders(readRepoFile(DELIVERY)), []);
});

test('A3-4 R2 GA-7d (GD-15): the decision closure is synchronous, store-free and environment-free', () => {
  const source = readRepoFile(PRODUCER);
  assert.deepEqual(decisionClosureOffenders(source), []);
  assert.ok(decisionClosure(source).size > 1, 'the closure must have been computed, not just the root');
});

test('A3-4 R2 GA-7e (GD-16): one ambient namespace read, compared only, and one binding', () => {
  assert.deepEqual(namespaceSourceOffenders(readRepoFile(PRODUCER)).filter((o) => o.startsWith('GA-7e')), []);
});

test('A3-4 R2 GA-7f (GD-17): two environment reads, one render, one sender, one support address', () => {
  assert.deepEqual(namespaceSourceOffenders(readRepoFile(PRODUCER)).filter((o) => o.startsWith('GA-7f')), []);
});

test('A3-4 R2 GA-7g (GD-18): the bound order I/O shape, and the order bindings of producer and delivery', () => {
  const producer = readRepoFile(PRODUCER);
  assert.deepEqual(boundOrderIoOffenders(producer), []);
  const ordersRow = PRODUCER_RUNTIME_IMPORT_TABLE.find((row) => row.module === 'orders');
  assert.ok(ordersRow, 'GA-7b must keep its orders row');
  assert.equal(sameBindings(ordersRow.bindings, NBT_BINDINGS), true, 'the orders row is exactly the NBT API');
  assert.deepEqual(producerImportTableOffenders(producer).filter((o) => o.includes('orders')), []);
  assert.deepEqual(deliveryOrderBindingOffenders(readRepoFile(DELIVERY)), []);
});

// ── GA-13: synthetic cases (pure checker self-tests) ────────────────────────
//
// A compliant model producer, then one mutation per case. The model passes
// every checker; each case must be reported by the checker named for it. The
// ref specifier is assembled so this file holds no quoted ref-module string.

const MODEL_REF_SPECIFIER = ['./confirmation-envelope', 'ref.ts'].join('-');

const MODEL_PRODUCER = `
import { buildConfirmationEmailEnvelope } from './confirmation-email-envelope.ts';
import { classifyLegacyConfirmationRecord, evaluateConfirmationEmailTransition } from './confirmation-email-state.ts';
import {
  CONFIRMATION_ENVELOPE_ORDER_ID_RE,
  confirmationEnvelopeObjectPath,
  resolveConfirmationEnvelopeWriterConfig,
  resolveConfirmationEnvelopeWriterNamespace,
} from './confirmation-envelope-config.ts';
import { createConfirmationEnvelopeStore } from './confirmation-envelope-store.ts';
import { materializeConfirmationEmailEnvelopeRef } from '${MODEL_REF_SPECIFIER}';
import { getBlobNamespace } from './blob-namespace.ts';
import {
  bindOrderNamespace,
  orderRecordPathInNamespace,
  readOrderVersionedInNamespace,
  withOrderTransactionInNamespace,
} from './orders.ts';
import {
  buildOrderConfirmationEmail,
  buildOrderConfirmationIdempotencyKey,
  getOrderSenderEmail,
  getSupportEmail,
} from './order-email.ts';
import type { OrderRecord } from './orders.ts';

function readBoundaryNamespace() {
  try {
    return { ok: true, namespace: getBlobNamespace(process.env) };
  } catch {
    return { ok: false };
  }
}

function boundaryAgrees(namespace) {
  const boundary = readBoundaryNamespace();
  return boundary.ok === true && boundary.namespace === namespace;
}

function verifyOrderProvenance(p, expectedOutcome, expected) {
  if (p.outcome !== expectedOutcome || p.namespace !== expected.namespace) throw new Error('mismatch');
}

function createBoundOrderIo(binding, injected, namespace) {
  const raw = injected ?? { read: readOrderVersionedInNamespace, transact: withOrderTransactionInNamespace };
  const guard = () => boundaryAgrees(namespace);
  const expectedFor = (orderId) => ({ namespace, recordPath: orderRecordPathInNamespace(binding, orderId) });
  return Object.freeze({
    read: async (orderId) => {
      const r = await raw.read(binding, orderId);
      const expectedOutcome = r.found === null ? 'not_found' : 'read';
      verifyOrderProvenance(r.provenance, expectedOutcome, expectedFor(orderId));
      return r.found === null ? null : r.found.order;
    },
    snapshotTransact: async (orderId, mutate) => {
      const r = await raw.transact(binding, orderId, mutate, { notFound: () => null, beforeCommit: guard });
      verifyOrderProvenance(r.provenance, r.status, expectedFor(orderId));
      return r.result;
    },
    guardedTransact: async (orderId, mutate, opts) => {
      const r = await raw.transact(binding, orderId, mutate, { notFound: opts.notFound, beforeCommit: guard });
      verifyOrderProvenance(r.provenance, r.status, expectedFor(orderId));
      return r.result;
    },
    postTransportTransact: async (orderId, mutate, opts) => {
      const r = await raw.transact(binding, orderId, mutate, { notFound: opts.notFound });
      verifyOrderProvenance(r.provenance, r.status, expectedFor(orderId));
      return r.result;
    },
    beforeTransport: () => (guard() ? null : 'namespace_drift'),
    classifyFault: () => null,
  });
}

export function resolveConfirmationEnvelopeWriter(writerDeps) {
  const supplied = writerDeps?.env ?? process.env;
  if (supplied.HSB_CONFIRMATION_ENVELOPE_WRITER !== 'true') return { kind: 'off' };
  const snapshot = Object.freeze({ ...supplied });
  const ns = resolveConfirmationEnvelopeWriterNamespace(snapshot);
  if (ns.ok !== true) return { kind: 'refused', reason: 'namespace_invalid' };
  const boundary = readBoundaryNamespace();
  if (!(boundary.ok === true && boundary.namespace === ns.namespace)) return { kind: 'refused', reason: 'namespace_disagreement' };
  const bound = bindOrderNamespace(ns.namespace);
  if (bound.ok !== true) return { kind: 'refused', reason: 'order_binding_invalid' };
  const orderIo = createBoundOrderIo(bound.binding, writerDeps?.orderIo, ns.namespace);
  const config = resolveConfirmationEnvelopeWriterConfig(snapshot);
  if (config.armed !== true) return { kind: 'disarmed', reason: config.reason, orderIo };
  const created = createConfirmationEnvelopeStore(snapshot, writerDeps.storeIo);
  return { kind: 'armed', writer: { namespace: ns.namespace, epochMs: config.epochMs, store: created.value }, orderIo };
}

function isConfirmationEnvelopeEnrolled(order, epochMs) {
  if (!CONFIRMATION_ENVELOPE_ORDER_ID_RE.test(order.id)) return false;
  if (order.confirmationEmailState !== null && order.confirmationEmailState !== undefined) return false;
  const paidAtMs = Date.parse(order.paidAt);
  return Number.isFinite(paidAtMs) && new Date(paidAtMs).toISOString() === order.paidAt && paidAtMs >= epochMs;
}

function freezeSnapshotFrame(observed, writer, nowIso) {
  const from = getOrderSenderEmail();
  const supportEmail = getSupportEmail();
  const render = buildOrderConfirmationEmail(observed, { supportEmail });
  return {
    params: { createdAt: nowIso, from, supportEmail, namespace: writer.namespace },
    render,
    idempotencyKey: buildOrderConfirmationIdempotencyKey(observed),
  };
}

function rebuildCandidate(latest, candidate) {
  const built = buildConfirmationEmailEnvelope({ orderId: latest.id, request: candidate.render });
  const objectPath = confirmationEnvelopeObjectPath(latest.id, candidate.params.namespace);
  return materializeConfirmationEmailEnvelopeRef({ built, objectPath }, { orderId: latest.id, namespace: candidate.params.namespace });
}

function decideSnapshotCommit(latest, evidence, ctx) {
  const blocked = ctx.evaluateClaimability(latest);
  if (blocked) return { abort: { status: 'blocked', reason: blocked } };
  if (!isConfirmationEnvelopeEnrolled(latest, ctx.epochMs)) return { abort: { status: 'snapshot_deferred', reason: 'record_changed' } };
  const legacyClass = classifyLegacyConfirmationRecord(latest, { t193AtMs: ctx.epochMs });
  const decision = evidence.kind === 'object_written'
    ? evaluateConfirmationEmailTransition({ from: null, event: 'claim_acquired', actor: 'worker', legacyClass })
    : evaluateConfirmationEmailTransition({ from: null, event: 'snapshot_refused', actor: 'worker' });
  const ref = rebuildCandidate(latest, evidence.candidate);
  return {
    commit: { ...latest, confirmationEmailState: decision.to, confirmationEmailHoldReason: decision.holdReason, updatedAt: ctx.nowIso },
    result: { status: 'snapshotted', ref },
  };
}

async function runSnapshotCommitStage(orderId, evidence, ctx, gate) {
  if (!boundaryAgrees(gate.writer.namespace)) return { status: 'snapshot_deferred', reason: 'namespace_drift' };
  return gate.orderIo.snapshotTransact(orderId, (latest) => decideSnapshotCommit(latest, evidence, ctx));
}

export async function snapshotConfirmationEnvelope(observed, gate, opts) {
  const ctx = { epochMs: gate.writer.epochMs, nowIso: new Date(opts.nowMs).toISOString(), evaluateClaimability: opts.evaluateClaimability };
  const frame = freezeSnapshotFrame(observed, gate.writer, ctx.nowIso);
  if (!boundaryAgrees(gate.writer.namespace)) return { status: 'snapshot_deferred', reason: 'namespace_drift' };
  await gate.writer.store.write(observed.id, JSON.stringify(frame));
  return runSnapshotCommitStage(observed.id, { kind: 'object_written', candidate: frame }, ctx, gate);
}
`;

/** One mutation of a source text; refuses to report a no-op as a case. */
function variant(source: string, find: string, replace: string): string {
  assert.ok(source.includes(find), `synthetic mutation anchor not found: ${find.slice(0, 60)}`);
  return source.replace(find, replace);
}

const MODEL_STATE_IMPORT =
  "import { classifyLegacyConfirmationRecord, evaluateConfirmationEmailTransition } from './confirmation-email-state.ts';";
const MODEL_ENVELOPE_IMPORT = "import { buildConfirmationEmailEnvelope } from './confirmation-email-envelope.ts';";
const MODEL_DECIDE_ANCHOR = "  const ref = rebuildCandidate(latest, evidence.candidate);";
const MODEL_FRAME_ANCHOR = '  const supportEmail = getSupportEmail();';

/** Every checker, on one producer source. */
function allProducerOffenders(source: string): string[] {
  return [
    ...runtimeReachOffenders(PRODUCER, findModuleReferencesIn(PRODUCER, source)),
    ...fieldNameOffenders(PRODUCER, source),
    ...producerVocabularyOffenders(source),
    ...producerImportTableOffenders(source),
    ...producerTransportOffenders(source),
    ...decisionClosureOffenders(source),
    ...namespaceSourceOffenders(source),
    ...boundOrderIoOffenders(source),
  ];
}

const producerReach = (source: string) => runtimeReachOffenders(PRODUCER, findModuleReferencesIn(PRODUCER, source));

test('A3-4 R2 GA-13 (GD-12): the compliant model producer passes every checker', () => {
  assert.deepEqual(allProducerOffenders(MODEL_PRODUCER), []);
  assert.ok(decisionClosure(MODEL_PRODUCER).has('isConfirmationEnvelopeEnrolled'), 'the model closure reaches its helpers');
});

test('A3-4 R2 GA-13 XR-1: the producer reaching the state module for the held set is an offender', () => {
  const source = variant(MODEL_PRODUCER, 'evaluateConfirmationEmailTransition } from', 'evaluateConfirmationEmailTransition, isConfirmationEmailHeldState } from');
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XR-2: the producer reaching the envelope digest is an offender', () => {
  const source = variant(MODEL_PRODUCER, 'buildConfirmationEmailEnvelope } from', 'buildConfirmationEmailEnvelope, digestConfirmationRequest } from');
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XR-3: an envelope binding imported from the state specifier is an offender', () => {
  const source = variant(MODEL_PRODUCER, MODEL_ENVELOPE_IMPORT, "import { buildConfirmationEmailEnvelope } from './confirmation-email-state.ts';");
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XR-4: a namespace import of the state module is an offender', () => {
  const source = variant(MODEL_PRODUCER, MODEL_STATE_IMPORT, `${MODEL_STATE_IMPORT}\nimport * as m from './confirmation-email-state.ts';`);
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XR-5: a re-export of the state bindings is an offender (GA-2)', () => {
  const source = variant(
    MODEL_PRODUCER,
    MODEL_STATE_IMPORT,
    "export { classifyLegacyConfirmationRecord, evaluateConfirmationEmailTransition } from './confirmation-email-state.ts';",
  );
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XR-6: a dynamic import of the state module is an offender (GA-2)', () => {
  const source = variant(
    MODEL_PRODUCER,
    MODEL_STATE_IMPORT,
    "const { classifyLegacyConfirmationRecord, evaluateConfirmationEmailTransition } = await import('./confirmation-email-state.ts');",
  );
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XR-7: an inline type inside the runtime import is an extra binding', () => {
  const source = variant(MODEL_PRODUCER, 'evaluateConfirmationEmailTransition } from', 'evaluateConfirmationEmailTransition, type ConfirmationEmailHoldReason } from');
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XR-8: the producer state grant does not extend to the sweep', () => {
  assert.notDeepEqual(runtimeReachOffenders(SWEEP, findModuleReferencesIn(SWEEP, MODEL_STATE_IMPORT)), []);
});

test('A3-4 R2 GA-13 XR-9: delivery reaching the legacy classifier is an offender', () => {
  const source = "import { isConfirmationEmailHeldState, classifyLegacyConfirmationRecord } from './confirmation-email-state.ts';";
  assert.notDeepEqual(runtimeReachOffenders(DELIVERY, findModuleReferencesIn(DELIVERY, source)), []);
  assert.deepEqual(runtimeReachOffenders(DELIVERY, findModuleReferences(DELIVERY)), [], 'control: the real delivery module');
});

test('A3-4 R2 GA-13 XR-10: two producer statements against the state specifier are an offender', () => {
  const source = variant(MODEL_PRODUCER, MODEL_STATE_IMPORT, `${MODEL_STATE_IMPORT}\n${MODEL_STATE_IMPORT}`);
  assert.notDeepEqual(producerReach(source), []);
});

test('A3-4 R2 GA-13 XF-1: the producer naming the dispatch-intent marker is an offender', () => {
  const source = variant(MODEL_PRODUCER, MODEL_DECIDE_ANCHOR, `  const marker = latest.confirmationEmailFirstDispatchIntentAt;\n${MODEL_DECIDE_ANCHOR}`);
  assert.notDeepEqual(fieldNameOffenders(PRODUCER, source), []);
});

test('A3-4 R2 GA-13 XF-2: the producer naming the retired inline envelope is an offender', () => {
  const source = variant(MODEL_PRODUCER, MODEL_DECIDE_ANCHOR, `  const retired = { confirmationEmailEnvelope: null };\n${MODEL_DECIDE_ANCHOR}`);
  assert.notDeepEqual(fieldNameOffenders(PRODUCER, source), []);
});

test('A3-4 R2 GA-13 XF-3: the kickoff naming the hold reason is an offender', () => {
  assert.notDeepEqual(fieldNameOffenders(KICKOFF, 'log(order.confirmationEmailHoldReason);'), []);
});

test('A3-4 R2 GA-13 XF-4: the kickoff naming the envelope ref is an offender', () => {
  assert.notDeepEqual(fieldNameOffenders(KICKOFF, 'log(order.confirmationEmailEnvelopeRef);'), []);
});

test('A3-4 R2 GA-13 XS-1: delivery importing the envelope store is an offender', () => {
  const store = ['./confirmation-envelope', 'store.ts'].join('-');
  assert.notDeepEqual(storeImporterOffenders(DELIVERY, `import { createConfirmationEnvelopeStore } from '${store}';`), []);
  assert.deepEqual(storeImporterOffenders(DELIVERY, readRepoFile(DELIVERY)), [], 'control: the real delivery module');
});

test('A3-4 R2 GA-13 XC-1: a source path in CANDIDATE_TESTS fails the shape assertion', () => {
  assert.notDeepEqual(candidateTestShapeOffenders(new Set([...CANDIDATE_TESTS, PRODUCER])), []);
});

test('A3-4 R2 GA-13 XN-1: a second, zero-argument getBlobNamespace() at S3 is an offender', () => {
  const source = variant(MODEL_PRODUCER, MODEL_FRAME_ANCHOR, `${MODEL_FRAME_ANCHOR}\n  const ambientNamespace = getBlobNamespace();`);
  assert.ok(namespaceSourceOffenders(source).some((o) => o.startsWith('GA-7e: the producer must hold exactly one getBlobNamespace(')));
});

test('A3-4 R2 GA-13 XE-1: a decision helper that renders is an offender', () => {
  let source = variant(MODEL_PRODUCER, MODEL_DECIDE_ANCHOR, `  const rendered = renderAgain(latest);\n${MODEL_DECIDE_ANCHOR}`);
  source = `${source}\nfunction renderAgain(order) {\n  return buildOrderConfirmationEmail(order, {});\n}\n`;
  assert.ok(decisionClosureOffenders(source).some((o) => o.startsWith('GA-7d: closure member renderAgain ')));
});

test('A3-4 R2 GA-13 XE-2: a decision helper that reads the public URL is an offender', () => {
  let source = variant(MODEL_PRODUCER, MODEL_DECIDE_ANCHOR, `  const site = publicUrl();\n${MODEL_DECIDE_ANCHOR}`);
  source = `${source}\nfunction publicUrl() {\n  return process.env.NEXT_PUBLIC_URL;\n}\n`;
  assert.ok(decisionClosureOffenders(source).some((o) => o.startsWith('GA-7d: closure member publicUrl ')));
  assert.ok(namespaceSourceOffenders(source).some((o) => o.startsWith('GA-7f')));
});

test('A3-4 R2 GA-13 XN-2: the ambient order transaction at S6 is an offender', () => {
  let source = variant(MODEL_PRODUCER, '  bindOrderNamespace,\n', '  bindOrderNamespace,\n  withOrderTransaction,\n');
  source = variant(source, 'gate.orderIo.snapshotTransact(orderId,', 'withOrderTransaction(orderId,');
  assert.ok(producerImportTableOffenders(source).some((o) => o.startsWith('GA-7b: orders bindings')));
  assert.ok(boundOrderIoOffenders(source).some((o) => o.includes('ambient order API withOrderTransaction')));
});

test('A3-4 R2 GA-13 XN-3: a guardedTransact without beforeCommit is an offender', () => {
  const source = variant(
    MODEL_PRODUCER,
    '{ notFound: opts.notFound, beforeCommit: guard }',
    '{ notFound: opts.notFound }',
  );
  assert.ok(boundOrderIoOffenders(source).some((o) => o.includes('guardedTransact must pass beforeCommit')));
});

test('A3-4 R2 GA-13 XN-4: a second binding of the ambient namespace at S6 is an offender', () => {
  const source = variant(
    MODEL_PRODUCER,
    "  if (!boundaryAgrees(gate.writer.namespace)) return { status: 'snapshot_deferred', reason: 'namespace_drift' };\n  return gate.orderIo",
    "  const ambient = readBoundaryNamespace();\n  const rebound = bindOrderNamespace(ambient.namespace);\n  return gate.orderIo",
  );
  assert.ok(namespaceSourceOffenders(source).some((o) => o.includes('bindOrderNamespace(ns.namespace)')));
  assert.ok(namespaceSourceOffenders(source).some((o) => o.includes('readBoundaryNamespace( may be called only')));
});

test('A3-4 R2 GA-13 XN-5: a decision helper that calls the agreement check is an offender', () => {
  let source = variant(MODEL_PRODUCER, MODEL_DECIDE_ANCHOR, `  const agreed = stillAgrees(ctx.namespace);\n${MODEL_DECIDE_ANCHOR}`);
  source = `${source}\nfunction stillAgrees(namespace) {\n  return boundaryAgrees(namespace);\n}\n`;
  assert.ok(decisionClosureOffenders(source).some((o) => o.startsWith('GA-7d: closure member stillAgrees ')));
});

test('A3-4 R2 GA-13 XN-6: a read that passes the literal read outcome is an offender', () => {
  const source = variant(
    MODEL_PRODUCER,
    'verifyOrderProvenance(r.provenance, expectedOutcome, expectedFor(orderId));',
    "verifyOrderProvenance(r.provenance, 'read', expectedFor(orderId));",
  );
  assert.ok(boundOrderIoOffenders(source).some((o) => o.includes("literal 'read' unconditionally")));
  // Control, once the producer exists: the real read derives its outcome (D-55).
  if (existsSync(path.join(REPO_ROOT, PRODUCER))) {
    assert.deepEqual(boundOrderIoOffenders(readRepoFile(PRODUCER)).filter((o) => o.includes("literal 'read'")), []);
  }
});

// ══ A3-5 — the frozen dispatcher, pinned (GD-1 … GD-5, RL-2, RL-3) ═════════
//
// Pure checkers over source text, each also run on a synthetic offender so a
// checker that has stopped seeing its offender fails here.

const ORDER_EMAIL = 'src/lib/order-email.ts';
const FROZEN_TRANSPORT_FN = 'dispatchFrozenConfirmationRequest';

/** I5-2: what the frozen transport may never reach, directly or through a helper. */
const FROZEN_TRANSPORT_FORBIDDEN = [
  'sendWithFallback', 'getSupportEmail', 'getOrderSenderEmail', 'getFallbackSenderEmail',
  'buildOrderConfirmationEmail', 'assertResendSuccess', 'formatActionableError', 'order',
  'buildOrderConfirmationIdempotencyKey', 'sendOrderConfirmationEmail',
];

/**
 * GD-1. The identifiers reachable from `root` in `source`: its own body, plus
 * every module-level function or const it names, transitively. AST-based, so a
 * name in a comment or a string is not a reference.
 */
function reachableIdentifiers(source: string, root: string): { found: boolean; names: Set<string>; envReads: Set<string> } {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const topLevel = new Map<string, ts.Node>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) topLevel.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) topLevel.set(declaration.name.text, declaration);
      }
    }
  }
  const names = new Set<string>();
  const envReads = new Set<string>();
  const start = topLevel.get(root);
  if (!start) return { found: false, names, envReads };
  const queue: ts.Node[] = [start];
  const seen = new Set<ts.Node>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const visit = (child: ts.Node) => {
      if (ts.isIdentifier(child)) {
        names.add(child.text);
        const target = topLevel.get(child.text);
        if (target && !seen.has(target)) queue.push(target);
      }
      if (ts.isPropertyAccessExpression(child) && child.expression.getText(file) === 'process.env') envReads.add(child.name.text);
      if (ts.isElementAccessExpression(child) && child.expression.getText(file) === 'process.env') {
        envReads.add(ts.isStringLiteral(child.argumentExpression) ? child.argumentExpression.text : '<computed>');
      }
      if (ts.isVariableDeclaration(child) && ts.isObjectBindingPattern(child.name) && child.initializer?.getText(file) === 'process.env') {
        envReads.add('<destructured>');
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
  }
  return { found: true, names, envReads };
}

function frozenTransportOffenders(source: string): string[] {
  const { found, names, envReads } = reachableIdentifiers(source, FROZEN_TRANSPORT_FN);
  if (!found) return [`GD-1: ${FROZEN_TRANSPORT_FN} is missing`];
  const offenders = FROZEN_TRANSPORT_FORBIDDEN.filter((name) => names.has(name)).map((name) => `GD-1: reaches ${name}`);
  const extraEnv = [...envReads].filter((key) => key !== 'HSB_RESEND_API_KEY' && key !== 'RESEND_API_KEY');
  if (extraEnv.length > 0) offenders.push(`GD-1: reads process.env.${extraEnv.join(', process.env.')}`);
  return offenders;
}

/** GD-2. The dispatcher's runtime and type edges, exactly. */
const DISPATCH_RUNTIME_IMPORTS: ReadonlyArray<{ specifier: RegExp; bindings: string[] }> = [
  { specifier: /^\.\/confirmation-email-state\.ts$/, bindings: ['appendConfirmationEmailAttempt', 'evaluateConfirmationEmailTransition', 'evaluateFirstDispatchIntentWrite'] },
  { specifier: /^\.\/confirmation-email-envelope\.ts$/, bindings: ['digestConfirmationRequest'] },
];
const DISPATCH_TYPE_SPECIFIERS: readonly RegExp[] = [
  /^\.\/confirmation-email-state\.ts$/,
  /^\.\/confirmation-email-envelope\.ts$/,
  /^\.\/confirmation-email-delivery\.ts$/,
  /^\.\/confirmation-envelope-producer\.ts$/,
  /^\.\/order-email\.ts$/,
  /^\.\/orders\.ts$/,
];

function dispatchImportOffenders(source: string): string[] {
  const offenders: string[] = [];
  const statements = importStatementsIn(source);
  for (const statement of statements) {
    if (statement.kind === 'type') {
      if (!DISPATCH_TYPE_SPECIFIERS.some((re) => re.test(statement.specifier))) {
        offenders.push(`GD-2: type edge to ${statement.specifier}`);
      }
      continue;
    }
    if (statement.kind !== 'named') {
      offenders.push(`GD-2: ${statement.kind} edge to ${statement.specifier}`);
      continue;
    }
    const row = DISPATCH_RUNTIME_IMPORTS.find((candidate) => candidate.specifier.test(statement.specifier));
    if (!row) {
      offenders.push(`GD-2: runtime edge to ${statement.specifier}`);
      continue;
    }
    if (!sameBindings(statement.bindings, row.bindings)) {
      offenders.push(`GD-2: ${statement.specifier} bindings ${JSON.stringify(statement.bindings)}`);
    }
  }
  for (const row of DISPATCH_RUNTIME_IMPORTS) {
    const count = statements.filter((statement) => statement.kind === 'named' && row.specifier.test(statement.specifier)).length;
    if (count !== 1) offenders.push(`GD-2: ${row.specifier} must be reached by exactly one runtime import, found ${count}`);
  }
  // AM-S4 / B9 / GA-8: no edge of any kind to the store, its config or the ref.
  const named = source.match(/['"][^'"]*(?:confirmation-envelope-(?:store|config|ref)|@vercel\/blob|resend)(?:\.ts)?['"]/);
  if (named) offenders.push(`GD-2: names ${named[0]}`);
  const transport = source.match(/\bfetch\s*\(|\bnew Resend\b|\bsendWithFallback\b|\bsendOrderConfirmationEmail\b|\bdispatchFrozenConfirmationRequest\b/);
  if (transport) offenders.push(`GD-2: transport reach ${transport[0]}`);
  if (countOf(source, /\bprocess\.env\b/) !== 1) offenders.push('GD-2: process.env must appear exactly once (the supplied-environment default)');
  return offenders;
}

/** GD-3. No release on any receipt arm: the module never calls the legacy
 *  release, and neither the receipt-failure commit nor the receipt path that
 *  writes the hold names a claim field. */
const RECEIPT_FAILED_COMMIT_FN = 'receiptFailedCommit';
const RECEIPT_PATH_FN = 'recordFrozenReceipt';

function dispatchReleaseOffenders(source: string): string[] {
  const offenders: string[] = [];
  if (/\breleaseConfirmationEmailClaim\b/.test(source)) offenders.push('GD-3: the dispatcher names releaseConfirmationEmailClaim');
  if (/\brecordConfirmationEmailReceipt\b/.test(source)) offenders.push('GD-3: the dispatcher names recordConfirmationEmailReceipt');
  const body = moduleLevelDeclarations(source).get(RECEIPT_FAILED_COMMIT_FN);
  if (body === undefined) return [...offenders, `GD-3: ${RECEIPT_FAILED_COMMIT_FN} is missing`];
  const reach = body.match(/emailResendClaim\w*|RELEASED_CLAIM|releasedClaim/);
  if (reach) offenders.push(`GD-3: ${RECEIPT_FAILED_COMMIT_FN} touches the claim through ${reach[0]}`);
  const path_ = moduleLevelDeclarations(source).get(RECEIPT_PATH_FN);
  if (path_ === undefined) return [...offenders, `GD-3: ${RECEIPT_PATH_FN} is missing`];
  const pathReach = path_.match(/emailResendClaim\w*|RELEASED_CLAIM|releasedClaim|decideReleasingCommit/);
  if (pathReach) offenders.push(`GD-3: ${RECEIPT_PATH_FN} touches the claim through ${pathReach[0]}`);
  return offenders;
}

/** GD-4. Delivery reaches the dispatcher through exactly its two entry points. */
const DISPATCH_SPECIFIER_RE = /confirmation-email-dispatch(?:\.ts)?$/;
const DELIVERY_DISPATCH_BINDINGS = ['dispatchFrozenConfirmation', 'resolveFrozenDispatcher'];

function deliveryDispatchImportOffenders(source: string): string[] {
  const edges = importStatementsIn(source).filter((statement) => DISPATCH_SPECIFIER_RE.test(statement.specifier));
  const runtime = edges.filter((statement) => statement.kind !== 'type');
  const offenders: string[] = [];
  if (runtime.length !== 1 || runtime[0].kind !== 'named' || !sameBindings(runtime[0].bindings, DELIVERY_DISPATCH_BINDINGS)) {
    offenders.push(`GD-4: delivery must import exactly ${DELIVERY_DISPATCH_BINDINGS.join(', ')} from the dispatcher, once`);
  }
  if (/\bdispatchFrozenConfirmationRequest\b/.test(source)) offenders.push('GD-4: delivery names the real transport');
  return offenders;
}

/** GD-5. Delivery lines 470–542 at 917c909: the legacy claim → send → receipt
 *  tail, including the receipt-failure release (RL-3). */
const LEGACY_TAIL_ANCHOR = '  const claimId = newClaimId();';
const LEGACY_TAIL_LINES = 73;
const LEGACY_TAIL_SHA256 = 'eae2ebd960ded051af9a0ccd563e0c2a8cb8a067c484c11dd28406be04baf5d1';

function legacyTailDigest(source: string): string | null {
  const lines = source.split('\n');
  const start = lines.indexOf(LEGACY_TAIL_ANCHOR);
  if (start === -1 || lines.indexOf(LEGACY_TAIL_ANCHOR, start + 1) !== -1) return null;
  return createHash('sha256').update(lines.slice(start, start + LEGACY_TAIL_LINES).join('\n')).digest('hex');
}

// ── Real-tree pins ──────────────────────────────────────────────────────────

test('A3-5 GD-1: the frozen transport reaches no sender, renderer, fallback or record', () => {
  assert.deepEqual(frozenTransportOffenders(readRepoFile(ORDER_EMAIL)), []);
});

test('A3-5 GD-2: the dispatcher import table is exact, and it never names the store, config, ref or SDKs', () => {
  assert.deepEqual(dispatchImportOffenders(readRepoFile(DISPATCH)), []);
  assert.deepEqual(runtimeReachOffenders(DISPATCH, findModuleReferences(DISPATCH)), []);
  assert.deepEqual(fieldNameOffenders(DISPATCH, readRepoFile(DISPATCH)), []);
  assert.equal(namesRecordField(readRepoFile(DISPATCH), 'confirmationEmailEnvelope'), false, 'the retired inline envelope');
});

test('A3-5 GD-3: no receipt arm of the dispatcher releases the claim', () => {
  assert.deepEqual(dispatchReleaseOffenders(readRepoFile(DISPATCH)), []);
});

test('A3-5 GD-4 (GA-9): delivery reaches the dispatcher through one pinned import, and the producer pin is unchanged', () => {
  const delivery = readRepoFile(DELIVERY);
  assert.deepEqual(deliveryDispatchImportOffenders(delivery), []);
  assert.deepEqual(deliveryProducerImportOffenders(delivery), []);
  assert.deepEqual(deliveryOrderBindingOffenders(delivery), []);
});

test('A3-5 GD-5 (RL-3): the legacy claim → send → receipt tail of delivery is byte-identical to 917c909', () => {
  assert.equal(legacyTailDigest(readRepoFile(DELIVERY)), LEGACY_TAIL_SHA256);
  assert.match(readRepoFile(DELIVERY), /await release\('receipt_write_failed'\);/);
});

test('A3-5 RL-2: no default caller injects a frozen transport, and the real binding has no caller', () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    if (!file.startsWith('src/') && !file.startsWith('scripts/')) continue;
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (file !== ORDER_EMAIL && /\bdispatchFrozenConfirmationRequest\b/.test(source)) offenders.push(`${file} names the real frozen transport`);
    if (file !== DELIVERY && file !== DISPATCH && /\bfrozenDispatch\b/.test(source)) offenders.push(`${file} injects frozenDispatch`);
    if (file !== SWEEP && /\badmitAwaitingFrozenDispatch\b/.test(source)) offenders.push(`${file} opts the sweep in`);
  }
  assert.deepEqual(offenders, []);
  const sweep = readRepoFile(SWEEP);
  const defaults = sweep.slice(sweep.indexOf('export function buildDefaultConfirmationEmailSweepDeps'));
  assert.doesNotMatch(defaults.slice(0, defaults.indexOf('\n}\n')), /admitAwaitingFrozenDispatch/, 'the default sweep never opts in');
});

// ── Synthetic offenders (each checker must see its own) ─────────────────────

test('A3-5 GD-1 synthetic: routing through the fallback, rendering, or a second env read is seen', () => {
  const real = readRepoFile(ORDER_EMAIL);
  // The first line of the function body, after its signature.
  const bodyStart = '): Promise<FrozenDispatchTransportResult> {\n';
  assert.equal(real.split(bodyStart).length, 2, 'the body anchor must be unique');
  const inject = (source: string, line: string) => source.replace(bodyStart, `${bodyStart}  ${line}\n`);
  const viaHelper = inject(`${real}\nfunction frozenHelper() {\n  return getOrderSenderEmail();\n}\n`, 'frozenHelper();');
  assert.ok(frozenTransportOffenders(viaHelper).includes('GD-1: reaches getOrderSenderEmail'));
  assert.ok(frozenTransportOffenders(inject(real, 'void sendWithFallback;')).includes('GD-1: reaches sendWithFallback'));
  assert.ok(frozenTransportOffenders(inject(real, 'void buildOrderConfirmationEmail;')).includes('GD-1: reaches buildOrderConfirmationEmail'));
  assert.ok(frozenTransportOffenders(inject(real, 'void process.env.HSB_EMAIL_FROM;')).some((o) => o.includes('process.env.HSB_EMAIL_FROM')));
  assert.ok(frozenTransportOffenders(inject(real, "void process.env['HSB_SUPPORT_EMAIL'];")).some((o) => o.includes('HSB_SUPPORT_EMAIL')));
  assert.ok(frozenTransportOffenders(inject(real, 'const { NEXT_PUBLIC_URL } = process.env;')).some((o) => o.includes('<destructured>')));
});

test('A3-5 GD-2/GD-3 synthetic: a store edge, a config type edge, a release and a receipt-arm claim write are seen', () => {
  const real = readRepoFile(DISPATCH);
  const store = ['./confirmation-envelope', 'store.ts'].join('-');
  const config = ['./confirmation-envelope', 'config.ts'].join('-');
  assert.notDeepEqual(dispatchImportOffenders(`import { createConfirmationEnvelopeStore } from '${store}';\n${real}`), []);
  assert.notDeepEqual(dispatchImportOffenders(`import type { ConfirmationEnvelopeStorageRefusal } from '${config}';\n${real}`), []);
  assert.notDeepEqual(dispatchImportOffenders(`import { sendOrderConfirmationEmail } from './order-email.ts';\n${real}`), []);
  assert.notDeepEqual(dispatchImportOffenders(`import { randomUUID } from 'node:crypto';\n${real}`), [], 'node:crypto is not on the §2 allowlist');
  assert.notDeepEqual(dispatchReleaseOffenders(`${real}\nvoid releaseConfirmationEmailClaim;\n`), []);
  const body = moduleLevelDeclarations(real).get(RECEIPT_FAILED_COMMIT_FN);
  assert.ok(body, `${RECEIPT_FAILED_COMMIT_FN} must exist`);
  const mutated = real.replace(body, body.replace(/\n}$/, '\n  void { emailResendClaimId: null };\n}'));
  assert.notEqual(mutated, real);
  assert.ok(dispatchReleaseOffenders(mutated).some((o) => o.startsWith('GD-3')));
  const receiptPath = moduleLevelDeclarations(real).get(RECEIPT_PATH_FN);
  assert.ok(receiptPath, `${RECEIPT_PATH_FN} must exist`);
  const inlineRelease = real.replace(receiptPath, receiptPath.replace('{ commit: held, result: true }', '{ commit: { ...held, ...RELEASED_CLAIM }, result: true }'));
  assert.notEqual(inlineRelease, real);
  assert.ok(dispatchReleaseOffenders(inlineRelease).some((o) => o.includes(RECEIPT_PATH_FN)));
});

test('A3-5 GD-4/GD-5 synthetic: an extra dispatch binding and an edited legacy tail are seen', () => {
  const delivery = readRepoFile(DELIVERY);
  const extra = delivery.replace('resolveFrozenDispatcher }', 'resolveFrozenDispatcher, classifyFrozenDispatchResult }');
  assert.notEqual(extra, delivery);
  assert.notDeepEqual(deliveryDispatchImportOffenders(extra), []);
  const edited = delivery.replace("    await release('receipt_write_failed');\n", '');
  assert.notEqual(edited, delivery);
  assert.notEqual(legacyTailDigest(edited), LEGACY_TAIL_SHA256);
});
