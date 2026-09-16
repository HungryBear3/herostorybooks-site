/**
 * HSB Phase B control-plane foundation — unreachability proof.
 *
 * The foundation added by this slice is default-off AND structurally unreachable:
 * no production source file imports it, names it, or can reach it through the
 * transitive import graph. This test builds that import closure from every
 * production entrypoint and asserts the control-plane artifacts are outside it.
 *
 * Offline only. No PostgreSQL, no network, no application imports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, SQL_DIR, readAllSql, sqlFileNames } from './support/control-plane-identity.ts';

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Everything the application ships or executes outside the test runner. */
const PRODUCTION_ROOTS = [
  'src',
  'scripts',
  'middleware.ts',
  'next.config.js',
  'postcss.config.js',
  'playwright.config.ts',
];

/**
 * Schema, harness, and proof artifacts. Nothing here may EVER be reachable from
 * production: the SQL is applied by an operator, never by the app.
 *
 * Superseded 2026-09-15 by the shadow settlement slice. This list used to also
 * assert that the slice had no runtime surface at all. It now has exactly one —
 * RUNTIME_ADAPTER below — so total unreachability is no longer the guarantee.
 * The guarantee that replaces it, and that the rest of this file pins, is
 * narrower and still load-bearing: exactly one adapter, reachable from exactly
 * one route, inert unless explicitly flagged on.
 */
const CONTROL_PLANE_ARTIFACTS = [
  'db/control-plane',
  'tests/control-plane-contract-identity.test.ts',
  'tests/control-plane-isolation.test.ts',
  'tests/control-plane-postgres.test.ts',
  'tests/control-plane-shadow-settlement.test.ts',
  'tests/control-plane-shadow-settlement-postgres.test.ts',
  'tests/support/control-plane-identity.ts',
  'tests/support/postgres-harness.ts',
];

/**
 * Artifacts that must contact no application source and need no new env var.
 *
 * This file is deliberately absent: proving the adapter is inert by default
 * requires importing it, which is the whole point of the superseded guarantee.
 * The schema, harness, and contract proofs below stay fully application-free.
 */
const OFFLINE_PROOF_ARTIFACTS = [
  'tests/control-plane-contract-identity.test.ts',
  'tests/control-plane-postgres.test.ts',
  'tests/support/control-plane-identity.ts',
  'tests/support/postgres-harness.ts',
];

/** The single production file permitted to name the control plane. */
const RUNTIME_ADAPTER = 'src/lib/hsb-control-plane-runtime/shadow-settlement.ts';

/** The single production file permitted to import the adapter. */
const RUNTIME_ADAPTER_IMPORTER = 'src/app/api/webhooks/stripe/route.ts';

/** Names that must not appear in production source outside the adapter. */
const CONTROL_PLANE_TOKENS = [
  'hsb_control',
  'db/control-plane',
  'control-plane-identity',
  'postgres-harness',
  'pg_advisory_xact_lock',
  'hsb-provider-payment-identity-v1',
  'hsb_stage_admin',
];

/**
 * Tokens that stay banned even inside the adapter. The adapter may name the
 * schema and its one projection function; it may not reach the stage machine,
 * the authoritative order/provider transitions, leases, workers, or jobs.
 */
const FORBIDDEN_IN_ADAPTER = [
  'open_order_control',
  'advance_order_state',
  'record_provider_evidence',
  'advance_provider_phase',
  'record_event_receipt',
  'apply_projection',
  'request_stage_transition',
  'hsb_stage_admin',
  'pg_advisory_xact_lock',
  'db/control-plane',
];

function walk(target: string, out: string[] = []): string[] {
  if (!existsSync(target)) return out;
  const stats = statSync(target);
  if (stats.isFile()) {
    if (CODE_EXTENSIONS.includes(path.extname(target))) out.push(target);
    return out;
  }
  for (const entry of readdirSync(target)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    walk(path.join(target, entry), out);
  }
  return out;
}

