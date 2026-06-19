/**
 * G5 Operator Control Room — verdict model (static/demo only).
 *
 * Mirrors the design artifact's verdict rule:
 *   GREEN  — all required checks pass · no blockers · G5 packet complete · zero warnings
 *   YELLOW — owner-test only: no blockers, but explicitly accepted warnings remain
 *   RED    — any missing env, email-health blocker, switch uncertainty,
 *            customer side-effect risk, unnamed operator, or incomplete G5 packet
 *
 * This module is INERT: it reads no env, performs no I/O, and makes no
 * provider calls. The state it operates on carries ONLY booleans / status
 * enums / label strings — never a secret value. There is no field that can
 * hold an env value, key, or token; redaction is structural, not runtime.
 */

// ── State shape (booleans + status enums only — never secret values) ─────────

/** present in a prod-shaped form · present but non-prod (test/staging/sandbox) · missing */
export type EnvStatus = 'present_prod' | 'present_nonprod' | 'missing';

export interface EnvVarState {
  /** Variable NAME only (e.g. "RESEND_WEBHOOK_SECRET") — never its value. */
  name: string;
  required: boolean;
  status: EnvStatus;
}

/** verified within SLA · stale (last event older than SLA) · unverifiable (no signal) */
export type EmailHealth = 'verified' | 'stale' | 'unverifiable';

export interface EmailState {
  webhookSecretPresent: boolean;
  apiKeyPresent: boolean;
  health: EmailHealth;
}

export interface PacketState {
  complete: boolean;
  missingItems: string[];
}

/** enforced & known-good · uncertain (cannot confirm enforcement) · tripped (active hold) */
export type SwitchStatus = 'enforced_ok' | 'uncertain' | 'tripped';

export interface KillSwitchState {
  id: string;
  status: SwitchStatus;
  /** Status-only switches (KS-4/KS-5) never drive the verdict. */
  enforced: boolean;
}

export interface OperatorState {
  named: boolean;
}

export interface SideEffectState {
  customerSideEffectRisk: boolean;
}

export interface DeclaredWarning {
  code: string;
  message: string;
  /** YELLOW requires every declared warning to be explicitly accepted. */
  accepted: boolean;
}

export interface ControlRoomState {
  env: EnvVarState[];
  email: EmailState;
  packet: PacketState;
  switches: KillSwitchState[];
  operator: OperatorState;
  sideEffect: SideEffectState;
  warnings: DeclaredWarning[];
}

export type Verdict = 'RED' | 'YELLOW' | 'GREEN';

export interface VerdictReason {
  kind: 'blocker' | 'warning';
  category: 'env' | 'email' | 'packet' | 'switch' | 'operator' | 'side_effect' | 'warning';
  message: string;
}

export interface VerdictResult {
  verdict: Verdict;
  blockers: VerdictReason[];
  warnings: VerdictReason[];
}

// ── Pure verdict function ────────────────────────────────────────────────────

/**
 * Compute the single launch verdict. Pure over the booleans/status fields of
 * `state` — same input always yields the same output, no I/O, no env.
 */
export function computeVerdict(state: ControlRoomState): VerdictResult {
  const blockers: VerdictReason[] = [];
  const warnings: VerdictReason[] = [];

  // Env: required + missing → blocker; non-prod → warning.
  for (const v of state.env) {
    if (v.required && v.status === 'missing') {
      blockers.push({ kind: 'blocker', category: 'env', message: `${v.name} missing` });
    } else if (v.status === 'present_nonprod') {
      warnings.push({ kind: 'warning', category: 'env', message: `${v.name} is non-prod (test/staging/sandbox)` });
    }
  }

  // Email health.
  if (!state.email.webhookSecretPresent) {
    blockers.push({ kind: 'blocker', category: 'email', message: 'RESEND_WEBHOOK_SECRET missing' });
  }
  if (!state.email.apiKeyPresent) {
    blockers.push({ kind: 'blocker', category: 'email', message: 'RESEND_API_KEY missing' });
  }
  if (state.email.health === 'unverifiable') {
    blockers.push({ kind: 'blocker', category: 'email', message: 'email health unverifiable' });
  } else if (state.email.health === 'stale') {
    blockers.push({ kind: 'blocker', category: 'email', message: 'email last verified event older than SLA' });
  }

  // G5 packet completeness.
  if (!state.packet.complete) {
    const detail = state.packet.missingItems.length ? `: ${state.packet.missingItems.join(', ')}` : '';
    blockers.push({ kind: 'blocker', category: 'packet', message: `G5 evidence packet incomplete${detail}` });
  }

  // Kill switches: only enforced switches can drive the verdict.
  for (const s of state.switches) {
    if (!s.enforced) continue;
    if (s.status === 'uncertain') {
      blockers.push({ kind: 'blocker', category: 'switch', message: `${s.id} enforcement uncertain` });
    } else if (s.status === 'tripped') {
      blockers.push({ kind: 'blocker', category: 'switch', message: `${s.id} is tripped (active hold)` });
    }
  }

  // Operator must be named for any owner-test action.
  if (!state.operator.named) {
    blockers.push({ kind: 'blocker', category: 'operator', message: 'operator not named' });
  }

  // Customer side-effect risk is an automatic blocker.
  if (state.sideEffect.customerSideEffectRisk) {
    blockers.push({ kind: 'blocker', category: 'side_effect', message: 'customer side-effect risk present' });
  }

  // Declared warnings: accepted → warning; not accepted → blocker (cannot be YELLOW).
  for (const w of state.warnings) {
    if (w.accepted) {
      warnings.push({ kind: 'warning', category: 'warning', message: w.message });
    } else {
      blockers.push({ kind: 'blocker', category: 'warning', message: `unaccepted warning: ${w.message}` });
    }
  }

  const verdict: Verdict = blockers.length > 0 ? 'RED' : warnings.length > 0 ? 'YELLOW' : 'GREEN';
  return { verdict, blockers, warnings };
}

