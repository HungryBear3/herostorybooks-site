#!/usr/bin/env node
/**
 * HSB G5 owner-test evidence capture.
 *
 * Read-only tooling that assembles a launch-readiness evidence packet for the
 * controlled owner-test / G5 gate, WITHOUT exposing secrets or causing any
 * customer side effect. It looks at:
 *
 *   - Production env presence (Stripe / email / storage / print / AI / admin /
 *     deploy) — presence + length + a whitelisted structural prefix only.
 *   - Kill-switch state (checkout pause flag + durable-persistence flag).
 *   - Stripe webhook route health (route present + signature verification).
 *   - Admin / email-health config readiness.
 *   - Order / proof readiness config (live store is NOT queried — read-only).
 *   - Vercel deployment identity (branch / commit / project) if safely local.
 *   - A readable blocker list, written as JSON + Markdown.
 *
 * It NEVER:
 *   - prints a raw env value or any secret body,
 *   - performs a production write, a Stripe replay, a customer email, a
 *     print/Lulu submission, or any FAL/OpenAI/Gemini generation,
 *   - deploys, or mutates Vercel env vars.
 *
 * The only I/O is: read process.env, read a few local files (route/lib/vercel
 * config), run read-only `git` for identity, and WRITE the evidence packet
 * under ops/logs/. No network calls.
 *
 * Status buckets: PASS · WARNING · BLOCKER · NOT CHECKED.
 *
 * Exit codes:
 *   0  evidence collection succeeded (EVEN IF launch blockers were found)
 *   1  script/runtime failure (or a self-check detected a would-be secret leak)
 *   2  invocation error (bad flag)
 *
 * Usage:
 *   node scripts/capture-g5-evidence.mjs
 *   node scripts/capture-g5-evidence.mjs --target=https://herostorybooks.com
 *   node scripts/capture-g5-evidence.mjs --json          (also print JSON to stdout)
 *   node scripts/capture-g5-evidence.mjs --out=ops/logs  (override base output dir)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Status model ────────────────────────────────────────────────────────────

export const STATUS = Object.freeze({
  PASS: 'PASS',
  WARNING: 'WARNING',
  BLOCKER: 'BLOCKER',
  NOT_CHECKED: 'NOT CHECKED',
});

/** @typedef {'PASS'|'WARNING'|'BLOCKER'|'NOT CHECKED'} Status */

// ── Secret redaction (security-critical, pure, unit-tested) ──────────────────

/**
 * Whitelisted STRUCTURAL prefixes. These reveal only the *kind/mode* of a key
 * (e.g. Stripe live vs test) — never any random secret body. redactSecret may
 * emit ONLY a string drawn from this list; it never emits arbitrary leading
 * characters of a value.
 */
export const KNOWN_SECRET_PREFIXES = Object.freeze([
  'sk-LIVE-REDACTED-',
  'sk-TEST-REDACTED-',
  'rk_live_',
  'rk_test_',
  'pk_live_',
  'pk_test_',
  'whsec-REDACTED-',
  'vercel-blob-rw-REDACTED-',
  're_',
]);

/**
 * Redact a secret value down to non-sensitive shape only.
 *
 * Returns { present, length, prefix } where:
 *   - present: whether a non-empty value exists,
 *   - length:  character length (low-sensitivity shape signal),
 *   - prefix:  a whitelisted structural prefix the value starts with, or null.
 *
 * It NEVER returns the value, nor any substring of it beyond a fixed
 * whitelisted prefix. This is the single choke point for "is it safe to show".
 *
 * @param {unknown} value
 * @returns {{ present: boolean, length: number, prefix: string | null }}
 */
export function redactSecret(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { present: false, length: 0, prefix: null };
  }
  const prefix = KNOWN_SECRET_PREFIXES.find((p) => value.startsWith(p)) ?? null;
  return { present: true, length: value.length, prefix };
}