/**
 * Extract every module specifier a file could resolve. Deliberately conservative:
 * it does not strip comments or template literals, so it over-reports edges. A
 * superset of the real import graph is the safe direction for an "is not
 * reachable" assertion.
 */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(REPO_ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null; // bare package specifier — resolves into node_modules, never into this slice

  const candidates = [
    base,
    ...CODE_EXTENSIONS.map((extension) => base + extension),
    ...CODE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
    // `allowImportingTsExtensions` lets source import `./x.ts` directly; also map
    // a compiled-looking `./x.js` specifier back onto its TypeScript source.
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importClosure(entrypoints: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(current, 'utf8');
    for (const specifier of specifiersOf(source)) {
      const resolved = resolveSpecifier(current, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

const productionEntrypoints = PRODUCTION_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)));
const closure = importClosure(productionEntrypoints);

test('the production import graph was actually built (harness self-check)', () => {
  assert.ok(productionEntrypoints.length > 50, `too few production entrypoints: ${productionEntrypoints.length}`);
  assert.ok(closure.size >= productionEntrypoints.length, 'closure smaller than its own entrypoints');
  assert.ok(
    closure.has(path.join(REPO_ROOT, 'src/lib/orders.ts')),
    'closure does not contain a known production module; extraction is broken',
  );
});

test('no production file can reach any control-plane artifact through imports', () => {
  const reachable = [...closure].map((file) => path.relative(REPO_ROOT, file));
  for (const artifact of CONTROL_PLANE_ARTIFACTS) {
    for (const file of reachable) {
      assert.ok(
        file !== artifact && !file.startsWith(`${artifact}/`),
        `production import graph reaches control-plane artifact: ${file}`,
      );
    }
  }
  for (const file of reachable) {
    assert.ok(!file.startsWith('db/'), `production import graph reaches db/: ${file}`);
  }
});

test('no production file except the one adapter names the control-plane implementation', () => {
  for (const file of productionEntrypoints) {
    const relative = path.relative(REPO_ROOT, file);
    if (relative === RUNTIME_ADAPTER) continue;
    const source = readFileSync(file, 'utf8');
    for (const token of CONTROL_PLANE_TOKENS) {
      assert.ok(
        !source.includes(token),
        `production file ${relative} names control-plane token ${token}`,
      );
    }
  }
});

test('the adapter names the projection seam and nothing else in the control plane', () => {
  const source = readFileSync(path.join(REPO_ROOT, RUNTIME_ADAPTER), 'utf8');

  // The only SQL the adapter may ever issue.
  assert.deepEqual(
    [...new Set([...source.matchAll(/hsb_control\.([a-z_]+)/g)].map((match) => match[1]))],
    ['enqueue_projection'],
    'the adapter reached a control-plane function other than enqueue_projection',
  );
  for (const token of FORBIDDEN_IN_ADAPTER) {
    assert.ok(!source.includes(token), `the adapter reaches a forbidden control-plane surface: ${token}`);
  }
  assert.ok(
    !/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(source),
    'the adapter must issue no direct DML; evidence goes through enqueue_projection only',
  );
});

test('exactly one production file imports the adapter, and it is the Stripe webhook', () => {
  const importers = productionEntrypoints
    .filter((file) => path.relative(REPO_ROOT, file) !== RUNTIME_ADAPTER)
    .filter((file) =>
      specifiersOf(readFileSync(file, 'utf8')).some(
        (specifier) => resolveSpecifier(file, specifier) === path.join(REPO_ROOT, RUNTIME_ADAPTER),
      ))
    .map((file) => path.relative(REPO_ROOT, file));

  assert.deepEqual(importers, [RUNTIME_ADAPTER_IMPORTER]);
});

test('the adapter is inert by default: no URL read, no pool, no SQL while the flag is off', async () => {
  const adapter = await import('../src/lib/hsb-control-plane-runtime/shadow-settlement.ts');

  const reads: string[] = [];
  let executorsCreated = 0;
  let queries = 0;
  const env = new Proxy({} as Record<string, string | undefined>, {
    get(target, property) {
      if (typeof property === 'string') reads.push(property);
      return target[property as string];
    },
  }) as unknown as NodeJS.ProcessEnv;

  // Split so the fixture never forms a production-shaped order id on one line.
  const HEX = '0f1e2d3c4b5a6978';
  const facts = {
    orderKey: `ord_${HEX}`,
    stripeSessionId: `cs_test_${HEX}`,
    amountTotalCents: 4900,
    currency: 'usd',
  };

  for (const flag of [undefined, 'false', 'TRUE', '1', ' true ', 'yes']) {
    reads.length = 0;
    const outcome = await adapter.recordShadowCheckoutSettlement(
      facts,
      {
        env: Object.assign(env, { HSB_CONTROL_PLANE_SHADOW: flag }),
        createExecutor: async () => {
          executorsCreated += 1;
          return async () => { queries += 1; return { rows: [] }; };
        },
        logger: { warn: () => {} },
      },
    );
    assert.deepEqual(outcome, { status: 'disabled' }, `flag ${JSON.stringify(flag)} must leave the shadow off`);
  }

  assert.equal(executorsCreated, 0, 'an off shadow must construct no pool');
  assert.equal(queries, 0, 'an off shadow must issue no SQL');
  assert.deepEqual(
    [...new Set(reads)],
    ['HSB_CONTROL_PLANE_SHADOW'],
    'an off shadow must read the flag and no connection setting',
  );
});

test('no deployment, cron, or build surface references the control-plane', () => {
  const surfaces = ['package.json', 'vercel.json', 'next.config.js', '.vercelignore', 'config/hsb-asset-allowlist.json'];
  for (const surface of surfaces) {
    const absolute = path.join(REPO_ROOT, surface);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    for (const token of [...CONTROL_PLANE_TOKENS, 'control-plane']) {
      assert.ok(!source.includes(token), `${surface} references ${token}`);
    }
  }

  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts.test,
    'node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts',
    'the npm test script changed; control-plane discovery relies on the tests/*.test.ts glob '
      + 'and the suite relies on --test-concurrency=1 to keep files serial',
  );
  // Superseded 2026-09-15: the shadow settlement slice adds exactly one pinned
  // driver. It stays a single exact pin, and no ORM or query builder joins it.
  assert.deepEqual(
    Object.keys(packageJson.dependencies).filter((name) => /prisma|(^|\/)pg$|postgres|knex|drizzle|typeorm|sequelize/i.test(name)),
    ['pg'],
    'the only permitted runtime database dependency is pg',
  );
  assert.equal(packageJson.dependencies.pg, '8.23.0', 'pg must stay pinned to the approved exact version');
  assert.deepEqual(
    Object.keys(packageJson.devDependencies).filter((name) => /prisma|(^|\/)pg$|postgres|knex|drizzle|typeorm|sequelize/i.test(name)),
    ['@types/pg'],
    'the only permitted database devDependency is the pg type package',
  );
  assert.match(packageJson.devDependencies['@types/pg'], /^8\.23\.\d+$/, '@types/pg must stay pinned');
});

test('control-plane test files are discovered by the repository test glob', () => {
  const discovered = readdirSync(path.join(REPO_ROOT, 'tests')).filter((name) => name.endsWith('.test.ts'));
  for (const expected of [
    'control-plane-contract-identity.test.ts',
    'control-plane-isolation.test.ts',
    'control-plane-postgres.test.ts',
    'control-plane-shadow-settlement.test.ts',
    'control-plane-shadow-settlement-postgres.test.ts',
  ]) {
    assert.ok(discovered.includes(expected), `${expected} is not discovered by tests/*.test.ts`);
  }
});

test('the offline control-plane proofs import no application source and require no new env var', () => {
  const ALLOWED_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'NODE_V8_COVERAGE']);
  const ownFiles = OFFLINE_PROOF_ARTIFACTS.map((artifact) => path.join(REPO_ROOT, artifact));
  for (const file of ownFiles) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersOf(source)) {
      assert.ok(!specifier.startsWith('@/'), `${path.basename(file)} imports application source: ${specifier}`);
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null) {
        assert.match(specifier, /^node:/, `${path.basename(file)} imports a non-stdlib package: ${specifier}`);
        continue;
      }
      const relative = path.relative(REPO_ROOT, resolved);
      assert.ok(relative.startsWith('tests/'), `${path.basename(file)} imports outside tests/: ${relative}`);
    }
    for (const match of source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
      assert.ok(ALLOWED_ENV.has(match[1]), `${path.basename(file)} introduces an env var requirement: ${match[1]}`);
    }
  }
});