export const VERDICT_RULE = {
  GREEN: 'all required checks pass · no blockers · G5 packet complete · zero warnings',
  YELLOW: 'owner-test only — no blockers, with explicitly accepted warnings remaining',
  RED: 'any missing env, email-health blocker, switch uncertainty, customer side-effect risk, unnamed operator, or incomplete G5 packet',
} as const;

// ── Static/demo data (fabricated — no real reads) ────────────────────────────

const REQUIRED_ENV = [
  'STRIPE_SECRET_KEY',
  'RESEND_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'LULU_API_KEY',
  'NEXT_PUBLIC_URL',
] as const;

function envAll(status: EnvStatus): EnvVarState[] {
  return REQUIRED_ENV.map((name) => ({ name, required: true, status }));
}

/**
 * Default demo state shown by the route. Fabricated to land on RED (the safe
 * posture): the G5 packet is incomplete and email health is unverifiable, so
 * the operator sees a clear "why". Toggle the named variants below in tests.
 */
export const DEMO_STATE: ControlRoomState = {
  env: [
    { name: 'STRIPE_SECRET_KEY', required: true, status: 'present_prod' },
    { name: 'RESEND_WEBHOOK_SECRET', required: true, status: 'missing' },
    { name: 'RESEND_API_KEY', required: true, status: 'present_prod' },
    { name: 'BLOB_READ_WRITE_TOKEN', required: true, status: 'present_prod' },
    { name: 'LULU_API_KEY', required: true, status: 'present_nonprod' },
    { name: 'NEXT_PUBLIC_URL', required: true, status: 'present_nonprod' },
  ],
  email: { webhookSecretPresent: false, apiKeyPresent: true, health: 'unverifiable' },
  packet: { complete: false, missingItems: ['paid order id', 'proof QA sign-off', 'owner print-go evidence'] },
  switches: [
    { id: 'KS-2 proof release hold', status: 'enforced_ok', enforced: true },
    { id: 'KS-3 owner print-go', status: 'enforced_ok', enforced: true },
    { id: 'KS-6 print-provider', status: 'enforced_ok', enforced: true },
    { id: 'KS-4 marketing hold', status: 'enforced_ok', enforced: false },
    { id: 'KS-5 provider hold', status: 'enforced_ok', enforced: false },
  ],
  operator: { named: false },
  sideEffect: { customerSideEffectRisk: false },
  warnings: [],
};

/** All-clear GREEN demo state — every required check passes, packet complete. */
export const DEMO_STATE_GREEN: ControlRoomState = {
  env: envAll('present_prod'),
  email: { webhookSecretPresent: true, apiKeyPresent: true, health: 'verified' },
  packet: { complete: true, missingItems: [] },
  switches: [
    { id: 'KS-2 proof release hold', status: 'enforced_ok', enforced: true },
    { id: 'KS-3 owner print-go', status: 'enforced_ok', enforced: true },
    { id: 'KS-6 print-provider', status: 'enforced_ok', enforced: true },
  ],
  operator: { named: true },
  sideEffect: { customerSideEffectRisk: false },
  warnings: [],
};

/** YELLOW demo: no blockers, one explicitly accepted warning remains. */
export const DEMO_STATE_YELLOW: ControlRoomState = {
  ...DEMO_STATE_GREEN,
  warnings: [
    {
      code: 'owner_test_window',
      message: 'owner-test checkout open to allow-listed emails only',
      accepted: true,
    },
  ],
};