/**
 * Scan a serialized blob for any actual secret value body and return the names
 * of any that leaked. Used as a belt-and-suspenders self-check before writing
 * the packet: if anything here is non-empty, we have a bug and must abort.
 *
 * @param {string} serialized
 * @param {Record<string, string | undefined>} secretEnv  name -> raw value
 * @returns {string[]} names whose value appears verbatim in `serialized`
 */
export function findLeakedSecrets(serialized, secretEnv) {
  const leaked = [];
  for (const [name, raw] of Object.entries(secretEnv)) {
    if (typeof raw !== 'string') continue;
    const body = raw.trim();
    // Ignore short/empty values and recognized structural prefixes — a value
    // that IS only a known prefix carries no secret body.
    if (body.length < 6) continue;
    if (KNOWN_SECRET_PREFIXES.includes(body)) continue;
    if (serialized.includes(body)) leaked.push(name);
  }
  return leaked;
}

// ── Env catalogue ────────────────────────────────────────────────────────────

/**
 * kind:
 *   'secret'   → redactSecret only (never value)
 *   'identity' → deploy identity, safe to show (branch/commit/env)
 *   'flag'     → operational boolean/enum, safe to show
 *   'public'   → NEXT_PUBLIC_* (compiled into client bundle; already public)
 *   'config'   → non-secret config we still keep to presence-only by default
 *
 * required: launch-critical — a missing one drives a WARNING (we cannot assert
 * BLOCKER from a local shell, which may differ from the Vercel environment).
 */
