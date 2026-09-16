/**
 * HSB Phase B control-plane foundation — real PostgreSQL behavioural proof.
 *
 * Runs against a disposable cluster created by `initdb`, started by `pg_ctl` on a
 * Unix socket inside a random temp directory, and torn down on success and failure.
 * No TCP, no network, no credentials, no ambient database.
 *
 * If the local PostgreSQL tools are missing this file FAILS. It never skips: a
 * silently-skipped safety proof is worse than a red one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadContract, ACCEPTED } from './support/control-plane-identity.ts';
import {
  applyControlPlaneSchema,
  startDisposableCluster,
  waitForCondition,
  type CommandResult,
  type PostgresCluster,
} from './support/postgres-harness.ts';

const contract = loadContract();
const registries = contract.registries;

const cluster: PostgresCluster = startDisposableCluster();
const appliedFiles = applyControlPlaneSchema(cluster);

test.after(() => cluster.stop());

const NON_OWNER_ROLES = ['hsb_app', 'hsb_webhook', 'hsb_worker', 'hsb_backfill', 'hsb_stage_admin', 'hsb_auditor'];

function rows(text: string): string[] {
  return cluster.sql(text).split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function one(text: string): string {
  const result = rows(text);
  assert.equal(result.length, 1, `expected exactly one row from:\n${text}\ngot: ${JSON.stringify(result)}`);
  return result[0];
}

/** Non-empty result lines emitted by a concurrent psql session. */
function sessionRows(result: CommandResult): string[] {
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function enumValues(typeName: string): string[] {
  return rows(
    `SELECT e.enumlabel FROM pg_catalog.pg_enum e
       JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'hsb_control' AND t.typname = '${typeName}'
      ORDER BY e.enumsortorder;`,
  );
}

// ---------------------------------------------------------------------------
// Stage navigation. Every probe runs inside BEGIN/ROLLBACK so the committed
// singleton stays exactly where the surrounding tests expect it.
// ---------------------------------------------------------------------------
const TRANSITION = (to: string, guard: string) =>
  `SELECT hsb_control.request_stage_transition('${to}', '${guard}', 'harness', 'probe');`;

const ENTER_HOLD =
  `SELECT hsb_control.enter_hold_after_outage(s.stage_epoch, s.runtime_generation, 'harness')
     FROM hsb_control.stage_state s WHERE s.stage_id = 'singleton';`;

const NAVIGATE: Record<string, string[]> = {
  off: [],
  shadow: [TRANSITION('shadow', 'begin_shadow')],
  backfill: [TRANSITION('shadow', 'begin_shadow'), TRANSITION('backfill', 'begin_backfill')],
  verified: [
    TRANSITION('shadow', 'begin_shadow'),
    TRANSITION('backfill', 'begin_backfill'),
    TRANSITION('verified', 'backfill_verified'),
  ],
  activated: [
    TRANSITION('shadow', 'begin_shadow'),
    TRANSITION('backfill', 'begin_backfill'),
    TRANSITION('verified', 'backfill_verified'),
    TRANSITION('activated', 'activation_gate_passed'),
  ],
  hold: [
    TRANSITION('shadow', 'begin_shadow'),
    TRANSITION('backfill', 'begin_backfill'),
    TRANSITION('verified', 'backfill_verified'),
    TRANSITION('activated', 'activation_gate_passed'),
    ENTER_HOLD,
  ],
};

const STAGES: string[] = registries.stages.values;
const STAGE_EDGES: Array<{ from: string; to: string; guard: string }> = registries.stage_edges.edges;

function probe(from: string, body: string): { ok: boolean; output: string } {
  const script = ['BEGIN;', ...NAVIGATE[from], body, 'ROLLBACK;'].join('\n');
  try {
    return { ok: true, output: cluster.sql(script) };
  } catch (error) {
    return { ok: false, output: (error as Error).message };
  }
}

// ===========================================================================
// Harness and cluster safety
// ===========================================================================

test('the disposable cluster runs on a Unix socket with no TCP listener', () => {
  assert.equal(
    one(`SELECT CASE WHEN setting = '' THEN '<empty>' ELSE setting END
           FROM pg_catalog.pg_settings WHERE name = 'listen_addresses';`),
    '<empty>',
  );
  assert.equal(one(`SELECT setting FROM pg_catalog.pg_settings WHERE name = 'unix_socket_directories';`), cluster.socketDir);
  assert.ok(cluster.root.includes('hsb-cp-'), 'cluster root is not an isolated harness temp directory');
  assert.equal(one('SELECT current_database();'), 'hsb_cp');
});

test('every checked-in control-plane SQL file applies in ordinal order', () => {
  assert.deepEqual(appliedFiles, [
    '0001_schema_roles_metadata.sql',
    '0002_stage_machine.sql',
    '0003_source_revisions.sql',
    '0004_payment_identity_lock.sql',
    '0005_durable_substrate.sql',
    '0006_roles_and_grants.sql',
  ]);
  assert.equal(one(`SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = 'hsb_control';`), '1');
  assert.equal(
    one(`SELECT rolname FROM pg_catalog.pg_roles r
           JOIN pg_catalog.pg_namespace n ON n.nspowner = r.oid
          WHERE n.nspname = 'hsb_control';`),
    'hsb_owner',
  );
});

// ===========================================================================
// Bound contract metadata
// ===========================================================================

test('authoritative metadata binds the accepted registry and manifest hashes', () => {
  const bound = one(
    `SELECT contract_id || '|' || contract_version || '|' || canonical_registry_sha256 || '|'
            || source_manifest_sha256 || '|' || source_manifest_entries || '|'
            || application_base_commit || '|' || application_base_tree || '|'
            || offline_verdict || '|' || provider_qualification
       FROM hsb_control.contract_binding;`,
  );
  assert.equal(
    bound,
    [
      ACCEPTED.contractId,
      ACCEPTED.contractVersion,
      ACCEPTED.canonicalRegistrySha256,
      ACCEPTED.sourceManifestSha256,
      ACCEPTED.sourceManifestEntries,
      ACCEPTED.applicationBaseCommit,
      ACCEPTED.applicationBaseTree,
      ACCEPTED.verdict,
      'HOLD_UNQUALIFIED',
    ].join('|'),
  );
});

test('the contract binding is immutable', () => {
  for (const statement of [
    `UPDATE hsb_control.contract_binding SET contract_version = 5;`,
    `DELETE FROM hsb_control.contract_binding;`,
  ]) {
    assert.match(cluster.sqlExpectError(statement), /HSB_CONTROL_IMMUTABLE_ROW/);
  }
  assert.equal(one(`SELECT count(*) FROM hsb_control.contract_binding;`), '1');
});

test('the installed enum domains equal the contract registries exactly', () => {
  const expected: Array<[string, string[]]> = [
    ['stage', registries.stages.values],
    ['order_state', registries.order_states.values],
    ['exposed_order_class', registries.exposed_order_classes.values],
    ['provider_phase', registries.provider_phases.values],
    ['event_processing_state', registries.event_processing_states.values],
    ['evidence_class', registries.evidence_classes.values],
    ['event_family', registries.event_families.values],
    ['dispute_state', registries.dispute_states.values],
    ['source_era', registries.legacy_source_facts.enums.source_era],
    ['canonical_adoption', registries.legacy_source_classes.canonical_adoption_domain],
    ['revision_result', registries.backfill_revision_protocol.result_domain],
  ];
  for (const [typeName, values] of expected) {
    assert.deepEqual(enumValues(typeName), values, `enum ${typeName} drifted from the contract`);
  }
});

test('the seeded transition tables equal the contract edge sets exactly', () => {
  assert.deepEqual(
    rows(`SELECT guard FROM hsb_control.transition_guard ORDER BY guard;`),
    [...registries.transition_guards.values].sort(),
  );

  assert.deepEqual(
    rows(`SELECT from_stage || '>' || to_stage || ':' || guard FROM hsb_control.stage_edge ORDER BY 1;`),
    STAGE_EDGES.map((e) => `${e.from}>${e.to}:${e.guard}`).sort(),
  );

  assert.deepEqual(
    rows(`SELECT from_state || '>' || to_state || ':' || guard FROM hsb_control.order_state_edge ORDER BY 1;`),
    registries.order_edges_with_guards.edges.map((e: any) => `${e.from}>${e.to}:${e.guard}`).sort(),
  );

  assert.deepEqual(
    rows(`SELECT from_phase || '>' || to_phase || ':' || guard FROM hsb_control.provider_phase_edge ORDER BY 1;`),
    registries.provider_phase_edges_with_guards.edges.map((e: any) => `${e.from}>${e.to}:${e.guard}`).sort(),
  );

  assert.deepEqual(
    rows(`SELECT from_state || '+' || incoming || '>' || to_state || ':' || guard
            FROM hsb_control.dispute_edge ORDER BY 1;`),
    registries.dispute_edges_with_guards.edges
      .map((e: any) => `${e.from}+${e.incoming}>${e.to}:${e.guard}`)
      .sort(),
  );

  assert.deepEqual(
    rows(`SELECT order_state || '>' || exposed_class FROM hsb_control.order_containment ORDER BY 1;`),
    Object.entries(registries.containment_projection.mapping).map(([k, v]) => `${k}>${v}`).sort(),
  );
});

// ===========================================================================
// Stage machine
// ===========================================================================

test('the stage singleton starts at exactly off with no implicit activation', () => {
  assert.equal(
    one(`SELECT stage || '|' || stage_epoch || '|' || runtime_generation FROM hsb_control.stage_state;`),
    'off|0|0',
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.stage_state;`), '1');
  assert.equal(one(`SELECT count(*) FROM hsb_control.stage_transition_audit;`), '0');
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off');
});

test('all ten contract stage edges are accepted', () => {
  for (const edge of STAGE_EDGES) {
    const body =
      edge.from === 'activated' && edge.to === 'hold' ? ENTER_HOLD : TRANSITION(edge.to, edge.guard);
    const result = probe(edge.from, `${body}\nSELECT 'STAGE=' || hsb_control.current_stage();`);
    assert.ok(result.ok, `contract edge ${edge.from} -> ${edge.to} was rejected:\n${result.output}`);
    assert.ok(
      result.output.includes(`STAGE=${edge.to}`),
      `edge ${edge.from} -> ${edge.to} did not land on ${edge.to}: ${result.output}`,
    );
  }
});

test('every complement of the stage edge set is rejected', () => {
  const legal = new Set(STAGE_EDGES.map((e) => `${e.from}>${e.to}`));
  let rejected = 0;
  for (const from of STAGES) {
    for (const to of STAGES) {
      if (legal.has(`${from}>${to}`)) continue;
      const result = probe(from, TRANSITION(to, 'begin_shadow'));
      assert.ok(!result.ok, `complement ${from} -> ${to} was accepted`);
      assert.match(
        result.output,
        /HSB_CONTROL_STAGE_EDGE_REJECTED/,
        `complement ${from} -> ${to} failed for the wrong reason:\n${result.output}`,
      );
      rejected += 1;
    }
  }
  assert.equal(rejected, STAGES.length * STAGES.length - STAGE_EDGES.length);
  assert.equal(rejected, 26);
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off', 'a rejected probe changed the committed stage');
});

test('the prohibited legacy reverse fallback hold -> shadow is rejected', () => {
  assert.equal(registries.stage_edges.legacy_reverse_fallback_prohibited, true);
  const result = probe('hold', TRANSITION('shadow', 'verified_rollback'));
  assert.ok(!result.ok);
  assert.match(result.output, /HSB_CONTROL_STAGE_EDGE_REJECTED/);
});

test('a legal stage edge with the wrong guard is rejected', () => {
  const result = probe('off', TRANSITION('shadow', 'audited_resume'));
  assert.ok(!result.ok);
  assert.match(result.output, /HSB_CONTROL_STAGE_GUARD_REJECTED/);
  assert.match(result.output, /requires guard begin_shadow/);
});

test('the outage latch is reachable only through the narrow app-only function', () => {
  const viaGeneral = probe('activated', TRANSITION('hold', 'runtime_outage_latch'));
  assert.ok(!viaGeneral.ok);
  assert.match(viaGeneral.output, /HSB_CONTROL_STAGE_NARROW_ONLY/);

  const wrongFence = probe(
    'activated',
    `SELECT hsb_control.enter_hold_after_outage(s.stage_epoch + 1, s.runtime_generation, 'harness')
       FROM hsb_control.stage_state s WHERE s.stage_id = 'singleton';`,
  );
  assert.ok(!wrongFence.ok);
  assert.match(wrongFence.output, /HSB_CONTROL_STAGE_FENCE_REJECTED/);

  for (const from of ['off', 'shadow', 'backfill', 'verified', 'hold']) {
    const result = probe(from, ENTER_HOLD);
    assert.ok(!result.ok, `enter_hold_after_outage was accepted from ${from}`);
    assert.match(result.output, /HSB_CONTROL_STAGE_EDGE_REJECTED/);
  }
});

test('stage_state cannot be moved by direct DML, even by the schema owner', () => {
  for (const [statement, pattern] of [
    [`UPDATE hsb_control.stage_state SET stage = 'activated', stage_epoch = 1;`, /HSB_CONTROL_STAGE_DIRECT_DML/],
    [`UPDATE hsb_control.stage_state SET stage = 'shadow', stage_epoch = 1;`, /HSB_CONTROL_STAGE_DIRECT_DML/],
    [`INSERT INTO hsb_control.stage_state (stage_id, stage, stage_epoch, runtime_generation)
        VALUES ('other', 'activated', 0, 0);`, /HSB_CONTROL_STAGE_SINGLETON|violates check constraint/],
    [`DELETE FROM hsb_control.stage_state;`, /HSB_CONTROL_STAGE_SINGLETON/],
  ] as Array<[string, RegExp]>) {
    assert.match(cluster.sqlExpectError(`SET ROLE hsb_owner;\n${statement}`), pattern);
  }
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off');
});

test('every accepted stage transition appends exactly one audit row', () => {
  const result = probe(
    'verified',
    `SELECT 'AUDIT=' || count(*) FROM hsb_control.stage_transition_audit;
     SELECT 'ROWS=' || string_agg(from_stage || '>' || to_stage || ':' || guard || ':' || actor_label, ',' ORDER BY audit_seq)
       FROM hsb_control.stage_transition_audit;`,
  );
  assert.ok(result.ok, result.output);
  assert.ok(result.output.includes('AUDIT=3'), `expected three audit rows, got:\n${result.output}`);
  assert.ok(
    result.output.includes(
      'ROWS=off>shadow:begin_shadow:harness,shadow>backfill:begin_backfill:harness,backfill>verified:backfill_verified:harness',
    ),
    `audit rows did not match the accepted transitions:\n${result.output}`,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.stage_transition_audit;`), '0', 'audit leaked past rollback');
});

