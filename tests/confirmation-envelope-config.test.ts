/**
 * The confirmation-envelope lane's credential, namespace, path grammar and
 * build gate (L-4 Slice A3-2).
 *
 * Everything here is pure: an environment object goes in, a closed refusal or
 * a resolved credential comes out. No SDK is imported by the module under test
 * and none is reachable from it, so "zero SDK calls" on these paths is a
 * structural property rather than an assertion about a spy — the store test
 * file proves the same property again with seams that throw if touched.
 *
 * Every token here is synthetic and follows the repository's existing test
 * convention (`vercel_blob_rw_<storeId>_<secret>`). No environment variable is
 * mutated: every function under test takes its environment as a parameter.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES,
  CONFIRMATION_ENVELOPE_ORDER_ID_RE,
  CONFIRMATION_ENVELOPE_PEER_TOKEN_ENVS,
  CONFIRMATION_ENVELOPE_READ_OPTIONS,
  CONFIRMATION_ENVELOPE_TOKEN_ENV,
  CONFIRMATION_ENVELOPE_WRITER_ENV,
  CONFIRMATION_ENVELOPE_WRITE_OPTIONS,
  confirmationEnvelopeBuildContractProblem,
  confirmationEnvelopeObjectPath,
  confirmationEnvelopeRefusalProblem,
  isConfirmationEnvelopeWriterEnabled,
  isVercelProductionBuild,
  resolveConfirmationEnvelopeStoreCredential,
  type ConfirmationEnvelopeStorageRefusal,
} from '../src/lib/confirmation-envelope-config.ts';
import { CONFIRMATION_ENVELOPE_LIMITS } from '../src/lib/confirmation-email-envelope.ts';

const tokenFor = (storeId: string, secret: string) => `vercel_blob_rw_${storeId}_${secret}`;

const ENVELOPE_TOKEN = tokenFor('EnvStore0001', 'envelopesecret01');
const ORDER_TOKEN = tokenFor('OrderStore001', 'ordersecret01');
const INTAKE_TOKEN = tokenFor('IntakeStore01', 'intakesecret01');
const GUARD_TOKEN = tokenFor('GuardStore001', 'guardsecret01');
const STORY_TOKEN = tokenFor('StoryStore001', 'storysecret01');
const FAMILY_TOKEN = tokenFor('FamilyStore01', 'familysecret01');

/**
 * Synthetic order ids are ASSEMBLED rather than written as literals.
 *
 * REQ16 (tests/review-snapshot-and-guards.test.ts) refuses any committable
 * line matching /\bord_[0-9a-f]{16,}\b/i, and this lane's own grammar is
 * exactly that shape — so a valid id written out would be indistinguishable
 * from a production identifier to the only guard that looks for one. The
 * assembled form still satisfies the grammar at runtime, which is what the
 * path tests need, and is obviously patterned.
 */
const SYNTHETIC_ID_BODY = 'a5f0'.repeat(4);
const VALID_ORDER_ID = `ord_${SYNTHETIC_ID_BODY}`;

/**
 * An environment literal, typed. This repository's `NodeJS.ProcessEnv`
 * declares `NODE_ENV` as required, so a bare object literal is not assignable;
 * the surrounding suites use the same cast.
 */
const asEnv = (value: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  value as NodeJS.ProcessEnv;

/** A fully configured, correct environment. Individual tests degrade it. */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [CONFIRMATION_ENVELOPE_TOKEN_ENV]: ENVELOPE_TOKEN,
    BLOB_READ_WRITE_TOKEN: ORDER_TOKEN,
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
    HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: GUARD_TOKEN,
    HSB_PRIVATE_READ_WRITE_TOKEN: STORY_TOKEN,
    FAMILY_REVIEW_DEST_BLOB_TOKEN: FAMILY_TOKEN,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

// ── S-1: the credential must be present at all ──────────────────────────────

test('an unset envelope credential is store_unconfigured', () => {
  for (const value of [undefined, '', '   ', '\t\n']) {
    const env = baseEnv();
    if (value === undefined) delete env[CONFIRMATION_ENVELOPE_TOKEN_ENV];
    else env[CONFIRMATION_ENVELOPE_TOKEN_ENV] = value;
    const result = resolveConfirmationEnvelopeStoreCredential(env);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.refusal, 'store_unconfigured');
  }
});

