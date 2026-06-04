#!/usr/bin/env node
/**
 * HSB production cutover readiness verifier — READ ONLY.
 *
 * Purpose: give the operator a deterministic PASS / WARN / FAIL readout of
 * whether a built HSB target (Preview or the apex behind a guard) is shaped
 * correctly for production cutover, WITHOUT changing anything. This script is
 * a verifier, not an actuator.
 *
 * What it checks:
 *   1. Predeploy / live-features lineage (static, no network): whether a
 *      `predeploy:live-features` (or `predeploy*`) npm script exists and
 *      whether a live-features manifest / build id is present to anchor
 *      lineage. Lineage that can't be established is a WARN, never a silent pass.
 *   2. Required routes return a healthy status for a supplied --base-url:
 *        /  /checkout  /pricing  /samples  and the admin auth surface
 *        (/admin/orders by default) which must be GATED (not 200, not 404).
 *   3. Bad-signature webhook probes (intentionally invalid POSTs):
 *        - Stripe webhook must answer 400 "Invalid signature", NOT 404 / 200.
 *        - Resend webhook must reject a fake/stale signature, NOT 404 / 200.
 *          (This repo ships no Resend webhook today; an unprovided path that
 *           404s is reported WARN, not a fabricated pass.)
 *   4. Checkout HTML markers on the fetched /checkout document:
 *        present: "Custom Story", "Built from your voice note",
 *                 "Custom story lesson", "Custom occasion", "32-page high-res PDF"
 *        absent:  "Hero pronouns", "Select pronouns"
 *   5. A concise PASS/WARN/FAIL report + overall verdict.
 *
 * HARD SAFETY RULES enforced by this script:
 *   - Read-only. No deploy. No apex/www aliasing. No env / provider / order /
 *     customer mutation. No git mutation. No file writes.
 *   - Network is limited to: HTTP GET of the listed pages, and POST of
 *     intentionally-INVALID webhook probes (rejected before any event is
 *     processed, so no order/customer side effects).
 *   - No secret values are read or printed. Probe signatures are obviously bogus.
 *
 * Exit codes: 0 = PASS or WARN · 1 = at least one FAIL · 2 = invocation error.
 *
 * Usage:
 *   node scripts/verify-hsb-cutover-readiness.mjs --base-url https://preview.example
 *   node scripts/verify-hsb-cutover-readiness.mjs            (static lineage checks only)
 *   node scripts/verify-hsb-cutover-readiness.mjs --base-url URL --resend-path /api/webhooks/resend
 *   node scripts/verify-hsb-cutover-readiness.mjs --base-url URL --json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Verdict vocabulary ──────────────────────────────────────────────────────

export const VERDICT = Object.freeze({
  PASS: 'PASS',
  WARN: 'WARN',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
});

const SEVERITY = { PASS: 0, SKIP: 0, WARN: 1, FAIL: 2 };

// ── Config (exported so tests and operators can see the contract) ───────────

export const REQUIRED_ROUTES = Object.freeze([
  { path: '/', label: 'home' },
  { path: '/checkout', label: 'checkout' },
  { path: '/pricing', label: 'pricing' },
  { path: '/samples', label: 'samples' },
]);

export const DEFAULT_ADMIN_PATH = '/admin/orders';
export const DEFAULT_STRIPE_WEBHOOK_PATH = '/api/webhooks/stripe';
export const DEFAULT_RESEND_WEBHOOK_PATH = '/api/webhooks/resend';

export const CHECKOUT_MARKERS = Object.freeze([
  { label: 'Custom Story', kind: 'present', needle: 'Custom Story' },
  { label: 'Built from your voice note', kind: 'present', needle: 'Built from your voice note' },
  { label: 'Custom story lesson', kind: 'present', needle: 'Custom story lesson' },
  { label: 'Custom occasion', kind: 'present', needle: 'Custom occasion' },
  { label: '32-page high-res PDF', kind: 'present', needle: '32-page high-res PDF' },
  { label: 'Hero pronouns', kind: 'absent', needle: 'Hero pronouns' },
  { label: 'Select pronouns', kind: 'absent', needle: 'Select pronouns' },
]);

// ── Pure classifiers (the load-bearing, unit-tested logic) ──────────────────

/** A normal page route: 2xx healthy, 3xx redirect = WARN, 404/5xx = FAIL. */
export function classifyRoute(status, label = 'route') {
  if (status >= 200 && status < 300) return { verdict: VERDICT.PASS, detail: `${label} ${status}` };
  if (status >= 300 && status < 400) return { verdict: VERDICT.WARN, detail: `${label} ${status} redirect` };
  if (status === 404) return { verdict: VERDICT.FAIL, detail: `${label} 404 — route missing` };
  if (status >= 500) return { verdict: VERDICT.FAIL, detail: `${label} ${status} server error` };
  return { verdict: VERDICT.WARN, detail: `${label} ${status} unexpected` };
}