test('the stage transition audit is append-only', () => {
  const result = probe(
    'shadow',
    `UPDATE hsb_control.stage_transition_audit SET actor_label = 'tampered';`,
  );
  assert.ok(!result.ok);
  assert.match(result.output, /HSB_CONTROL_IMMUTABLE_ROW/);
});

// ===========================================================================
// Immutable source revisions
// ===========================================================================

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = '0123456789abcdef'.repeat(4);

// Exact-fact convergence fixtures. Each one is a distinct observed fact, so no two
// of them may ever be mistaken for a replay of one another.
const DIGEST_EXACT_1 = '1'.repeat(64);
const DIGEST_EXACT_2 = '2'.repeat(64);
const DIGEST_RACE_PROVIDER = '3'.repeat(64);
const DIGEST_RACE_DISPUTE = '4'.repeat(64);

test('registry seeding is available while the stage is off', () => {
  assert.equal(one(`SELECT hsb_control.register_source_identity('legacy:orders', 'parent');`), 't');
  assert.equal(one(`SELECT hsb_control.register_source_identity('legacy:orders', 'parent');`), 'f');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.register_source_identity('legacy:orders', 'current');`),
    /immutable_revision_overwrite/,
  );
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off');
});

test('an unknown source identity fails closed', () => {
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.record_source_revision('legacy:never-registered', 'v1', '${DIGEST_A}');`),
    /HSB_CONTROL_REVISION_REJECT:unknown_source_identity/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '0');
});

test('a malformed observed source fact fails closed', () => {
  for (const [call, field] of [
    [`hsb_control.record_source_revision('', 'v1', '${DIGEST_A}')`, 'source_identity'],
    [`hsb_control.record_source_revision('legacy:orders', '', '${DIGEST_A}')`, 'source_version'],
    [`hsb_control.record_source_revision('legacy:orders', 'v1', 'not-a-digest')`, 'source_digest'],
    [`hsb_control.record_source_revision('legacy:orders', 'v1', '${'A'.repeat(64)}')`, 'source_digest'],
    [`hsb_control.record_source_revision('legacy:orders', 'v1', NULL)`, 'source_digest'],
  ] as Array<[string, string]>) {
    const stderr = cluster.sqlExpectError(`SELECT ${call};`);
    assert.match(stderr, /HSB_CONTROL_REVISION_REJECT:malformed_observed_source_fact/);
    assert.ok(stderr.includes(field), `rejection did not name ${field}:\n${stderr}`);
  }
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '0');
});