test('an unconfigured lane never falls back to the ambient order credential', () => {
  const env = baseEnv();
  delete env[CONFIRMATION_ENVELOPE_TOKEN_ENV];
  const result = resolveConfirmationEnvelopeStoreCredential(env);
  assert.equal(result.ok, false);
  // The ambient token is present and usable, and is still not adopted.
  assert.equal(env.BLOB_READ_WRITE_TOKEN, ORDER_TOKEN);
  assert.doesNotMatch(JSON.stringify(result), /vercel_blob_rw_/);
});

// ── S-2: shape ──────────────────────────────────────────────────────────────

test('a malformed credential is store_not_dedicated, by shape', () => {
  const malformed = [
    'nope',
    'vercel_blob_ro_EnvStore0001_envelopesecret01', // wrong prefix
    'vercel_blob_rw_EnvStore0001', // four segments
    'vercel_blob_rw_EnvStore0001_envelopesecret01_extra', // six segments
    tokenFor('short', 'envelopesecret01'), // store id under the minimum
    tokenFor('EnvStore0001', 'tiny'), // secret under the minimum
    tokenFor('Env-Store-01', 'envelopesecret01'), // non-alphanumeric segment
  ];
  for (const token of malformed) {
    const result = resolveConfirmationEnvelopeStoreCredential(
      baseEnv({ [CONFIRMATION_ENVELOPE_TOKEN_ENV]: token }),
    );
    assert.equal(result.ok, false, `expected refusal for ${token.slice(0, 18)}…`);
    assert.equal(result.ok === false && result.refusal, 'store_not_dedicated');
  }
});

// ── S-3 / S-4: store IDENTITY, not string inequality ────────────────────────

test('a different credential string naming a peer store id is store_not_dedicated', () => {
  const peers: Array<[keyof typeof CONFIRMATION_ENVELOPE_PEER_TOKEN_ENVS, string]> = [
    ['order', 'OrderStore001'],
    ['intake', 'IntakeStore01'],
    ['guard', 'GuardStore001'],
    ['story-media', 'StoryStore001'],
    ['family-review', 'FamilyStore01'],
  ];
  for (const [lane, storeId] of peers) {
    // A DIFFERENT string. Same store. This is the misconfiguration that a
    // whole-token comparison waves through, and it is the whole point.
    const collidingToken = tokenFor(storeId, 'adifferentsecret');
    const variable = CONFIRMATION_ENVELOPE_PEER_TOKEN_ENVS[lane];
    const env = baseEnv({ [CONFIRMATION_ENVELOPE_TOKEN_ENV]: collidingToken });
    assert.notEqual(collidingToken, env[variable], `${lane} fixture must differ as a string`);
    const result = resolveConfirmationEnvelopeStoreCredential(env);
    assert.equal(result.ok, false, `${lane} collision must be refused`);
    assert.equal(result.ok === false && result.refusal, 'store_not_dedicated');
  }
});

test('every peer lane named by the architecture is actually compared', () => {
  assert.deepEqual(Object.values(CONFIRMATION_ENVELOPE_PEER_TOKEN_ENVS), [
    'BLOB_READ_WRITE_TOKEN',
    'HSB_INTAKE_BLOB_READ_WRITE_TOKEN',
    'HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN',
    'HSB_PRIVATE_READ_WRITE_TOKEN',
    'FAMILY_REVIEW_DEST_BLOB_TOKEN',
  ]);
});

