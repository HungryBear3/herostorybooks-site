/**
 * Father's Day deadline helper.
 *
 * Used by the homepage hero + the SeasonalCallout block to surface an
 * honest "best chance to arrive in time" badge. Copy must stay
 * non-promising — carriers vary, so we say "order by" / "best chance",
 * never "guaranteed delivery".
 *
 * Constants:
 *   - Father's Day 2026: Sunday, June 21, 2026 (third Sunday of June).
 *   - Last-safe print order date: Friday, June 5, 2026. This leaves a
 *     conservative 5–7 business days for print fulfillment plus 3–5
 *     days of US shipping after proof approval.
 *
 * If the launch business rule for the last-safe date changes (e.g.
 * shorter print SLA), only `LAST_SAFE_ORDER_DATE` needs updating.
 *
 * Pure module: no DOM, no fetch. Pass `now` for deterministic tests.
 */

export const FATHERS_DAY_2026 = '2026-06-21';
export const LAST_SAFE_ORDER_DATE_2026 = '2026-06-05';

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
  /** Human label, e.g. "Thu, Jun 5". */
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
  const dayWord = (n: number) => (Math.abs(n) === 1 ? 'day' : 'days');

  let badgeCopy: string;
  switch (tier) {
    case 'comfortable':
    case 'tightening':
      badgeCopy =
        `Order by ${safeOrderDateLabel} for the best chance at Father's Day — ` +
        `${daysUntilSafeOrderDate} ${dayWord(daysUntilSafeOrderDate)} left`;
      break;
    case 'last-call':
    case 'final-hours':
      badgeCopy =
        `Last ${daysUntilSafeOrderDate} ${dayWord(daysUntilSafeOrderDate)} to order ` +
        `for the best chance at Father's Day (by ${safeOrderDateLabel})`;
      break;
    case 'digital-only':
      // Past print-safe window but Father's Day not yet — pivot to digital.
      badgeCopy =
        `Print window for Father's Day has tightened — the Digital PDF ` +
        `(${fathersDayLabel}) is still a safe gift you can share instantly`;
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
 * Digital-first Father's Day offer copy.
 *
 * The Digital PDF is the lead Father's Day gift: it is delivered the same
 * day a proof is approved, with no print or shipping step, so there is no
 * carrier timing risk. Printed books stay available as an OPTIONAL upgrade,
 * but their arrival depends on the order-by date and the carrier, so we
 * never claim a printed book will arrive by Father's Day.
 *
 * Centralized here (rather than inline JSX) so the positioning is pure,
 * importable, and pinned by tests. Copy rules — mirrored in
 * tests/fathers-day.test.ts:
 *   - Lead with digital / instant / no shipping risk.
 *   - Frame print as optional and timing-dependent.
 *   - Never guarantee delivery; never promise a printed book by Father's Day.
 *   - No likeness guarantees.
 */
export const FATHERS_DAY_OFFER = {
  eyebrow: "Father's Day gift",
  headline: "A Father's Day gift with no shipping risk.",
  digitalLead:
    "The Digital PDF is the safest Father's Day pick. We email your proof first (usually within 2 business days); once you approve, the high-resolution book is delivered the same day — no printing or shipping, so no carrier timing risk. Print it at home, read it on any screen, or share it instantly.",
  printOptional:
    "Want a printed keepsake too? Add a softcover or hardcover as an optional upgrade. Printed books ship after proof approval, and arrival depends on the order-by date and your carrier, so we don't promise a printed book will arrive by Father's Day.",
  proofNote:
    'Every order includes a full digital proof before anything prints, human story and art review, and no blind hardcover order.',
  ctaLabel: 'Start the digital book',
  ctaHref: '/checkout?format=digital',
} as const;
