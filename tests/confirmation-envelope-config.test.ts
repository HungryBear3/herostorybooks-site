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
import * as envelopeConfig from '../src/lib/confirmation-envelope-config.ts';
import { CONFIRMATION_ENVELOPE_LIMITS } from '../src/lib/confirmation-email-envelope.ts';
import { CONFIRMATION_EMAIL_LEGACY_T193_FLOOR_AT } from '../src/lib/confirmation-email-state.ts';

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

/**
 * A3-4 R2 (§11.1). The build contract always refuses an armed Vercel
 * Production build: the snapshot producer alone sends no confirmation email,
 * and only the accepted frozen dispatcher (A3-5) may lift this interlock. The
 * epoch and credential validation it used to perform now lives in
 * `confirmationEnvelopeWriterConfigProblem`, tested directly here.
 */
const ACTIVATION_INTERLOCK_PROBLEM =
  'HSB_CONFIRMATION_ENVELOPE_WRITER cannot be armed on a Vercel deployment until the frozen dispatcher '
  + '(L-4 A3-5) is accepted: the snapshot producer alone sends no confirmation email';

/** A canonical writer epoch at or after the floor. */
const VALID_EPOCH = '2026-10-15T12:00:00.000Z';

test('an armed Production build refuses a missing, colliding or unparseable credential', () => {
  // A3-4 R2 AM-C3 (CA-2): the same assertions, redirected to the writer
  // configuration problem with a valid epoch; the build contract refuses each
  // of these environments with the activation interlock.
  const armed = (overrides: Record<string, string | undefined> = {}) =>
    baseEnv({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true',
      HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: VALID_EPOCH,
      ...overrides,
    });
  const problemOf = (env: NodeJS.ProcessEnv) => envelopeConfig.confirmationEnvelopeWriterConfigProblem(env);

  const missing = armed();
  delete missing[CONFIRMATION_ENVELOPE_TOKEN_ENV];
  const missingProblem = problemOf(missing);
  assert.match(String(missingProblem), /HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN is not set/);

  const colliding = armed({
    [CONFIRMATION_ENVELOPE_TOKEN_ENV]: tokenFor('OrderStore001', 'adifferentsecret'),
  });
  assert.match(String(problemOf(colliding)), /Blob store of its own/);

  const malformed = armed({ [CONFIRMATION_ENVELOPE_TOKEN_ENV]: 'nope' });
  assert.ok(problemOf(malformed));

  const badNamespace = armed({ HSB_BLOB_NAMESPACE: 'two/segments' });
  assert.match(String(problemOf(badNamespace)), /HSB_BLOB_NAMESPACE/);

  for (const env of [missing, colliding, malformed, badNamespace]) {
    assert.equal(confirmationEnvelopeBuildContractProblem(env), ACTIVATION_INTERLOCK_PROBLEM);
  }
});

