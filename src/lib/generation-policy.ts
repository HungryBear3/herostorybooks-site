/**
 * HSB Generation Operating Policy — route gate + config validator.
 *
 * This module is the single source of truth for which generation route a paid
 * order is allowed to take. Existing per-call provider selection (story-
 * generator.ts feature flags, image-generator.ts default chain) stays in
 * place, but the policy guard called from release/print boundaries
 * (`generation-manifest.ts evaluateReleaseGuard` / `evaluatePrintGuard`)
 * cross-checks the recorded provenance against this policy.
 *
 * Hard rules implemented here:
 *
 *  - Paid orders default to `OPENAI_MANUAL` (Abby / OpenAI subscription).
 *  - `OPENAI_API` is permitted only when `apiFallbackEnabled=true` and
 *    manual capacity is full (caller asserts).
 *  - `FAL` / `SEEDREAM` are permitted only when `emergencyImageRoute=true`
 *    AND the order carries both `emergencyApprovedBy` and
 *    `emergencyApprovalRef`. Per-order audit log entry is required.
 *  - `TEMPLATE_FIXTURE` is never permitted for a paid order, regardless of
 *    config. This is the "no template prose ships to a paying customer"
 *    invariant.
 *
 * Production safety:
 *
 *  - In production (`NODE_ENV='production'` or `VERCEL_ENV='production'`),
 *    `allowTemplateFallbackForPaid=true` causes `loadGenerationPolicyConfig`
 *    to throw at startup.
 *  - `defaultPaidCustomerRoute` other than `OPENAI_MANUAL` is also rejected
 *    in production.
 *  - Env vars MAY override flags in dev/preview but are ignored for the
 *    dangerous flags in production (the tracked JSON wins).
 *
 * This module has no broker, network, secret, or order-store dependencies.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Statically-imported tracked defaults. Importing the JSON directly
// makes the policy config statically traceable for Turbopack/NFT and
// removes the need for `fs.readFileSync(process.cwd() + ...)` at runtime.
// Tests still override via `opts.readJson`.
import TRACKED_POLICY from '../../data/policies/generation-route.json' with { type: 'json' };

export type GenerationRoute =
  | 'OPENAI_MANUAL'
  | 'OPENAI_API'
  | 'FAL'
  | 'SEEDREAM'
  | 'TEMPLATE_FIXTURE'
  | 'BLOCKED';

export type RouteFailureCode =
  | 'BLOCKED_TEMPLATE_PAID'
  | 'BLOCKED_FAL_NO_APPROVAL'
  | 'BLOCKED_FAL_FLAG_OFF'
  | 'BLOCKED_API_FLAG_OFF'
  | 'BLOCKED_API_MANUAL_CAPACITY_AVAILABLE'
  | 'BLOCKED_UNKNOWN_REQUEST'
  | 'BLOCKED_NOT_PAID';

export interface GenerationPolicyConfig {
  policyVersion: string;
  binding: string;
  defaultPaidCustomerRoute: GenerationRoute;
  apiFallbackEnabled: boolean;
  emergencyImageRoute: boolean;
  allowTemplateFallbackForPaid: boolean;
  orderIntakeOpen: boolean;
  digitalFirstMode: boolean;
  printCtaEnabled: boolean;
}

export interface RouteDecisionInput {
  /** Required: is this a paid customer order? */
  paid: boolean;
  /** Operator-requested route. Defaults to config.defaultPaidCustomerRoute. */
  requestedRoute?: GenerationRoute;
  /** Required for any fal/Seedream paid-order route. */
  emergencyApprovedBy?: string | null;
  /** Required for any fal/Seedream paid-order route. */
  emergencyApprovalRef?: string | null;
  /** When true, manual capacity is exhausted and OpenAI API fallback may be
   *  considered (still requires `apiFallbackEnabled`). */
  manualCapacityFull?: boolean;
  /** Optional record of explicit Alexy authorization for an API-fallback
   *  batch — recorded for the audit event when present, not yet gating. */
  apiAuthorizedBy?: string | null;
  apiAuthorizedAt?: string | null;
}

