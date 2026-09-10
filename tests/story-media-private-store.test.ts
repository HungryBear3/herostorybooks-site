/**
 * Story media (customer voice notes and story documents) lives in its OWN
 * private Vercel Blob store.
 *
 * The regression this locks down
 * ------------------------------
 * The checkout media controls were gated on `HSB_BLOB_ACCESS_MODE === 'private'`
 * — a GLOBAL switch that also governs order JSON and hero photos. Production
 * cannot set it: the legacy order store is a PUBLIC store and rejects a
 * private write ("Cannot use private access on a public store"), so flipping
 * the global would break order persistence outright. The variable is therefore
 * absent in Production, the gate evaluated false, and the record-audio,
 * upload-audio and upload-document controls silently disappeared.
 *
 * The contract now
 * ----------------
 *   - Visibility follows the browser-selected lane: the dedicated legacy
 *     `HSB_PRIVATE_READ_WRITE_TOKEN`, or the direct-intake credential when the
 *     public direct-upload flag is enabled.
 *   - Voice/document bytes are written to that store with `access: 'private'`.
 *   - Order JSON and photos keep using `BLOB_READ_WRITE_TOKEN` and its current
 *     public behaviour, untouched.
 *   - A mixed rollback deletes each object through the credential for ITS
 *     store, classified fail-closed from the order/lease namespace.
 *   - A Vercel PRODUCTION build fails if the private credential is missing,
 *     blank, or the same store as the public one. Local, CI and Preview builds
 *     require no secrets.
 *
 * Every token in this file is synthetic.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isCheckoutStoryMediaEnabled } from '../src/lib/checkout-direct-flags.ts';
import {
  STORY_MEDIA_PRIVATE_TOKEN_ENV,
  classifyOrderMediaLane,
  storyMediaBuildContractProblem,
  storyMediaPrivateToken,
  storyMediaPrivateTokenProblem,
} from '../src/lib/story-media-store.ts';

/** Synthetic, parseable, obviously fake. */
const PUBLIC_TOKEN = 'vercel_blob_rw_pubORDERS0000_publicsecret';
const PRIVATE_TOKEN = 'vercel_blob_rw_privSTORY0000_privatesecret';
const INTAKE_TOKEN = 'vercel_blob_rw_privINTAKE000_intakesecret';
const GUARD_TOKEN = 'vercel_blob_rw_privGUARD0000_guardsecret';
/** Same store as PUBLIC_TOKEN, different secret — one keyspace, two strings. */
const PUBLIC_ALIAS_TOKEN = 'vercel_blob_rw_pubORDERS0000_othersecret';
const MALFORMED_TOKEN = 'not-a-vercel-token';

const env = (values: Record<string, string | undefined>) => values as unknown as NodeJS.ProcessEnv;

// ── The credential validator ────────────────────────────────────────────────

test('the private story-media credential must be present and name its own store', () => {
  assert.equal(storyMediaPrivateTokenProblem(env({})), `${STORY_MEDIA_PRIVATE_TOKEN_ENV} is not set`);
  assert.equal(
    storyMediaPrivateTokenProblem(env({ HSB_PRIVATE_READ_WRITE_TOKEN: '   ' })),
    `${STORY_MEDIA_PRIVATE_TOKEN_ENV} is not set`,
  );
  assert.equal(
    storyMediaPrivateTokenProblem(env({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PUBLIC_TOKEN,
    })),
    `${STORY_MEDIA_PRIVATE_TOKEN_ENV} must name a different Blob store than BLOB_READ_WRITE_TOKEN`,
  );
  assert.equal(
    storyMediaPrivateTokenProblem(env({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PUBLIC_ALIAS_TOKEN,
    })),
    `${STORY_MEDIA_PRIVATE_TOKEN_ENV} must name a different Blob store than BLOB_READ_WRITE_TOKEN`,
    'two credentials for one store are one keyspace, not two',
  );
  assert.equal(
    storyMediaPrivateTokenProblem(env({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PRIVATE_TOKEN,
    })),
    null,
  );
  assert.equal(
    storyMediaPrivateTokenProblem(env({ HSB_PRIVATE_READ_WRITE_TOKEN: PRIVATE_TOKEN })),
    null,
    'the public token is optional; only its COLLISION with the private one is a fault',
  );
  assert.match(
    storyMediaPrivateTokenProblem(env({ HSB_PRIVATE_READ_WRITE_TOKEN: MALFORMED_TOKEN })) ?? '',
    /valid Vercel Blob credential/,
    'a non-empty credential whose store identity cannot be parsed is unusable',
  );
});