/**
 * The admin auth surface must exist AND be gated:
 *   200 = open to the world (FAIL), 404 = missing (FAIL),
 *   401/403 or a redirect to login = correctly gated (PASS).
 */
export function classifyAdminSurface(status, label = 'admin') {
  if (status === 200) return { verdict: VERDICT.FAIL, detail: `${label} 200 — auth surface is OPEN (unauthenticated)` };
  if (status === 404) return { verdict: VERDICT.FAIL, detail: `${label} 404 — auth surface missing` };
  if (status === 401 || status === 403) return { verdict: VERDICT.PASS, detail: `${label} ${status} gated` };
  if (status >= 300 && status < 400) return { verdict: VERDICT.PASS, detail: `${label} ${status} redirect to auth` };
  if (status >= 500) return { verdict: VERDICT.FAIL, detail: `${label} ${status} server error` };
  return { verdict: VERDICT.WARN, detail: `${label} ${status} unexpected` };
}

/**
 * A bad-signature webhook probe. The route must REJECT the bogus signature.
 *   - 400 is the canonical "Invalid signature" answer → PASS.
 *   - Other auth-style rejections (401/403/422) → PASS (still rejected).
 *   - 2xx → FAIL (it accepted an invalid signature).
 *   - 404 → FAIL if the path was explicitly supplied; otherwise WARN (the
 *     route may simply not be deployed — don't fabricate a pass or a fail).
 *   - 5xx → WARN (rejected, but noisily).
 */
export function classifyWebhookProbe(status, { provider = 'webhook', pathProvided = false } = {}) {
  if (status === 400) return { verdict: VERDICT.PASS, detail: `${provider} 400 rejected invalid signature` };
  if (status === 401 || status === 403 || status === 422) {
    return { verdict: VERDICT.PASS, detail: `${provider} ${status} rejected (not 400, but rejected)` };
  }
  if (status >= 200 && status < 300) {
    return { verdict: VERDICT.FAIL, detail: `${provider} ${status} — ACCEPTED an invalid signature` };
  }
  if (status === 404) {
    return pathProvided
      ? { verdict: VERDICT.FAIL, detail: `${provider} 404 — supplied webhook path not found` }
      : { verdict: VERDICT.WARN, detail: `${provider} 404 at default path — route not deployed? pass an explicit --${provider}-path` };
  }
  if (status >= 500) return { verdict: VERDICT.WARN, detail: `${provider} ${status} server error while rejecting` };
  return { verdict: VERDICT.WARN, detail: `${provider} ${status} unexpected` };
}

/** Scan fetched HTML for required present / absent markers. */
export function scanMarkers(html, markers = CHECKOUT_MARKERS) {
  const text = typeof html === 'string' ? html : '';
  return markers.map((m) => {
    const found = text.includes(m.needle);
    const ok = m.kind === 'present' ? found : !found;
    return {
      label: m.label,
      kind: m.kind,
      found,
      verdict: ok ? VERDICT.PASS : VERDICT.FAIL,
      detail: `${m.label}: expected ${m.kind}, ${found ? 'found' : 'not found'}`,
    };
  });
}

/**
 * Static predeploy / live-features lineage evaluation (no network, no exec).
 * Inputs are gathered by the CLI and passed in so this stays pure & testable.
 */
