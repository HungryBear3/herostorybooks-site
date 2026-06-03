/**
 * Public-launch HOLD model (HER-11).
 *
 * This module makes the public-launch HOLD state *visible* to internal
 * operators. It is intentionally inert:
 *
 *   - It performs NO actions and mutates NOTHING (no orders, customers, env,
 *     provider, payment, print, or email state).
 *   - It NEVER derives a "cleared/green" status from the presence of an env
 *     var, secret name, or doc. A hold is only ever cleared by a human
 *     recording an explicit verdict in the linked Linear issue — and this code
 *     deliberately provides no path to flip a blocker to cleared.
 *   - `clearedForPublicTraffic` is the literal type `false`. There is no code
 *     path that can make it `true`. Public/creator/gifting traffic stays HOLD.
 *
 * The dashboard built on top of this is read-only display + admin-auth only.
 */

export const PUBLIC_LAUNCH_POSTURE = 'PUBLIC_LAUNCH_HOLD' as const;

/**
 * Status of a single launch blocker. Note the absence of any "cleared" /
 * "green" / "pass" value: by design this model cannot represent an
 * auto-cleared blocker. Clearing a hold is a human decision recorded in
 * Linear, not a state this code computes.
 */
export type LaunchHoldStatus = 'blocked' | 'in_progress' | 'hold';

export interface LaunchBlocker {
  /** Linear identifier, e.g. "HER-5". */
  id: string;
  title: string;
  /** Why this blocks public/creator/gifting launch. */
  why: string;
  status: LaunchHoldStatus;
  /**
   * Named ops owner. Owners are not yet assigned (that is itself a blocker —
   * see HER-9 "Named ops owners documented"), so this is honestly
   * "Unassigned" rather than a fabricated name.
   */
  owner: string;
  /**
   * The real-world evidence a human must capture/verify before this hold can
   * be cleared. Presence of a secret/doc is explicitly NOT sufficient.
   */
  evidenceRequired: string;
  linearUrl: string;
}

const LINEAR_BASE = 'https://linear.app/herostorybooks/issue';

/**
 * The hard public-launch blockers. Every entry is in a not-cleared state.
 * Statuses are fixed editorial facts about where each gate stands; they are
 * NOT computed from environment/secret/doc presence.
 */
export const LAUNCH_BLOCKERS: readonly LaunchBlocker[] = [
  {
    id: 'HER-5',
    title: 'G5 paid owner-test artifact packet',
    why: 'No real paid G5 owner-test evidence packet has been captured yet. Without it there is no proof the live paid path produces an acceptable book.',
    status: 'blocked',
    owner: 'Unassigned',
    evidenceRequired:
      'Real paid order id + timestamp, payment proof (no sensitive data), checkout/proof/QA screenshots, owner-go + operator identity, email events/logs — captured and reviewed by a human.',
    linearUrl: `${LINEAR_BASE}/HER-5`,
  },
  {
    id: 'HER-6',
    title: 'Resend production secret + webhook + dashboard health',
    why: 'Production email monitoring is not verified end-to-end. Email event persistence / stale-event warning readiness is unconfirmed.',
    status: 'blocked',
    owner: 'Unassigned',
    evidenceRequired:
      'Human-verified: prod Resend secret in the approved env, webhook endpoint configured AND verified by a live test event landing, durable fail-closed persistence, documented replay/freshness, visible stale-last-event warning. Secret name existing is NOT sufficient.',
    linearUrl: `${LINEAR_BASE}/HER-6`,
  },
  {
    id: 'HER-7',
    title: 'RPI physical softcover QA',
    why: 'The approved RPI softcover production test has not been shipped, delivered, and physically inspected. Physical fulfillment quality is unproven.',
    status: 'in_progress',
    owner: 'Unassigned',
    evidenceRequired:
      'Shipped + delivered status (actual, not estimated), physical inspection (print/color/binding/page-order), photo evidence packet, and a recorded PASS/CONDITIONAL/FAIL human verdict.',
    linearUrl: `${LINEAR_BASE}/HER-7`,
  },
  {
    id: 'HER-9',
    title: 'Final go/no-go for controlled G5 / YELLOW',
    why: 'No explicit final go/no-go has been recorded. Named ops owners and kill-switch posture review are still open. Approval here is not public-launch clearance.',
    status: 'blocked',
    owner: 'Unassigned',
    evidenceRequired:
      'A dated, approver-signed go/no-go referencing G1/G2/G3 gates, deploy-candidate baseline 0379602, the reviewed G5 packet, Resend/webhook readiness, named ops owners, and kill-switch posture.',
    linearUrl: `${LINEAR_BASE}/HER-9`,
  },
  {
    id: 'HER-10',
    title: 'Post-G5 review packet',
    why: 'The controlled G5 run has not happened, so there is no post-run review converting evidence into launch-readiness truth.',
    status: 'blocked',
    owner: 'Unassigned',
    evidenceRequired:
      'Run summary, expected-vs-actual comparison, errors/anomalies, customer-facing risk review, print/email/proof/order path review, and follow-up issues — written after a real G5 run.',
    linearUrl: `${LINEAR_BASE}/HER-10`,
  },
  {
    id: 'HER-11',
    title: 'Public launch HOLD (umbrella)',
    why: 'Public/creator/gifting traffic is on hard HOLD until every blocker above is explicitly cleared by a human. This dashboard does not and cannot clear it.',
    status: 'hold',
    owner: 'Unassigned',
    evidenceRequired:
      'Every blocker above explicitly cleared, plus a fresh final review that states public-launch clearance in words. No single gate passing implies public launch.',
    linearUrl: `${LINEAR_BASE}/HER-11`,
  },
];

export interface LaunchHoldSnapshot {
  posture: typeof PUBLIC_LAUNCH_POSTURE;
  /**
   * Structurally `false`. There is no code path that sets this true — public
   * launch clearance is a human act recorded in Linear, never inferred here.
   */
  clearedForPublicTraffic: false;
  blockers: readonly LaunchBlocker[];
  openCount: number;
  generatedAt: string;
  note: string;
}

/**
 * Build a read-only snapshot of the public-launch HOLD state. Pure: depends
 * only on the static blocker list and the supplied clock. Reads no env, no
 * secrets, no order/provider state.
 */
export function getLaunchHoldSnapshot(now: Date = new Date()): LaunchHoldSnapshot {
  return {
    posture: PUBLIC_LAUNCH_POSTURE,
    clearedForPublicTraffic: false,
    blockers: LAUNCH_BLOCKERS,
    openCount: LAUNCH_BLOCKERS.length,
    generatedAt: now.toISOString(),
    note:
      'Read-only. This view reports HOLD status only — it clears nothing and triggers no action. ' +
      'Public, creator, and gifting traffic remain on HOLD until each blocker is explicitly cleared by a human in Linear.',
  };
}