test('the credential validator never puts a token value in its problem message', () => {
  const problems = [
    storyMediaPrivateTokenProblem(env({})),
    storyMediaPrivateTokenProblem(env({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PUBLIC_TOKEN,
    })),
  ];
  for (const problem of problems) {
    assert.ok(problem);
    assert.doesNotMatch(problem, /publicsecret|privatesecret|othersecret/);
  }
});

test('storyMediaPrivateToken returns the trimmed credential, or null as a hard stop', () => {
  assert.equal(
    storyMediaPrivateToken(env({ HSB_PRIVATE_READ_WRITE_TOKEN: `  ${PRIVATE_TOKEN}  ` })),
    PRIVATE_TOKEN,
  );
  assert.equal(storyMediaPrivateToken(env({})), null);
  assert.equal(storyMediaPrivateToken(env({ HSB_PRIVATE_READ_WRITE_TOKEN: MALFORMED_TOKEN })), null);
  assert.equal(
    storyMediaPrivateToken(env({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PUBLIC_ALIAS_TOKEN,
    })),
    null,
    'a colliding credential is never handed to the SDK',
  );
});

// ── Checkout media visibility ───────────────────────────────────────────────

test('story media visibility depends on the private credential, never on the global access mode', () => {
  assert.equal(
    isCheckoutStoryMediaEnabled(env({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PRIVATE_TOKEN,
    })),
    true,
    'this is the exact Production shape: both tokens set, no HSB_BLOB_ACCESS_MODE',
  );
  assert.equal(
    isCheckoutStoryMediaEnabled(env({ HSB_PRIVATE_READ_WRITE_TOKEN: PRIVATE_TOKEN })),
    true,
  );
  assert.equal(
    isCheckoutStoryMediaEnabled(env({
      HSB_BLOB_ACCESS_MODE: 'private',
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
    })),
    false,
    'the global mode alone no longer enables the controls',
  );
  assert.equal(isCheckoutStoryMediaEnabled(env({})), false);
  assert.equal(
    isCheckoutStoryMediaEnabled(env({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PUBLIC_ALIAS_TOKEN,
    })),
    false,
    'the same store under two names is not a private lane',
  );
});

test('checkout media availability follows the browser-selected legacy or direct upload path', () => {
  const legacyReady = {
    BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
    HSB_PRIVATE_READ_WRITE_TOKEN: PRIVATE_TOKEN,
  };
  assert.equal(isCheckoutStoryMediaEnabled(env(legacyReady)), true);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    ...legacyReady,
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'false',
  })), true, 'server pre-enable does not change the browser-selected legacy path');

  const directReady = {
    BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
    HSB_CHECKOUT_GUARD_MODE: 'durable',
    HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: GUARD_TOKEN,
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
  };
  assert.equal(
    isCheckoutStoryMediaEnabled(env(directReady)),
    true,
    'the direct path uses its intake store and does not require the legacy private token',
  );

  for (const broken of [
    { ...directReady, HSB_CHECKOUT_DIRECT_UPLOAD: 'false' },
    { ...directReady, HSB_CHECKOUT_GUARD_MODE: undefined },
    { ...directReady, HSB_CHECKOUT_GUARD_MODE: 'process-local' },
    { ...directReady, HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: undefined },
    { ...directReady, HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: MALFORMED_TOKEN },
    { ...directReady, HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: PUBLIC_ALIAS_TOKEN },
    { ...directReady, HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_privINTAKE000_othersecret' },
    { ...directReady, HSB_INTAKE_BLOB_READ_WRITE_TOKEN: undefined },
    { ...directReady, HSB_INTAKE_BLOB_READ_WRITE_TOKEN: MALFORMED_TOKEN },
    { ...directReady, HSB_INTAKE_BLOB_READ_WRITE_TOKEN: PUBLIC_ALIAS_TOKEN },
    { ...directReady, HSB_INTAKE_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_privGUARD0000_othersecret' },
    { ...directReady, HSB_BLOB_NAMESPACE: 'bad/namespace' },
    { ...directReady, HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: 'not-a-number' },
    { ...directReady, HSB_CHECKOUT_GUARD_MAX_UPLOADS_PER_MINUTE: '-1' },
    { ...directReady, HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: '1e6' },
    { ...directReady, HSB_CHECKOUT_GUARD_MAX_FINALIZATIONS_PER_MINUTE: '2.5' },
    { ...directReady, HSB_CHECKOUT_GUARD_MAX_REPLACEMENTS_PER_MINUTE: 'many' },
    { ...directReady, HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: '0x10' },
  ]) {
    assert.equal(isCheckoutStoryMediaEnabled(env(broken)), false, JSON.stringify(broken));
  }

  assert.equal(isCheckoutStoryMediaEnabled(env({
    ...directReady,
    HSB_BLOB_NAMESPACE: 'production_checkout',
    HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: '0',
    HSB_CHECKOUT_GUARD_MAX_UPLOADS_PER_MINUTE: '1',
    HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: '1048576',
    HSB_CHECKOUT_GUARD_MAX_FINALIZATIONS_PER_MINUTE: '2',
    HSB_CHECKOUT_GUARD_MAX_REPLACEMENTS_PER_MINUTE: '3',
    HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: '4',
  })), true, 'every runtime parser accepts the same explicit configuration as the UI gate');
});

