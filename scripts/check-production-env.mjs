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
    name: 'NEXT_PUBLIC_URL',
    purpose: 'Canonical site origin used in emails, review URLs, og:url. MUST be https + no localhost on production.',
    aliases: [],
    requiredOn: ['production'],
    shape: shapeNextPublicUrl,
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

// ── Inspect ──────────────────────────────────────────────────────────────────

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

  // PRESENT_DISALLOWED branch (currently only HSB_BLOB_NAMESPACE on prod
  // without the approved-for-production flag).
  if (spec.flagIfPresent && foundName !== null && raw !== undefined && raw.trim().length > 0) {
    const sh = spec.shape((raw ?? '').trim());
    return {
      name: spec.name,
      lookedAt: foundName,
      status: sh.ok ? 'PRESENT' : 'PRESENT_DISALLOWED',
      requiredHere,
      observation: sh.observation,
      purpose: spec.purpose,
    };
  }

  if (foundName === null) {
    return {
      name: spec.name,
      lookedAt: null,
      status: 'MISSING',
      requiredHere,
      observation: requiredHere
        ? `not set (required on ${env})`
        : `not set (optional on ${env})`,
      purpose: spec.purpose,
    };
  }
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return {
      name: spec.name,
      lookedAt: foundName,
      status: 'PRESENT_BUT_EMPTY',
      requiredHere,
      observation:
        raw === ''
          ? `set to empty string`
          : `set to whitespace-only value (raw length ${(raw ?? '').length})`,
      purpose: spec.purpose,
    };
  }
  const sh = spec.shape(trimmed);
  return {
    name: spec.name,
    lookedAt: foundName,
    status: sh.ok ? 'PRESENT' : 'SHAPE_FAIL',
    requiredHere,
    observation: sh.observation,
    purpose: spec.purpose,
  };
}

const results = checks.map(inspectOne);

// A result is a FAILURE if it's required-here AND status is anything
// other than 'PRESENT', OR if it's PRESENT_DISALLOWED regardless of
// requiredHere. PRESENT alone is always fine.
const failures = results.filter(
  (r) => r.status === 'PRESENT_DISALLOWED' || (r.requiredHere && r.status !== 'PRESENT'),
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
  process.stdout.write(`HSB production env activation check — env=${env} — ${new Date().toISOString()}\n`);
  process.stdout.write(`(read-only; no values printed; no Vercel mutation)\n\n`);
  for (const r of results) {
    const reqTag = r.requiredHere ? ' [required]' : ' [optional]';
    const aliasTag = r.lookedAt && r.lookedAt !== r.name ? ` (via alias ${r.lookedAt})` : '';
    process.stdout.write(
      `${r.name.padEnd(PAD)} ${r.status.padEnd(STATUS_PAD)}${reqTag}${aliasTag}\n` +
        `  ${r.observation}\n` +
        `  → ${r.purpose}\n\n`,
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
