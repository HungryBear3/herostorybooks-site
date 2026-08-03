/**
 * Source guards for the customer editable-review surface.
 *
 * 1. No real customer / order identifier may appear in committed source. The
 *    review work started from a specific real order's package; names, order ids
 *    and artifact paths from it must never be checked in, in code OR fixtures.
 *
 * 2. Every customer review route must pass a CUSTOMER actor into the service.
 *    The service defaults to the internal actor for operator/system callers, so
 *    a route that forgot to pass one would silently skip the capability check.
 *    This guard makes that impossible to merge.
 *
 * Both are static reads of the repository — no network, no order access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO = process.cwd();

/**
 * Everything that could end up in a commit: git-tracked files PLUS
 * untracked-but-not-ignored ones, across the WHOLE repository — not just
 * src/tests/scripts, because QA artifacts and scratch notes at the repo root
 * are exactly where verbatim customer strings tend to land.
 *
 * Paths excluded by .gitignore are skipped deliberately and visibly there
 * (the order-scoped review tool, its virtualenv, evidence bundles). Relying on
 * a tracked-only scan would instead make the guard depend on staging order:
 * `npm test` before `git add` would pass, and the commit would still carry the
 * identifier.
 */
/**
 * Inverted on purpose: scan EVERYTHING except known-binary payloads, rather
 * than allow-listing extensions. An allowlist silently skips whatever nobody
 * thought of (.csv, .jsonl, .har, extensionless notes) — which is exactly where
 * a pasted customer record tends to land.
 */
const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|ico|svgz|pdf|zip|gz|tgz|bz2|xz|7z|woff2?|ttf|otf|eot|mp[34]|mov|mp4|webm|wav|ogg|bin|wasm|node|dylib|so|dll|exe|class|jar|db|sqlite3?|lock)$/i;

function sourceFiles(): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean);
  return listed.filter((f) => !BINARY_EXTENSIONS.test(f)).map((f) => path.join(REPO, f));
}

// ── 1. No real customer / order identifiers ────────────────────────────────

/**
 * Identifiers carried over from the real order package this work started from.
 * Kept as split literals so this guard file does not itself contain a
 * greppable copy of the identifier it bans.
 */
const BANNED: Array<{ label: string; pattern: RegExp }> = [
  { label: 'real recipient first name', pattern: new RegExp(`\\b${['P', 'eter'].join('')}\\b`, 'i') },
  { label: 'real child name', pattern: new RegExp(`\\b${['B', 'enny'].join('')}\\b`, 'i') },
  {
    label: 'real order id',
    pattern: new RegExp(['ord_', '217450cb153f4543'].join(''), 'i'),
  },
  { label: 'order-scoped artifact path', pattern: /review-v2-cc/i },
  { label: 'shared bookgen runs path', pattern: /hsb-bookgen-runs/i },
];

test('committed source contains no real customer or order identifiers', () => {
  const violations: string[] = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(REPO, file);
    if (rel === path.join('tests', 'review-source-guards.test.ts')) continue; // this file
    let text: string;
    try {
      const buf = readFileSync(file);
      if (buf.subarray(0, 8192).includes(0)) continue; // binary payload
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    for (const { label, pattern } of BANNED) {
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (pattern.test(line)) violations.push(`${rel}:${i + 1} [${label}] ${line.trim().slice(0, 100)}`);
      });
    }
  }
  assert.deepEqual(
    violations,
    [],
    `real customer/order identifiers must never be committed:\n${violations.join('\n')}`,
  );
});

test('review fixtures use obviously synthetic names and hosts', () => {
  const reviewTests = sourceFiles().filter((f) => /tests\/(review|order-guarded|editable-review|customer-text)/.test(f));
  assert.ok(reviewTests.length >= 5, 'expected the review test suite to be present');
  for (const file of reviewTests) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // tracked-but-deleted, mid-rebase, etc.
    }
    // Fixture addresses must be unmistakably synthetic. The risk being guarded
    // is a REAL customer address landing in a committed fixture, so reserved
    // test domains and trivial placeholders (a@b.com) both qualify; anything
    // that looks like a real personal mailbox does not.
    const emails = text.match(/['"][A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}['"]/g) ?? [];
    const SYNTHETIC =
      /@(example\.(com|org|net|invalid)|[a-z0-9-]+\.(invalid|test|local|localhost))['"]|^['"][a-z]{1,2}@[a-z]{1,2}\.(com|org|net)['"]$/i;
    for (const e of emails) {
      assert.ok(
        SYNTHETIC.test(e),
        `${path.relative(REPO, file)}: fixture email must be unmistakably synthetic, got ${e}`,
      );
    }
  }
});

// ── 2. Every customer review route passes a customer actor ─────────────────