test('the hermetic browser-QA branch enables only the legacy controls without Blob credentials', () => {
  const hermeticQa = {
    HSB_E2E_STORY_MEDIA_ENABLED: 'true',
    HSB_ORDER_STORE_DIR: '/tmp/project/.e2e-store',
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
  };

  assert.equal(isCheckoutStoryMediaEnabled(env(hermeticQa)), true);
  assert.equal(
    isCheckoutStoryMediaEnabled(env({
      ...hermeticQa,
      NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    })),
    false,
    'QA may not expose a browser-selected direct lane rejected by the shared configuration contract',
  );
});

test('the explicit story-media opt-out disables runtime controls even when a path is otherwise ready', () => {
  const validLegacy = {
    HSB_PRIVATE_READ_WRITE_TOKEN: PRIVATE_TOKEN,
    HSB_STORY_MEDIA_INTENT: 'disabled',
  };
  const validDirect = {
    BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
    HSB_CHECKOUT_GUARD_MODE: 'durable',
    HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: GUARD_TOKEN,
    HSB_STORY_MEDIA_INTENT: 'disabled',
  };
  const hermeticQa = {
    HSB_E2E_STORY_MEDIA_ENABLED: 'true',
    HSB_ORDER_STORE_DIR: '/tmp/project/.e2e-store',
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
    HSB_STORY_MEDIA_INTENT: 'disabled',
  };

  assert.equal(isCheckoutStoryMediaEnabled(env(validLegacy)), false);
  assert.equal(isCheckoutStoryMediaEnabled(env(validDirect)), false);
  assert.equal(isCheckoutStoryMediaEnabled(env(hermeticQa)), false);
});

test('the story-media gate no longer reads HSB_BLOB_ACCESS_MODE at all', () => {
  const flags = readFileSync('src/lib/checkout-direct-flags.ts', 'utf8');
  const gate = flags.slice(flags.indexOf('export function isCheckoutStoryMediaEnabled'));
  assert.doesNotMatch(gate, /HSB_BLOB_ACCESS_MODE/);
});

// ── Rollback lane classification ────────────────────────────────────────────

test('order media objects are classified into a store lane fail-closed', () => {
  assert.equal(classifyOrderMediaLane('photo-upload.jpg'), 'public');
  assert.equal(classifyOrderMediaLane('supporting-1-photo-upload.jpg'), 'public');
  assert.equal(classifyOrderMediaLane('supporting-12-photo-upload.png'), 'public');
  assert.equal(classifyOrderMediaLane('voice-aB12cD34eF56.webm'), 'private');
  assert.equal(classifyOrderMediaLane('document-aB12cD34eF56.pdf'), 'private');

  for (const unknown of [
    '',
    'mystery-object.bin',
    'photo',
    'voice-noextension',
    'nested/voice-aB12cD34eF56.webm',
    '../voice-aB12cD34eF56.webm',
    'supporting-x-photo-upload.jpg',
  ]) {
    assert.equal(classifyOrderMediaLane(unknown), null, `must not classify ${JSON.stringify(unknown)}`);
  }
});

// ── The Production deploy/build contract ────────────────────────────────────