test('an unconfigured peer lane is skipped, not treated as a collision', () => {
  const env = baseEnv();
  delete env.FAMILY_REVIEW_DEST_BLOB_TOKEN;
  delete env.HSB_PRIVATE_READ_WRITE_TOKEN;
  const result = resolveConfirmationEnvelopeStoreCredential(env);
  assert.equal(result.ok, true);
});

test('a peer lane whose own credential is unparseable fails closed', () => {
  // Distinctness from a store whose identity cannot be determined cannot be
  // proven, and an identity we cannot determine must not be treated as
  // distinct from anything.
  const result = resolveConfirmationEnvelopeStoreCredential(
    baseEnv({ HSB_INTAKE_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_broken' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'store_not_dedicated');
});

// ── S-6: namespace ──────────────────────────────────────────────────────────

test('an invalid namespace is namespace_invalid and the credential does not resolve', () => {
  for (const namespace of ['has space', 'two/segments', '-leading', '.', 'x'.repeat(65)]) {
    const result = resolveConfirmationEnvelopeStoreCredential(
      baseEnv({ HSB_BLOB_NAMESPACE: namespace }),
    );
    assert.equal(result.ok, false, `namespace ${JSON.stringify(namespace)} must refuse`);
    assert.equal(result.ok === false && result.refusal, 'namespace_invalid');
  }
});

test('Vercel Preview without an explicit namespace is namespace_invalid', () => {
  const env = baseEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
  delete env.HSB_BLOB_NAMESPACE;
  const result = resolveConfirmationEnvelopeStoreCredential(env);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'namespace_invalid');
});

test('Preview may not aim the envelope lane at the production namespace', () => {
  const result = resolveConfirmationEnvelopeStoreCredential(
    baseEnv({ VERCEL: '1', VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'production' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'namespace_invalid');
});

test('the namespace is resolved once, into the credential', () => {
  const result = resolveConfirmationEnvelopeStoreCredential(
    baseEnv({ VERCEL: '1', VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'preview' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.credential.namespace, 'preview');
});

// ── S-7: the path grammar, checked BEFORE a path exists ─────────────────────

test('an order id failing the grammar yields no path at all', () => {
  const rejected = [
    '../etc',
    'ord_../etc',
    `ord_${SYNTHETIC_ID_BODY}/..`,
    `ord_${SYNTHETIC_ID_BODY.slice(0, 15)}`,
    `ord_${SYNTHETIC_ID_BODY}0`,
    `ord_${SYNTHETIC_ID_BODY.toUpperCase()}`,
    `ORD_${SYNTHETIC_ID_BODY}`,
    `ord_${SYNTHETIC_ID_BODY.slice(0, 14)}/x`,
    `ord_${SYNTHETIC_ID_BODY}\n`,
    'ord_zzzzzzzzzzzzzzzz',
    '',
  ];
  for (const orderId of rejected) {
    assert.equal(
      confirmationEnvelopeObjectPath(orderId, 'preview'),
      null,
      `${JSON.stringify(orderId)} must not produce a path`,
    );
    assert.equal(CONFIRMATION_ENVELOPE_ORDER_ID_RE.test(orderId), false);
  }
});

// ── P-2: path shape ─────────────────────────────────────────────────────────

test('the object path is the namespaced lane key and nothing else', () => {
  assert.equal(
    confirmationEnvelopeObjectPath(VALID_ORDER_ID, 'preview'),
    `preview/confirmation-envelopes/${VALID_ORDER_ID}/v1.json`,
  );
  // Production runs flat, for the same legacy reason the order store does.
  assert.equal(
    confirmationEnvelopeObjectPath(VALID_ORDER_ID, ''),
    `confirmation-envelopes/${VALID_ORDER_ID}/v1.json`,
  );
});

// ── S-8: unknown and noncanonical values fail closed ────────────────────────

test('only the exact literal true arms the writer', () => {
  for (const value of ['true']) {
    assert.equal(
      isConfirmationEnvelopeWriterEnabled(asEnv({ [CONFIRMATION_ENVELOPE_WRITER_ENV]: value })),
      true,
    );
  }
  for (const value of ['TRUE', 'True', '1', 'yes', 'on', 'enabled', 'true ', ' true', '', 'garbage']) {
    assert.equal(
      isConfirmationEnvelopeWriterEnabled(asEnv({ [CONFIRMATION_ENVELOPE_WRITER_ENV]: value })),
      false,
      `${JSON.stringify(value)} must not arm the writer`,
    );
  }
  assert.equal(isConfirmationEnvelopeWriterEnabled(asEnv({})), false);
});

test('access is a frozen literal that no environment value can reach', () => {
  assert.equal(CONFIRMATION_ENVELOPE_WRITE_OPTIONS.access, 'private');
  assert.equal(CONFIRMATION_ENVELOPE_WRITE_OPTIONS.allowOverwrite, false);
  assert.equal(CONFIRMATION_ENVELOPE_WRITE_OPTIONS.addRandomSuffix, false);
  assert.equal(CONFIRMATION_ENVELOPE_WRITE_OPTIONS.contentType, 'application/json');
  assert.equal(CONFIRMATION_ENVELOPE_READ_OPTIONS.access, 'private');
  assert.equal(CONFIRMATION_ENVELOPE_READ_OPTIONS.useCache, false);
  assert.ok(Object.isFrozen(CONFIRMATION_ENVELOPE_WRITE_OPTIONS));
  assert.ok(Object.isFrozen(CONFIRMATION_ENVELOPE_READ_OPTIONS));
});

test('the global order-store access switch cannot downgrade this lane', () => {
  // HSB_BLOB_ACCESS_MODE governs the PUBLIC order store. An envelope lane an
  // unknown or misspelled global could flip is the failure this slice exists
  // to prevent, so the resolved credential carries no access mode at all.
  for (const mode of ['public', 'private', 'garbage', '']) {
    const result = resolveConfirmationEnvelopeStoreCredential(
      baseEnv({ HSB_BLOB_ACCESS_MODE: mode }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      Object.keys(result.ok === true ? result.credential : {}).sort(),
      ['namespace', 'token'],
    );
  }
});

// ── The build gate ──────────────────────────────────────────────────────────

test('the build gate is silent everywhere but an armed Vercel Production build', () => {
  const broken = { [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true' };
  const unconfigured = baseEnv(broken);
  delete unconfigured[CONFIRMATION_ENVELOPE_TOKEN_ENV];

  // Local, CI, Preview, Development: no secret required even when armed.
  for (const where of [
    {},
    { VERCEL: '1', VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'preview' },
    { VERCEL: '1', VERCEL_ENV: 'development' },
    { VERCEL_ENV: 'production' }, // VERCEL blank: this is CI, not Vercel
    { VERCEL: '1' }, // VERCEL_ENV blank
  ]) {
    assert.equal(
      confirmationEnvelopeBuildContractProblem(asEnv({ ...unconfigured, ...where })),
      null,
      `${JSON.stringify(where)} must not require a secret`,
    );
  }
});

test('a Production build with the writer off never requires a credential', () => {
  const env = baseEnv({ VERCEL: '1', VERCEL_ENV: 'production' });
  delete env[CONFIRMATION_ENVELOPE_TOKEN_ENV];
  assert.equal(confirmationEnvelopeBuildContractProblem(asEnv(env)), null);
  for (const value of ['', 'false', 'TRUE', '1', 'enabled', 'garbage']) {
    assert.equal(
      confirmationEnvelopeBuildContractProblem(asEnv({ ...env, [CONFIRMATION_ENVELOPE_WRITER_ENV]: value })),
      null,
      `writer=${JSON.stringify(value)} must leave the gate disarmed`,
    );
  }
});

test('an armed Production build refuses a missing, colliding or unparseable credential', () => {
  const armed = (overrides: Record<string, string | undefined> = {}) =>
    baseEnv({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true',
      ...overrides,
    });

  const missing = armed();
  delete missing[CONFIRMATION_ENVELOPE_TOKEN_ENV];
  const missingProblem = confirmationEnvelopeBuildContractProblem(missing);
  assert.match(String(missingProblem), /HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN is not set/);

  const colliding = armed({
    [CONFIRMATION_ENVELOPE_TOKEN_ENV]: tokenFor('OrderStore001', 'adifferentsecret'),
  });
  assert.match(String(confirmationEnvelopeBuildContractProblem(colliding)), /Blob store of its own/);

  const malformed = armed({ [CONFIRMATION_ENVELOPE_TOKEN_ENV]: 'nope' });
  assert.ok(confirmationEnvelopeBuildContractProblem(malformed));

  const badNamespace = armed({ HSB_BLOB_NAMESPACE: 'two/segments' });
  assert.match(String(confirmationEnvelopeBuildContractProblem(badNamespace)), /HSB_BLOB_NAMESPACE/);
});

test('an armed Production build passes on a correct configuration', () => {
  assert.equal(
    confirmationEnvelopeBuildContractProblem(
      baseEnv({
        VERCEL: '1',
        VERCEL_ENV: 'production',
        [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true',
      }),
    ),
    null,
  );
});

test('no build-gate output can contain a credential value', () => {
  const armed = baseEnv({
    VERCEL: '1',
    VERCEL_ENV: 'production',
    [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true',
  });
  const cases = [
    { ...armed, [CONFIRMATION_ENVELOPE_TOKEN_ENV]: 'nope' },
    { ...armed, [CONFIRMATION_ENVELOPE_TOKEN_ENV]: tokenFor('OrderStore001', 'adifferentsecret') },
    { ...armed, HSB_BLOB_NAMESPACE: 'two/segments' },
  ];
  for (const env of cases) {
    const problem = String(confirmationEnvelopeBuildContractProblem(asEnv(env)));
    assert.ok(problem.length > 0);
    assert.doesNotMatch(problem, /vercel_blob_rw_/);
    for (const secret of ['envelopesecret01', 'adifferentsecret', 'EnvStore0001', 'OrderStore001']) {
      assert.ok(!problem.includes(secret), `problem string leaked ${secret}`);
    }
  }
});

test('every closed refusal maps to a printable problem, none of them silence', () => {
  // The resolver returns only three of these. The rest are reachable only
  // through this mapping, so a fallback that returned "no problem" would be
  // invisible to the gate's own tests — which is why the mapping is tested
  // directly rather than only through the gate.
  const closed: ConfirmationEnvelopeStorageRefusal[] = [
    'store_unconfigured',
    'store_not_dedicated',
    'namespace_invalid',
    'path_invalid',
    'store_not_private',
    'object_exists',
    'not_found',
    'read_failed',
    'write_failed',
    'delete_failed',
    'invalid_object',
    'too_large',
    'digest_mismatch',
  ];
  for (const refusal of closed) {
    const problem = confirmationEnvelopeRefusalProblem(refusal);
    assert.ok(problem.length > 0, `${refusal} must produce a message`);
    assert.doesNotMatch(problem, /vercel_blob_rw_/);
  }
});

test('isVercelProductionBuild needs both Vercel signals', () => {
  assert.equal(isVercelProductionBuild(asEnv({ VERCEL: '1', VERCEL_ENV: 'production' })), true);
  assert.equal(isVercelProductionBuild(asEnv({ VERCEL_ENV: 'production' })), false);
  assert.equal(isVercelProductionBuild(asEnv({ VERCEL: '1', VERCEL_ENV: 'preview' })), false);
  assert.equal(isVercelProductionBuild(asEnv({})), false);
});

// ── Ceilings ────────────────────────────────────────────────────────────────

test('the object ceiling is the canonical request ceiling plus a bounded header', () => {
  assert.ok(CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES > CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes);
  assert.equal(
    CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES - CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes,
    4_096,
  );
});