export const ENV_CATALOGUE = Object.freeze({
  Stripe: [
    { name: 'STRIPE_SECRET_KEY', kind: 'secret', required: true },
    { name: 'STRIPE_WEBHOOK_SECRET', kind: 'secret', required: true },
    { name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', kind: 'public', required: false },
  ],
  Email: [
    { name: 'RESEND_API_KEY', kind: 'secret', required: false },
    { name: 'HSB_RESEND_API_KEY', kind: 'secret', required: false },
    { name: 'EMAIL_FROM', kind: 'config', required: false },
    { name: 'HSB_EMAIL_FROM', kind: 'config', required: false },
    { name: 'HSB_SUPPORT_EMAIL', kind: 'config', required: false },
    { name: 'HSB_OPERATOR_EMAIL', kind: 'config', required: false },
  ],
  Storage: [
    { name: 'BLOB_READ_WRITE_TOKEN', kind: 'secret', required: true },
    { name: 'HSB_BLOB_NAMESPACE', kind: 'flag', required: false },
    { name: 'HSB_BLOB_ACCESS_MODE', kind: 'flag', required: false },
    { name: 'HSB_PUBLIC_BLOB_BASE', kind: 'config', required: false },
  ],
  'Print / Lulu': [
    { name: 'LULU_CLIENT_KEY', kind: 'secret', required: false },
    { name: 'LULU_CLIENT_SECRET', kind: 'secret', required: false },
    { name: 'LULU_WEBHOOK_SECRET', kind: 'secret', required: false },
    { name: 'LULU_API_URL', kind: 'config', required: false },
  ],
  'Image / AI': [
    { name: 'GOOGLE_GEMINI_API_KEY', kind: 'secret', required: false },
    { name: 'FAL_KEY', kind: 'secret', required: false },
    { name: 'OPENAI_API_KEY', kind: 'secret', required: false },
  ],
  Admin: [
    { name: 'HSB_ORDER_ADMIN_KEY', kind: 'secret', required: true },
    { name: 'FAMILY_REVIEW_ADMIN_KEY', kind: 'secret', required: false },
  ],
  'Ops flags': [
    { name: 'HSB_CHECKOUT_PAUSED', kind: 'flag', required: false },
    { name: 'HSB_REQUIRE_DURABLE_PERSISTENCE', kind: 'flag', required: false },
  ],
  'Deploy identity': [
    { name: 'NODE_ENV', kind: 'identity', required: false },
    { name: 'VERCEL', kind: 'identity', required: false },
    { name: 'VERCEL_ENV', kind: 'identity', required: false },
    { name: 'VERCEL_GIT_COMMIT_REF', kind: 'identity', required: false },
    { name: 'VERCEL_GIT_COMMIT_SHA', kind: 'identity', required: false },
    { name: 'NEXT_PUBLIC_URL', kind: 'public', required: false },
  ],
});

/** Flatten the catalogue to the set of names treated as secrets. */
export function secretEnvNames(catalogue = ENV_CATALOGUE) {
  const out = [];
  for (const vars of Object.values(catalogue)) {
    for (const v of vars) if (v.kind === 'secret') out.push(v.name);
  }
  return out;
}

/**
 * Describe a single env var safely for the packet. Secrets go through
 * redactSecret; identity/flag/public values may be shown; config is
 * presence-only.
 *
 * @param {{name:string, kind:string, required:boolean}} spec
 * @param {Record<string, string | undefined>} env
 */
export function describeEnvVar(spec, env) {
  const raw = env[spec.name];
  const present = typeof raw === 'string' && raw.trim().length > 0;
  const base = { name: spec.name, kind: spec.kind, required: spec.required, present };
  if (!present) return { ...base, shown: null };
  if (spec.kind === 'secret') {
    const r = redactSecret(raw.trim());
    return { ...base, length: r.length, prefix: r.prefix, shown: null };
  }
  if (spec.kind === 'identity' || spec.kind === 'flag' || spec.kind === 'public') {
    // Safe to show. Commit SHA is shortened for readability.
    let shown = raw.trim();
    if (spec.name === 'VERCEL_GIT_COMMIT_SHA') shown = shown.slice(0, 12);
    return { ...base, shown };
  }
  // config: presence only.
  return { ...base, shown: null };
}

// ── Section builders (pure: given env/fs facts, return checks) ───────────────

/** @typedef {{ section:string, status:Status, label:string, detail:string, data?:object }} Check */

/**
 * @param {Record<string,string|undefined>} env
 * @returns {Check[]}
 */
export function buildEnvChecks(env) {
  /** @type {Check[]} */
  const checks = [];
  for (const [group, vars] of Object.entries(ENV_CATALOGUE)) {
    const described = vars.map((spec) => describeEnvVar(spec, env));
    const missingRequired = described.filter((d) => d.required && !d.present);
    const presentCount = described.filter((d) => d.present).length;
    // WARNING if a launch-required var is missing OR nothing in the group is
    // configured in this shell (a fully-empty group is a readiness gap to
    // confirm, not a pass). PASS only when something is present and no
    // required var is missing.
    const nothingConfigured = presentCount === 0 && described.length > 0;
    /** @type {Status} */
    const status = missingRequired.length > 0 || nothingConfigured ? STATUS.WARNING : STATUS.PASS;
    const detail =
      `${presentCount}/${described.length} present` +
      (missingRequired.length > 0
        ? ` · required MISSING in this shell: ${missingRequired.map((d) => d.name).join(', ')} ` +
          '(local shell only — verify on the Vercel target before clearing)'
        : nothingConfigured
          ? ' · nothing configured in this shell — verify on the Vercel target'
          : '');
    checks.push({ section: 'Production env', status, label: group, detail, data: { vars: described } });
  }
  return checks;
}

/**
 * @param {Record<string,string|undefined>} env
 * @param {{ checkoutPauseLib: boolean }} facts
 * @returns {Check[]}
 */
export function buildKillSwitchChecks(env, facts) {
  const paused = String(env.HSB_CHECKOUT_PAUSED ?? '').trim().toLowerCase() === 'true';
  const durable = String(env.HSB_REQUIRE_DURABLE_PERSISTENCE ?? '').trim().toLowerCase() === 'true';
  /** @type {Check[]} */
  const checks = [];
  checks.push({
    section: 'Kill-switch state',
    status: paused ? STATUS.WARNING : STATUS.PASS,
    label: 'Checkout pause (HSB_CHECKOUT_PAUSED)',
    detail: paused
      ? 'checkout is PAUSED — confirm this is intended for the G5 window.'
      : 'checkout is NOT paused (live).',
    data: { paused, libPresent: facts.checkoutPauseLib },
  });
  checks.push({
    section: 'Kill-switch state',
    status: durable ? STATUS.PASS : STATUS.WARNING,
    label: 'Durable persistence (HSB_REQUIRE_DURABLE_PERSISTENCE)',
    detail: durable
      ? 'durable persistence required (fail-closed).'
      : 'not forced in this shell; Vercel runs are durable by default — verify on target.',
    data: { durable },
  });
  return checks;
}

/**
 * @param {{ routeExists:boolean, hasSignatureVerify:boolean, handlesMissingSecret:boolean }} facts
 * @param {Record<string,string|undefined>} env
 * @returns {Check[]}
 */
export function buildWebhookChecks(facts, env) {
  /** @type {Check[]} */
  const checks = [];
  if (!facts.routeExists) {
    checks.push({
      section: 'Stripe webhook',
      status: STATUS.BLOCKER,
      label: 'Webhook route',
      detail: 'src/app/api/webhooks/stripe/route.ts is MISSING — payments cannot be reconciled.',
    });
    return checks;
  }
  checks.push({
    section: 'Stripe webhook',
    status: facts.hasSignatureVerify ? STATUS.PASS : STATUS.BLOCKER,
    label: 'Signature verification',
    detail: facts.hasSignatureVerify
      ? 'route verifies Stripe signatures (constructEvent present).'
      : 'route does NOT verify Stripe signatures — forgeable webhook.',
  });
  const secret = redactSecret((env.STRIPE_WEBHOOK_SECRET ?? '').trim());
  checks.push({
    section: 'Stripe webhook',
    status: secret.present ? STATUS.PASS : STATUS.WARNING,
    label: 'Webhook secret (STRIPE_WEBHOOK_SECRET)',
    detail: secret.present
      ? `present (len=${secret.length}${secret.prefix ? `, prefix=${secret.prefix}` : ''}).`
      : 'MISSING in this shell — verify on the Vercel target.',
  });
  return checks;
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {Check[]}
 */
export function buildEmailHealthChecks(env) {
  const provider = redactSecret((env.RESEND_API_KEY ?? env.HSB_RESEND_API_KEY ?? '').trim());
  const fromSet =
    Boolean((env.EMAIL_FROM ?? '').trim()) || Boolean((env.HSB_EMAIL_FROM ?? '').trim());
  /** @type {Check[]} */
  const checks = [];
  checks.push({
    section: 'Admin / email-health',
    status: provider.present ? STATUS.PASS : STATUS.WARNING,
    label: 'Email provider key (RESEND)',
    detail: provider.present
      ? `present (len=${provider.length}${provider.prefix ? `, prefix=${provider.prefix}` : ''}).`
      : 'MISSING in this shell — verify on the Vercel target.',
  });
  checks.push({
    section: 'Admin / email-health',
    status: fromSet ? STATUS.PASS : STATUS.WARNING,
    label: 'From address (EMAIL_FROM / HSB_EMAIL_FROM)',
    detail: fromSet ? 'configured.' : 'not set in this shell.',
  });
  checks.push({
    section: 'Admin / email-health',
    status: STATUS.NOT_CHECKED,
    label: 'Live email-health probe',
    detail: 'not run — no customer sends and no network calls are performed by this tool.',
  });
  return checks;
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {Check[]}
 */
export function buildOrderReadinessChecks(env) {
  const admin = redactSecret((env.HSB_ORDER_ADMIN_KEY ?? '').trim());
  const blob = redactSecret((env.BLOB_READ_WRITE_TOKEN ?? '').trim());
  /** @type {Check[]} */
  const checks = [];
  checks.push({
    section: 'Order / proof readiness',
    status: admin.present ? STATUS.PASS : STATUS.WARNING,
    label: 'Admin key configured (HSB_ORDER_ADMIN_KEY)',
    detail: admin.present ? `present (len=${admin.length}).` : 'MISSING in this shell.',
  });
  checks.push({
    section: 'Order / proof readiness',
    status: blob.present ? STATUS.PASS : STATUS.WARNING,
    label: 'Order store token (BLOB_READ_WRITE_TOKEN)',
    detail: blob.present ? `present (len=${blob.length}).` : 'MISSING in this shell.',
  });
  checks.push({
    section: 'Order / proof readiness',
    status: STATUS.NOT_CHECKED,
    label: 'Live order/proof enumeration',
    detail:
      'not queried — kept read-only and offline. Use /admin/orders or `npm run order:status -- <id>` for a live, authenticated read.',
  });
  return checks;
}

/**
 * @param {{ branch:string, head:string, dirty:boolean, dirtyCount:number,
 *           vercelProjectId:string|null }} git
 * @param {Record<string,string|undefined>} env
 * @returns {Check[]}
 */
export function buildDeployIdentityChecks(git, env) {
  /** @type {Check[]} */
  const checks = [];
  checks.push({
    section: 'Deploy identity',
    status: git.dirty ? STATUS.WARNING : STATUS.PASS,
    label: 'Git',
    detail:
      `branch=${git.branch} head=${git.head}` +
      (git.dirty ? ` · working tree DIRTY (${git.dirtyCount} file(s))` : ' · clean'),
  });
  const vercelEnv = (env.VERCEL_ENV ?? '').trim();
  const commitRef = (env.VERCEL_GIT_COMMIT_REF ?? '').trim();
  const commitSha = (env.VERCEL_GIT_COMMIT_SHA ?? '').trim().slice(0, 12);
  if (vercelEnv || commitRef || commitSha || git.vercelProjectId) {
    checks.push({
      section: 'Deploy identity',
      status: STATUS.PASS,
      label: 'Vercel',
      detail:
        `env=${vercelEnv || '(n/a)'} ref=${commitRef || '(n/a)'} ` +
        `sha=${commitSha || '(n/a)'} project=${git.vercelProjectId ? `${git.vercelProjectId.slice(0, 12)}…` : '(n/a)'}`,
    });
  } else {
    checks.push({
      section: 'Deploy identity',
      status: STATUS.NOT_CHECKED,
      label: 'Vercel',
      detail: 'no local Vercel identity (VERCEL_* env / .vercel/project.json) available in this shell.',
    });
  }
  return checks;
}

// ── Report assembly (pure) ───────────────────────────────────────────────────

/**
 * @param {Object} input
 * @param {Record<string,string|undefined>} input.env
 * @param {string} input.now            ISO timestamp
 * @param {string} input.target         target environment/domain label
 * @param {{ branch:string, head:string, dirty:boolean, dirtyCount:number, vercelProjectId:string|null }} input.git
 * @param {{ checkoutPauseLib:boolean, webhookRouteExists:boolean, webhookSignatureVerify:boolean }} input.facts
 */
export function buildReport(input) {
  const { env, now, target, git, facts } = input;
  /** @type {Check[]} */
  const checks = [
    ...buildEnvChecks(env),
    ...buildKillSwitchChecks(env, { checkoutPauseLib: facts.checkoutPauseLib }),
    ...buildWebhookChecks(
      {
        routeExists: facts.webhookRouteExists,
        hasSignatureVerify: facts.webhookSignatureVerify,
        handlesMissingSecret: true,
      },
      env,
    ),
    ...buildEmailHealthChecks(env),
    ...buildOrderReadinessChecks(env),
    ...buildDeployIdentityChecks(git, env),
  ];

  const buckets = bucketCounts(checks);
  const blockers = checks.filter((c) => c.status === STATUS.BLOCKER);

  return {
    tool: 'capture-g5-evidence',
    version: 1,
    generatedAt: now,
    target,
    safety: {
      readOnly: true,
      customerSideEffects: 'No customer side effects performed.',
      productionWrites: false,
      stripeReplays: false,
      customerEmails: false,
      printSubmissions: false,
      aiGeneration: false,
      deploy: false,
      secretsPrinted: false,
    },
    buckets,
    blockers: blockers.map((b) => ({ section: b.section, label: b.label, detail: b.detail })),
    checks,
  };
}

/**
 * @param {Check[]} checks
 * @returns {{ PASS:number, WARNING:number, BLOCKER:number, 'NOT CHECKED':number }}
 */
export function bucketCounts(checks) {
  const out = { PASS: 0, WARNING: 0, BLOCKER: 0, 'NOT CHECKED': 0 };
  for (const c of checks) out[c.status] = (out[c.status] ?? 0) + 1;
  return out;
}

// ── Markdown rendering ───────────────────────────────────────────────────────

const GLYPH = { PASS: '✅', WARNING: '⚠️', BLOCKER: '⛔', 'NOT CHECKED': '⏭️' };

/**
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const L = [];
  L.push('# HSB G5 Owner-Test Evidence Packet');
  L.push('');
  L.push(`- Generated: ${report.generatedAt}`);
  L.push(`- Target: ${report.target}`);
  L.push(`- Tool: ${report.tool} v${report.version} (read-only)`);
  L.push('');
  L.push('> **No customer side effects performed.** No production writes, no Stripe replays, no');
  L.push('> customer emails, no print/Lulu submissions, no FAL/OpenAI/Gemini generation, no deploy,');
  L.push('> no Vercel env mutation. Secret values are redacted to presence/length/structural-prefix only.');
  L.push('');
  const b = report.buckets;
  L.push(`**Summary:** ✅ PASS ${b.PASS} · ⚠️ WARNING ${b.WARNING} · ⛔ BLOCKER ${b.BLOCKER} · ⏭️ NOT CHECKED ${b['NOT CHECKED']}`);
  L.push('');
  if (report.blockers.length > 0) {
    L.push('## ⛔ Blockers');
    for (const blk of report.blockers) L.push(`- **${blk.section} — ${blk.label}:** ${blk.detail}`);
    L.push('');
  } else {
    L.push('## ⛔ Blockers');
    L.push('- none detected by this read-only check (WARNING/NOT CHECKED items still need human confirmation).');
    L.push('');
  }

  // Group checks by section, preserving first-seen order.
  const order = [];
  const bySection = new Map();
  for (const c of report.checks) {
    if (!bySection.has(c.section)) {
      bySection.set(c.section, []);
      order.push(c.section);
    }
    bySection.get(c.section).push(c);
  }
  for (const section of order) {
    L.push(`## ${section}`);
    L.push('');
    L.push('| Status | Item | Detail |');
    L.push('| --- | --- | --- |');
    for (const c of bySection.get(section)) {
      const detail = c.detail.replace(/\|/g, '\\|');
      L.push(`| ${GLYPH[c.status]} ${c.status} | ${c.label} | ${detail} |`);
    }
    L.push('');
    // Env var detail (redacted) for the env section.
    for (const c of bySection.get(section)) {
      if (!c.data || !Array.isArray(c.data.vars)) continue;
      L.push(`<details><summary>${c.label} — redacted env detail</summary>`);
      L.push('');
      L.push('| Var | Present | Shown | Length | Prefix |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const v of c.data.vars) {
        L.push(
          `| ${v.name} | ${v.present ? 'yes' : 'no'} | ${v.shown ?? '—'} | ${v.length ?? '—'} | ${v.prefix ?? '—'} |`,
        );
      }
      L.push('');
      L.push('</details>');
      L.push('');
    }
  }
  L.push('---');
  L.push('Statuses are captured from the LOCAL shell + repo. WARNING/NOT CHECKED items are not');
  L.push('failures — they mark things a human must confirm on the Vercel target before clearing G5.');
  L.push('');
  return L.join('\n');
}

// ── Real-world fact gathering (I/O; not exercised by unit tests) ─────────────

function gitFacts(repoRoot) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']) || '(unknown)';
  const head = run(['rev-parse', '--short=12', 'HEAD']) || '(unknown)';
  const dirtyLines = run(['status', '--porcelain']).split('\n').filter(Boolean);
  let vercelProjectId = null;
  const projectJson = resolve(repoRoot, '.vercel', 'project.json');
  if (existsSync(projectJson)) {
    try {
      const data = JSON.parse(readFileSync(projectJson, 'utf8'));
      if (typeof data.projectId === 'string') vercelProjectId = data.projectId;
    } catch {
      /* ignore malformed local config */
    }
  }
  return { branch, head, dirty: dirtyLines.length > 0, dirtyCount: dirtyLines.length, vercelProjectId };
}

