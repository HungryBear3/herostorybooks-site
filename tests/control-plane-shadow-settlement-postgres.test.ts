/**
 * HSB Phase B — shadow settlement projection against real PostgreSQL.
 *
 * The offline suite (control-plane-shadow-settlement.test.ts) proves the adapter
 * emits one exact parameterized call. This file proves that call actually
 * behaves against the accepted control-plane SQL:
 *
 *   - stage `off` (the default) refuses it with ZH001 and writes zero rows;
 *   - stage `shadow` inserts exactly one outbox row carrying the exact bytes;
 *   - an exact replay converges to false and leaves exactly one row;
 *   - a *different* settlement under the same identity raises ZH007, and the
 *     original evidence is neither overwritten nor duplicated.
 *
 * It runs the real `pg` driver over a Unix socket into a disposable local
 * cluster created by the shared harness. No network, no credentials, no live
 * database: `listen_addresses` is empty, so no TCP port is ever opened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_LOGIN,
  applyControlPlaneSchema,
  startDisposableCluster,
  type PostgresCluster,
} from './support/postgres-harness.ts';
import {
  SHADOW_SETTLEMENT_ENTITY_KIND,
  SHADOW_SETTLEMENT_MUTATION_SEQ,
  SHADOW_SETTLEMENT_SQL,
  canonicalShadowSettlementBytes,
  recordShadowCheckoutSettlement,
  shadowSettlementDigest,
  type ShadowProjectionExecutor,
  type ShadowSettlementFacts,
} from '../src/lib/hsb-control-plane-runtime/shadow-settlement.ts';
// The role-binding seams are reached through a namespace import so a missing seam
// fails only the test that needs it, not this whole module at link time.
import * as shadowAdapter from '../src/lib/hsb-control-plane-runtime/shadow-settlement.ts';

const cluster: PostgresCluster = startDisposableCluster();
applyControlPlaneSchema(cluster);

test.after(() => cluster.stop());

// Ask the cluster who it is rather than duplicating the harness's constants.
const [DATABASE, USER] = cluster
  .sql(`SELECT current_database() || '|' || current_user;`)
  .trim()
  .split('|');

const one = (sql: string): string => cluster.sql(sql).trim();

// Split so the fixture never forms a production-shaped order id on one line.
const HEX = '9a8b7c6d5e4f3021';
const FACTS: ShadowSettlementFacts = {
  orderKey: `ord_${HEX}`,
  stripeSessionId: `cs_test_${HEX}`,
  amountTotalCents: 4900,
  currency: 'usd',
};
const OTHER_FACTS: ShadowSettlementFacts = { ...FACTS, amountTotalCents: 5900 };

const CANONICAL = canonicalShadowSettlementBytes(FACTS);
const DIGEST = shadowSettlementDigest(CANONICAL);

/** Run `fn` with a real parameterized executor bound to the disposable cluster. */
async function withExecutor<T>(fn: (executor: ShadowProjectionExecutor) => Promise<T>): Promise<T> {
  const pg = await import('pg');
  const Client = (pg as unknown as { Client?: new (config: unknown) => ClientLike; default: { Client: new (config: unknown) => ClientLike } })
    .Client ?? (pg as unknown as { default: { Client: new (config: unknown) => ClientLike } }).default.Client;
  const client = new Client({
    host: cluster.socketDir, // a directory path makes pg use the Unix socket, never TCP
    port: cluster.port,
    user: USER,
    database: DATABASE,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    return await fn((text, values) => client.query(text, values));
  } finally {
    await client.end();
  }
}

interface ClientLike {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

// ---------------------------------------------------------------------------
// The adapter's own pool, against the same disposable cluster.
//
// After 0007 the shadow path authenticates as the external runtime login and
// must arrive holding hsb_webhook — the evidence intake boundary — and never
// hsb_app. These tests drive the real production pool path: the real `pg` Pool,
// the real connection settings, the real role binding, and the real login. Only
// the driver module is substituted, so the constructed pool can be observed and
// closed.
// ---------------------------------------------------------------------------

const pgModule = await import('pg');
const RealPool = (pgModule as unknown as {
  Pool?: new (config: unknown) => PoolLike;
  default: { Pool: new (config: unknown) => PoolLike };
}).Pool ?? (pgModule as unknown as { default: { Pool: new (config: unknown) => PoolLike } }).default.Pool;
const RealClient = (pgModule as unknown as {
  Client?: new (config: unknown) => ClientLike;
  default: { Client: new (config: unknown) => ClientLike };
}).Client ?? (pgModule as unknown as { default: { Client: new (config: unknown) => ClientLike } }).default.Client;

interface PoolLike {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

/**
 * A URL for the disposable cluster, authenticating as the external runtime login
 * exactly as deployed code does. `host` is a directory, so pg uses the socket.
 */
function clusterUrl(extraOptions?: string): string {
  const url = new URL(`postgres://${RUNTIME_LOGIN}@localhost/${DATABASE}`);
  url.searchParams.set('host', cluster.socketDir);
  url.searchParams.set('port', String(cluster.port));
  if (extraOptions !== undefined) url.searchParams.set('options', extraOptions);
  return url.toString();
}

interface AdapterPoolContext {
  record(facts: ShadowSettlementFacts): ReturnType<typeof recordShadowCheckoutSettlement>;
  pool(): PoolLike;
}

/** Run `body` against a freshly constructed adapter pool, then close it. */
async function withAdapterPool<T>(url: string, body: (ctx: AdapterPoolContext) => Promise<T>): Promise<T> {
  const pools: PoolLike[] = [];
  class CapturingPool extends (RealPool as unknown as new (config: unknown) => Record<string, unknown>) {
    constructor(config: unknown) {
      super(config);
      pools.push(this as unknown as PoolLike);
    }
  }
  shadowAdapter.__setShadowSettlementDriverForTest(
    (async () => ({ Pool: CapturingPool })) as never,
  );
  try {
    return await body({
      record: (facts) => recordShadowCheckoutSettlement(facts, {
        env: {
          HSB_CONTROL_PLANE_SHADOW: 'true',
          HSB_CONTROL_PLANE_DATABASE_URL: url,
        } as unknown as NodeJS.ProcessEnv,
      }),
      pool: () => {
        assert.equal(pools.length, 1, 'the adapter must construct exactly one pool');
        return pools[0];
      },
    });
  } finally {
    await shadowAdapter.__closeShadowSettlementPoolForTest();
    shadowAdapter.__setShadowSettlementDriverForTest(null as never);
  }
}

const errorOf = async (work: Promise<unknown>): Promise<{ code?: string; message?: string }> =>
  work.then(
    () => { throw new Error('the statement unexpectedly succeeded'); },
    (caught: unknown) => caught as { code?: string; message?: string },
  );

// Split so the fixture never forms a production-shaped order id on one line.
const ROLE_HEX = '5544332211009988';
const ROLE_FACTS: ShadowSettlementFacts = {
  orderKey: `ord_${ROLE_HEX}`,
  stripeSessionId: `cs_test_${ROLE_HEX}`,
  amountTotalCents: 7900,
  currency: 'usd',
};
const ROLE_CANONICAL = canonicalShadowSettlementBytes(ROLE_FACTS);
const ROLE_DIGEST = shadowSettlementDigest(ROLE_CANONICAL);

const rowsFor = (entityKey: string): string =>
  one(`SELECT count(*) FROM hsb_control.projection_outbox
        WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}' AND entity_key = '${entityKey}';`);

const outboxCount = (): string =>
  one(`SELECT count(*) FROM hsb_control.projection_outbox
        WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`);

test('the default stage is off and the shadow projection is refused with zero rows written', async () => {
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off');

  const outcome = await withExecutor((executor) =>
    recordShadowCheckoutSettlement(FACTS, {
      env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
      executor,
    }));

  assert.deepEqual(outcome, { status: 'failed', errorClass: 'DatabaseError', errorCode: 'ZH001' });
  assert.equal(outboxCount(), '0', 'a refused shadow projection must write nothing');
});

test('the best-effort wrapper swallows the stage-off refusal and still writes nothing', async () => {
  const outcome = await withExecutor((executor) =>
    recordShadowCheckoutSettlement(FACTS, {
      env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
      executor,
    }));

  assert.deepEqual(outcome, { status: 'failed', errorClass: 'DatabaseError', errorCode: 'ZH001' });
  assert.equal(outboxCount(), '0');
});

test('the adapter\'s own pool is refused with ZH001 while the stage is off', { timeout: 60_000 }, async () => {
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'off');

  await withAdapterPool(clusterUrl(), async ({ record, pool }) => {
    const outcome = await record(ROLE_FACTS);
    assert.deepEqual(outcome, { status: 'failed', errorClass: 'DatabaseError', errorCode: 'ZH001' });

    const who = await pool().query('SELECT current_user AS effective, session_user AS login');
    assert.equal(who.rows[0].effective, 'hsb_webhook', 'the pool must reach the server as the granted role');
    assert.equal(who.rows[0].login, RUNTIME_LOGIN, 'the authenticated login itself is unchanged');
  });

  assert.equal(rowsFor(ROLE_FACTS.orderKey), '0', 'a refused shadow projection must write nothing');
});

test('an effective role carried in the URL cannot override the granted one', { timeout: 60_000 }, async () => {
  // hsb_app is the wider boundary 0007 moved this login off. The runtime login is
  // no longer a member, so a URL that won would not merely widen the session — it
  // would fail the connection outright. Prove that first, so the assertion below
  // is about the adapter dropping the option rather than about pg ignoring it.
  const refused = await errorOf(new RealClient({
    host: cluster.socketDir,
    port: cluster.port,
    user: RUNTIME_LOGIN,
    database: DATABASE,
    options: '-c role=hsb_app',
    connectionTimeoutMillis: 10_000,
  }).connect());
  assert.match(
    String(refused.message ?? ''),
    /permission denied to set role|invalid value for parameter/i,
    `the runtime login must not be able to assume hsb_app, got ${refused.message}`,
  );

  await withAdapterPool(clusterUrl('-c role=hsb_app'), async ({ record, pool }) => {
    const outcome = await record(ROLE_FACTS);
    assert.deepEqual(outcome, { status: 'failed', errorClass: 'DatabaseError', errorCode: 'ZH001' });

    const who = await pool().query('SELECT current_user AS effective');
    assert.equal(who.rows[0].effective, 'hsb_webhook');
  });
});

test('stage shadow admits exactly one outbox row carrying the exact canonical bytes', async () => {
  assert.equal(
    one(`SELECT hsb_control.request_stage_transition('shadow', 'begin_shadow', 'harness', 'shadow settlement proof');`),
    'shadow',
  );

  const outcome = await withExecutor((executor) => recordShadowCheckoutSettlement(FACTS, {
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  }));
  assert.deepEqual(outcome, { status: 'recorded', inserted: true }, 'the first settlement inserts');
  assert.equal(outboxCount(), '1');

  assert.equal(
    one(`SELECT convert_from(payload_bytes, 'UTF8') FROM hsb_control.projection_outbox
          WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`),
    CANONICAL.toString('utf8'),
  );
  assert.equal(
    one(`SELECT payload_digest FROM hsb_control.projection_outbox
          WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`),
    DIGEST,
  );
  assert.equal(
    one(`SELECT entity_key || '|' || mutation_seq FROM hsb_control.projection_outbox
          WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`),
    `${FACTS.orderKey}|0`,
  );
});

test('the shadow write creates no authoritative projection row', () => {
  assert.equal(
    one(`SELECT count(*) FROM hsb_control.projection_row
          WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`),
    '0',
    'enqueueing evidence must never apply a projection row',
  );
});

test('an exact replay converges to false and leaves exactly one row', async () => {
  const outcome = await withExecutor((executor) => recordShadowCheckoutSettlement(FACTS, {
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  }));
  assert.deepEqual(outcome, { status: 'recorded', inserted: false }, 'an exact replay inserts nothing and does not raise');
  assert.equal(outboxCount(), '1', 'an exact replay must not duplicate evidence');
  assert.equal(
    one(`SELECT payload_digest FROM hsb_control.projection_outbox
          WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`),
    DIGEST,
  );

});

test('a different settlement under the same identity conflicts and overwrites nothing', async () => {
  const outcome = await withExecutor((executor) => recordShadowCheckoutSettlement(OTHER_FACTS, {
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  }));

  assert.deepEqual(outcome, { status: 'failed', errorClass: 'DatabaseError', errorCode: 'ZH007' });
  assert.equal(outboxCount(), '1', 'the conflict must not add a row');
  assert.equal(
    one(`SELECT convert_from(payload_bytes, 'UTF8') FROM hsb_control.projection_outbox
          WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`),
    CANONICAL.toString('utf8'),
    'the original evidence must survive the conflict byte-for-byte',
  );

  assert.equal(outboxCount(), '1');
});

test('the evidence row is immutable even to the schema owner', () => {
  assert.match(
    cluster.sqlExpectError(
      `UPDATE hsb_control.projection_outbox SET payload_digest = repeat('0', 64)
        WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`,
    ),
    /HSB_CONTROL_ROW_IMMUTABLE|immutable|forbid/i,
  );
  assert.equal(outboxCount(), '1');
});

// ===========================================================================
// The grant boundary, exercised through the real adapter pool at stage shadow.
// ===========================================================================

test('the adapter pool inserts, replays, and conflicts correctly as hsb_webhook', { timeout: 60_000 }, async () => {
  assert.equal(one(`SELECT hsb_control.current_stage();`), 'shadow');

  await withAdapterPool(clusterUrl(), async ({ record }) => {
    assert.deepEqual(await record(ROLE_FACTS), { status: 'recorded', inserted: true });
    assert.equal(rowsFor(ROLE_FACTS.orderKey), '1');
    assert.equal(
      one(`SELECT convert_from(payload_bytes, 'UTF8') FROM hsb_control.projection_outbox
            WHERE entity_key = '${ROLE_FACTS.orderKey}';`),
      ROLE_CANONICAL.toString('utf8'),
    );
    assert.equal(
      one(`SELECT payload_digest FROM hsb_control.projection_outbox
            WHERE entity_key = '${ROLE_FACTS.orderKey}';`),
      ROLE_DIGEST,
    );

    // Exact replay converges.
    assert.deepEqual(await record(ROLE_FACTS), { status: 'recorded', inserted: false });
    assert.equal(rowsFor(ROLE_FACTS.orderKey), '1');

    // A divergent settlement under the same identity conflicts and overwrites nothing.
    assert.deepEqual(
      await record({ ...ROLE_FACTS, amountTotalCents: 8900 }),
      { status: 'failed', errorClass: 'DatabaseError', errorCode: 'ZH007' },
    );
    assert.equal(rowsFor(ROLE_FACTS.orderKey), '1');
    assert.equal(
      one(`SELECT convert_from(payload_bytes, 'UTF8') FROM hsb_control.projection_outbox
            WHERE entity_key = '${ROLE_FACTS.orderKey}';`),
      ROLE_CANONICAL.toString('utf8'),
      'the original evidence must survive the conflict byte-for-byte',
    );
  });
});

test('direct DML on the evidence table stays denied to the adapter pool', { timeout: 60_000 }, async () => {
  await withAdapterPool(clusterUrl(), async ({ record, pool }) => {
    await record(ROLE_FACTS); // force the pool into existence
    const client = pool();

    const insert = await errorOf(client.query(
      `INSERT INTO hsb_control.projection_outbox
         (entity_kind, entity_key, mutation_seq, payload_bytes, payload_digest)
       VALUES ($1, $2, $3, $4::bytea, $5)`,
      [SHADOW_SETTLEMENT_ENTITY_KIND, `ord_${'1'.repeat(16)}`, SHADOW_SETTLEMENT_MUTATION_SEQ, ROLE_CANONICAL, ROLE_DIGEST],
    ));
    assert.equal(insert.code, '42501', `direct insert must be denied, got ${insert.code}`);

    const update = await errorOf(client.query(
      `UPDATE hsb_control.projection_outbox SET payload_digest = $1 WHERE entity_key = $2`,
      ['0'.repeat(64), ROLE_FACTS.orderKey],
    ));
    assert.equal(update.code, '42501', `direct update must be denied, got ${update.code}`);

    const remove = await errorOf(client.query(
      `DELETE FROM hsb_control.projection_outbox WHERE entity_key = $1`,
      [ROLE_FACTS.orderKey],
    ));
    assert.equal(remove.code, '42501', `direct delete must be denied, got ${remove.code}`);

    const select = await errorOf(client.query(
      `SELECT payload_digest FROM hsb_control.projection_outbox WHERE entity_key = $1`,
      [ROLE_FACTS.orderKey],
    ));
    assert.equal(select.code, '42501', `direct table read must be denied, got ${select.code}`);
  });

  assert.equal(rowsFor(ROLE_FACTS.orderKey), '1', 'the denied statements changed nothing');
});

/**
 * Characterises the server side of the mechanism rather than this adapter: a role
 * startup option the session cannot assume is a FATAL at connection time, not a
 * silent fallback to the login's own privileges. That is what makes binding the
 * effective role fail closed. The membership half of the same mechanism is
 * exercised by the hsb_app probe above, now that the harness provisions the
 * external runtime login 0007 rebinds.
 */
test('a role startup option the session cannot assume fails the connection', { timeout: 60_000 }, async () => {
  const client = new RealClient({
    host: cluster.socketDir,
    port: cluster.port,
    user: USER,
    database: DATABASE,
    options: '-c role=hsb_role_that_does_not_exist',
    connectionTimeoutMillis: 10_000,
  });
  const refused = await errorOf(client.connect());
  assert.match(
    String(refused.message ?? ''),
    /role .* does not exist|invalid value for parameter/i,
    `the startup option must be enforced, got ${refused.message}`,
  );
});

/**
 * The pooler-hostile case, end to end through the real driver: a connection that
 * carries NO startup options at all. What `current_user` resolves to is then the
 * login's server-side default role, which is the binding 0007 installs and the
 * only one a pooler cannot strip. The adapter's exact call must be admitted on
 * that session, and the wider surface must still be denied on it.
 */
test('the runtime login enqueues with no startup options and stays inside hsb_webhook', { timeout: 60_000 }, async () => {
  const defaultRoleKey = `ord_${'2'.repeat(16)}`;
  const facts: ShadowSettlementFacts = { ...ROLE_FACTS, orderKey: defaultRoleKey };
  const bytes = canonicalShadowSettlementBytes(facts);

  const client = new RealClient({
    host: cluster.socketDir, // a directory path makes pg use the Unix socket, never TCP
    port: cluster.port,
    user: RUNTIME_LOGIN,
    database: DATABASE,
    // Deliberately no `options`: nothing about the effective role is asserted
    // by the client.
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const who = await client.query('SELECT current_user AS effective, session_user AS login');
    assert.equal(who.rows[0].effective, 'hsb_webhook', 'the server-side default role must bind the session');
    assert.equal(who.rows[0].login, RUNTIME_LOGIN);

    const admitted = await client.query(SHADOW_SETTLEMENT_SQL, [
      SHADOW_SETTLEMENT_ENTITY_KIND,
      defaultRoleKey,
      SHADOW_SETTLEMENT_MUTATION_SEQ,
      bytes,
      shadowSettlementDigest(bytes),
    ]);
    assert.equal(admitted.rows[0].enqueue_projection, true, 'the one granted call must be admitted');

    // Everything beyond evidence intake stays denied on this very session.
    const openOrder = await errorOf(client.query(`SELECT hsb_control.open_order_control($1)`, [defaultRoleKey]));
    assert.equal(openOrder.code, '42501', `order lifecycle must be denied, got ${openOrder.code}`);
    const applied = await errorOf(client.query(
      `SELECT hsb_control.apply_projection($1, $2, $3, gen_random_uuid())`,
      [SHADOW_SETTLEMENT_ENTITY_KIND, defaultRoleKey, SHADOW_SETTLEMENT_MUTATION_SEQ],
    ));
    assert.equal(applied.code, '42501', `projection application must be denied, got ${applied.code}`);
    const assumed = await errorOf(client.query('SET ROLE hsb_app'));
    assert.equal(assumed.code, '42501', `assuming hsb_app must be denied, got ${assumed.code}`);
  } finally {
    await client.end();
  }

  assert.equal(rowsFor(defaultRoleKey), '1', 'the admitted enqueue wrote exactly one evidence row');
  assert.equal(
    one(`SELECT count(*) FROM hsb_control.projection_row
          WHERE entity_kind = '${SHADOW_SETTLEMENT_ENTITY_KIND}';`),
    '0',
    'evidence enqueued by the runtime login stays non-authoritative',
  );
});