test('the source revision transition table appends, noops, and rejects exactly as specified', () => {
  // new version + changed digest -> append exactly one
  assert.equal(one(`SELECT hsb_control.record_source_revision('legacy:orders', 'v1', '${DIGEST_A}');`), 'append');
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '1');

  // exact tuple -> noop, no new row
  assert.equal(one(`SELECT hsb_control.record_source_revision('legacy:orders', 'v1', '${DIGEST_A}');`), 'noop');
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '1');

  // same version + changed digest -> reject
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.record_source_revision('legacy:orders', 'v1', '${DIGEST_B}');`),
    /HSB_CONTROL_REVISION_REJECT:immutable_revision_overwrite/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '1');

  // new version + unchanged digest -> reject
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.record_source_revision('legacy:orders', 'v2', '${DIGEST_A}');`),
    /HSB_CONTROL_REVISION_REJECT:unchanged_bytes_new_revision/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '1');

  // new version + changed digest -> append exactly one more
  assert.equal(one(`SELECT hsb_control.record_source_revision('legacy:orders', 'v2', '${DIGEST_B}');`), 'append');
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '2');
  assert.equal(registries.backfill_revision_protocol.append_cardinality, 1);
});

test('prior source revision rows are preserved exactly across later decisions', () => {
  const snapshot = rows(
    `SELECT source_identity || '|' || source_version || '|' || source_digest || '|' || revision_seq
       || '|' || extract(epoch from recorded_at)::text
       FROM hsb_control.source_revision_canonical;`,
  );

  cluster.sqlExpectError(`SELECT hsb_control.record_source_revision('legacy:orders', 'v1', '${DIGEST_C}');`);
  assert.equal(one(`SELECT hsb_control.record_source_revision('legacy:orders', 'v3', '${DIGEST_C}');`), 'append');

  const after = rows(
    `SELECT source_identity || '|' || source_version || '|' || source_digest || '|' || revision_seq
       || '|' || extract(epoch from recorded_at)::text
       FROM hsb_control.source_revision_canonical;`,
  );
  assert.deepEqual(after.slice(0, snapshot.length), snapshot, 'a prior revision row changed');
  assert.equal(after.length, snapshot.length + 1);

  // registries.backfill_revision_protocol.canonical_row_order
  assert.deepEqual(
    rows(`SELECT source_version FROM hsb_control.source_revision_canonical;`),
    ['v1', 'v2', 'v3'],
  );
});

test('source revision history is immutable and rollback only marks rows inert', () => {
  assert.match(
    cluster.sqlExpectError(`UPDATE hsb_control.source_revision SET source_digest = '${DIGEST_C}' WHERE source_version = 'v1';`),
    /HSB_CONTROL_IMMUTABLE_ROW/,
  );
  assert.match(
    cluster.sqlExpectError(`DELETE FROM hsb_control.source_revision;`),
    /HSB_CONTROL_IMMUTABLE_ROW/,
  );
  assert.match(
    cluster.sqlExpectError(`DELETE FROM hsb_control.source_identity_registry;`),
    /HSB_CONTROL_IMMUTABLE_ROW/,
  );

  assert.equal(one(`SELECT hsb_control.mark_source_revision_inert('legacy:orders', 'v1');`), 't');
  assert.equal(one(`SELECT hsb_control.mark_source_revision_inert('legacy:orders', 'v1');`), 'f');
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision WHERE inert;`), '1');
  assert.match(
    cluster.sqlExpectError(`UPDATE hsb_control.source_revision SET inert = false WHERE source_version = 'v1';`),
    /an inert revision is never revived/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.source_revision;`), '3');
});

// ===========================================================================
// `off` fails closed
// ===========================================================================

const RUNTIME_MUTATIONS: Array<[string, string]> = [
  ['lock_payment_identities', `SELECT hsb_control.lock_payment_identities(ARRAY['charge']::hsb_control.identity_kind[], ARRAY['ch_gate']);`],
  ['bind_charge_alias', `SELECT hsb_control.bind_charge_alias('ch_gate', 'pi_gate');`],
  ['open_order_control', `SELECT hsb_control.open_order_control('ord_gate');`],
  ['advance_order_state', `SELECT hsb_control.advance_order_state('ord_gate', 'provisioning', 'tx3_first_marker');`],
  ['open_provider_phase', `SELECT hsb_control.open_provider_phase('ord_gate', 0);`],
  ['advance_provider_phase', `SELECT hsb_control.advance_provider_phase('ord_gate', 0, 'marker', 'tx3_immutable_authorization');`],
  ['record_provider_evidence', `SELECT hsb_control.record_provider_evidence('ord_gate', 0, 'S+', 'payment_intent.succeeded', '${DIGEST_A}');`],
  ['record_event_receipt', `SELECT hsb_control.record_event_receipt('evt_gate', 'payment_intent.succeeded', '${DIGEST_A}');`],
  ['claim_event_lease', `SELECT hsb_control.claim_event_lease('evt_gate', gen_random_uuid(), 60);`],
  ['settle_event_lease', `SELECT hsb_control.settle_event_lease('evt_gate', gen_random_uuid(), 'applied');`],
  ['record_reversal_evidence', `SELECT hsb_control.record_reversal_evidence('pi_gate', 'rev1', 'full', 100, 'usd', '${DIGEST_A}');`],
  ['consume_reversal', `SELECT hsb_control.consume_reversal('pi_gate', 'rev1', 'ord_gate');`],
  ['apply_dispute_evidence', `SELECT hsb_control.apply_dispute_evidence('dp_gate', 'ord_gate', 'open', '${DIGEST_A}');`],
  ['enqueue_projection', `SELECT hsb_control.enqueue_projection('order_control', 'ord_gate', 1, '\\x00'::bytea, encode(sha256('\\x00'::bytea), 'hex'));`],
  ['apply_projection', `SELECT hsb_control.apply_projection('order_control', 'ord_gate', 1, gen_random_uuid());`],
];

test('off fails closed for every runtime order, provider, and payment mutation', () => {
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off');
  for (const [name, call] of RUNTIME_MUTATIONS) {
    const stderr = cluster.sqlExpectError(call);
    assert.match(stderr, /HSB_CONTROL_STAGE_OFF/, `${name} did not fail closed while off:\n${stderr}`);
    assert.ok(stderr.includes(name), `${name} did not name itself in the refusal:\n${stderr}`);
  }
  assert.equal(one(`SELECT count(*) FROM hsb_control.order_control;`), '0');
  assert.equal(one(`SELECT count(*) FROM hsb_control.event_receipt;`), '0');
  assert.equal(one(`SELECT count(*) FROM hsb_control.charge_alias;`), '0');
});

// ===========================================================================
// Transaction-scoped payment-identity advisory lock (real concurrency)
// ===========================================================================

test('the advisory lock identity is deterministic and derived from the contract lock name', () => {
  assert.equal(registries.payment_identity_lock_protocol.global_lock_name, 'hsb-provider-payment-identity-v1');
  assert.equal(registries.payment_identity_lock_protocol.global_lock_kind, 'pg_advisory_xact_lock');
  const key = one(`SELECT hsb_control.payment_identity_lock_key();`);
  assert.equal(key, '-7866424830880951197');
  assert.equal(one(`SELECT hsb_control.payment_identity_lock_key();`), key, 'lock key is not stable');
  assert.equal(
    one(`SELECT ('x' || substr(md5('hsb-provider-payment-identity-v1'), 1, 16))::bit(64)::bigint;`),
    key,
    'lock key is not the documented derivation of the contract lock name',
  );
});

