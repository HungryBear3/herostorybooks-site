#!/usr/bin/env node
/**
 * HSB production env activation checklist.
 *
 * Read-only audit that reports which required-on-Production env vars
 * are PRESENT / MISSING / PRESENT_BUT_EMPTY / SHAPE_FAIL /
 * PRESENT_DISALLOWED. Designed for the operator activation flow after
 * the 2026-06-02 deploy-candidate audit (closed R1–R6 plus the
 * ops/ NFT-leak fix).
 *
 * HARD RULES this script enforces against itself:
 *   - Never prints any secret value. Only length, presence-tag, and a
 *     sanitized shape observation (e.g., "starts with 'whsec_'") when
 *     the prefix is itself a documented public marker, not a secret.
 *   - Never writes to any file.
 *   - Never makes network calls.
 *   - Never modifies Vercel env (no `vercel env add`, no API calls).
 *   - Never deploys.
 *
 * Three invocation modes:
 *
 *   1. Local with shell-exported secrets (manual operator check):
 *        $ STRIPE_SECRET_KEY=… RESEND_WEBHOOK_SECRET=… \
 *            node scripts/check-production-env.mjs --env=production
 *
 *   2. Pulled-from-Vercel snapshot (preferred operator workflow):
 *        $ vercel env pull --environment=production .env.production.local
 *        $ node --env-file=.env.production.local \
 *            scripts/check-production-env.mjs --env=production
 *      The `.env.production.local` file is gitignored; verify your
 *      shell history is private before running.
 *
 *   3. JSON for CI / automation:
 *        $ node scripts/check-production-env.mjs --env=production --json
 *
 * Exit codes:
 *   0  every required-on-Production check is PRESENT + shape-OK
 *   1  one or more required checks failed (missing / empty / shape /
 *      disallowed-on-production)
 *   2  invocation error (bad flag, unknown --env)
 */

// ── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let env = 'production';
let json = false;
for (const a of args) {
  if (a === '--json') json = true;
  else if (a === '--help' || a === '-h') {
    printHelp();
    process.exit(0);
  } else if (a.startsWith('--env=')) {
    env = a.slice('--env='.length);
  } else {
    console.error(`Unknown flag: ${a}`);
    printHelp();
    process.exit(2);
  }
}
if (!['production', 'preview', 'development'].includes(env)) {
  console.error(`--env must be one of production | preview | development (got: ${env})`);
  process.exit(2);
}

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/check-production-env.mjs [--env=production|preview|development] [--json]\n` +
      `\n` +
      `Reports presence + shape of every required-on-Production env var.\n` +
      `Never prints secret values; never mutates Vercel; never deploys.\n`,
  );
}

// ── Check definitions ───────────────────────────────────────────────────────
//
// Each entry declares ONE env var to inspect. `aliases` lets us treat
// e.g., RESEND_API_KEY / HSB_RESEND_API_KEY interchangeably — the
// codebase reads both. `shape` is a function that returns
// { ok, observation } from the trimmed value; it MUST NOT echo the
// value itself. `requiredOn` lists the env contexts where the var is
// mandatory; missing in other contexts is fine.

const checks = [
  {
    name: 'BLOB_READ_WRITE_TOKEN',
    purpose: 'Vercel Blob durable persistence for orders, owner-print-go locks, KS state, Resend events.',
    aliases: [],
    requiredOn: ['production', 'preview'],
    shape: shapeStartsWith('vercel_blob_rw_'),
  },
  {
    name: 'RESEND_WEBHOOK_SECRET',
    purpose: 'Svix HMAC for /api/webhooks/resend. Without this the webhook 503s every inbound event.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeStartsWith('whsec_'),
  },
  {
    name: 'RESEND_API_KEY',
    purpose: 'Outbound Resend send (proof/digital/lifecycle emails).',
    aliases: ['HSB_RESEND_API_KEY'],
    requiredOn: ['production'],
    shape: shapeStartsWith('re_'),
  },
  {
    name: 'HSB_ORDER_ADMIN_KEY',
    purpose: 'Operator cookie/header secret for /admin/* and /api/admin/*.',
    aliases: [],
    requiredOn: ['production', 'preview'],
    shape: shapeMinLength(16),
  },
  {
    name: 'LULU_CLIENT_KEY',
    purpose: 'Lulu print-jobs OAuth client id.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeMinLength(8),
  },
  {
    name: 'LULU_CLIENT_SECRET',
    purpose: 'Lulu print-jobs OAuth client secret.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeMinLength(8),
  },
  {
    name: 'LULU_API_URL',
    purpose: 'Lulu base URL. Default api.lulu.com (production); api.sandbox.lulu.com is staging only.',
    aliases: [],
    requiredOn: [],
    shape: shapeLuluUrl,
  },
  {
    name: 'LULU_WEBHOOK_SECRET',
    purpose: 'HMAC for /api/webhooks/lulu. Optional but strongly recommended on production.',
    aliases: [],
    requiredOn: [],
    shape: shapeMinLength(8),
  },
  {
    name: 'STRIPE_SECRET_KEY',
    purpose: 'Stripe Checkout / webhook handling. MUST be a live key on production.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeStripeSecretKey,
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    purpose: 'Stripe webhook HMAC for /api/webhooks/stripe.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeStartsWith('whsec_'),
  },
  {
    name: 'FAL_KEY',
    purpose: 'FAL image-generation API key. Without it paid image generation cannot run and fulfillment stalls.',
    aliases: [],
    requiredOn: ['production'],
    // Present + non-empty is the requirement; we deliberately do not enforce a
    // strict prefix/format to avoid false SHAPE_FAILs across FAL key variants.
    // Reports length only, never the value.
    shape: shapeMinLength(8),
  },
  {
    name: 'NEXT_PUBLIC_URL',
    purpose: 'Canonical site origin used in emails, review URLs, og:url. MUST be https + no localhost on production.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeNextPublicUrl,
  },
  {
    name: 'HSB_PUBLIC_CHECKOUT_ENABLED',
    purpose:
      'Public checkout gate (src/lib/owner-test-gate.ts). When exactly true, non-allowlisted buyers may create Stripe Checkout sessions; proof/print gates still apply.',
    aliases: [],
    requiredOn: [],
    shape: shapeBooleanTrueFlag('public checkout is ENABLED; owner-test allowlist is bypassed'),
  },
  {
    name: 'HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT',
    purpose:
      'Optional public-intake hard cap for paid orders per Chicago day. If invalid at runtime, checkout fails closed.',
    aliases: [],
    requiredOn: [],
    shape: shapeDailyPaidLimit,
  },
  {
    name: 'HSB_OWNER_TEST_CHECKOUT_ENABLED',
    purpose:
      'Owner-test checkout enable flag (src/lib/owner-test-gate.ts). Required on production for the G5 owner-test: ' +
      "must be exactly 'true' or checkout stays default-closed.",
    aliases: [],
    requiredOn: ['production'],
    shape: shapeOwnerTestCheckoutEnabled,
  },
  {
    name: 'HSB_OWNER_TEST_EMAILS',
    purpose:
      'Owner-test email allowlist (src/lib/owner-test-gate.ts). Required on production for the G5 owner-test: ' +
      'comma-separated, must contain at least one valid email. Only listed buyers can complete checkout.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeOwnerTestEmails,
  },
  {
    name: 'HSB_BLOB_NAMESPACE',
    purpose:
      'Optional blob path prefix. On Production this MUST be unset/empty so writes land in the canonical namespace ' +
      '(per src/lib/orders.ts:getBlobNamespace). Override only if explicitly approved by ops.',
    aliases: [],
    requiredOn: [],
    shape: shapeBlobNamespaceForEnv(env),
    // Special: this var is checked even when not "required" because
    // its PRESENCE on production is the failure condition.
    flagIfPresent: true,
  },
];

// ── Shape helpers (NEVER echo the value) ────────────────────────────────────

function shapeStartsWith(prefix) {
  return (value) => {
    if (value.startsWith(prefix)) {
      return {
        ok: true,
        observation: `starts with '${prefix}', length ${value.length}`,
      };
    }
    return {
      ok: false,
      observation: `does NOT start with '${prefix}'; length ${value.length}`,
    };
  };
}

function shapeMinLength(min) {
  return (value) => {
    if (value.length >= min) {
      return { ok: true, observation: `length ${value.length} (>= ${min})` };
    }
    return {
      ok: false,
      observation: `length ${value.length} below required minimum ${min}`,
    };
  };
}

function shapeStripeSecretKey(value) {
  if (value.startsWith('sk_live_')) {
    return { ok: true, observation: `starts with 'sk_live_', length ${value.length}` };
  }
  if (value.startsWith('sk_test_')) {
    return {
      ok: false,
      observation: `starts with 'sk_test_' — this is a TEST key. Production must use 'sk_live_'. length ${value.length}`,
    };
  }
  return {
    ok: false,
    observation: `does NOT start with 'sk_live_' or 'sk_test_'; length ${value.length}`,
  };
}

function shapeLuluUrl(value) {
  if (value.includes('api.sandbox.lulu.com')) {
    return {
      ok: false,
      observation: `points at api.sandbox.lulu.com — sandbox/staging only. Production must use api.lulu.com.`,
    };
  }
  if (value.startsWith('https://api.lulu.com')) {
    return { ok: true, observation: `https://api.lulu.com (production)` };
  }
  return {
    ok: true,
    observation: `non-default value (length ${value.length}); verify intentionally`,
  };
}