export function evaluatePredeployLineage({ scriptNames = [], manifestFound = false, buildIdFound = false } = {}) {
  const predeployScript = scriptNames.find((n) => n === 'predeploy:live-features')
    ?? scriptNames.find((n) => n.startsWith('predeploy'));
  const anchors = [];
  if (predeployScript) anchors.push(`script:${predeployScript}`);
  if (manifestFound) anchors.push('manifest');
  if (buildIdFound) anchors.push('build-id');

  if (predeployScript && (manifestFound || buildIdFound)) {
    return { verdict: VERDICT.PASS, detail: `lineage anchored by ${anchors.join(' + ')}` };
  }
  if (anchors.length > 0) {
    return { verdict: VERDICT.WARN, detail: `partial lineage (${anchors.join(' + ')}); cannot fully verify predeploy:live-features` };
  }
  return { verdict: VERDICT.WARN, detail: 'no predeploy:live-features script or manifest/build-id found — lineage unverifiable' };
}

/** Worst-of rollup across a flat list of { verdict } checks (SKIP ignored). */
export function rollupVerdict(checks) {
  let worst = VERDICT.PASS;
  for (const c of checks) {
    if ((SEVERITY[c.verdict] ?? 0) > (SEVERITY[worst] ?? 0)) worst = c.verdict;
  }
  return worst;
}

/** Render a concise grouped report string from sectioned checks. */
export function formatReport(sections, overall) {
  const lines = [];
  lines.push('HSB cutover readiness — verifier report');
  lines.push('========================================');
  for (const section of sections) {
    lines.push(`\n${section.title}`);
    if (!section.checks.length) {
      lines.push('  (no checks)');
      continue;
    }
    for (const c of section.checks) {
      lines.push(`  [${c.verdict.padEnd(4)}] ${c.name} — ${c.detail}`);
    }
  }
  lines.push('\nSafety:');
  lines.push('  Production deploy: NOT RUN');
  lines.push('  Apex/www alias: NOT TOUCHED');
  lines.push('  Env/provider/order/customer mutations: NONE');
  lines.push('  Network: GET pages + intentionally-invalid webhook probes only');
  lines.push(`\nOVERALL: ${overall}`);
  return lines.join('\n');
}

// ── CLI-only helpers (network + fs; not imported by unit tests) ─────────────

