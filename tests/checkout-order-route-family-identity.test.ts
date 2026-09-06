/*
 * The stable-id bypass, proven at the `/api/order` POST boundary itself.
 *
 * The helper-level suite (checkout-family-identity-alignment.test.ts) proves
 * the alignment rule; this proves the ROUTE applies it, and applies it early
 * enough. That distinction is the whole finding: the defect was never in a
 * helper, it was the route deriving an index by looking a bound id up in a
 * client-supplied array —
 *
 *   familyCharacterIds.indexOf(binding.familyCharacterId)
 *
 * — so a request that declared its ids in one order and its characters in
 * another moved the photo exemption onto a character who had uploaded nothing
 * and written nothing.
 *
 * How this runs the real route
 * ----------------------------
 * `src/app/api/order/route.ts` is the one file in the repo that imports
 * through the `@/…` tsconfig alias, which the node runner does not resolve —
 * hence the long-standing "the route cannot be imported under node:test" note
 * in checkout-direct-order-wiring.test.ts. Each scenario therefore runs in a
 * CHILD process with a module-resolve hook that maps the alias to the real
 * `src/` modules and swaps exactly three external edges — `next/server`,
 * `stripe`, `@vercel/blob` — plus `@/lib/orders`, which re-exports the REAL
 * module behind a journal. The route's own logic is unmodified and no seam was
 * added to production code. Same pattern as the two-store isolation harness.
 *
 * Everything is synthetic: no store, no account, no customer, no network. The
 * journal is how "nothing external happened" is asserted rather than assumed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

interface JournalEntry {
  surface: 'orders' | 'stripe' | 'blob';
  op: string;
  detail: unknown;
}

interface ScenarioResult {
  scenario: string;
  status: number;
  body: { error?: string; code?: string } | null;
  journal: JournalEntry[];
}

/** Synthetic values. Deliberately not resolvable to any real account or store. */
const CHILD_ENV = {
  HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
  STRIPE_PRODUCT_DIGITAL_ID: 'prod_TestDigital',
  HSB_STRIPE_SECRET_KEY: 'sk_test_journalled',
  HSB_CHECKOUT_PAUSED: 'false',
};

function runScenario(name: string): ScenarioResult {
  const raw = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      resolve(process.cwd(), 'tests/helpers/order-route-register.mjs'),
      resolve(process.cwd(), 'tests/helpers/order-route-scenario.mjs'),
      name,
    ],
    { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, ...CHILD_ENV }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const match = raw.match(/__SCENARIO_JSON__([\s\S]*?)__END__/);
  assert.ok(match, `scenario ${name} produced no result payload:\n${raw}`);
  return JSON.parse(match[1]!) as ScenarioResult;
}

const surfaces = (r: ScenarioResult, surface: JournalEntry['surface']) =>
  r.journal.filter((entry) => entry.surface === surface);

// ── the defect ──────────────────────────────────────────────────────────────

test('a reordered familyCharacterIds request is refused by POST /api/order with 400', () => {
  const r = runScenario('reordered');

  assert.equal(r.status, 400);
  assert.equal(r.body?.code, 'direct_intake_family_identity_mismatch');
  assert.match(r.body?.error ?? '', /No charge was made/);
});

test('the reordered request touches no durable order, blob, or Stripe surface', () => {
  const r = runScenario('reordered');

  assert.deepEqual(r.journal, [], 'a refused request must make no external call at all');
  assert.equal(surfaces(r, 'orders').length, 0, 'no order record was created or persisted');
  assert.equal(surfaces(r, 'blob').length, 0, 'no durable media surface was touched');
  assert.equal(surfaces(r, 'stripe').length, 0, 'no Stripe client was constructed');
});

test('the refusal lands before createOrderRecord, persistence, and Stripe', () => {
  const r = runScenario('reordered');
  for (const op of [
    'createOrderRecord',
    'persistOrResumeCheckoutOrder',
    'withOrderTransaction',
    'uploadOrderPhoto',
    'uploadOrderSupportingPhoto',
    'bindOrderCheckoutSession',
  ]) {
    assert.equal(
      r.journal.some((entry) => entry.op === op),
      false,
      `${op} must not run for a misaligned identity`,
    );
  }
});

test('an identity that names characters this request does not carry is refused', () => {
  for (const scenario of ['foreign', 'idless']) {
    const r = runScenario(scenario);
    assert.equal(r.status, 400, `${scenario} must be refused`);
    assert.equal(r.body?.code, 'direct_intake_family_identity_mismatch', scenario);
    assert.deepEqual(r.journal, [], `${scenario} must make no external call`);
  }
});

// ── what must keep working ──────────────────────────────────────────────────

test('the aligned request still enforces the description the reorder was evading', () => {
  const r = runScenario('aligned');

  // Bo owns the photo and wrote a description; Nana has neither. The gate the
  // reorder was built to slip past fires, and names the right person.
  assert.equal(r.status, 400);
  assert.equal(r.body?.code, 'supporting_character_details_required');
  assert.match(r.body?.error ?? '', /Nana/);
  assert.equal(r.body?.error?.includes('Uncle Bo'), false, 'Bo is described and must not be named');
  assert.deepEqual(r.journal, [], 'the description gate also refuses before any external call');
});

test('an aligned request whose characters are all covered proceeds past the gate', () => {
  const r = runScenario('aligned-nana-photo');

  // Nana owns the photo, Bo wrote a description: nothing is missing, so the
  // route moves on and builds the order record. The refusal is specific, not a
  // blanket block on the direct path.
  assert.notEqual(r.body?.code, 'direct_intake_family_identity_mismatch');
  assert.notEqual(r.body?.code, 'supporting_character_details_required');
  assert.ok(
    r.journal.some((entry) => entry.op === 'createOrderRecord'),
    'a valid direct request must still reach the order record',
  );
  // It stops at the intake store, which this synthetic child does not
  // configure — so still no Stripe, and still no charge.
  assert.equal(surfaces(r, 'stripe').length, 0);
});
