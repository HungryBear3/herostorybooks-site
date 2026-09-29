/**
 * Meta Conversions API: DEFERRED, as an executable status rather than a stub
 * that could be flipped on.
 *
 * A CAPI event needs `user_data` matching evidence. A policy-safe send would
 * require, at minimum: durable, explicit marketing consent recorded before
 * checkout; consented, bounded `fbp`/`fbc` browser identifiers carried through
 * signed Checkout Session metadata; and an approved decision on Advanced
 * Matching. This architecture carries none of them — Phase A signs only GA
 * identity and governed attribution into Stripe metadata — so the server
 * purchase resolves to this frozen no-send status with a null event, whatever
 * the settlement and whatever environment variables exist. There is no
 * transport, endpoint, token read, or env flag here to activate.
 *
 * The Phase-A settled-webhook winner (src/lib/purchase-analytics.ts) remains
 * the only purchase writer. Nothing in this module is called by the webhook.
 */
import { META_EVENT_CONTRACT } from './analytics-event-contract.ts';
import { PRIMARY_OUTCOME_EVIDENCE } from './campaign-governance.ts';

export const META_SERVER_PURCHASE_STATUS = Object.freeze({
  status: 'DEFERRED' as const,
  serverEvent: null,
  transport: null,
  reasons: Object.freeze([
    'NO_DURABLE_MARKETING_CONSENT',
    'NO_CONSENTED_FBP_FBC_IN_SIGNED_CHECKOUT_METADATA',
    'ADVANCED_MATCHING_NOT_APPROVED',
    'NO_POLICY_SAFE_USER_DATA',
  ] as const),
});

/** Always the frozen DEFERRED status: inputs and environment cannot change it. */
export function resolveMetaServerPurchase(_settlement?: unknown, _env?: unknown): typeof META_SERVER_PURCHASE_STATUS {
  return META_SERVER_PURCHASE_STATUS;
}

type Loose = Record<string, unknown> | null | undefined;

/**
 * The deferred server state may not contradict the event contract or what an
 * experiment is measured from: Purchase stays server-only and in the same
 * state as this status; a deferred status carries no event, no transport and
 * its reasons; and no primary outcome may be measured from a Meta source.
 */
export function metaDeferredContractViolations(input: {
  eventContract?: unknown;
  serverStatus?: unknown;
  primaryOutcomeEvidence?: unknown;
} = {}): string[] {
  const contract = (input.eventContract ?? META_EVENT_CONTRACT) as Record<string, Loose>;
  const status = (input.serverStatus ?? META_SERVER_PURCHASE_STATUS) as Loose;
  const evidence = (input.primaryOutcomeEvidence ?? PRIMARY_OUTCOME_EVIDENCE) as Record<string, Loose>;
  const violations: string[] = [];
  const purchase = contract?.Purchase;
  if (!purchase || purchase.browser !== 'forbidden' || purchase.transport !== 'server_conversions_api') {
    violations.push('META_BROWSER_PURCHASE_ALLOWED');
  }
  if (purchase?.state !== status?.status) violations.push('META_PURCHASE_STATE_CONTRADICTS_SERVER_STATUS');
  if (status?.status === 'DEFERRED') {
    if (status.serverEvent !== null || status.transport !== null) violations.push('META_DEFERRED_SERVER_EVENT_PRESENT');
    if (!Array.isArray(status.reasons) || status.reasons.length === 0) violations.push('META_DEFERRED_WITHOUT_REASONS');
    const sources = Object.values(evidence ?? {}).flatMap((basis) => [basis?.events, basis?.denominator]);
    if (sources.some((source) => typeof source === 'string' && source.startsWith('meta.'))) {
      violations.push('EXPERIMENT_OUTCOME_DEPENDS_ON_DEFERRED_META');
    }
  }
  return violations;
}