test('the build contract is inert everywhere except a Vercel Production build', () => {
  assert.equal(storyMediaBuildContractProblem(env({})), null, 'a bare local build needs no secrets');
  assert.equal(
    storyMediaBuildContractProblem(env({ NODE_ENV: 'production' })),
    null,
    'NODE_ENV=production off Vercel is CI, not a deploy',
  );
  assert.equal(
    storyMediaBuildContractProblem(env({ VERCEL: '1', VERCEL_ENV: 'preview' })),
    null,
  );
  assert.equal(
    storyMediaBuildContractProblem(env({ VERCEL: '1', VERCEL_ENV: 'development' })),
    null,
  );
  assert.equal(
    storyMediaBuildContractProblem(env({ VERCEL: '', VERCEL_ENV: '' })),
    null,
    'the CI workflow blanks both and must not need a credential',
  );
});

test('a Vercel Production build fails when the private story-media credential is unusable', () => {
  const production = (extra: Record<string, string | undefined>) =>
    storyMediaBuildContractProblem(env({ VERCEL: '1', VERCEL_ENV: 'production', ...extra }));

  assert.match(production({}) ?? '', new RegExp(STORY_MEDIA_PRIVATE_TOKEN_ENV));
  assert.match(production({ HSB_PRIVATE_READ_WRITE_TOKEN: '  ' }) ?? '', /is not set/);
  assert.match(
    production({ HSB_PRIVATE_READ_WRITE_TOKEN: MALFORMED_TOKEN }) ?? '',
    /valid Vercel Blob credential/,
  );
  assert.match(
    production({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PUBLIC_ALIAS_TOKEN,
    }) ?? '',
    /must name a different Blob store/,
  );
  assert.equal(
    production({
      BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
      HSB_PRIVATE_READ_WRITE_TOKEN: PRIVATE_TOKEN,
    }),
    null,
  );

  const directBuildReady = {
    BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN,
    HSB_CHECKOUT_GUARD_MODE: 'durable',
    HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: GUARD_TOKEN,
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
  };
  assert.equal(
    production(directBuildReady),
    null,
    'a browser-selected direct path validates the intake lane, not the legacy private lane',
  );
  for (const broken of [
    {
      HSB_CHECKOUT_DIRECT_UPLOAD: 'false',
      NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
    },
    {
      HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
      HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: GUARD_TOKEN,
    },
    {
      HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
      HSB_CHECKOUT_GUARD_MODE: 'durable',
    },
    {
      ...directBuildReady,
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: MALFORMED_TOKEN,
    },
    { ...directBuildReady, HSB_BLOB_NAMESPACE: 'bad/namespace' },
    { ...directBuildReady, HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: 'not-a-number' },
    { ...directBuildReady, HSB_CHECKOUT_GUARD_MAX_UPLOADS_PER_MINUTE: '-1' },
    { ...directBuildReady, HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: '1e6' },
    { ...directBuildReady, HSB_CHECKOUT_GUARD_MAX_FINALIZATIONS_PER_MINUTE: '2.5' },
    { ...directBuildReady, HSB_CHECKOUT_GUARD_MAX_REPLACEMENTS_PER_MINUTE: 'many' },
    { ...directBuildReady, HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: '0x10' },
  ]) {
    assert.match(production(broken) ?? '', /direct|intake|credential|guard|durable|namespace|minute|integer/i);
  }
});

test('a Vercel Production build can be released from the contract only by an explicit opt-out', () => {
  assert.equal(
    storyMediaBuildContractProblem(env({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      HSB_STORY_MEDIA_INTENT: 'disabled',
    })),
    null,
  );
  assert.match(
    storyMediaBuildContractProblem(env({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      HSB_STORY_MEDIA_INTENT: 'enabled',
    })) ?? '',
    new RegExp(STORY_MEDIA_PRIVATE_TOKEN_ENV),
  );
  assert.match(
    storyMediaBuildContractProblem(env({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      HSB_STORY_MEDIA_INTENT: 'off',
    })) ?? '',
    new RegExp(STORY_MEDIA_PRIVATE_TOKEN_ENV),
    'only the exact literal opts out; an unrecognised value fails closed',
  );
});

test('the build contract runs before next build and never prints a token value', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  const buildScript = pkg.scripts.build;
  const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(buildScript, /story-media/, 'the contract must be wired into the build lifecycle');
  assert.ok(
    buildScript.indexOf('story-media') < buildScript.indexOf('next build'),
    'the contract must run BEFORE next build',
  );
  assert.match(ciWorkflow, /run:\s*npm run build/, 'CI must execute the package-level build contract');
  assert.doesNotMatch(ciWorkflow, /run:\s*npx next build/, 'CI must not bypass the package-level build contract');

  const run = (extra: Record<string, string>) =>
    spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/check-story-media-env.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...extra,
      },
    });

  const ok = run({});
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);

  const failed = run({ VERCEL: '1', VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN });
  assert.equal(failed.status, 1);
  const output = `${failed.stdout}${failed.stderr}`;
  assert.match(output, new RegExp(STORY_MEDIA_PRIVATE_TOKEN_ENV));
  assert.doesNotMatch(output, /publicsecret|privatesecret/);
});