function shapeNextPublicUrl(value) {
  const trimmed = value.trim();
  if (/^https:\/\//i.test(trimmed) === false) {
    return {
      ok: false,
      observation: `does NOT start with https://; got scheme=${trimmed.split('://')[0] || '(none)'}; length ${trimmed.length}`,
    };
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.includes('localhost') || lowered.includes('127.0.0.1')) {
    return {
      ok: false,
      observation: `contains localhost/127.0.0.1 — invalid for production`,
    };
  }
  if (lowered.includes('vercel.app')) {
    return {
      ok: false,
      observation: `points at a *.vercel.app preview host — production must use the canonical custom domain`,
    };
  }
  if (trimmed.endsWith('/')) {
    return {
      ok: false,
      observation: `has a trailing slash; codebase strips one with .replace(/\\/$/, '') but ops convention is no trailing slash`,
    };
  }
  return { ok: true, observation: `https origin (length ${trimmed.length}); no localhost / vercel.app / trailing slash` };
}

function shapeBooleanTrueFlag(enabledObservation) {
  return (value) => {
    if (value.toLowerCase() === 'true') {
      return { ok: true, observation: `equals 'true' — ${enabledObservation}` };
    }
    return {
      ok: false,
      observation: `not enabled; must be exactly 'true' to open this mode (length ${value.length})`,
    };
  };
}

function shapeDailyPaidLimit(value) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100) {
    return { ok: true, observation: `integer daily paid-order cap ${parsed}` };
  }
  return {
    ok: false,
    observation: `must be an integer from 0 through 100; runtime treats invalid configured caps as closed`,
  };
}

function shapeBlobNamespaceForEnv(targetEnv) {
  return (value) => {
    if (targetEnv === 'production') {
      const approved = process.env.HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION === 'true';
      if (approved) {
        return {
          ok: true,
          observation: `present (length ${value.length}); HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION=true present, treated as explicitly approved`,
        };
      }
      return {
        ok: false,
        observation: `present (length ${value.length}) but HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION is not 'true'. Production must use the canonical blob namespace.`,
      };
    }
    if (targetEnv === 'preview') {
      if (value === 'production') {
        return {
          ok: false,
          observation: `equals 'production' on a Preview env — getBlobNamespace() refuses this combination outright. Use 'preview' or any other non-empty value.`,
        };
      }
      return { ok: true, observation: `preview namespace value (length ${value.length})` };
    }
    return { ok: true, observation: `dev namespace value (length ${value.length})` };
  };
}

// Owner-test checkout enable flag. Mirrors src/lib/owner-test-gate.ts:
// isOwnerTestCheckoutEnabled — only 'true' (case/whitespace tolerant) opens
// checkout, so the checker must accept exactly what the gate accepts. Anything
// else (including 'false') is a G5 blocker.
function shapeOwnerTestCheckoutEnabled(value) {
  if (value.toLowerCase() === 'true') {
    return { ok: true, observation: `equals 'true' — owner-test checkout is ENABLED` };
  }
  return {
    ok: false,
    observation: `must be exactly 'true' to enable owner-test checkout; got a non-'true' value (length ${value.length})`,
  };
}