export interface RouteDecision {
  route: GenerationRoute;
  permitted: boolean;
  reason: string;
  failureCode?: RouteFailureCode;
  /** Always true when the decision is fallback/emergency and permitted —
   *  callers MUST record a `route_decision_recorded` audit event. */
  requiresAuditLog: boolean;
  /** Echoed approver fields when applicable (for the audit payload). */
  approvedBy?: string | null;
  approvalRef?: string | null;
}

// Static relative path. Node resolves it against the runtime CWD;
// avoiding `process.cwd()` here keeps Turbopack's NFT from treating
// this as a dynamic filesystem reference and ballooning the trace
// of every route bundle that transitively imports this module (the
// 2026-06-02 "unexpected file in NFT list" warning surfaced
// through webhooks/lulu → admin-actions → generation-manifest →
// here). The resolved file still lands at <project-root>/data/...
// at runtime.
const POLICY_CONFIG_PATH = join('data', 'policies', 'generation-route.json');

const CONSERVATIVE_DEFAULTS: GenerationPolicyConfig = {
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

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

/**
 * Read the tracked policy config from `data/policies/generation-route.json`.
 *
 * In production, dangerous flags (`allowTemplateFallbackForPaid`,
 * `apiFallbackEnabled`, `emergencyImageRoute`) and the default route are
 * sourced exclusively from the tracked JSON; env vars are ignored. In
 * dev/preview, env vars (HSB_POLICY_*) can override for testing.
 *
 * Throws on invalid config (production-only): if the file enables template
 * fallback for paid or sets a default route other than OPENAI_MANUAL.
 */
export function loadGenerationPolicyConfig(
  opts: { configPath?: string; readJson?: (path: string) => unknown } = {},
): GenerationPolicyConfig {
  // Primary source: the statically-imported TRACKED_POLICY JSON.
  // `opts.readJson` is honored only as a test seam — production code
  // never opts in. `opts.configPath` is preserved for backward
  // compatibility but is only consulted when `readJson` is also passed.
  const path = opts.configPath ?? POLICY_CONFIG_PATH;
  let raw: unknown = TRACKED_POLICY;
  if (opts.readJson) {
    try {
      raw = opts.readJson(path);
    } catch (err) {
      if (isProductionEnv()) {
        throw new Error(
          `[generation-policy] Test seam readJson threw in production env: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      raw = {};
    }
  }
  // `existsSync` is retained as a defensive read in case the bundler
  // omitted the JSON; in practice the static import keeps this no-op.
  if (!opts.readJson && existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // fall back to TRACKED_POLICY (already assigned)
    }
  }
  const r = (raw ?? {}) as Partial<GenerationPolicyConfig>;
  const merged: GenerationPolicyConfig = {
    policyVersion: r.policyVersion ?? CONSERVATIVE_DEFAULTS.policyVersion,
    binding: r.binding ?? CONSERVATIVE_DEFAULTS.binding,
    defaultPaidCustomerRoute: r.defaultPaidCustomerRoute ?? CONSERVATIVE_DEFAULTS.defaultPaidCustomerRoute,
    apiFallbackEnabled: r.apiFallbackEnabled ?? CONSERVATIVE_DEFAULTS.apiFallbackEnabled,
    emergencyImageRoute: r.emergencyImageRoute ?? CONSERVATIVE_DEFAULTS.emergencyImageRoute,
    allowTemplateFallbackForPaid: r.allowTemplateFallbackForPaid ?? CONSERVATIVE_DEFAULTS.allowTemplateFallbackForPaid,
    orderIntakeOpen: r.orderIntakeOpen ?? CONSERVATIVE_DEFAULTS.orderIntakeOpen,
    digitalFirstMode: r.digitalFirstMode ?? CONSERVATIVE_DEFAULTS.digitalFirstMode,
    printCtaEnabled: r.printCtaEnabled ?? CONSERVATIVE_DEFAULTS.printCtaEnabled,
  };
  // Production-only validation: refuse weakened defaults.
  const errors = validateGenerationPolicyConfig(merged);
  if (isProductionEnv() && errors.length > 0) {
    throw new Error(
      `[generation-policy] Production refused unsafe config: ${errors.join('; ')}`,
    );
  }
  return merged;
}

/**
 * Pure validator — returns a list of policy-violating field reasons.
 * Empty array means the config is conservative-enough for production.
 */
export function validateGenerationPolicyConfig(
  config: GenerationPolicyConfig,
): string[] {
  const reasons: string[] = [];
  if (config.allowTemplateFallbackForPaid === true) {
    reasons.push('allowTemplateFallbackForPaid=true forbidden — template prose must never reach paid customers');
  }
  if (config.defaultPaidCustomerRoute !== 'OPENAI_MANUAL') {
    reasons.push(
      `defaultPaidCustomerRoute=${config.defaultPaidCustomerRoute} forbidden — paid default must be OPENAI_MANUAL`,
    );
  }
  // fal/Seedream cannot be a default route at all (even outside of paid).
  // We keep the field strict to OPENAI_MANUAL / OPENAI_API for default;
  // fal/Seedream/TEMPLATE_FIXTURE/BLOCKED are not legal defaults.
  if (
    config.defaultPaidCustomerRoute === 'FAL' ||
    config.defaultPaidCustomerRoute === 'SEEDREAM' ||
    config.defaultPaidCustomerRoute === 'TEMPLATE_FIXTURE'
  ) {
    reasons.push(
      `defaultPaidCustomerRoute=${config.defaultPaidCustomerRoute} forbidden — fal/Seedream/template never default for paid`,
    );
  }
  return reasons;
}

/**
 * Decide the route for a paid generation attempt against the policy.
 *
 * Always returns a `RouteDecision` (never throws). When `permitted=false`,
 * `route='BLOCKED'` and `failureCode` is set. Callers MUST inspect
 * `permitted` before acting.
 *
 * Non-paid orders (test/internal/fixture) are permitted to use any route
 * (including TEMPLATE_FIXTURE) without audit log.
 */
export function chooseGenerationRoute(
  input: RouteDecisionInput,
  config: GenerationPolicyConfig = loadGenerationPolicyConfig(),
): RouteDecision {
  // Non-paid orders bypass the policy gate.
  if (input.paid !== true) {
    return {
      route: input.requestedRoute ?? config.defaultPaidCustomerRoute,
      permitted: true,
      reason: 'non-paid order — policy gate not applied',
      requiresAuditLog: false,
    };
  }
  const requested = input.requestedRoute ?? config.defaultPaidCustomerRoute;

  // Template fixture is never permitted for paid orders, regardless of config.
  if (requested === 'TEMPLATE_FIXTURE') {
    return {
      route: 'BLOCKED',
      permitted: false,
      reason: 'Template / fixture prose blocked for paid orders by policy §2',
      failureCode: 'BLOCKED_TEMPLATE_PAID',
      requiresAuditLog: true,
    };
  }

  // BLOCKED requested directly = honored, but audit-logged so we know who/why.
  if (requested === 'BLOCKED') {
    return {
      route: 'BLOCKED',
      permitted: false,
      reason: 'Caller explicitly requested BLOCKED route',
      failureCode: 'BLOCKED_UNKNOWN_REQUEST',
      requiresAuditLog: true,
    };
  }

  // fal/Seedream — emergency route only.
  if (requested === 'FAL' || requested === 'SEEDREAM') {
    if (!config.emergencyImageRoute) {
      return {
        route: 'BLOCKED',
        permitted: false,
        reason: `${requested} requested but emergencyImageRoute flag is disabled`,
        failureCode: 'BLOCKED_FAL_FLAG_OFF',
        requiresAuditLog: true,
      };
    }
    const approvedBy = (input.emergencyApprovedBy ?? '').trim();
    const approvalRef = (input.emergencyApprovalRef ?? '').trim();
    if (!approvedBy || !approvalRef) {
      return {
        route: 'BLOCKED',
        permitted: false,
        reason: `${requested} requested without both emergencyApprovedBy + emergencyApprovalRef`,
        failureCode: 'BLOCKED_FAL_NO_APPROVAL',
        requiresAuditLog: true,
      };
    }
    return {
      route: requested,
      permitted: true,
      reason: `${requested} emergency route permitted (approvedBy=${approvedBy})`,
      requiresAuditLog: true,
      approvedBy,
      approvalRef,
    };
  }

  // OPENAI_API — flagged + manual capacity exhausted.
  if (requested === 'OPENAI_API') {
    if (!config.apiFallbackEnabled) {
      return {
        route: 'BLOCKED',
        permitted: false,
        reason: 'OPENAI_API requested but apiFallbackEnabled flag is disabled',
        failureCode: 'BLOCKED_API_FLAG_OFF',
        requiresAuditLog: true,
      };
    }
    if (input.manualCapacityFull !== true) {
      return {
        route: 'BLOCKED',
        permitted: false,
        reason: 'OPENAI_API requested but manual capacity is not declared full',
        failureCode: 'BLOCKED_API_MANUAL_CAPACITY_AVAILABLE',
        requiresAuditLog: true,
      };
    }
    return {
      route: 'OPENAI_API',
      permitted: true,
      reason: 'OPENAI_API fallback permitted (manual capacity full + flag on)',
      requiresAuditLog: true,
      approvedBy: input.apiAuthorizedBy ?? null,
    };
  }

  // OPENAI_MANUAL — the default route, always permitted for paid orders.
  if (requested === 'OPENAI_MANUAL') {
    return {
      route: 'OPENAI_MANUAL',
      permitted: true,
      reason: 'OPENAI_MANUAL (default Abby / subscription) route',
      requiresAuditLog: false,
    };
  }

  // Unknown enum member — refuse, do not silently fall back.
  return {
    route: 'BLOCKED',
    permitted: false,
    reason: `Unknown requested route '${String(requested)}'`,
    failureCode: 'BLOCKED_UNKNOWN_REQUEST',
    requiresAuditLog: true,
  };
}

/**
 * Per-order context the release guard hands to `evaluatePaidRouteAllowance`.
 * Mirrors the bounded approval fields on OrderRecord so the same logic
 * `chooseGenerationRoute` uses at decision time also runs at release-time
 * verification.
 */
export interface PaidRouteContext {
  emergencyApprovedBy?: string | null;
  emergencyApprovalRef?: string | null;
  apiAuthorizedBy?: string | null;
  apiAuthorizedAt?: string | null;
}

export interface RouteAllowance {
  allowed: boolean;
  failureCode?:
    | 'BLOCKED_TEMPLATE_PAID'
    | 'BLOCKED_FAL_NO_APPROVAL'
    | 'BLOCKED_FAL_FLAG_OFF'
    | 'BLOCKED_API_FLAG_OFF'
    | 'BLOCKED_API_AUTHORIZATION_MISSING'
    | 'BLOCKED_UNKNOWN_REQUEST';
  reason?: string;
}

/**
 * The single shared policy check both `chooseGenerationRoute` (decision-
 * time) and `evaluateReleaseGuard` (release-time) consult. Verifies that
 * a given route family is currently allowed for a paid order, given the
 * order-level context (emergency / API authorization fields) and the
 * runtime config flags.
 */
export function evaluatePaidRouteAllowance(
  route: GenerationRoute,
  ctx: PaidRouteContext,
  config: GenerationPolicyConfig,
): RouteAllowance {
  if (route === 'OPENAI_MANUAL') {
    return { allowed: true };
  }
  if (route === 'TEMPLATE_FIXTURE') {
    return {
      allowed: false,
      failureCode: 'BLOCKED_TEMPLATE_PAID',
      reason: 'Template / fixture prose blocked for paid orders by policy §2',
    };
  }
  if (route === 'FAL' || route === 'SEEDREAM') {
    if (!config.emergencyImageRoute) {
      return {
        allowed: false,
        failureCode: 'BLOCKED_FAL_FLAG_OFF',
        reason: `${route} requires emergencyImageRoute=true in tracked config`,
      };
    }
    const approvedBy = (ctx.emergencyApprovedBy ?? '').trim();
    const approvalRef = (ctx.emergencyApprovalRef ?? '').trim();
    if (!approvedBy || !approvalRef) {
      return {
        allowed: false,
        failureCode: 'BLOCKED_FAL_NO_APPROVAL',
        reason: `${route} requires order-level emergencyApprovedBy + emergencyApprovalRef`,
      };
    }
    return { allowed: true };
  }
  if (route === 'OPENAI_API') {
    if (!config.apiFallbackEnabled) {
      return {
        allowed: false,
        failureCode: 'BLOCKED_API_FLAG_OFF',
        reason: 'OPENAI_API requires apiFallbackEnabled=true in tracked config',
      };
    }
    const authorizedBy = (ctx.apiAuthorizedBy ?? '').trim();
    const authorizedAt = (ctx.apiAuthorizedAt ?? '').trim();
    if (!authorizedBy || !authorizedAt) {
      return {
        allowed: false,
        failureCode: 'BLOCKED_API_AUTHORIZATION_MISSING',
        reason: 'OPENAI_API requires order-level apiAuthorizedBy + apiAuthorizedAt (per-day/batch authorization)',
      };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    failureCode: 'BLOCKED_UNKNOWN_REQUEST',
    reason: `Unknown route ${String(route)}`,
  };
}

/**
 * Map an existing PageArtifact `generationProvider` value to the policy
 * route family for downstream guards. Returns `null` for any unknown or
 * unmapped value — the release guard treats that as `MISSING_LINEAGE`,
 * which is the policy-mandated behavior (unknown providers MUST NOT
 * pass through the generic emergency-approval branch).
 */
export function pageProviderToRoute(
  generationProvider: string | null | undefined,
): GenerationRoute | null {
  if (!generationProvider) return null;
  const p = generationProvider.toLowerCase();
  if (p === 'manual' || p === 'openai_manual' || p === 'abby') return 'OPENAI_MANUAL';
  if (p === 'openai') return 'OPENAI_API';
  if (p === 'fal' || p === 'fal_edit' || p === 'fal-edit') return 'FAL';
  if (p === 'seedream' || p === 'seedream_edit') return 'SEEDREAM';
  if (p === 'template' || p === 'template_fixture' || p === 'fixture') return 'TEMPLATE_FIXTURE';
  // gemini and any other unmapped value: NOT on the v1 policy allow-list.
  // Returning null forces the release guard to refuse with MISSING_LINEAGE
  // rather than silently treating the page as "emergency route eligible".
  return null;
}

/**
 * Map a story source enum value to the policy route family. Per policy
 * §7 ("no template/generic prose") and §2 (route allow-list), gemini /
 * ollama / template sources are not on the allow-list for paid orders
 * and must block. `'manual'` covers the Abby subscription workflow.
 *
 * Returns `null` for any unmapped value — the release guard refuses
 * with MISSING_LINEAGE or PROVIDER_ROUTE_BLOCKED rather than silently
 * routing through the emergency-approval branch.
 */
export function storySourceToRoute(
  storySource: string | null | undefined,
): GenerationRoute | null {
  if (!storySource) return null;
  const s = storySource.toLowerCase();
  if (s === 'manual') return 'OPENAI_MANUAL';
  if (s === 'openai_chat' || s === 'openai_page_prose') return 'OPENAI_API';
  if (s === 'template' || s === 'template_fixture') return 'TEMPLATE_FIXTURE';
  if (s === 'template_after_openai_failure') return 'TEMPLATE_FIXTURE';
  // gemini_page_prose / ollama_page_prose / unknown: not on the v1
  // policy allow-list. Returning null blocks release.
  return null;
}