test('an armed Production build is refused by the A3-4 activation interlock even on a correct configuration', () => {
  // A3-4 R2 AM-C2 (CA-1).
  const env = baseEnv({
    VERCEL: '1',
    VERCEL_ENV: 'production',
    [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true',
  });
  assert.equal(confirmationEnvelopeBuildContractProblem(env), ACTIVATION_INTERLOCK_PROBLEM);
  assert.equal(
    envelopeConfig.confirmationEnvelopeWriterConfigProblem(
      asEnv({ ...env, HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: VALID_EPOCH }),
    ),
    null,
  );
});

test('no build-gate output can contain a credential value', () => {
  const armed = baseEnv({
    VERCEL: '1',
    VERCEL_ENV: 'production',
    [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true',
    HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: VALID_EPOCH,
  });
  const cases = [
    { ...armed, [CONFIRMATION_ENVELOPE_TOKEN_ENV]: 'nope' },
    { ...armed, [CONFIRMATION_ENVELOPE_TOKEN_ENV]: tokenFor('OrderStore001', 'adifferentsecret') },
    { ...armed, HSB_BLOB_NAMESPACE: 'two/segments' },
  ];
  // A3-4 R2 AM-C4 (CA-3): both the build contract and the writer
  // configuration problem are held to the leak assertions.
  const gates: Array<[string, (env: NodeJS.ProcessEnv) => string | null]> = [
    ['build contract', confirmationEnvelopeBuildContractProblem],
    ['writer configuration', (env) => envelopeConfig.confirmationEnvelopeWriterConfigProblem(env)],
  ];
  for (const env of cases) {
    for (const [label, gate] of gates) {
      const problem = String(gate(asEnv(env)));
      assert.ok(problem.length > 0, `${label} must name a problem`);
      assert.doesNotMatch(problem, /vercel_blob_rw_/);
      for (const secret of ['envelopesecret01', 'adifferentsecret', 'EnvStore0001', 'OrderStore001']) {
        assert.ok(!problem.includes(secret), `${label} problem string leaked ${secret}`);
      }
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
    'object_mismatch',
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

// ── A3-4 R2 AM-C5: the writer configuration (CF rows) ───────────────────────
//
// `resolveConfirmationEnvelopeWriterConfig` is pure: it reads only the
// environment object it is given and returns the first failure in the order
// flag_off, activation_interlock, epoch_missing, epoch_invalid,
// epoch_before_floor, binding_invalid, namespace_invalid.

const EPOCH_ENV = 'HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH';
const FLOOR_AT = '2026-09-21T12:48:51.665Z';

function writerEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return baseEnv({ [CONFIRMATION_ENVELOPE_WRITER_ENV]: 'true', [EPOCH_ENV]: VALID_EPOCH, ...overrides });
}

/** A proxy over a plain copy that records every key read (names only). */
function recordingEnv(source: Record<string, string | undefined>) {
  const reads: string[] = [];
  const env = new Proxy({ ...source }, {
    get(target, key, receiver) {
      if (typeof key === 'string') reads.push(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === 'string') reads.push(key);
      return Reflect.has(target, key);
    },
  }) as unknown as NodeJS.ProcessEnv;
  return { env, reads };
}

const resolveWriter = (env: NodeJS.ProcessEnv, bindings?: { accountLabel: string; templateVersion: string }) =>
  envelopeConfig.resolveConfirmationEnvelopeWriterConfig(env, bindings);
const reasonOf = (result: ReturnType<typeof resolveWriter>) => (result.armed === true ? 'armed' : result.reason);

test('CF-1: anything but the exact literal true is flag_off, and nothing else is read', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
    const { env, reads } = recordingEnv({ [CONFIRMATION_ENVELOPE_WRITER_ENV]: flag, [EPOCH_ENV]: 'garbage' });
    assert.equal(reasonOf(resolveWriter(env)), 'flag_off', `flag=${JSON.stringify(flag)}`);
    assert.deepEqual([...new Set(reads)], [CONFIRMATION_ENVELOPE_WRITER_ENV], `flag=${JSON.stringify(flag)} read more than the flag`);
  }
});

test('CF-2: an armed writer on any Vercel deployment is activation_interlock, ahead of every later fault', () => {
  assert.equal(reasonOf(resolveWriter(writerEnv({ VERCEL: '1' }))), 'activation_interlock');
  for (const vercelEnv of ['production', 'preview', 'development']) {
    assert.equal(reasonOf(resolveWriter(writerEnv({ VERCEL: '1', VERCEL_ENV: vercelEnv }))), 'activation_interlock');
  }
  assert.equal(reasonOf(resolveWriter(writerEnv({ VERCEL: '1', [EPOCH_ENV]: undefined }))), 'activation_interlock');
});

test('CF-3: a missing epoch is epoch_missing, never a default', () => {
  assert.equal(reasonOf(resolveWriter(writerEnv({ [EPOCH_ENV]: undefined }))), 'epoch_missing');
  assert.equal(reasonOf(resolveWriter(writerEnv({ [EPOCH_ENV]: '' }))), 'epoch_missing');
});

test('CF-4: a noncanonical epoch is epoch_invalid, identically in every time zone', () => {
  for (const epoch of [
    '2026-10-15T12:00:00Z',
    '2026-10-15T12:00:00.000+00:00',
    '2026-10-15T12:00:00.000',
    ' 2026-10-15T12:00:00.000Z',
    '2026-10-15T12:00:00.000Z ',
    '2026-09-31T00:00:00.000Z',
    'not-an-instant',
  ]) {
    assert.equal(reasonOf(resolveWriter(writerEnv({ [EPOCH_ENV]: epoch }))), 'epoch_invalid', JSON.stringify(epoch));
  }
});

test('CF-5 / CF-6: the epoch floor is inclusive', () => {
  const before = new Date(Date.parse(FLOOR_AT) - 1).toISOString();
  assert.equal(reasonOf(resolveWriter(writerEnv({ [EPOCH_ENV]: before }))), 'epoch_before_floor');
  const atFloor = resolveWriter(writerEnv({ [EPOCH_ENV]: FLOOR_AT }));
  assert.equal(reasonOf(atFloor), 'armed');
  assert.equal(atFloor.armed === true && atFloor.epochMs, Date.parse(FLOOR_AT));
  assert.equal(atFloor.armed === true && atFloor.epochAt, FLOOR_AT);
});

test('CF-7: the writer epoch floor restates the legacy T193 floor exactly', () => {
  assert.equal(envelopeConfig.CONFIRMATION_ENVELOPE_WRITER_EPOCH_FLOOR_AT, CONFIRMATION_EMAIL_LEGACY_T193_FLOOR_AT);
  assert.equal(envelopeConfig.CONFIRMATION_ENVELOPE_WRITER_EPOCH_FLOOR_AT, FLOOR_AT);
  assert.equal(envelopeConfig.CONFIRMATION_ENVELOPE_WRITER_EPOCH_ENV, EPOCH_ENV);
});

test('CF-8: an unusable account label or template version is binding_invalid', () => {
  const good = {
    accountLabel: envelopeConfig.CONFIRMATION_ENVELOPE_ACCOUNT_LABEL,
    templateVersion: envelopeConfig.CONFIRMATION_ENVELOPE_TEMPLATE_VERSION,
  };
  for (const bad of ['', 'x'.repeat(257), 'bad\n', 'UPPER']) {
    assert.equal(reasonOf(resolveWriter(writerEnv(), { ...good, accountLabel: bad })), 'binding_invalid', JSON.stringify(bad));
    assert.equal(reasonOf(resolveWriter(writerEnv(), { ...good, templateVersion: bad })), 'binding_invalid', JSON.stringify(bad));
  }
  assert.equal(reasonOf(resolveWriter(writerEnv(), good)), 'armed');
});

test('CF-10: both binding constants satisfy both grammars', () => {
  for (const value of [envelopeConfig.CONFIRMATION_ENVELOPE_ACCOUNT_LABEL, envelopeConfig.CONFIRMATION_ENVELOPE_TEMPLATE_VERSION]) {
    assert.match(value, /^[\x20-\x7E]{1,256}$/);
    assert.match(value, /^[a-z0-9][a-z0-9.-]{0,63}$/);
  }
  assert.equal(envelopeConfig.CONFIRMATION_ENVELOPE_ACCOUNT_LABEL, 'hsb-resend-primary-v1');
  assert.equal(envelopeConfig.CONFIRMATION_ENVELOPE_TEMPLATE_VERSION, 'hsb-order-confirmation-v1');
});

test('CF-namespace: an armed configuration carries the namespace of the environment it was given', () => {
  const armed = resolveWriter(writerEnv({ HSB_BLOB_NAMESPACE: 'ns-a' }));
  assert.equal(armed.armed === true && armed.namespace, 'ns-a');
  const flat = resolveWriter(writerEnv());
  assert.equal(flat.armed === true && flat.namespace, '');
  assert.equal(reasonOf(resolveWriter(writerEnv({ HSB_BLOB_NAMESPACE: 'a/b' }))), 'namespace_invalid');
  assert.equal(reasonOf(resolveWriter(writerEnv({ VERCEL_ENV: 'preview' }))), 'namespace_invalid');
});

test('CF-14: writer-configuration and build-contract problems name the fault and never a value', () => {
  const problems = [
    envelopeConfig.confirmationEnvelopeWriterConfigProblem(writerEnv({ [EPOCH_ENV]: undefined })),
    envelopeConfig.confirmationEnvelopeWriterConfigProblem(writerEnv({ [EPOCH_ENV]: 'garbage' })),
    envelopeConfig.confirmationEnvelopeWriterConfigProblem(writerEnv({ [EPOCH_ENV]: '2026-01-01T00:00:00.000Z' })),
    envelopeConfig.confirmationEnvelopeWriterConfigProblem(writerEnv({ [CONFIRMATION_ENVELOPE_TOKEN_ENV]: 'nope' })),
    envelopeConfig.confirmationEnvelopeWriterConfigProblem(
      writerEnv({ [CONFIRMATION_ENVELOPE_TOKEN_ENV]: tokenFor('OrderStore001', 'adifferentsecret') }),
    ),
    confirmationEnvelopeBuildContractProblem(writerEnv({ VERCEL: '1', VERCEL_ENV: 'production' })),
  ];
  for (const problem of problems) {
    assert.ok(typeof problem === 'string' && problem.length > 0);
    assert.doesNotMatch(problem!, /vercel_blob_rw_/);
    for (const secret of ['envelopesecret01', 'adifferentsecret', 'EnvStore0001', 'OrderStore001', 'garbage']) {
      assert.ok(!problem!.includes(secret), `problem leaked ${secret}`);
    }
  }
  assert.match(String(problems[0]), /HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH/);
  assert.equal(envelopeConfig.confirmationEnvelopeWriterConfigProblem(baseEnv()), null, 'writer off: no problem');
});

test('CF-18: the writer namespace resolver is pure and agrees with getBlobNamespace', () => {
  const cases: Array<[Record<string, string | undefined>, { ok: true; namespace: string } | { ok: false }]> = [
    [{}, { ok: true, namespace: '' }],
    [{ HSB_BLOB_NAMESPACE: 'ns-a' }, { ok: true, namespace: 'ns-a' }],
    [{ VERCEL_ENV: 'development' }, { ok: true, namespace: 'development' }],
    [{ HSB_BLOB_NAMESPACE: ' ns-a' }, { ok: false }],
    [{ HSB_BLOB_NAMESPACE: 'a/b' }, { ok: false }],
    [{ VERCEL_ENV: 'preview' }, { ok: false }],
  ];
  const ambient = process.env;
  const ambientReads: string[] = [];
  process.env = new Proxy({ ...ambient }, {
    get(target, key, receiver) {
      if (typeof key === 'string') ambientReads.push(key);
      return Reflect.get(target, key, receiver);
    },
  }) as NodeJS.ProcessEnv;
  try {
    for (const [values, expected] of cases) {
      assert.deepEqual(envelopeConfig.resolveConfirmationEnvelopeWriterNamespace(asEnv(values)), expected, JSON.stringify(values));
    }
  } finally {
    process.env = ambient;
  }
  assert.deepEqual(ambientReads, [], 'the resolver must read only the environment it is given');
});
