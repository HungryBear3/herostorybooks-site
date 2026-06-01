/**
 * Tests for the Generation Operating Policy route gate + config validator.
 *
 * Covers Section 10 required tests:
 *  1. Paid order forced to fal without emergencyApprovedBy → blocked
 *  2. Paid order forced to fal with approval but emergencyImageRoute=false → blocked
 *  3. Paid order forced to fal with approval AND emergencyImageRoute=true → permitted, requires audit
 * 11. Production config with allowTemplateFallbackForPaid=true → validation fails
 * 12. Production config with default route fal/Seedream → validation fails
 *
 * Plus several supporting cases (paid OPENAI_API gating, non-paid bypass,
 * template-fixture always blocked).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseGenerationRoute,
  loadGenerationPolicyConfig,
  pageProviderToRoute,
  storySourceToRoute,
  validateGenerationPolicyConfig,
  type GenerationPolicyConfig,
} from '../src/lib/generation-policy.ts';

const SAFE_DEFAULTS: GenerationPolicyConfig = {
  policyVersion: '2026-05-31',
  binding: "Father's Day launch through 2026-06-21",
  defaultPaidCustomerRoute: 'OPENAI_MANUAL',
  apiFallbackEnabled: false,
  emergencyImageRoute: false,
  allowTemplateFallbackForPaid: false,
  orderIntakeOpen: true,
  digitalFirstMode: true,
  printCtaEnabled: true,
};

// ── Required test 1 ──────────────────────────────────────────────────────────
test('paid order forced to fal without emergencyApprovedBy → BLOCKED', () => {
  const decision = chooseGenerationRoute(
    { paid: true, requestedRoute: 'FAL' },
    { ...SAFE_DEFAULTS, emergencyImageRoute: true },
  );
  assert.equal(decision.permitted, false);
  assert.equal(decision.route, 'BLOCKED');
  assert.equal(decision.failureCode, 'BLOCKED_FAL_NO_APPROVAL');
  assert.equal(decision.requiresAuditLog, true);
});

// ── Required test 2 ──────────────────────────────────────────────────────────
test('paid order forced to fal with approval but emergencyImageRoute=false → BLOCKED', () => {
  const decision = chooseGenerationRoute(
    {
      paid: true,
      requestedRoute: 'FAL',
      emergencyApprovedBy: 'alexy',
      emergencyApprovalRef: 'fd-emergency-2026-06-19',
    },
    SAFE_DEFAULTS,
  );
  assert.equal(decision.permitted, false);
  assert.equal(decision.route, 'BLOCKED');
  assert.equal(decision.failureCode, 'BLOCKED_FAL_FLAG_OFF');
});

// ── Required test 3 ──────────────────────────────────────────────────────────
test('paid order forced to fal with approval AND emergencyImageRoute=true → permitted + requires audit', () => {
  const decision = chooseGenerationRoute(
    {
      paid: true,
      requestedRoute: 'FAL',
      emergencyApprovedBy: 'alexy',
      emergencyApprovalRef: 'fd-emergency-2026-06-19',
    },
    { ...SAFE_DEFAULTS, emergencyImageRoute: true },
  );
  assert.equal(decision.permitted, true);
  assert.equal(decision.route, 'FAL');
  assert.equal(decision.requiresAuditLog, true);
  assert.equal(decision.approvedBy, 'alexy');
  assert.equal(decision.approvalRef, 'fd-emergency-2026-06-19');
});

test('paid order forced to Seedream behaves identically to fal under the policy', () => {
  const decision = chooseGenerationRoute(
    {
      paid: true,
      requestedRoute: 'SEEDREAM',
      emergencyApprovedBy: 'alexy',
      emergencyApprovalRef: 'fd-emergency-2026-06-19',
    },
    { ...SAFE_DEFAULTS, emergencyImageRoute: true },
  );
  assert.equal(decision.permitted, true);
  assert.equal(decision.route, 'SEEDREAM');
  assert.equal(decision.requiresAuditLog, true);
});

// ── TEMPLATE_FIXTURE always blocked for paid ─────────────────────────────────
test('paid order requesting TEMPLATE_FIXTURE → BLOCKED regardless of config', () => {
  const decision = chooseGenerationRoute(
    { paid: true, requestedRoute: 'TEMPLATE_FIXTURE' },
    { ...SAFE_DEFAULTS, allowTemplateFallbackForPaid: true }, // even if (validation-rejected) flag is on
  );
  assert.equal(decision.permitted, false);
  assert.equal(decision.route, 'BLOCKED');
  assert.equal(decision.failureCode, 'BLOCKED_TEMPLATE_PAID');
});

// ── Default route ───────────────────────────────────────────────────────────
test('paid order with no requestedRoute → defaults to OPENAI_MANUAL', () => {
  const decision = chooseGenerationRoute({ paid: true }, SAFE_DEFAULTS);
  assert.equal(decision.permitted, true);
  assert.equal(decision.route, 'OPENAI_MANUAL');
  assert.equal(decision.requiresAuditLog, false);
});

// ── OPENAI_API gating ───────────────────────────────────────────────────────
test('paid order requesting OPENAI_API with flag off → BLOCKED', () => {
  const decision = chooseGenerationRoute(
    { paid: true, requestedRoute: 'OPENAI_API', manualCapacityFull: true },
    SAFE_DEFAULTS,
  );
  assert.equal(decision.permitted, false);
  assert.equal(decision.failureCode, 'BLOCKED_API_FLAG_OFF');
});

test('paid order requesting OPENAI_API with flag on but manual capacity available → BLOCKED', () => {
  const decision = chooseGenerationRoute(
    { paid: true, requestedRoute: 'OPENAI_API', manualCapacityFull: false },
    { ...SAFE_DEFAULTS, apiFallbackEnabled: true },
  );
  assert.equal(decision.permitted, false);
  assert.equal(decision.failureCode, 'BLOCKED_API_MANUAL_CAPACITY_AVAILABLE');
});

test('paid order requesting OPENAI_API with flag on AND manual capacity full → permitted + audit', () => {
  const decision = chooseGenerationRoute(
    {
      paid: true,
      requestedRoute: 'OPENAI_API',
      manualCapacityFull: true,
      apiAuthorizedBy: 'alexy',
      apiAuthorizedAt: '2026-06-19T18:00:00Z',
    },
    { ...SAFE_DEFAULTS, apiFallbackEnabled: true },
  );
  assert.equal(decision.permitted, true);
  assert.equal(decision.route, 'OPENAI_API');
  assert.equal(decision.requiresAuditLog, true);
  assert.equal(decision.approvedBy, 'alexy');
});

// ── Non-paid bypass ─────────────────────────────────────────────────────────
test('non-paid order can use any route without audit log', () => {
  const decision = chooseGenerationRoute(
    { paid: false, requestedRoute: 'TEMPLATE_FIXTURE' },
    SAFE_DEFAULTS,
  );
  assert.equal(decision.permitted, true);
  assert.equal(decision.route, 'TEMPLATE_FIXTURE');
  assert.equal(decision.requiresAuditLog, false);
});

// ── Required test 11 ────────────────────────────────────────────────────────
test('config validation refuses allowTemplateFallbackForPaid=true', () => {
  const reasons = validateGenerationPolicyConfig({
    ...SAFE_DEFAULTS,
    allowTemplateFallbackForPaid: true,
  });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /allowTemplateFallbackForPaid=true forbidden/);
});

// ── Required test 12 ────────────────────────────────────────────────────────
test('config validation refuses default route FAL', () => {
  const reasons = validateGenerationPolicyConfig({
    ...SAFE_DEFAULTS,
    defaultPaidCustomerRoute: 'FAL',
  });
  assert.ok(reasons.length >= 1);
  assert.ok(reasons.some((r) => r.includes('defaultPaidCustomerRoute=FAL forbidden')));
});

test('config validation refuses default route SEEDREAM', () => {
  const reasons = validateGenerationPolicyConfig({
    ...SAFE_DEFAULTS,
    defaultPaidCustomerRoute: 'SEEDREAM',
  });
  assert.ok(reasons.some((r) => r.includes('defaultPaidCustomerRoute=SEEDREAM')));
});

test('config validation refuses default route TEMPLATE_FIXTURE', () => {
  const reasons = validateGenerationPolicyConfig({
    ...SAFE_DEFAULTS,
    defaultPaidCustomerRoute: 'TEMPLATE_FIXTURE',
  });
  assert.ok(reasons.some((r) => r.includes('TEMPLATE_FIXTURE')));
});

test('config validation accepts the conservative defaults', () => {
  const reasons = validateGenerationPolicyConfig(SAFE_DEFAULTS);
  assert.equal(reasons.length, 0);
});

// ── loadGenerationPolicyConfig: env-independent reading via injection ──────
test('loadGenerationPolicyConfig: uses injected readJson and applies conservative defaults for missing fields', () => {
  const config = loadGenerationPolicyConfig({
    readJson: () => ({}),
  });
  assert.equal(config.defaultPaidCustomerRoute, 'OPENAI_MANUAL');
  assert.equal(config.apiFallbackEnabled, false);
  assert.equal(config.emergencyImageRoute, false);
  assert.equal(config.allowTemplateFallbackForPaid, false);
});

// ── Production hard-fail on unsafe config ──────────────────────────────────
test('loadGenerationPolicyConfig throws in production when config weakens defaults', () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () =>
        loadGenerationPolicyConfig({
          readJson: () => ({ ...SAFE_DEFAULTS, allowTemplateFallbackForPaid: true }),
        }),
      /Production refused unsafe config/,
    );
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});

test('loadGenerationPolicyConfig allows unsafe config outside production for dev/preview testing', () => {
  const previousEnv = process.env.NODE_ENV;
  const previousVercel = process.env.VERCEL_ENV;
  process.env.NODE_ENV = 'development';
  delete process.env.VERCEL_ENV;
  try {
    const config = loadGenerationPolicyConfig({
      readJson: () => ({ ...SAFE_DEFAULTS, allowTemplateFallbackForPaid: true }),
    });
    assert.equal(config.allowTemplateFallbackForPaid, true);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousVercel !== undefined) process.env.VERCEL_ENV = previousVercel;
  }
});

// ── Provider/source → route family mapping (used by manifest guards) ───────
test('pageProviderToRoute maps known providers', () => {
  assert.equal(pageProviderToRoute('openai'), 'OPENAI_API');
  assert.equal(pageProviderToRoute('fal_edit'), 'FAL');
  assert.equal(pageProviderToRoute('seedream'), 'SEEDREAM');
  assert.equal(pageProviderToRoute('template'), 'TEMPLATE_FIXTURE');
  assert.equal(pageProviderToRoute('manual'), 'OPENAI_MANUAL');
  assert.equal(pageProviderToRoute(null), null);
});

test('storySourceToRoute maps known sources', () => {
  assert.equal(storySourceToRoute('openai_chat'), 'OPENAI_API');
  assert.equal(storySourceToRoute('gemini_page_prose'), 'FAL');
  assert.equal(storySourceToRoute('template'), 'TEMPLATE_FIXTURE');
  assert.equal(storySourceToRoute('template_after_openai_failure'), 'TEMPLATE_FIXTURE');
  assert.equal(storySourceToRoute(null), null);
});