// ── End-to-end store routing, against the real orders.ts ────────────────────

const PUBLIC_STORE = 'pubstoretest';
const PRIVATE_STORE = 'privstoretest';

interface ScenarioOutput {
  steps: Record<string, { ok: boolean; value?: unknown; error?: { name: string; message: string } }>;
  journal: Array<{
    op: string;
    pathname: string | null;
    storeId: string;
    access: string | null;
    hasExplicitToken: boolean;
  }>;
  stores: Record<string, string[]>;
}

let cachedScenario: ScenarioOutput | null = null;

function runStoreScenario(): ScenarioOutput {
  if (cachedScenario) return cachedScenario;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      './tests/helpers/blob-fake-register.mjs',
      './tests/helpers/story-media-store-scenario.mjs',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const match = /__SCENARIO_JSON__([\s\S]*?)__END__/.exec(result.stdout);
  assert.ok(match, `no scenario JSON in output:\n${result.stdout}\n${result.stderr}`);
  cachedScenario = JSON.parse(match[1]) as ScenarioOutput;
  return cachedScenario;
}

const isStoryMedia = (pathname: string | null) => /\/(?:voice|document)-/.test(pathname ?? '');

test('voice and document bytes are written privately to the dedicated store', () => {
  const out = runStoreScenario();
  const puts = out.journal.filter((entry) => entry.op === 'put');
  const storyPuts = puts.filter((entry) => isStoryMedia(entry.pathname));

  assert.equal(storyPuts.length, 2, JSON.stringify(puts));
  for (const entry of storyPuts) {
    assert.equal(entry.storeId, PRIVATE_STORE, `${entry.pathname} landed in the wrong store`);
    assert.equal(entry.access, 'private');
    assert.equal(entry.hasExplicitToken, true, 'story media must never ride the ambient credential');
    assert.match(entry.pathname ?? '', /\/checkout-12345678-1234-4123-8123-123456789abc\//);
  }
  assert.match(storyPuts[0].pathname ?? '', /voice-/);
  assert.match(storyPuts[1].pathname ?? '', /document-/);
});

test('customer photos and their store stay exactly where they were', () => {
  const out = runStoreScenario();
  const photoPuts = out.journal.filter((entry) => entry.op === 'put' && !isStoryMedia(entry.pathname));

  assert.equal(photoPuts.length, 2, JSON.stringify(photoPuts));
  for (const entry of photoPuts) {
    assert.equal(entry.storeId, PUBLIC_STORE, `${entry.pathname} left the legacy order store`);
    assert.equal(entry.access, 'public', 'the public store rejects a private write');
  }
  assert.deepEqual(out.stores.unresolved, [], 'no write may land without a resolvable credential');
  assert.deepEqual(out.stores.unparseable, []);
});

test('a mixed rollback deletes each object through the credential for its own store', () => {
  const out = runStoreScenario();

  assert.equal(out.steps.rollbackMixed.ok, true, JSON.stringify(out.steps.rollbackMixed));
  assert.equal(out.steps.rollbackMixed.value, 4);

  const deletes = out.journal.filter((entry) => entry.op === 'del');
  assert.equal(deletes.length, 4, JSON.stringify(deletes));
  for (const entry of deletes) {
    assert.equal(
      entry.storeId,
      isStoryMedia(entry.pathname) ? PRIVATE_STORE : PUBLIC_STORE,
      `${entry.pathname} was deleted against ${entry.storeId}`,
    );
  }

  // The proof that the routing was real: both stores are empty afterwards.
  assert.deepEqual(out.stores[PUBLIC_STORE], []);
  assert.deepEqual(out.stores[PRIVATE_STORE], []);
});

test('a rollback path that cannot be classified is refused before any delete', () => {
  const out = runStoreScenario();

  assert.equal(out.steps.rollbackUnclassifiable.ok, false);
  assert.equal(out.steps.rollbackUnclassifiable.error?.name, 'OrderPersistenceError');
  assert.match(out.steps.rollbackUnclassifiable.error?.message ?? '', /mystery-object\.bin/);
  assert.equal(
    out.journal.filter((entry) => entry.op === 'del' && entry.pathname?.includes('mystery')).length,
    0,
  );
});