test('the payment-identity lock is a real cross-session transaction barrier', async () => {
  const lockKey = one(`SELECT hsb_control.payment_identity_lock_key();`);
  const heldQuery = `SELECT count(*) FROM pg_catalog.pg_locks
                       WHERE locktype = 'advisory' AND granted
                         AND ((classid::bigint << 32) | objid::bigint)::bigint = ${lockKey}::bigint;`;

  const holder = cluster.startSession(
    `BEGIN;
     SELECT hsb_control.acquire_payment_identity_lock();
     SELECT pg_sleep(3);
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  waitForCondition(cluster, heldQuery, (value) => value === '1', {
    description: 'holder session did not take the advisory lock',
  });

  // A second session must block. lock_timeout turns "blocked" into an observable,
  // bounded fact instead of an indefinite hang.
  const blocked = cluster.sqlExpectError(
    `SET lock_timeout = '750ms';
     BEGIN;
     SELECT hsb_control.acquire_payment_identity_lock();
     COMMIT;`,
    { timeoutMs: 30_000 },
  );
  assert.match(blocked, /lock timeout/i, `the second session was not blocked by the barrier:\n${blocked}`);

  const holderResult = await holder;
  assert.equal(holderResult.status, 0, `holder session failed: ${holderResult.stderr}`);

  // The lock is transaction scoped: the holder's COMMIT released it.
  assert.equal(one(heldQuery), '0');
  assert.equal(
    one(`BEGIN; SELECT hsb_control.acquire_payment_identity_lock(); COMMIT;`),
    lockKey,
    'the barrier did not release after the holder committed',
  );
  assert.equal(one(heldQuery), '0', 'the lock outlived its transaction');
});

test('the advisory lock is released by ROLLBACK as well as COMMIT', () => {
  const lockKey = one(`SELECT hsb_control.payment_identity_lock_key();`);
  cluster.sql(`BEGIN; SELECT hsb_control.acquire_payment_identity_lock(); ROLLBACK;`);
  assert.equal(
    one(`SELECT count(*) FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted
           AND ((classid::bigint << 32) | objid::bigint)::bigint = ${lockKey}::bigint;`),
    '0',
  );
});

// ===========================================================================
// Runtime substrate. From here on the stage is `shadow`: still not activated,
// still unreachable from the application, but past the `off` gate.
// ===========================================================================

test('the control plane can be moved off -> shadow and audits the transition', () => {
  assert.equal(one(`SELECT hsb_control.request_stage_transition('shadow', 'begin_shadow', 'harness', 'runtime substrate proof');`), 'shadow');
  assert.equal(
    one(`SELECT stage || '|' || stage_epoch || '|' || runtime_generation FROM hsb_control.stage_state;`),
    'shadow|1|0',
  );
  assert.equal(
    one(`SELECT from_stage || '>' || to_stage || ':' || guard || ':' || via_narrow_outage
           FROM hsb_control.stage_transition_audit;`),
    'off>shadow:begin_shadow:false',
  );
});

test('a stage-off transition cannot overtake a mutation admitted in shadow', async () => {
  const paymentLockKey = one(`SELECT hsb_control.payment_identity_lock_key();`);
  const mutation = cluster.startSession(
    `SET application_name = 'hsb_stage_race_mutation';
     BEGIN;
     SET ROLE hsb_app;
     SELECT hsb_control.bind_charge_alias('ch_stage_race', 'pi_stage_holder');
     SELECT pg_sleep(3);
     COMMIT;`,
    { timeoutMs: 30_000 },
  );
  waitForCondition(
    cluster,
    `SELECT count(*) FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted
       AND ((classid::bigint << 32) | objid::bigint)::bigint = ${paymentLockKey}::bigint;`,
    (value) => value === '1',
    { description: 'admitted mutation did not take the payment lock' },
  );

  const disable = cluster.startSession(
    `SET application_name = 'hsb_stage_race_disable';
     SET ROLE hsb_stage_admin;
     SELECT hsb_control.request_stage_transition('off', 'disable_shadow', 'race-test');`,
    { timeoutMs: 30_000 },
  );

  await new Promise((resolve) => setTimeout(resolve, 250));
  const stageWhileMutationOpen = one(`SELECT hsb_control.current_stage();`);

  const [mutationResult, disableResult] = await Promise.all([mutation, disable]);
  assert.equal(mutationResult.status, 0, mutationResult.stderr);
  assert.equal(disableResult.status, 0, disableResult.stderr);
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off');
  assert.equal(one(`SELECT payment_intent_id FROM hsb_control.charge_alias WHERE charge_id = 'ch_stage_race';`), 'pi_stage_holder');
  assert.equal(one(`SELECT stage_at FROM hsb_control.control_audit WHERE subject_key = 'ch_stage_race';`), 'shadow');
  assert.equal(one(`SELECT hsb_control.request_stage_transition('shadow', 'begin_shadow', 'race-test-reset');`), 'shadow');

  assert.equal(stageWhileMutationOpen, 'shadow', 'off overtook an admitted mutation');
});

test('stale REPEATABLE READ and SERIALIZABLE snapshots cannot mutate after off', async () => {
  const results: Array<{ isolation: string; status: number | null; stderr: string; persisted: string }> = [];

  for (const [isolation, suffix] of [
    ['REPEATABLE READ', 'rr'],
    ['SERIALIZABLE', 'serializable'],
  ] as const) {
    const applicationName = `hsb_stale_stage_${suffix}`;
    const orderKey = `ord_after_off_${suffix}`;
    const stale = cluster.startSession(
      `SET application_name = '${applicationName}';
       SET ROLE hsb_app;
       BEGIN ISOLATION LEVEL ${isolation};
       SELECT hsb_control.current_stage();
       SELECT pg_sleep(2);
       SELECT hsb_control.open_order_control('${orderKey}');
       COMMIT;`,
      { timeoutMs: 30_000 },
    );

    waitForCondition(
      cluster,
      `SELECT count(*) FROM pg_catalog.pg_stat_activity
        WHERE application_name = '${applicationName}'
          AND wait_event = 'PgSleep';`,
      (value) => value === '1',
      { description: `${isolation} probe did not establish its shadow snapshot` },
    );

    assert.equal(
      cluster.sqlAsRole(
        'hsb_stage_admin',
        `SELECT hsb_control.request_stage_transition('off', 'disable_shadow', 'stale-snapshot-probe');`,
      ).trim(),
      'off',
    );

    const staleResult = await stale;
    const persisted = one(`SELECT count(*) FROM hsb_control.order_control WHERE order_key = '${orderKey}';`);
    assert.equal(
      cluster.sqlAsRole(
        'hsb_stage_admin',
        `SELECT hsb_control.request_stage_transition('shadow', 'begin_shadow', 'stale-snapshot-reset');`,
      ).trim(),
      'shadow',
    );
    results.push({ isolation, status: staleResult.status, stderr: staleResult.stderr, persisted });
  }

  for (const result of results) {
    assert.notEqual(result.status, 0, `${result.isolation} stale snapshot committed after off`);
    assert.match(result.stderr, /could not serialize access due to concurrent update|HSB_CONTROL_STAGE_OFF/);
    assert.equal(result.persisted, '0', `${result.isolation} left a post-off order behind`);
  }
});

test('concurrent alias binds for one charge are serialized to a single immutable alias', async () => {
  cluster.sql(`
    CREATE SCHEMA harness;
    CREATE TABLE harness.alias_release (singleton boolean PRIMARY KEY CHECK (singleton), released boolean NOT NULL);
    INSERT INTO harness.alias_release VALUES (true, false);
    CREATE FUNCTION harness.wait_for_alias_release() RETURNS void
    LANGUAGE plpgsql SET search_path = pg_catalog, harness AS $$
    BEGIN
      LOOP
        EXIT WHEN (SELECT released FROM harness.alias_release WHERE singleton);
        PERFORM pg_catalog.pg_sleep(0.05);
      END LOOP;
    END
    $$;
  `);

  const holder = cluster.startSession(
    `SET application_name = 'hsb_alias_holder';
     BEGIN;
     SELECT hsb_control.bind_charge_alias('ch_serialized', 'pi_first');
     SELECT harness.wait_for_alias_release();
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  const lockKey = one(`SELECT hsb_control.payment_identity_lock_key();`);
  waitForCondition(
    cluster,
    `SELECT count(*) FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted
       AND ((classid::bigint << 32) | objid::bigint)::bigint = ${lockKey}::bigint;`,
    (value) => value === '1',
    { description: 'the first binder did not take the payment-identity lock' },
  );

  // The second session blocks on the real advisory lock. Observe that wait in
  // pg_stat_activity before releasing the holder; no fixed sleep establishes
  // concurrency or correctness.
  const contender = cluster.startSession(
    `SET application_name = 'hsb_alias_waiter';
     BEGIN;
     SELECT hsb_control.bind_charge_alias('ch_serialized', 'pi_second');
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  waitForCondition(
    cluster,
    `SELECT count(*) FROM pg_catalog.pg_stat_activity
       WHERE application_name = 'hsb_alias_waiter'
         AND wait_event_type = 'Lock' AND wait_event = 'advisory';`,
    (value) => value === '1',
    { description: 'the competing alias binder never blocked on the advisory lock' },
  );

  cluster.sql(`UPDATE harness.alias_release SET released = true WHERE singleton;`);

  const holderResult = await holder;
  assert.equal(holderResult.status, 0, holderResult.stderr);
  const contenderResult = await contender;
  assert.notEqual(contenderResult.status, 0, 'conflicting alias unexpectedly succeeded');
  assert.match(
    contenderResult.stderr,
    /HSB_CONTROL_ALIAS_IMMUTABLE/,
    `expected an immutable-alias refusal, got:\n${contenderResult.stderr}`,
  );
  assert.doesNotMatch(contenderResult.stderr, /duplicate key value/, 'the binders raced instead of serializing');

  assert.equal(one(`SELECT payment_intent_id FROM hsb_control.charge_alias WHERE charge_id = 'ch_serialized';`), 'pi_first');
  assert.equal(one(`SELECT count(*) FROM hsb_control.charge_alias WHERE charge_id = 'ch_serialized';`), '1');
  // insert-once is idempotent for the identical alias
  assert.equal(one(`SELECT hsb_control.bind_charge_alias('ch_serialized', 'pi_first');`), 'pi_first');
  assert.match(cluster.sqlExpectError(`UPDATE hsb_control.charge_alias SET payment_intent_id = 'pi_third';`), /HSB_CONTROL_IMMUTABLE_ROW/);
  cluster.sql(`DROP SCHEMA harness CASCADE;`);
});

test('identities presented in opposite orders do not deadlock', async () => {
  const first = cluster.startSession(
    `BEGIN;
     SELECT hsb_control.lock_payment_identities(
       ARRAY['charge', 'payment_intent']::hsb_control.identity_kind[], ARRAY['ch_order', 'pi_order']);
     SELECT pg_sleep(1);
     COMMIT;`,
    { timeoutMs: 30_000 },
  );
  const second = cluster.startSession(
    `BEGIN;
     SELECT hsb_control.lock_payment_identities(
       ARRAY['payment_intent', 'charge']::hsb_control.identity_kind[], ARRAY['pi_order', 'ch_order']);
     SELECT pg_sleep(1);
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.doesNotMatch(`${a.stderr}${b.stderr}`, /deadlock/i);
  assert.equal(one(`SELECT count(*) FROM hsb_control.payment_identity WHERE identity_id IN ('ch_order', 'pi_order');`), '2');
});

test('identity arrays are one-dimensional and bounded by total cardinality', () => {
  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.lock_payment_identities(
         array_fill('charge'::hsb_control.identity_kind, ARRAY[1,65]),
         array_fill('ch_many'::text, ARRAY[1,65]));`,
    ),
    /HSB_CONTROL_IDENTITY_INPUT_REJECTED/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.payment_identity WHERE identity_id = 'ch_many';`), '0');
});

