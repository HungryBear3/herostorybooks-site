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

/**
 * Owner-test posture — EDITORIAL and deliberately separate from public launch.
 * The actual gate is enforced elsewhere (the owner-test checkout gate + order
 * route). This block exists so an operator can never read "owner-test allowed"
 * as "public launch ready". It is NOT computed from env — it only states the
 * posture and names the controlling flags so the distinction is unmissable.
 */
export const OWNER_TEST_POSTURE = 'OWNER_TEST_ONLY_BEHIND_GATE' as const;

export interface OwnerTestGateInfo {
  posture: typeof OWNER_TEST_POSTURE;
  allowed: string;
  control: string;
  notPublic: string;
}

export const OWNER_TEST_GATE: OwnerTestGateInfo = {
  posture: OWNER_TEST_POSTURE,
  allowed:
    'Controlled owner-test checkout only — an internal/owner email on the allowlist may complete a paid test order.',
  control:
    'Default-CLOSED gate: requires both HSB_OWNER_TEST_CHECKOUT_ENABLED=true AND the buyer email present on HSB_OWNER_TEST_EMAILS. With neither set, checkout is closed.',
  notPublic:
    'Owner-test access is NOT public traffic and is NOT public-launch clearance. Passing the owner-test gate clears nothing on this board.',
};

/**
 * The required public-launch gates, in the operator's own checklist language.
 * Each cross-references the Linear blocker(s) and/or evidence doc that proves
 * it. Editorial status only — never auto-green.
 */
export type LaunchGateStatus = LaunchHoldStatus;
export interface PublicLaunchGate {
  key: string;
  label: string;
  requirement: string;
  status: LaunchGateStatus;
  references: readonly string[];
}

export const PUBLIC_LAUNCH_GATES: readonly PublicLaunchGate[] = [
  {
    key: 'owner-test-packet',
    label: 'Controlled paid owner-test artifact packet',
    requirement: 'A real paid owner-test run captured + human-reviewed (the G5 packet).',
    status: 'blocked',
    references: ['HER-5', 'docs/reviews/hsb-g5-owner-test-artifact-packet-skeleton-2026-06-02.md'],
  },
  {
    key: 'proof-hardcover',
    label: 'Proof quality / current hardcover readiness',
    requirement: 'Current generated proofs meet quality bar; hardcover format readiness confirmed by a human.',
    status: 'in_progress',
    references: ['HER-7'],
  },
  {
    key: 'print-sla',
    label: 'Public print / fulfillment SLA readiness',
    requirement: 'Print + shipping turnaround proven against a public-facing SLA (not just one test order).',
    status: 'blocked',
    references: ['HER-7'],
  },
  {
    key: 'email-health',
    label: 'Bounce / email-health monitoring (or recorded manual-risk acceptance)',
    requirement: 'Live email-health monitoring verified end-to-end, OR a human-recorded acceptance of manual monitoring risk.',
    status: 'blocked',
    references: ['HER-6', '/admin/email-health'],
  },
  {
    key: 'public-traffic-approval',
    label: 'Social / creator / public traffic approval',
    requirement: 'Explicit Alexy approval to open public/creator/gifting traffic. Absent by default.',
    status: 'hold',
    references: ['HER-9', 'HER-11'],
  },
  {
    key: 'alias-cutover',
    label: 'Explicit production cutover / apex-www alias approval',
    requirement: 'Separate explicit approval to move the apex/www alias to a public-launch deployment.',
    status: 'hold',
    references: ['LIVE_HSB.md', 'HER-9'],
  },
];

/**
 * Hard do-not-do list for the HOLD window. Phrased as plain operator rules.
 * (Intentionally avoids naming specific provider SDK/call tokens so the
 * source stays free of mutating-call identifiers — these are rules, not code.)
 */
export const DO_NOT_DO: readonly string[] = [
  'No public traffic — do not open the site or share public links with general visitors.',
  'No creator or gifting outreach.',
  'No posting, scheduling, or boosting on any channel.',
  'No payment, print/fulfillment, or customer-message/provider actions without explicit Alexy approval.',
  'No production deploy, env change, or apex/www alias move without separate explicit approval.',
];

export interface EvidenceRef {
  label: string;
  path: string;
  note?: string;
}

/**
 * Pointers to where launch evidence lives (or will be captured). Static paths
 * only — this module reads no files and fetches nothing.
 */
export const EVIDENCE_DOCS: readonly EvidenceRef[] = [
  { label: 'Release hygiene + anti-drift runbook', path: 'docs/runbooks/release-hygiene.md' },
  { label: 'Canonical live deployment / alias rules', path: 'LIVE_HSB.md' },
  {
    label: 'G5 owner-test artifact packet',
    path: 'docs/reviews/hsb-g5-owner-test-artifact-packet-skeleton-2026-06-02.md',
    note: 'Captured during the controlled paid owner-test run.',
  },
];

export interface LaunchHoldSnapshot {
  posture: typeof PUBLIC_LAUNCH_POSTURE;
  /**
   * Structurally `false`. There is no code path that sets this true — public
   * launch clearance is a human act recorded in Linear, never inferred here.
   */
  clearedForPublicTraffic: false;
  ownerTest: OwnerTestGateInfo;
  gates: readonly PublicLaunchGate[];
  blockers: readonly LaunchBlocker[];
  doNotDo: readonly string[];
  evidence: readonly EvidenceRef[];
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
    ownerTest: OWNER_TEST_GATE,
    gates: PUBLIC_LAUNCH_GATES,
    blockers: LAUNCH_BLOCKERS,
    doNotDo: DO_NOT_DO,
    evidence: EVIDENCE_DOCS,
    openCount: LAUNCH_BLOCKERS.length,
    generatedAt: now.toISOString(),
    note:
      'Read-only. This view reports HOLD status only — it clears nothing and triggers no action. ' +
      'Public, creator, and gifting traffic remain on HOLD until each blocker is explicitly cleared by a human in Linear.',
  };
}