// Owner-test email allowlist. Mirrors src/lib/owner-test-gate.ts parsing:
// comma-separated, trimmed, lowercased. Requires at least one syntactically
// valid email. NEVER echoes any address — reports counts only.
function shapeOwnerTestEmails(value) {
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const entries = value
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  const valid = entries.filter((e) => emailRe.test(e));
  if (valid.length >= 1) {
    return {
      ok: true,
      observation: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${valid.length} valid email(s) (values not shown)`,
    };
  }
  return {
    ok: false,
    observation: `0 syntactically valid emails parsed from ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (values not shown)`,
  };
}

// ── Inspect ──────────────────────────────────────────────────────────────────

/**
 * Build the operator next-action text for a given diagnosis. Returned
 * verbatim in both human and JSON output so a reviewer scanning logs
 * always sees the exact remediation, not just the failure code.
 */
function nextActionFor({ status, name, lookedAt, requiredHere }) {
  switch (status) {
    case 'PRESENT':
      return null;
    case 'MISSING':
      return requiredHere
        ? `Set ${name} in Vercel (Production scope) and re-pull: \`vercel env pull --environment=production .env.production.local\`. Then re-run this checker.`
        : `Optional. Set ${name} in Vercel if the feature it gates is in use.`;
    case 'PRESENT_BUT_EMPTY':
      // This is the Vercel "Encrypted but pulls blank" failure mode:
      // the env var shows up in the dashboard list (so the dashboard
      // tag says Encrypted) but the actual stored value is empty, so
      // `vercel env pull` writes `${VAR}=` and Node sees an empty
      // string. See docs/runbook for the dashboard fix.
      return (
        `Vercel "encrypted but pulls blank" pattern: the var is registered in the dashboard ` +
        `but the stored value is empty. Fix: \`vercel env rm ${lookedAt ?? name} production\` ` +
        `(removes the empty entry), then \`vercel env add ${lookedAt ?? name} production\` ` +
        `(pipe the value via stdin so it never appears in shell history), then ` +
        `\`vercel env pull --environment=production .env.production.local\` and re-run this checker. ` +
        `See docs/runbooks/hsb-vercel-env-encrypted-but-blank-2026-06-02.md.`
      );
    case 'SHAPE_FAIL':
      return (
        `Value is set but failed the shape check. Verify the value in the Vercel dashboard ` +
        `(do not paste it anywhere). Common causes: copied a test key instead of live, leading/trailing whitespace, ` +
        `or wrong prefix family. Replace with the correct value, re-pull, re-run.`
      );
    case 'PRESENT_DISALLOWED':
      return (
        `Variable is present on a scope it must not be present on. ` +
        `Remove it: \`vercel env rm ${lookedAt ?? name} production\`, re-pull, re-run. ` +
        `Override only if explicitly approved by ops via HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION=true.`
      );
    default:
      return `Unknown status; investigate manually.`;
  }
}

// Mirrors src/lib/stripe-env.ts:sanitizeStripeEnv. The runtime strips literal
// backslash-n escape sequences and real CR/LF from secrets before using them,
// so the checker must classify against the SAME normalized value. Without this
// a value like "\n" (the 2026-06-02 Stripe webhook-secret blocker, stored in
// Vercel as the literal two characters backslash+n) is misreported as
// SHAPE_FAIL instead of effectively-empty, and a value with a trailing escape
// artifact passes silently with no warning.
function normalizeEnvValue(raw) {
  const base = (raw ?? '').trim();
  const normalized = base.replace(/\\n/g, '').replace(/[\r\n]/g, '').trim();
  return { normalized, strippedEscapes: normalized !== base };
}

function inspectOne(spec) {
  const candidateNames = [spec.name, ...spec.aliases];
  let foundName = null;
  let raw = undefined;
  for (const n of candidateNames) {
    if (Object.prototype.hasOwnProperty.call(process.env, n)) {
      foundName = n;
      raw = process.env[n];
      break;
    }
  }
  const requiredHere = spec.requiredOn.includes(env);

  const baseResult = (status, observation) => {
    const r = {
      name: spec.name,
      lookedAt: foundName,
      status,
      requiredHere,
      observation,
      purpose: spec.purpose,
      nextAction: null,
    };
    r.nextAction = nextActionFor(r);
    return r;
  };

  // PRESENT_DISALLOWED branch (currently only HSB_BLOB_NAMESPACE on prod
  // without the approved-for-production flag).
  if (spec.flagIfPresent && foundName !== null && raw !== undefined && raw.trim().length > 0) {
    const sh = spec.shape((raw ?? '').trim());
    return baseResult(sh.ok ? 'PRESENT' : 'PRESENT_DISALLOWED', sh.observation);
  }

  if (foundName === null) {
    return baseResult('MISSING', requiredHere
      ? `not set (required on ${env})`
      : `not set (optional on ${env})`);
  }
  const { normalized, strippedEscapes } = normalizeEnvValue(raw);
  if (normalized.length === 0) {
    // Distinguish three blank failure modes — all PRESENT_BUT_EMPTY, but the
    // observation makes the diagnostic explicit:
    //   - raw === ''            : Vercel "encrypted but pulls blank"
    //   - whitespace / escapes  : value normalizes to empty (e.g. "\n"), which
    //                             the runtime secret sanitizer treats as unset
    const observation =
      raw === ''
        ? `set to EMPTY STRING — classic "Encrypted in Vercel dashboard but pulls blank" pattern`
        : `set to a value that normalizes to empty (raw length ${(raw ?? '').length}: only whitespace and/or literal \\n / CR-LF escapes) — the runtime secret sanitizer treats this as unset`;
    return baseResult('PRESENT_BUT_EMPTY', observation);
  }
  const sh = spec.shape(normalized);
  if (!sh.ok) {
    return baseResult('SHAPE_FAIL', sh.observation);
  }
  // Shape-valid AFTER normalization. If the raw value carried literal \n / CR-LF
  // that the runtime sanitizer strips, the secret still works but the stored
  // Vercel value is dirty — surface it so the operator can clean it before it
  // bites a consumer that does not sanitize.
  const observation = strippedEscapes
    ? `${sh.observation} — NOTE: raw value contained literal \\n or CR/LF that the runtime sanitizer strips; clean the stored Vercel value`
    : sh.observation;
  return baseResult('PRESENT', observation);
}

const results = checks.map(inspectOne);
const publicCheckoutOpen = results.some((r) => r.name === 'HSB_PUBLIC_CHECKOUT_ENABLED' && r.status === 'PRESENT');
const ownerTestNames = new Set(['HSB_OWNER_TEST_CHECKOUT_ENABLED', 'HSB_OWNER_TEST_EMAILS']);

// A result is a FAILURE if it's required-here AND status is anything
// other than 'PRESENT', OR if it's PRESENT_DISALLOWED regardless of
// requiredHere. PRESENT alone is always fine. When public checkout is explicitly
// open, owner-test allowlist vars are no longer production-blocking.
const failures = results.filter(
  (r) => r.status === 'PRESENT_DISALLOWED' || (r.requiredHere && r.status !== 'PRESENT' && !(publicCheckoutOpen && ownerTestNames.has(r.name))),
);
const warnings = results.filter(
  (r) => !r.requiredHere && r.status !== 'PRESENT' && r.status !== 'MISSING' && r.status !== 'PRESENT_DISALLOWED',
);

// ── Output ───────────────────────────────────────────────────────────────────

if (json) {
  process.stdout.write(
    JSON.stringify(
      {
        env,
        generatedAt: new Date().toISOString(),
        results,
        failures: failures.map((f) => f.name),
        warnings: warnings.map((w) => w.name),
        verdict: failures.length === 0 ? 'PASS' : 'FAIL',
      },
      null,
      2,
    ) + '\n',
  );
} else {
  const PAD = 30;
  const STATUS_PAD = 22;
  // Loud per-status marker so failures cannot be misread when the
  // operator is scanning a long scrollback. Plain-ASCII alternatives
  // are used in TTYs that strip emoji.
  const markerFor = (r) => {
    if (r.status === 'PRESENT') return '✅ OK    ';
    if (r.status === 'PRESENT_DISALLOWED') return '❌ FAIL  ';
    // Required + non-PRESENT = FAIL; optional + non-PRESENT = WARN.
    if (r.requiredHere) return '❌ FAIL  ';
    return '⚠️  WARN ';
  };
  process.stdout.write(`HSB production env activation check — env=${env} — ${new Date().toISOString()}\n`);
  process.stdout.write(`(read-only; no values printed; no Vercel mutation)\n\n`);
  for (const r of results) {
    const reqTag = r.requiredHere ? ' [required]' : ' [optional]';
    const aliasTag = r.lookedAt && r.lookedAt !== r.name ? ` (via alias ${r.lookedAt})` : '';
    process.stdout.write(
      `${markerFor(r)}${r.name.padEnd(PAD)} ${r.status.padEnd(STATUS_PAD)}${reqTag}${aliasTag}\n` +
        `   observed: ${r.observation}\n` +
        `   purpose:  ${r.purpose}\n` +
        (r.nextAction ? `   next:     ${r.nextAction}\n` : '') +
        `\n`,
    );
  }
  process.stdout.write(`Failures (required + not PRESENT, or disallowed-on-env): ${failures.length}\n`);
  if (failures.length > 0) {
    for (const f of failures) {
      process.stdout.write(`  - ${f.name} (${f.status})\n`);
    }
  }
  process.stdout.write(`Warnings (optional + not clean): ${warnings.length}\n`);
  if (warnings.length > 0) {
    for (const w of warnings) {
      process.stdout.write(`  - ${w.name} (${w.status})\n`);
    }
  }
  process.stdout.write(`\nVerdict: ${failures.length === 0 ? 'PASS' : 'FAIL'}\n`);
}

process.exit(failures.length === 0 ? 0 : 1);