// ===========================================================================
// Inert durable substrate
// ===========================================================================

test('order control records are monotonic and closed over the contract edge set', () => {
  assert.equal(one(`SELECT hsb_control.open_order_control('ord_alpha');`), 'draft');
  assert.equal(one(`SELECT order_state || '|' || mutation_seq FROM hsb_control.order_control WHERE order_key = 'ord_alpha';`), 'draft|0');

  assert.equal(one(`SELECT hsb_control.advance_order_state('ord_alpha', 'provisioning', 'tx3_first_marker');`), 'provisioning');
  assert.equal(one(`SELECT mutation_seq FROM hsb_control.order_control WHERE order_key = 'ord_alpha';`), '1');

  // draft -> paid is not a contract edge
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.advance_order_state('ord_alpha', 'draft', 'tx3_first_marker');`),
    /HSB_CONTROL_ORDER_EDGE_REJECTED/,
  );
  // right edge, wrong guard
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.advance_order_state('ord_alpha', 'payable', 'tx7_exact_settlement');`),
    /HSB_CONTROL_ORDER_GUARD_REJECTED/,
  );
  // direct DML cannot move it
  assert.match(
    cluster.sqlExpectError(`UPDATE hsb_control.order_control SET order_state = 'paid', mutation_seq = mutation_seq + 1;`),
    /HSB_CONTROL_ORDER_DIRECT_DML/,
  );
  assert.match(cluster.sqlExpectError(`DELETE FROM hsb_control.order_control;`), /HSB_CONTROL_ORDER_DIRECT_DML/);

  assert.equal(one(`SELECT order_state FROM hsb_control.order_control WHERE order_key = 'ord_alpha';`), 'provisioning');
  // registries.containment_projection.mapping: provisioning is exposed as ambiguous
  assert.equal(one(`SELECT exposed_class FROM hsb_control.order_control_exposed WHERE order_key = 'ord_alpha';`), 'ambiguous');
});

test('provider phase records are closed over the contract phase edges', () => {
  assert.equal(one(`SELECT hsb_control.open_provider_phase('ord_alpha', 0);`), 'absent');
  assert.equal(
    one(`SELECT hsb_control.advance_provider_phase('ord_alpha', 0, 'marker', 'tx3_immutable_authorization');`),
    'marker',
  );
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.advance_provider_phase('ord_alpha', 0, 'settled', 'exact_settlement');`),
    /HSB_CONTROL_PHASE_EDGE_REJECTED/,
  );
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.advance_provider_phase('ord_alpha', 0, 'candidate', 'conflict');`),
    /HSB_CONTROL_PHASE_GUARD_REJECTED/,
  );
  assert.match(
    cluster.sqlExpectError(`UPDATE hsb_control.provider_phase_record SET provider_phase = 'settled';`),
    /HSB_CONTROL_PHASE_DIRECT_DML/,
  );

  assert.ok(Number(one(`SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'payment_intent.succeeded', '${DIGEST_A}');`)) > 0);
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.record_provider_evidence('ord_alpha', 9, 'S+', 'payment_intent.succeeded', '${DIGEST_A}');`),
    /violates foreign key constraint/,
  );
  assert.match(cluster.sqlExpectError(`DELETE FROM hsb_control.provider_evidence;`), /HSB_CONTROL_IMMUTABLE_ROW/);
});

test('durable event receipts replay exactly, fence on owner token, and never re-open', () => {
  assert.equal(one(`SELECT hsb_control.record_event_receipt('evt_1', 'payment_intent.succeeded', '${DIGEST_A}');`), 'received');
  assert.equal(one(`SELECT hsb_control.record_event_receipt('evt_1', 'payment_intent.succeeded', '${DIGEST_A}');`), 'received');
  assert.equal(one(`SELECT count(*) FROM hsb_control.event_receipt;`), '1');

  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.record_event_receipt('evt_1', 'payment_intent.succeeded', '${DIGEST_B}');`),
    /HSB_CONTROL_EVENT_DIGEST_CONFLICT/,
  );
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.record_event_receipt('evt_1', 'charge_or_refund_update', '${DIGEST_A}');`),
    /HSB_CONTROL_EVENT_IDENTITY_CONFLICT/,
  );

  assert.equal(one(`SELECT hsb_control.record_event_receipt('evt_unleased', 'payment_intent.succeeded', '${DIGEST_A}');`), 'received');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.settle_event_lease('evt_unleased', NULL, 'applied');`),
    /HSB_CONTROL_EVENT_FENCED/,
  );
  assert.equal(one(`SELECT processing_state FROM hsb_control.event_receipt WHERE event_id = 'evt_unleased';`), 'received');

  const owner = one(`SELECT gen_random_uuid();`);
  assert.equal(one(`SELECT hsb_control.claim_event_lease('evt_1', '${owner}'::uuid, 120);`), 'leased');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.claim_event_lease('evt_1', gen_random_uuid(), 120);`),
    /HSB_CONTROL_EVENT_LEASE_LIVE/,
  );
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.settle_event_lease('evt_1', gen_random_uuid(), 'applied');`),
    /HSB_CONTROL_EVENT_FENCED/,
  );

  assert.equal(one(`SELECT hsb_control.settle_event_lease('evt_1', '${owner}'::uuid, 'applied');`), 'applied');
  assert.equal(one(`SELECT hsb_control.claim_event_lease('evt_1', gen_random_uuid(), 120);`), 'applied');
  assert.match(
    cluster.sqlExpectError(`UPDATE hsb_control.event_receipt SET processing_state = 'received' WHERE event_id = 'evt_1';`),
    /HSB_CONTROL_EVENT_TERMINAL/,
  );
  assert.match(cluster.sqlExpectError(`DELETE FROM hsb_control.event_receipt;`), /HSB_CONTROL_IMMUTABLE_ROW/);
});