const CUSTOMER_REVIEW_ROUTES = [
  'src/app/api/order/[orderId]/accept-page/route.ts',
  'src/app/api/order/[orderId]/regenerate-page/route.ts',
  'src/app/api/order/[orderId]/acknowledge-proof/route.ts',
  'src/app/api/order/[orderId]/approve-whole-book/route.ts',
];

test('every customer review route authorizes AND passes a customer actor to the service', () => {
  for (const rel of CUSTOMER_REVIEW_ROUTES) {
    const text = readFileSync(path.join(REPO, rel), 'utf8');
    assert.match(
      text,
      /authorizeCustomerReviewWrite\(/,
      `${rel}: must run route-level authorization`,
    );
    assert.match(
      text,
      /customerReviewActor\(\s*auth\.reviewToken\s*\)/,
      `${rel}: must pass the presented capability into the service so it can be revalidated ` +
        'inside the guarded transaction (route preauthorization is only an optimization)',
    );
    assert.doesNotMatch(
      text,
      /INTERNAL_REVIEW_ACTOR/,
      `${rel}: a customer route must never use the internal actor`,
    );
  }
});

test('the wording-change route forwards the presented token to the service', () => {
  const rel = 'src/app/api/order/[orderId]/request-text-change/route.ts';
  const text = readFileSync(path.join(REPO, rel), 'utf8');
  assert.match(text, /authorizeCustomerReviewWrite\(/, `${rel}: must authorize`);
  assert.match(
    text,
    /reviewToken/,
    `${rel}: must forward the token so saveTextChangeRequest can revalidate it`,
  );
});

test('the review-route authorizer surfaces the validated token for revalidation', () => {
  const text = readFileSync(path.join(REPO, 'src/lib/review-route-auth.ts'), 'utf8');
  assert.match(text, /reviewToken\?: string \| null/, 'auth result must carry the token');
  assert.match(text, /return \{ ok: true, reviewToken: token \}/, 'must return it on success');
});

// ── 3. The unconditional proof persist is not reachable from review flows ──

test('review flows never call the unconditional rebuild as their production path', () => {
  const pageReview = readFileSync(path.join(REPO, 'src/lib/page-review.ts'), 'utf8');
  // The only permitted references are the legacy TEST-ONLY dep declarations and
  // the shim that consumes them; the production default must be build-only.
  assert.match(
    pageReview,
    /deps\.buildProof \?\? buildProofArtifactFromPageArtifacts/,
    'the production proof path must be the build-only helper',
  );
  assert.match(
    pageReview,
    /@deprecated TEST-ONLY legacy shim/,
    'the unconditional rebuild dep must be marked test-only',
  );
  // page-review must not itself call updateFulfillmentState for proof fields.
  // No `s` flag: [^)] already spans newlines, and the flag is above this project's TS target.
  const proofPersist = /updateFulfillmentState\([^)]*storyArtifactUrl/;
  assert.doesNotMatch(
    pageReview,
    proofPersist,
    'page-review must never persist storyArtifactUrl through an unconditional write',
  );
});

test('buildProofArtifactFromPageArtifacts persists nothing', () => {
  const fulfillment = readFileSync(path.join(REPO, 'src/lib/fulfillment.ts'), 'utf8');
  const start = fulfillment.indexOf('export async function buildProofArtifactFromPageArtifacts');
  assert.ok(start > 0, 'build-only helper must exist');
  // Slice to the function's own closing brace, not to the next declaration —
  // otherwise the following function's doc comment is included.
  const end = fulfillment.indexOf('\n}', start);
  assert.ok(end > start);
  const body = fulfillment.slice(start, end);
  assert.doesNotMatch(
    body,
    /updateFulfillmentState|persistOrder/,
    'the build-only proof helper must not persist anything',
  );
});

// ── 4. The review client mirrors the server's ack invalidation ─────────────

test('the review client clears the proof acknowledgment when a page is regenerated', () => {
  const rel = 'src/app/review/[orderId]/review-client.tsx';
  const text = readFileSync(path.join(REPO, rel), 'utf8');
  const start = text.indexOf('async function regenerate');
  const end = text.indexOf('async function accept(');
  assert.ok(start >= 0, `${rel}: regenerate handler must exist`);
  assert.ok(
    end > start,
    `${rel}: could not bound the regenerate handler (start=${start}, end=${end}) — ` +
      'a slice that runs to EOF would make the assertions below vacuous',
  );
  const regen = text.slice(start, end);
  assert.match(
    regen,
    /proofReviewedAt: null/,
    `${rel}: regenerate must clear the persisted ack in local snapshot state — the server ` +
      'invalidates it with the content change, and a stale client value leaves Approve ' +
      'enabled, 409s on click, and blocks re-acknowledgment without a page reload',
  );
  assert.match(regen, /setProofAck\(false\)/, `${rel}: regenerate must untick the ack checkbox`);
});
