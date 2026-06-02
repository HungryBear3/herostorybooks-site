/**
 * Father's Day deadline helper.
 *
 * Used by the homepage hero + the SeasonalCallout block to surface honest
 * Father's Day timing. Copy must stay non-promising: carriers and print
 * partners vary, so we say "best chance" and "digital is safest", never
 * "guaranteed delivery" or a public cutoff date without written SLA.
 *
 * Constants:
 *   - Father's Day 2026: Sunday, June 21, 2026 (third Sunday of June).
 *   - Conservative softcover print cutoff: Monday, June 1, 2026. This is
 *     kept for tiering only; public copy must not present it as a promise.
 *
 * If written partner SLA arrives, update this helper and tests together.
 *
 * Pure module: no DOM, no fetch. Pass `now` for deterministic tests.
 */

export const FATHERS_DAY_2026 = '2026-06-21';
/**
 * Internal conservative print-tiering date. NOT a public promise.
 * Used by the urgency-badge tier logic only; do not surface to
 * customers as an "order by" deadline.
 */
export const LAST_SAFE_ORDER_DATE_2026 = '2026-06-01';
/**
 * Public softcover best-chance window. Surfaced in the per-format
 * timing block as "Jun 5 best chance" — never as a deadline or
 * guarantee. Operators approved this date on 2026-06-01 as the
 * latest softcover order date with a non-trivial chance of arriving
 * by Father's Day. The print-path SLA decision still requires that
 * any public copy frame this as best-chance only.
 */
export const SOFTCOVER_BEST_CHANCE_DATE_2026 = '2026-06-05';
/**
 * Public digital safe-delivery cutoff. Digital orders have no
 * shipping step, so "by Jun 18" is a defensible statement: the
 * digital proof-then-delivery loop fits inside the remaining window.
 * Still framed as a cutoff, not a guarantee, because proof revisions
 * extend the loop.
 */
export const DIGITAL_SAFE_CUTOFF_DATE_2026 = '2026-06-18';

export type FathersDayTier =
  | 'comfortable'      // ≥ 10 days until last-safe order date
  | 'tightening'       // 4–9 days
  | 'last-call'        // 1–3 days
  | 'final-hours'      // safe date is today
  | 'digital-only'     // past safe print date, but Father's Day not yet
  | 'past-event';      // Father's Day already happened — hide the badge

export interface FathersDayCountdown {
  /** Days from `now` to the last-safe order date. Negative if past. */
  daysUntilSafeOrderDate: number;
  /** Days from `now` to Father's Day itself. Negative if past. */
  daysUntilFathersDay: number;
  /** Internal conservative cutoff label. Do not display as a public promise. */
  safeOrderDateLabel: string;
  /** Human label, e.g. "Sun, Jun 21". */
  fathersDayLabel: string;
  /** Urgency tier — drives the badge styling + copy choice. */
  tier: FathersDayTier;
  /**
   * Suggested badge copy. The component is free to override, but this
   * gives a sensible default that stays honest about delivery risk.
   */
  badgeCopy: string;
}

function startOfDayUtc(input: Date | string): Date {
  if (typeof input === 'string') {
    return new Date(input + 'T00:00:00Z');
  }
  return new Date(
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()),
  );
}

function daysBetween(from: Date, to: Date): number {
  const fromUtc = startOfDayUtc(from);
  const toUtc = startOfDayUtc(to);
  return Math.round((toUtc.getTime() - fromUtc.getTime()) / 86400000);
}