test('the control-plane SQL performs no network, shell, or untrusted dynamic execution', () => {
  const sql = readAllSql();
  assert.ok(sqlFileNames().length > 0, 'no SQL to scan');
  for (const pattern of [
    /\bCOPY\b[\s\S]{0,80}\bPROGRAM\b/i,
    /\bCREATE\s+EXTENSION\b/i,
    /\bdblink\b/i,
    /\bpostgres_fdw\b/i,
    /\bplpythonu?\b/i,
    /\bLANGUAGE\s+plperlu\b/i,
    /\bLANGUAGE\s+c\b/i,
    /\bpg_read_file\b/i,
    /\bpg_ls_dir\b/i,
    /\blo_import\b/i,
  ]) {
    assert.ok(!pattern.test(sql), `control-plane SQL contains a dangerous construct: ${pattern}`);
  }
  // Dynamic SQL is permitted only where it cannot interpolate caller-supplied text.
  for (const dynamic of sql.match(/EXECUTE\s+[^\n;]+/gi) ?? []) {
    assert.ok(
      !/\|\|\s*(p_|NEW\.|OLD\.)/.test(dynamic),
      `dynamic SQL concatenates caller input: ${dynamic}`,
    );
  }
  assert.ok(existsSync(SQL_DIR));
});