function parseArgs(argv) {
  const args = { baseUrl: null, adminPath: DEFAULT_ADMIN_PATH, stripePath: DEFAULT_STRIPE_WEBHOOK_PATH, resendPath: DEFAULT_RESEND_WEBHOOK_PATH, resendPathProvided: false, json: false, skipHttp: false, help: false, timeoutMs: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base-url') args.baseUrl = next();
    else if (a === '--admin-path') args.adminPath = next();
    else if (a === '--stripe-path') args.stripePath = next();
    else if (a === '--resend-path') { args.resendPath = next(); args.resendPathProvided = true; }
    else if (a === '--timeout-ms') args.timeoutMs = Number(next()) || args.timeoutMs;
    else if (a === '--skip-http') args.skipHttp = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function fetchStatus(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: ctrl.signal });
    const text = method === 'GET' ? await res.text().catch(() => '') : '';
    return { status: res.status, text, ok: true };
  } catch (err) {
    return { status: 0, text: '', ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function gatherPredeployInputs(repoRoot) {
  let scriptNames = [];
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    scriptNames = Object.keys(pkg.scripts ?? {});
  } catch { /* report as no-script below */ }
  const manifestCandidates = [
    'ops/live-features-manifest.json',
    'ops/logs/live-features-manifest.json',
    'live-features.json',
    '.next/live-features-manifest.json',
  ];
  const manifestFound = manifestCandidates.some((p) => existsSync(join(repoRoot, p)));
  const buildIdFound = existsSync(join(repoRoot, '.next/BUILD_ID'));
  return { scriptNames, manifestFound, buildIdFound };
}

async function runHttpChecks(args) {
  const sections = [];

  // Routes
  const routeChecks = [];
  for (const r of REQUIRED_ROUTES) {
    const res = await fetchStatus(joinUrl(args.baseUrl, r.path), { timeoutMs: args.timeoutMs });
    if (!res.ok) routeChecks.push({ name: r.path, verdict: VERDICT.FAIL, detail: `unreachable: ${res.error}` });
    else { const v = classifyRoute(res.status, r.label); routeChecks.push({ name: r.path, ...v }); }
  }
  const adminRes = await fetchStatus(joinUrl(args.baseUrl, args.adminPath), { timeoutMs: args.timeoutMs });
  if (!adminRes.ok) routeChecks.push({ name: args.adminPath, verdict: VERDICT.FAIL, detail: `unreachable: ${adminRes.error}` });
  else { const v = classifyAdminSurface(adminRes.status, 'admin'); routeChecks.push({ name: args.adminPath, ...v }); }
  sections.push({ title: 'Routes', checks: routeChecks });

  // Webhook probes (intentionally invalid signatures)
  const webhookChecks = [];
  const stripeRes = await fetchStatus(joinUrl(args.baseUrl, args.stripePath), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=0,v1=cutover_probe_invalid' },
    body: '{"id":"evt_cutover_probe","type":"probe.invalid"}',
    timeoutMs: args.timeoutMs,
  });
  if (!stripeRes.ok) webhookChecks.push({ name: 'stripe webhook', verdict: VERDICT.FAIL, detail: `unreachable: ${stripeRes.error}` });
  else { const v = classifyWebhookProbe(stripeRes.status, { provider: 'stripe', pathProvided: true }); webhookChecks.push({ name: 'stripe webhook', ...v }); }

  const resendRes = await fetchStatus(joinUrl(args.baseUrl, args.resendPath), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'svix-id': 'msg_cutover_probe', 'svix-timestamp': '0', 'svix-signature': 'v1,cutover_probe_invalid' },
    body: '{"type":"probe.invalid"}',
    timeoutMs: args.timeoutMs,
  });
  if (!resendRes.ok) webhookChecks.push({ name: 'resend webhook', verdict: VERDICT.WARN, detail: `unreachable: ${resendRes.error}` });
  else { const v = classifyWebhookProbe(resendRes.status, { provider: 'resend', pathProvided: args.resendPathProvided }); webhookChecks.push({ name: 'resend webhook', ...v }); }
  sections.push({ title: 'Webhook bad-signature probes', checks: webhookChecks });

  // Checkout markers
  const checkoutGet = await fetchStatus(joinUrl(args.baseUrl, '/checkout'), { timeoutMs: args.timeoutMs });
  let markerChecks;
  if (!checkoutGet.ok) {
    markerChecks = [{ name: 'checkout HTML', verdict: VERDICT.FAIL, detail: `unreachable: ${checkoutGet.error}` }];
  } else {
    markerChecks = scanMarkers(checkoutGet.text).map((m) => ({ name: m.label, verdict: m.verdict, detail: m.detail }));
  }
  sections.push({ title: 'Checkout HTML markers', checks: markerChecks });

  return sections;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/verify-hsb-cutover-readiness.mjs --base-url <url> [--admin-path p] [--stripe-path p] [--resend-path p] [--skip-http] [--json]\n');
    process.exit(0);
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sections = [];

  // Section 1: predeploy / live-features lineage (static)
  const inputs = gatherPredeployInputs(repoRoot);
  const lineage = evaluatePredeployLineage(inputs);
  sections.push({ title: 'Predeploy / live-features lineage', checks: [{ name: 'lineage', ...lineage }] });

  // Sections 2-4: HTTP (only if a base URL is supplied)
  if (args.skipHttp || !args.baseUrl) {
    sections.push({ title: 'HTTP checks', checks: [{ name: 'routes/webhooks/markers', verdict: VERDICT.SKIP, detail: args.skipHttp ? 'skipped via --skip-http' : 'no --base-url supplied' }] });
  } else {
    const httpSections = await runHttpChecks(args);
    sections.push(...httpSections);
  }

  const allChecks = sections.flatMap((s) => s.checks);
  const overall = rollupVerdict(allChecks);
  process.stdout.write(`${formatReport(sections, overall)}\n`);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ overall, sections, safety: { productionDeploy: 'NOT_RUN', apexAlias: 'NOT_TOUCHED', mutations: 'NONE' } }, null, 2)}\n`);
  }
  process.exit(overall === VERDICT.FAIL ? 1 : 0);
}

const __isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (__isCli) {
  main().catch((err) => {
    console.error('[verify-hsb-cutover] fatal:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