test('event lease duration starts after row-lock acquisition and expired owners cannot settle', () => {
  assert.equal(one(`SELECT hsb_control.record_event_receipt('evt_clock', 'payment_intent.succeeded', '${DIGEST_A}');`), 'received');
  const owner = one(`SELECT gen_random_uuid();`);
  const leaseRows = rows(`BEGIN;
    SELECT pg_sleep(1.2);
    SELECT hsb_control.claim_event_lease('evt_clock', '${owner}'::uuid, 1);
    SELECT lease_expires_at > clock_timestamp() FROM hsb_control.event_receipt WHERE event_id = 'evt_clock';
    COMMIT;`);
  assert.equal(leaseRows.at(-1), 't');
  cluster.sql(`SELECT pg_sleep(1.1);`);
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.settle_event_lease('evt_clock', '${owner}'::uuid, 'applied');`),
    /HSB_CONTROL_EVENT_FENCED/,
  );
});

test('the PaymentIntent-keyed reversal inbox is append-only with separate unique consumption', () => {
  assert.equal(
    registries.payment_identity_lock_protocol.evidence_rule,
    'append_only_with_separate_unique_consumption',
  );
  assert.equal(one(`SELECT hsb_control.record_reversal_evidence('pi_rev', 're_1', 'full', 4900, 'usd', '${DIGEST_A}');`), 't');
  assert.equal(one(`SELECT hsb_control.record_reversal_evidence('pi_rev', 're_1', 'full', 4900, 'usd', '${DIGEST_A}');`), 'f');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.record_reversal_evidence('pi_rev', 're_1', 'partial', 100, 'eur', '${DIGEST_B}');`),
    /HSB_CONTROL_REVERSAL_CONFLICT/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.reversal_evidence;`), '1');
  assert.match(
    cluster.sqlExpectError(`UPDATE hsb_control.reversal_evidence SET amount_minor = 0;`),
    /HSB_CONTROL_IMMUTABLE_ROW/,
  );

  assert.equal(one(`SELECT hsb_control.consume_reversal('pi_rev', 're_1', 'ord_alpha');`), 't');
  assert.equal(one(`SELECT hsb_control.consume_reversal('pi_rev', 're_1', 'ord_alpha');`), 'f');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.consume_reversal('pi_rev', 're_1', 'ord_beta');`),
    /HSB_CONTROL_REVERSAL_CONSUMPTION_CONFLICT/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.reversal_consumption;`), '1');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.consume_reversal('pi_rev', 're_missing', 'ord_alpha');`),
    /violates foreign key constraint/,
  );
});

test('the dispute machine is closed and terminal-safe', () => {
  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_1', 'ord_alpha', 'open', '${DIGEST_A}');`), 'open');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.apply_dispute_evidence('dp_1', 'ord_beta', 'lost', '${DIGEST_B}');`),
    /HSB_CONTROL_DISPUTE_ORDER_CONFLICT/,
  );
  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_1', 'ord_alpha', 'won', '${DIGEST_B}');`), 'won');
  // stale open after a terminal preserves the terminal
  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_1', 'ord_alpha', 'open', '${DIGEST_C}');`), 'won');
  // the opposite terminal produces conflict, and conflict absorbs all later evidence
  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_1', 'ord_alpha', 'lost', '${DIGEST_A}');`), 'conflict');
  // A later *distinct* won observation, not a replay of the earlier won evidence.
  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_1', 'ord_alpha', 'won', '${DIGEST_D}');`), 'conflict');

  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.apply_dispute_evidence('dp_1', 'ord_alpha', 'none', '${DIGEST_A}');`),
    /HSB_CONTROL_DISPUTE_INPUT_REJECTED/,
  );
  assert.equal(one(`SELECT count(*) FROM hsb_control.dispute_evidence WHERE dispute_id = 'dp_1';`), '5');
  assert.match(cluster.sqlExpectError(`DELETE FROM hsb_control.dispute_evidence;`), /HSB_CONTROL_IMMUTABLE_ROW/);
});

// ---------------------------------------------------------------------------
// Exact-fact convergence.
//
// Evidence stays append-only for every *distinct* observation. Durable event
// receipts own terminal event replay, but a crash between an evidence append and
// event settlement replays the byte-identical fact, so applying the exact same
// fact twice must converge on the one durable row it already produced rather
// than duplicating storage or advancing the dispute graph a second time.
// ---------------------------------------------------------------------------

const PROVIDER_EVIDENCE_COUNT = (digest: string) =>
  `SELECT count(*) FROM hsb_control.provider_evidence
    WHERE order_key = 'ord_alpha' AND generation = 0 AND event_digest = '${digest}';`;

test('an exact provider-evidence replay converges on the one durable row it already wrote', () => {
  const before = Number(one(`SELECT count(*) FROM hsb_control.provider_evidence WHERE order_key = 'ord_alpha';`));

  const first = one(
    `SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'payment_intent.succeeded', '${DIGEST_EXACT_1}');`,
  );
  const replay = one(
    `SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'payment_intent.succeeded', '${DIGEST_EXACT_1}');`,
  );

  assert.equal(replay, first, 'the exact replay did not return the existing evidence_seq');
  assert.equal(one(PROVIDER_EVIDENCE_COUNT(DIGEST_EXACT_1)), '1', 'the exact replay appended duplicate storage');
  assert.equal(
    one(`SELECT count(*) FROM hsb_control.provider_evidence WHERE order_key = 'ord_alpha';`),
    String(before + 1),
  );
});

test('provider evidence differing in any identity column is never treated as a replay', () => {
  const before = Number(one(`SELECT count(*) FROM hsb_control.provider_evidence WHERE order_key = 'ord_alpha';`));

  const distinct = [
    // different digest
    `SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'payment_intent.succeeded', '${DIGEST_EXACT_2}');`,
    // different evidence class
    `SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S0', 'payment_intent.succeeded', '${DIGEST_EXACT_1}');`,
    // different event family
    `SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'checkout.session.completed', '${DIGEST_EXACT_1}');`,
  ].map((call) => one(call));

  assert.equal(new Set(distinct).size, distinct.length, 'distinct observations collapsed onto one evidence row');
  assert.equal(
    one(`SELECT count(*) FROM hsb_control.provider_evidence WHERE order_key = 'ord_alpha';`),
    String(before + distinct.length),
  );
  // An unknown generation is still a hard failure, not a replay.
  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.record_provider_evidence('ord_alpha', 9, 'S+', 'payment_intent.succeeded', '${DIGEST_EXACT_1}');`,
    ),
    /violates foreign key constraint/,
  );
});

test('an exact dispute-evidence replay returns current state and leaves dispute_seq alone', () => {
  const seq = `SELECT dispute_seq FROM hsb_control.dispute_record WHERE dispute_id = 'dp_exact';`;
  const evidence = `SELECT count(*) FROM hsb_control.dispute_evidence WHERE dispute_id = 'dp_exact';`;

  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_exact', 'ord_alpha', 'open', '${DIGEST_EXACT_1}');`), 'open');
  assert.equal(one(seq), '1');
  assert.equal(one(evidence), '1');

  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_exact', 'ord_alpha', 'open', '${DIGEST_EXACT_1}');`), 'open');
  assert.equal(one(seq), '1', 'the exact replay advanced dispute_seq a second time');
  assert.equal(one(evidence), '1', 'the exact replay appended duplicate dispute evidence');

  // A distinct observation still advances the dispute graph exactly as before.
  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_exact', 'ord_alpha', 'won', '${DIGEST_EXACT_2}');`), 'won');
  assert.equal(one(seq), '2');
  assert.equal(one(evidence), '2');

  // Replaying the older exact fact after the state moved returns the state now held.
  assert.equal(one(`SELECT hsb_control.apply_dispute_evidence('dp_exact', 'ord_alpha', 'open', '${DIGEST_EXACT_1}');`), 'won');
  assert.equal(one(seq), '2');
  assert.equal(one(evidence), '2');

  // A conflicting order binding is still a refusal, never a replay.
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.apply_dispute_evidence('dp_exact', 'ord_beta', 'open', '${DIGEST_EXACT_1}');`),
    /HSB_CONTROL_DISPUTE_ORDER_CONFLICT/,
  );
  assert.equal(one(evidence), '2');
});

test('a concurrent exact provider-evidence replay lands one durable fact without a unique violation', async () => {
  const holder = cluster.startSession(
    `SET application_name = 'hsb_provider_replay_holder';
     BEGIN;
     SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'payment_intent.succeeded', '${DIGEST_RACE_PROVIDER}');
     SELECT pg_sleep(3);
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  waitForCondition(
    cluster,
    `SELECT count(*) FROM pg_catalog.pg_stat_activity
       WHERE application_name = 'hsb_provider_replay_holder' AND wait_event = 'PgSleep';`,
    (value) => value === '1',
    { description: 'the first exact provider observation never landed inside its open transaction' },
  );

  const contender = cluster.startSession(
    `SET application_name = 'hsb_provider_replay_contender';
     BEGIN;
     SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'payment_intent.succeeded', '${DIGEST_RACE_PROVIDER}');
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  const [holderResult, contenderResult] = await Promise.all([holder, contender]);
  assert.equal(holderResult.status, 0, holderResult.stderr);
  assert.equal(contenderResult.status, 0, `the concurrent exact replay failed:\n${contenderResult.stderr}`);
  assert.doesNotMatch(
    `${holderResult.stderr}${contenderResult.stderr}`,
    /duplicate key value|deadlock detected/i,
    'the concurrent exact replay surfaced a raw unique violation or deadlock',
  );

  assert.equal(one(PROVIDER_EVIDENCE_COUNT(DIGEST_RACE_PROVIDER)), '1');
  assert.equal(
    sessionRows(contenderResult)[0],
    sessionRows(holderResult)[0],
    'the concurrent replay did not converge on the durable evidence_seq',
  );
});

test('a concurrent exact dispute replay opens one record and appends one evidence row', async () => {
  const holder = cluster.startSession(
    `SET application_name = 'hsb_dispute_replay_holder';
     BEGIN;
     SELECT hsb_control.apply_dispute_evidence('dp_race', 'ord_alpha', 'open', '${DIGEST_RACE_DISPUTE}');
     SELECT pg_sleep(3);
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  waitForCondition(
    cluster,
    `SELECT count(*) FROM pg_catalog.pg_stat_activity
       WHERE application_name = 'hsb_dispute_replay_holder' AND wait_event = 'PgSleep';`,
    (value) => value === '1',
    { description: 'the first exact dispute observation never landed inside its open transaction' },
  );

  // Both sessions open the same brand-new dispute id: the first-insert race is the
  // hard case, because neither can see the other's uncommitted dispute_record row.
  const contender = cluster.startSession(
    `SET application_name = 'hsb_dispute_replay_contender';
     BEGIN;
     SELECT hsb_control.apply_dispute_evidence('dp_race', 'ord_alpha', 'open', '${DIGEST_RACE_DISPUTE}');
     COMMIT;`,
    { timeoutMs: 30_000 },
  );

  const [holderResult, contenderResult] = await Promise.all([holder, contender]);
  assert.equal(holderResult.status, 0, holderResult.stderr);
  assert.equal(contenderResult.status, 0, `the concurrent exact dispute replay failed:\n${contenderResult.stderr}`);
  assert.doesNotMatch(
    `${holderResult.stderr}${contenderResult.stderr}`,
    /duplicate key value|deadlock detected/i,
    'the concurrent first-insert exact replay surfaced a raw unique violation or deadlock',
  );

  assert.equal(sessionRows(holderResult)[0], 'open');
  assert.equal(sessionRows(contenderResult)[0], 'open');
  assert.equal(one(`SELECT count(*) FROM hsb_control.dispute_record WHERE dispute_id = 'dp_race';`), '1');
  assert.equal(one(`SELECT dispute_seq FROM hsb_control.dispute_record WHERE dispute_id = 'dp_race';`), '1');
  assert.equal(one(`SELECT count(*) FROM hsb_control.dispute_evidence WHERE dispute_id = 'dp_race';`), '1');
});

