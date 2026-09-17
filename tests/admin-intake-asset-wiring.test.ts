/**
 * The wiring around the intake-asset retrieval handler.
 *
 * The behaviour is proven in admin-intake-asset-retrieval.test.ts, where the
 * production handler runs end to end with only its auth/order/provider
 * boundaries injected. What cannot be executed under `node:test` is the Next
 * route file (next/server) and the admin page (JSX; node's type stripping does
 * not handle it). Those two are pinned here by source inspection, deliberately
 * as ABSENCE tripwires: that the route keeps no decision of its own for a
 * weaker one to grow back into, and that the admin surface renders links built
 * by the audited helper rather than anything from the stored tuple.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const ROUTE_PATH = 'src/app/api/admin/orders/[orderId]/intake-assets/[assetId]/route.ts';
const ROUTE = readFileSync(ROUTE_PATH, 'utf8');
const PAGE = readFileSync('src/app/admin/orders/[orderId]/page.tsx', 'utf8');
const RUNBOOK = readFileSync('docs/runbooks/manual-custom-story-operations.md', 'utf8');

// ── Route shell ──────────────────────────────────────────────────────────────

test('the route delegates to the audited handler', () => {
  assert.match(ROUTE, /handleAdminIntakeAssetRequest/);
  assert.match(ROUTE, /export async function GET/);
  assert.match(ROUTE, /export function POST/);
  assert.match(ROUTE, /export function OPTIONS/);
  assert.match(ROUTE, /adminIntakeAssetUnsupportedMethodReply/);
  assert.match(ROUTE, /adminIntakeAssetOptionsReply/);
});

test('the route takes only the two path params and no caller-supplied media facts', () => {
  assert.match(ROUTE, /params:\s*Promise<\{\s*orderId:\s*string;\s*assetId:\s*string\s*\}>/);
  for (const forbidden of ['searchParams', 'pathname', 'mimeType', 'blobUrl', 'intakeId', 'capability']) {
    assert.ok(!ROUTE.includes(forbidden), `route must not read ${forbidden}`);
  }
});

test('the route holds no auth scheme, token read or provider call of its own', () => {
  for (const forbidden of [
    'HSB_INTAKE_BLOB_READ_WRITE_TOKEN',
    'BLOB_READ_WRITE_TOKEN',
    'process.env',
    '@vercel/blob',
    'getRequiredIntakeBlobToken',
  ]) {
    assert.ok(!ROUTE.includes(forbidden), `route must not contain ${forbidden}`);
  }
});

test('the route exports the Node runtime and refuses static caching', () => {
  assert.match(ROUTE, /export const runtime = 'nodejs'/);
  assert.match(ROUTE, /export const dynamic = 'force-dynamic'/);
});

test('the route forwards every header the handler chose, verbatim', () => {
  assert.match(ROUTE, /reply\.headers/);
  // No second, weaker header set may be constructed in the shell.
  assert.ok(!/Cache-Control['"]?\s*:/.test(ROUTE), 'route must not restate Cache-Control');
  assert.ok(!ROUTE.includes('Content-Security-Policy'), 'route must not restate the CSP');
  assert.ok(!ROUTE.includes('Referrer-Policy'), 'route must not restate Referrer-Policy');
  assert.ok(!ROUTE.includes('X-Content-Type-Options'), 'route must not restate nosniff');
  assert.ok(!/\bAllow['"]?\s*:/.test(ROUTE), 'route must not restate Allow');
  assert.ok(!/\bstatus\s*:\s*(?:204|405)\b/.test(ROUTE), 'route must not own method statuses');
});

// ── Admin order page ─────────────────────────────────────────────────────────

test('the admin page builds its intake links through the audited helper', () => {
  assert.match(PAGE, /listAdminIntakeAssets/);
  assert.match(PAGE, /from '@\/lib\/admin-intake-asset-route-handler'/);
});

test('the admin page renders nothing from an intake link but label, href and size', () => {
  const start = PAGE.indexOf('>Private intake media<');
  assert.ok(start > 0, 'expected a "Private intake media" section');
  const section = PAGE.slice(start, PAGE.indexOf('</section>', start));
  // The opaque assetId is allowed — it is the href's own path segment. A
  // storage path, a provider URL, a capability or an intake id is not.
  for (const forbidden of ['pathname', 'blobUrl', 'capability', 'etag', 'intakeId']) {
    assert.ok(!section.includes(forbidden), `intake asset section must not render ${forbidden}`);
  }
  assert.match(section, /href=\{asset\.href\}/);
  assert.match(section, /\{asset\.label\}/);
});

test('the admin page opens intake assets through the order-scoped API only', () => {
  assert.ok(!PAGE.includes('vercel-storage'), 'no provider host may appear on the page');
  assert.ok(!PAGE.includes('blob.vercel'), 'no provider host may appear on the page');
});

// ── Runbook §4.4 ─────────────────────────────────────────────────────────────

test('runbook 4.4 names the supported retrieval surface instead of an escalation', () => {
  const section = RUNBOOK.slice(RUNBOOK.indexOf('### 4.4'), RUNBOOK.indexOf('## 5.'));
  assert.ok(section.length > 0, 'expected a 4.4 section');
  assert.ok(!/not implemented/i.test(section.split('\n')[0]!), '4.4 heading must not say not implemented');
  assert.match(section, /\/api\/admin\/orders\/<orderId>\/intake-assets\/<assetId>/);
  // The prohibitions that surround it are untouched.
  assert.match(section, /Do not[\s\S]*construct a Blob URL, mint a token/);
  // `\s+` rather than a literal space: the prohibition must survive rewrapping.
  assert.match(section, /no\s+automated\s+transcription/i);
});

// ── §4.4 privacy claim vs. what the admin page actually renders ──────────────

const SECTION_4_4 = RUNBOOK.slice(RUNBOOK.indexOf('### 4.4'), RUNBOOK.indexOf('## 5.'));

/**
 * Inherited, pre-existing rows. They are authenticated text and a storage path
 * is not a credential, so they are not an access-control problem — but they are
 * why §4.4 may not promise an operator that no storage path reaches the
 * browser. The claim belongs to the retrieval response and its link, and to
 * nothing else on the page.
 */
