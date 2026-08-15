/**
 * Guards the two runtime properties of the Playwright-managed Next server:
 * it must bind loopback ONLY, and its readiness budget must be strictly parsed.
 *
 * The binding assertion is not cosmetic. Before this change the config
 * ADDRESSED 127.0.0.1 (baseURL and the readiness url) while `next start` with
 * no -H bound 0.0.0.0 — so the server was reachable from the network and the
 * config merely looked loopback-only.
 *
 * These assert against the RESOLVED config object, not the source text. An
 * earlier version matched regexes over the file and was twice shown to be
 * bypassable — by a commented-out correct line, then by a trailing comment —
 * and would still have been fooled by a dead-but-live decoy containing a
 * correct `command:`. Importing the config removes that whole class: there is
 * exactly one effective value and this reads it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBSERVER_HOST,
  DEFAULT_WEBSERVER_TIMEOUT_MS,
  WEBSERVER_TIMEOUT_ENV,
  InvalidWebServerTimeoutError,
  resolveWebServerTimeoutMs,
} from './e2e/webserver-env.ts';

import playwrightConfig from '../playwright.config.ts';

/** The effective config Playwright will actually run. */
const CONFIG = playwrightConfig as {
  use: { baseURL: string };
  webServer: { command: string; url: string; timeout: number; env: Record<string, string> };
};
const { command, url, timeout, env } = CONFIG.webServer;

// ── loopback binding ─────────────────────────────────────────────────────────

test('the webServer command binds the server to loopback with -H', () => {
  assert.equal(WEBSERVER_HOST, '127.0.0.1');
  assert.match(
    command,
    /\bnext start\b.*\s-H\s+127\.0\.0\.1(\s|$)/,
    'next start must pass -H; without it Next binds 0.0.0.0 and the server is '
    + 'reachable off-machine even though Playwright dials 127.0.0.1',
  );
  // The only host the command may bind is loopback.
  const boundHosts = [...command.matchAll(/-H\s+(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(boundHosts, ['127.0.0.1']);
});

test('the port is still supplied explicitly and remains overridable', () => {
  assert.match(command, /\s-p\s+3178(\s|$)/, 'the -p flag must survive the -H addition');
  assert.match(url, /:3178\//);
});

test('every address Playwright dials is loopback', () => {
  assert.equal(CONFIG.use.baseURL, 'http://127.0.0.1:3178');
  assert.equal(url, 'http://127.0.0.1:3178/');
  for (const value of [command, url, CONFIG.use.baseURL]) {
    assert.doesNotMatch(value, /0\.0\.0\.0/);
    assert.doesNotMatch(value, /localhost/);
  }
});

// ── timeout: default ─────────────────────────────────────────────────────────

test('the readiness timeout defaults to 120000ms when unset', () => {
  assert.equal(DEFAULT_WEBSERVER_TIMEOUT_MS, 120_000);
  assert.equal(resolveWebServerTimeoutMs(undefined), 120_000);
});

test('the resolved webServer timeout is the strict default', () => {
  assert.equal(timeout, DEFAULT_WEBSERVER_TIMEOUT_MS);
});

test('the timeout variable is dedicated, not a provider or production name', () => {
  assert.equal(WEBSERVER_TIMEOUT_ENV, 'HSB_E2E_WEBSERVER_TIMEOUT_MS');
  for (const forbidden of ['VERCEL', 'BLOB', 'STRIPE', 'RESEND', 'OPENAI', 'FAL', 'LULU', 'GEMINI']) {
    assert.ok(!WEBSERVER_TIMEOUT_ENV.includes(forbidden), `must not reuse ${forbidden}`);
  }
});

// ── timeout: valid overrides ─────────────────────────────────────────────────

test('a valid CI override is honoured exactly', () => {
  assert.equal(resolveWebServerTimeoutMs('300000'), 300_000);
  assert.equal(resolveWebServerTimeoutMs('1'), 1);
  assert.equal(resolveWebServerTimeoutMs('120000'), 120_000);
  assert.equal(resolveWebServerTimeoutMs(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('the override is read from the dedicated environment variable', () => {
  const previous = process.env[WEBSERVER_TIMEOUT_ENV];
  try {
    process.env[WEBSERVER_TIMEOUT_ENV] = '240000';
    assert.equal(resolveWebServerTimeoutMs(), 240_000);
    delete process.env[WEBSERVER_TIMEOUT_ENV];
    assert.equal(resolveWebServerTimeoutMs(), DEFAULT_WEBSERVER_TIMEOUT_MS);
  } finally {
    if (previous === undefined) delete process.env[WEBSERVER_TIMEOUT_ENV];
    else process.env[WEBSERVER_TIMEOUT_ENV] = previous;
  }
});

// ── timeout: fail closed ─────────────────────────────────────────────────────

const MALFORMED: Array<[string, string]> = [
  ['zero', '0'],
  ['padded zero', '00'],
  ['negative', '-1'],
  ['negative large', '-300000'],
  ['explicit plus', '+300000'],
  ['fractional', '1.5'],
  ['whole-looking float', '120000.0'],
  ['exponent notation', '1e5'],
  ['hexadecimal', '0x1F'],
  ['leading zero', '0120000'],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['leading whitespace', ' 120000'],
  ['trailing whitespace', '120000 '],
  ['thousands separator', '120,000'],
  ['underscore separator', '120_000'],
  ['non-numeric', 'soon'],
  ['NaN literal', 'NaN'],
  ['Infinity literal', 'Infinity'],
  ['unit suffix', '120000ms'],
  ['beyond safe integer', '9007199254740993'],
  ['null literal', 'null'],
  ['boolean literal', 'true'],
];

for (const [label, value] of MALFORMED) {
  test(`a ${label} timeout fails closed rather than being coerced`, () => {
    assert.throws(
      () => resolveWebServerTimeoutMs(value),
      InvalidWebServerTimeoutError,
      `${JSON.stringify(value)} must be rejected, not silently accepted`,
    );
  });
}

test('the rejection message names the variable and the default', () => {
  try {
    resolveWebServerTimeoutMs('nope');
    assert.fail('expected a throw');
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /HSB_E2E_WEBSERVER_TIMEOUT_MS/);
    assert.match(message, /120000/);
    assert.match(message, /"nope"/, 'the offending value must be quoted back');
  }
});

// ── isolation guarantees must survive this change ────────────────────────────

test('credential blanking, store isolation, and the durable opt-out are intact', () => {
  for (const name of [
    'BLOB_READ_WRITE_TOKEN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY',
    'LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'STRIPE_SECRET_KEY',
  ]) {
    assert.equal(env[name], '', `${name} must still be blanked for the server`);
  }
  assert.match(env.HSB_ORDER_STORE_DIR, /\.e2e-store$/, 'the store must stay a throwaway');
  assert.equal(env.HSB_REQUIRE_DURABLE_PERSISTENCE, 'false');
});