function repoFacts(repoRoot) {
  const webhookPath = resolve(repoRoot, 'src/app/api/webhooks/stripe/route.ts');
  const webhookRouteExists = existsSync(webhookPath);
  let webhookSignatureVerify = false;
  if (webhookRouteExists) {
    try {
      webhookSignatureVerify = /constructEvent\s*\(/.test(readFileSync(webhookPath, 'utf8'));
    } catch {
      webhookSignatureVerify = false;
    }
  }
  const checkoutPauseLib = existsSync(resolve(repoRoot, 'src/lib/checkout-pause.ts'));
  return { webhookRouteExists, webhookSignatureVerify, checkoutPauseLib };
}

function resolveTarget(env, explicit) {
  if (explicit) return explicit;
  if (env.NEXT_PUBLIC_URL) return env.NEXT_PUBLIC_URL;
  if (env.VERCEL_ENV) return `vercel:${env.VERCEL_ENV}`;
  return 'local shell (unspecified target)';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function folderStamp(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}`
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, target: null, out: 'ops/logs', help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a.startsWith('--target=')) out.target = a.slice('--target='.length);
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

const USAGE = `HSB G5 owner-test evidence capture (read-only).

USAGE
  node scripts/capture-g5-evidence.mjs [--target=<url|label>] [--out=<dir>] [--json]

OPTIONS
  --target=<url|label>  Label the target environment/domain (default: NEXT_PUBLIC_URL / VERCEL_ENV).
  --out=<dir>           Base output dir (default: ops/logs).
  --json                Also print the JSON report to stdout.
  -h, --help            This message.

Writes ops/logs/g5-evidence-<YYYY-MM-DD-HHMM>/{summary.json,summary.md}.
Exit 0 even if launch blockers are found; nonzero only on script failure.
NEVER prints secret values, performs customer actions, or deploys.`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const repoRoot = process.cwd();
  const env = process.env;
  const nowDate = new Date();
  const git = gitFacts(repoRoot);
  const facts = repoFacts(repoRoot);
  const target = resolveTarget(env, args.target);

  const report = buildReport({ env, now: nowDate.toISOString(), target, git, facts });

  // Belt-and-suspenders: refuse to write if any real secret body leaked into
  // the serialized packet. A leak here is a tool bug, not a launch finding.
  const json = JSON.stringify(report, null, 2);
  const md = renderMarkdown(report);
  const secretEnv = {};
  for (const name of secretEnvNames()) secretEnv[name] = env[name];
  const leaked = findLeakedSecrets(`${json}\n${md}`, secretEnv);
  if (leaked.length > 0) {
    process.stderr.write(
      `[capture-g5-evidence] ABORT: redaction self-check found ${leaked.length} leaked secret(s): ` +
        `${leaked.join(', ')}. Not writing packet.\n`,
    );
    process.exit(1);
  }

  const dirName = `g5-evidence-${folderStamp(nowDate)}`;
  const outDir = resolve(repoRoot, args.out, dirName);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'summary.json'), `${json}\n`, 'utf8');
    writeFileSync(join(outDir, 'summary.md'), md, 'utf8');
  } catch (err) {
    process.stderr.write(`[capture-g5-evidence] failed to write packet: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const b = report.buckets;
  const rel = join(args.out, dirName);
  process.stdout.write(
    `G5 evidence packet written: ${rel}/summary.md (+ summary.json)\n` +
      `  PASS ${b.PASS} · WARNING ${b.WARNING} · BLOCKER ${b.BLOCKER} · NOT CHECKED ${b['NOT CHECKED']}\n` +
      `  Target: ${target}\n` +
      '  No customer side effects performed.\n',
  );
  if (args.json) process.stdout.write(`${json}\n`);

  // Success exit even with blockers — collection succeeded.
  process.exit(0);
}

const __filename__ = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename__) {
  main();
}