const PAGE_STORAGE_PATH_ROWS = [...PAGE.matchAll(/label="([^"]*(?:blob path|storage path)[^"]*)"/gi)]
  .map((match) => match[1]!);

test('§4.4 makes its no-path/no-credential claim about the response and its link only', () => {
  assert.match(
    SECTION_4_4,
    /(storage path|credential|provider)[^.]*\bin (that|this) response\b[^.]*\blink\b/i,
    '§4.4 must scope the claim to the retrieval response and the link that opens it',
  );
});

test('§4.4 never widens that claim to the operator browser or the dashboard', () => {
  const overreach = [
    /\b(nothing|no|never|not)\b[^.]*\b(storage path|pathname|path)\b[^.]*\b(browser|dashboard|admin page|ops page)\b/i,
    /\b(storage path|pathname|path)\b[^.]*\b(never|does not|do not|cannot)\b[^.]*\b(reach|appear|leave|show)[^.]*\b(browser|dashboard|page)\b/i,
  ];
  for (const pattern of overreach) {
    const hit = SECTION_4_4.match(pattern);
    assert.equal(hit, null, `§4.4 overstates privacy: ${JSON.stringify(hit?.[0] ?? '')}`);
  }
});

test('while the order page prints storage paths, §4.4 says so instead of implying otherwise', () => {
  if (PAGE_STORAGE_PATH_ROWS.length === 0) return; // rows removed: nothing to disclose.
  // Prose rewraps; a label split across two lines is still the label.
  const unwrapped = SECTION_4_4.replace(/\s+/g, ' ');
  for (const label of PAGE_STORAGE_PATH_ROWS) {
    assert.ok(
      unwrapped.includes(label),
      `the order page renders a "${label}" row, so §4.4 must disclose it rather than imply no path is shown`,
    );
  }
});

test('the prohibition table no longer calls byte retrieval unimplemented', () => {
  assert.ok(
    !/Fetching order media bytes from an operator surface \| \*\*Not implemented/.test(RUNBOOK),
    'the §6.3 row must be updated alongside §4.4',
  );
  assert.match(RUNBOOK, /Automated prose or template fallback for a media-backed order \| Prohibited/);
  assert.match(RUNBOOK, /Admin "Retry fulfillment" on a media-backed order \| Prohibited/);
});