function formatLabel(iso: string): string {
  // Render in en-US, abbreviated weekday + month. UTC so the rendered
  // string is stable across server / client locales.
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function getFathersDayCountdown(
  now: Date = new Date(),
): FathersDayCountdown {
  const daysUntilSafeOrderDate = daysBetween(now, new Date(LAST_SAFE_ORDER_DATE_2026 + 'T00:00:00Z'));
  const daysUntilFathersDay = daysBetween(now, new Date(FATHERS_DAY_2026 + 'T00:00:00Z'));

  let tier: FathersDayTier;
  if (daysUntilFathersDay < 0) tier = 'past-event';
  else if (daysUntilSafeOrderDate < 0) tier = 'digital-only';
  else if (daysUntilSafeOrderDate === 0) tier = 'final-hours';
  else if (daysUntilSafeOrderDate <= 3) tier = 'last-call';
  else if (daysUntilSafeOrderDate <= 9) tier = 'tightening';
  else tier = 'comfortable';

  const safeOrderDateLabel = formatLabel(LAST_SAFE_ORDER_DATE_2026);
  const fathersDayLabel = formatLabel(FATHERS_DAY_2026);
  let badgeCopy: string;
  switch (tier) {
    case 'comfortable':
    case 'tightening':
      badgeCopy =
        `Printed books are best chance only for Father's Day; Digital PDF ` +
        `is the safest way to have something ready to open`;
      break;
    case 'last-call':
    case 'final-hours':
      badgeCopy =
        `Print timing is tight for Father's Day; choose Digital PDF for the ` +
        `safest on-day gift, with print as a follow-up keepsake`;
      break;
    case 'digital-only':
      // Past conservative print window but Father's Day not yet — pivot to digital.
      badgeCopy =
        `For Father's Day timing, Digital PDF is the safest on-day gift; ` +
        `printed books can follow after proof approval`;
      break;
    case 'past-event':
    default:
      // Caller should hide the badge entirely when past-event.
      badgeCopy = '';
      break;
  }

  return {
    daysUntilSafeOrderDate,
    daysUntilFathersDay,
    safeOrderDateLabel,
    fathersDayLabel,
    tier,
    badgeCopy,
  };
}

/**
 * Father's Day offer copy.
 *
 * Printed books remain available, but without partner-confirmed SLA they are
 * framed as best-chance/follow-up keepsakes. The Digital PDF is the on-day
 * safety valve, not a lower-quality consolation prize.
 *
 * Centralized here (rather than inline JSX) so the positioning is pure,
 * importable, and pinned by tests. Copy rules — mirrored in
 * tests/fathers-day.test.ts:
 *   - Lead with proof-before-print trust.
 *   - Frame digital as the safest on-day gift.
 *   - Frame print as best-chance/follow-up unless SLA is written.
 *   - Never guarantee delivery; never promise a printed book by Father's Day.
 *   - No likeness guarantees.
 */
export const FATHERS_DAY_OFFER = {
  eyebrow: "Father's Day gift",
  headline: "Give Dad a story only your family could tell.",
  digitalLead:
    "Start with a personalized proof book starring your child and the dad or grandpa they love. You review the full proof first, ask for changes if needed, and we only print once you approve.",
  printOptional:
    "Digital is the safest Father's Day option. Printed books are best-chance keepsakes after proof approval; hardcover should be treated as a follow-up keepsake, not an on-day promise.",
  proofNote:
    'Proofs are usually ready within 2 business days. No printed book is sent to production until you approve the proof.',
  ctaLabel: "Create Dad's book",
  ctaHref: '/checkout',
  // ── Per-format timing block ────────────────────────────────────────────────
  //
  // Required everywhere we render Father's Day timing copy (/, /checkout,
  // /pricing, /fathers-day). Each format gets its own row so we never
  // bundle hardcover into a softcover-shaped "order by Jun 5" line.
  //
  // Ops rules (binding):
  //   - No guaranteed Father's Day delivery.
  //   - Digital safe cutoff Jun 18 — defensible because there is no
  //     shipping step after approval.
  //   - Softcover Jun 5 = best-chance only, never a deadline.
  //   - Hardcover = post-holiday keepsake.
  //   - Always pair with the shipping-estimates disclaimer and the
  //     proof-before-print line.
  //
  // Source-of-truth dates live in SOFTCOVER_BEST_CHANCE_DATE_2026 /
  // DIGITAL_SAFE_CUTOFF_DATE_2026 above.
  digitalTiming:
    "Digital PDF: order by Jun 18 for safe digital delivery on Father's Day. No shipping step — the only loop is your proof review.",
  softcoverTiming:
    "Classic softcover: Jun 5 is the best-chance window for on-day arrival. Not a deadline or guarantee — print and carrier timing can shift after proof approval.",
  hardcoverTiming:
    "Premium hardcover: treat as a post-holiday keepsake. Hardcover production runs longer; it will almost always arrive after Father's Day and is best given as a follow-up keepsake.",
  shippingDisclaimer:
    "Shipping dates are estimates, not guarantees. Print and carrier windows vary; only the proof-before-print review is in our control.",
  proofBeforePrint:
    "Every printed book is proof-approved before print — no book is sent to production until you approve the digital proof.",
} as const;