test('projections are non-authoritative, digest-checked, monotonic, and owner-token fenced', () => {
  assert.equal(registries.projection_contract.reverse_gate_exists, false);
  const payload = `'\\x7b7d'::bytea`;
  const digest = one(`SELECT encode(sha256(${payload}), 'hex');`);

  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.enqueue_projection('order_control', 'ord_alpha', 1, ${payload}, '${DIGEST_A}');`),
    /HSB_CONTROL_PROJECTION_DIGEST_MISMATCH/,
  );
  assert.equal(one(`SELECT hsb_control.enqueue_projection('order_control', 'ord_alpha', 1, ${payload}, '${digest}');`), 't');
  assert.equal(one(`SELECT hsb_control.enqueue_projection('order_control', 'ord_alpha', 1, ${payload}, '${digest}');`), 'f');
  const conflictingPayload = `'\\x7b226368616e676564223a747275657d'::bytea`;
  const conflictingDigest = one(`SELECT encode(sha256(${conflictingPayload}), 'hex');`);
  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.enqueue_projection('order_control', 'ord_alpha', 1, ${conflictingPayload}, '${conflictingDigest}');`,
    ),
    /HSB_CONTROL_PROJECTION_REPLAY_CONFLICT/,
  );
  assert.equal(one(`SELECT hsb_control.enqueue_projection('order_control', 'ord_alpha', 2, ${payload}, '${digest}');`), 't');

  const owner = one(`SELECT gen_random_uuid();`);
  assert.equal(one(`SELECT hsb_control.apply_projection('order_control', 'ord_alpha', 2, '${owner}'::uuid);`), '2');
  // reverse_gate_exists: false — an older sequence never moves the projection back
  assert.equal(one(`SELECT hsb_control.apply_projection('order_control', 'ord_alpha', 1, '${owner}'::uuid);`), '2');
  assert.match(
    cluster.sqlExpectError(`SELECT hsb_control.apply_projection('order_control', 'ord_alpha', 2, gen_random_uuid());`),
    /HSB_CONTROL_PROJECTION_FENCED/,
  );
  assert.match(
    cluster.sqlExpectError(`UPDATE hsb_control.projection_row SET is_authoritative = true;`),
    /violates check constraint/,
  );
  assert.match(cluster.sqlExpectError(`UPDATE hsb_control.projection_outbox SET payload_bytes = '\\x00'::bytea;`), /HSB_CONTROL_IMMUTABLE_ROW/);
});

test('raw digest and currency inputs are rejected before fixed-width normalization', () => {
  const paddedDigest = `${DIGEST_A} `;

  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.record_provider_evidence('ord_alpha', 0, 'S+', 'payment_intent.succeeded', '${paddedDigest}');`,
    ),
    /check constraint|HSB_CONTROL.*REJECTED/i,
  );
  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.record_event_receipt('evt_padded_digest', 'payment_intent.succeeded', '${paddedDigest}');`,
    ),
    /check constraint|HSB_CONTROL.*REJECTED/i,
  );
  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.record_reversal_evidence('pi_padded_currency', 'rev_currency', 'partial', 1, 'usd ', '${DIGEST_A}');`,
    ),
    /check constraint|HSB_CONTROL.*REJECTED/i,
  );
  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.record_reversal_evidence('pi_padded_digest', 'rev_digest', 'partial', 1, 'usd', '${paddedDigest}');`,
    ),
    /check constraint|HSB_CONTROL.*REJECTED/i,
  );
  assert.match(
    cluster.sqlExpectError(
      `SELECT hsb_control.apply_dispute_evidence('dp_padded_digest', 'ord_alpha', 'open', '${paddedDigest}');`,
    ),
    /check constraint|HSB_CONTROL.*REJECTED/i,
  );

  assert.equal(one(`SELECT count(*) FROM hsb_control.event_receipt WHERE event_id = 'evt_padded_digest';`), '0');
  assert.equal(one(`SELECT count(*) FROM hsb_control.reversal_evidence WHERE payment_intent_id LIKE 'pi_padded_%';`), '0');
  assert.equal(one(`SELECT count(*) FROM hsb_control.dispute_record WHERE dispute_id = 'dp_padded_digest';`), '0');

  assert.deepEqual(
    rows(`SELECT c.relname || '.' || a.attname
            FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'hsb_control'
             AND a.attnum > 0 AND NOT a.attisdropped
             AND pg_catalog.format_type(a.atttypid, a.atttypmod) ~ '^character\\(';`),
    [],
  );
});

// ===========================================================================
// Role and function boundaries
// ===========================================================================

test('all seven contract roles exist and none of them can log in', () => {
  assert.deepEqual(
    rows(`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'hsb\\_%' AND rolname <> 'hsb_cp_bootstrap' ORDER BY rolname;`),
    [...registries.roles_and_function_grants.roles].sort(),
  );
  assert.equal(
    one(`SELECT count(*) FROM pg_catalog.pg_roles
          WHERE rolname LIKE 'hsb\\_%' AND rolname <> 'hsb_cp_bootstrap'
            AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole);`),
    '0',
  );
});

test('PUBLIC holds no execute privilege on any control-plane function', () => {
  assert.equal(registries.roles_and_function_grants.public_execute, false);
  assert.deepEqual(
    rows(`SELECT p.proname FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'hsb_control'
             AND (p.proacl IS NULL
                  OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
           ORDER BY p.proname;`),
    [],
  );
  assert.ok(Number(one(`SELECT count(*) FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'hsb_control';`)) >= 20);
});

test('no non-owner role holds direct table DML', () => {
  assert.equal(registries.roles_and_function_grants.direct_table_dml_nonowner, false);
  const roleList = NON_OWNER_ROLES.map((role) => `'${role}'`).join(', ');
  assert.deepEqual(
    rows(`SELECT r.role || ':' || c.relname || ':' || p.priv
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN unnest(ARRAY[${roleList}]) AS r(role)
           CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
           WHERE n.nspname = 'hsb_control' AND c.relkind IN ('r', 'p', 'v')
             AND has_table_privilege(r.role, c.oid, p.priv)
           ORDER BY 1;`),
    [],
  );
  // PUBLIC holds nothing on any table either.
  assert.deepEqual(
    rows(`SELECT c.relname FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'hsb_control' AND c.relkind IN ('r', 'p', 'v')
             AND (c.relacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0));`),
    [],
  );
});

test('every SECURITY DEFINER function pins a safe search_path', () => {
  const definers = rows(
    `SELECT p.proname || ' => ' || coalesce(array_to_string(p.proconfig, ' '), '<none>')
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'hsb_control' AND p.prosecdef
      ORDER BY p.proname;`,
  );
  assert.ok(definers.length >= 20, `expected many SECURITY DEFINER functions, found ${definers.length}`);
  for (const entry of definers) {
    assert.match(entry, /search_path=/, `SECURITY DEFINER without a pinned search_path: ${entry}`);
    assert.doesNotMatch(entry, /\bpublic\b/, `search_path includes public: ${entry}`);
    assert.doesNotMatch(entry, /\$user/, `search_path includes $user: ${entry}`);
  }
  // Every SECURITY DEFINER function runs as the non-superuser schema owner.
  assert.deepEqual(
    rows(`SELECT p.proname FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
           WHERE n.nspname = 'hsb_control' AND p.prosecdef AND (r.rolname <> 'hsb_owner' OR r.rolsuper);`),
    [],
  );
});

test('the executable surface of each role is exactly the contract boundary', () => {
  const roleList = NON_OWNER_ROLES.map((role) => `'${role}'`).join(', ');
  const granted = rows(
    `SELECT r.role || ':' || p.proname
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN unnest(ARRAY[${roleList}]) AS r(role)
      WHERE n.nspname = 'hsb_control' AND has_function_privilege(r.role, p.oid, 'EXECUTE')
      ORDER BY 1;`,
  );

  const expected = [
    'hsb_app:acquire_payment_identity_lock',
    'hsb_app:advance_order_state',
    'hsb_app:advance_provider_phase',
    'hsb_app:bind_charge_alias',
    'hsb_app:current_stage',
    'hsb_app:current_stage_fingerprint',
    'hsb_app:enqueue_projection',
    'hsb_app:enter_hold_after_outage',
    'hsb_app:lock_payment_identities',
    'hsb_app:open_order_control',
    'hsb_app:open_provider_phase',
    'hsb_auditor:current_stage',
    'hsb_auditor:current_stage_fingerprint',
    'hsb_backfill:current_stage',
    'hsb_backfill:current_stage_fingerprint',
    'hsb_backfill:mark_source_revision_inert',
    'hsb_backfill:record_source_revision',
    'hsb_stage_admin:current_stage',
    'hsb_stage_admin:current_stage_fingerprint',
    'hsb_stage_admin:register_source_identity',
    'hsb_stage_admin:request_stage_transition',
    'hsb_webhook:acquire_payment_identity_lock',
    'hsb_webhook:apply_dispute_evidence',
    'hsb_webhook:bind_charge_alias',
    'hsb_webhook:current_stage',
    'hsb_webhook:current_stage_fingerprint',
    'hsb_webhook:lock_payment_identities',
    'hsb_webhook:record_event_receipt',
    'hsb_webhook:record_provider_evidence',
    'hsb_webhook:record_reversal_evidence',
    'hsb_worker:acquire_payment_identity_lock',
    'hsb_worker:apply_projection',
    'hsb_worker:claim_event_lease',
    'hsb_worker:consume_reversal',
    'hsb_worker:current_stage',
    'hsb_worker:current_stage_fingerprint',
    'hsb_worker:lock_payment_identities',
    'hsb_worker:settle_event_lease',
  ];
  assert.deepEqual(granted, expected);
});

test('role boundaries are enforced at call time, not only in the catalog', () => {
  // hsb_app may latch the outage hold but may not drive the stage machine.
  assert.match(
    cluster.sqlAsRoleExpectError('hsb_app', `SELECT hsb_control.request_stage_transition('backfill', 'begin_backfill', 'app');`),
    /permission denied for function request_stage_transition/,
  );
  // hsb_stage_admin may drive the stage machine but may not latch the outage hold.
  assert.match(
    cluster.sqlAsRoleExpectError('hsb_stage_admin', `SELECT hsb_control.enter_hold_after_outage(1, 0, 'stage_admin');`),
    /permission denied for function enter_hold_after_outage/,
  );
  assert.match(
    cluster.sqlAsRoleExpectError('hsb_webhook', `SELECT hsb_control.open_order_control('ord_webhook');`),
    /permission denied for function open_order_control/,
  );
  assert.match(
    cluster.sqlAsRoleExpectError('hsb_backfill', `SELECT hsb_control.bind_charge_alias('ch_b', 'pi_b');`),
    /permission denied for function bind_charge_alias/,
  );
  assert.match(
    cluster.sqlAsRoleExpectError('hsb_auditor', `SELECT hsb_control.record_source_revision('legacy:orders', 'v9', '${DIGEST_B}');`),
    /permission denied for function record_source_revision/,
  );
  assert.match(
    cluster.sqlAsRoleExpectError('hsb_app', `INSERT INTO hsb_control.order_control (order_key, order_state) VALUES ('ord_direct', 'draft');`),
    /permission denied for table order_control/,
  );

  // The auditor reads and the backfill role works, which proves the denials above
  // are boundaries rather than a blanket failure.
  assert.equal(cluster.sqlAsRole('hsb_auditor', `SELECT (count(*) >= 1)::text FROM hsb_control.stage_transition_audit;`).trim(), 'true');
  assert.equal(cluster.sqlAsRole('hsb_auditor', `SELECT hsb_control.current_stage();`).trim(), 'shadow');
  assert.equal(
    cluster.sqlAsRole('hsb_backfill', `SELECT hsb_control.record_source_revision('legacy:orders', 'v4', '${'d'.repeat(64)}');`).trim(),
    'append',
  );
});

// ===========================================================================
// Structural safety of the substrate
// ===========================================================================

test('the substrate stores no PII-shaped column and keeps keys explicit', () => {
  const columns = rows(
    `SELECT c.relname || '.' || a.attname
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'hsb_control' AND c.relkind IN ('r', 'p', 'v')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1;`,
  );
  assert.ok(columns.length > 50, `expected a substantial substrate, found ${columns.length} columns`);
  const piiPattern = /(mail|first_name|last_name|full_name|child_name|street|addr|postal|zip|phone|card_number|ip_addr|user_agent|photo|avatar|birth)/i;
  for (const column of columns) {
    assert.doesNotMatch(column, piiPattern, `PII-shaped column in the control plane: ${column}`);
  }

  // Every base table has an explicit primary key.
  assert.deepEqual(
    rows(`SELECT c.relname FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'hsb_control' AND c.relkind = 'r'
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                              WHERE k.conrelid = c.oid AND k.contype = 'p')
           ORDER BY 1;`),
    [],
  );

  // Foreign keys and indexes are present, not aspirational.
  assert.ok(
    Number(one(`SELECT count(*) FROM pg_catalog.pg_constraint k
                  JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
                  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'hsb_control' AND k.contype = 'f';`)) >= 10,
  );
  assert.ok(
    Number(one(`SELECT count(*) FROM pg_catalog.pg_indexes WHERE schemaname = 'hsb_control';`)) >= 20,
  );
});

test('the control plane is still not activated when the proof finishes', () => {
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'shadow');
  assert.equal(one(`SELECT runtime_generation FROM hsb_control.stage_state;`), '0');
  assert.equal(
    one(`SELECT count(*) FROM hsb_control.stage_transition_audit WHERE to_stage = 'activated';`),
    '0',
  );
  assert.equal(one(`SELECT provider_qualification FROM hsb_control.contract_binding;`), 'HOLD_UNQUALIFIED');
});
