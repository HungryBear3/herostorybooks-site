import type { OrderRecord, PageArtifact, ReviewAuditEvent } from './orders.ts';

export const DAILY_PAID_TARGET = 8;
export const DAILY_PAID_CEILING = 10;
export const QA_IN_FLIGHT_SLOWDOWN_THRESHOLD = 6;
export const MEDIAN_PROOF_HOURS_SLOWDOWN_THRESHOLD = 36;
export const MAX_REVISION_ROUND_TRIPS = 2;
export const QA_DEFECT_RATE_PAUSE_THRESHOLD = 20;
export const PRINT_ACK_DELAY_HOURS_PAUSE_THRESHOLD = 24;

export type CapacityRecommendationLevel = 'open' | 'slowdown' | 'pause';

export interface CapacityDashboardSummary {
  generatedAtIso: string;
  localDay: string;
  timezone: string;
  dailyPaidTarget: number;
  dailyPaidCeiling: number;
  paidOrdersToday: number;
  paidOrdersTodayOrderIds: string[];
  qaInFlight: number;
  qaInFlightOrderIds: string[];
  oldestProofAgeHours: number | null;
  oldestProofOrderId: string | null;
  medianProofTimeHours: number | null;
  proofTimeSampleSize: number;
  maxRevisionRoundTrips: number;
  maxRevisionOrderId: string | null;
  rollingFiveQaDefectRatePercent: number | null;
  rollingFiveDefectOrderCount: number;
  rollingFivePaidOrderCount: number;
  printAckDelayedCount: number;
  printAckDelayedOrderIds: string[];
  stripeDisputeSignalAvailable: boolean;
  stripeDisputeOpen: boolean | null;
  recommendation: {
    level: CapacityRecommendationLevel;
    label: string;
    reasons: string[];
    unavailableSignals: string[];
  };
}

interface CapacityOptions {
  now?: Date;
  timezone?: string;
}

const DEFAULT_TIMEZONE = 'America/Chicago';
const HOUR_MS = 60 * 60 * 1000;

export function buildCapacityDashboardSummary(
  orders: OrderRecord[],
  options: CapacityOptions = {},
): CapacityDashboardSummary {
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const localDay = formatLocalDay(now, timezone);

  const paidOrders = orders.filter((order) => order.paymentStatus === 'paid');
  const paidOrdersToday = paidOrders.filter((order) => formatLocalDay(getPaidReferenceDate(order), timezone) === localDay);
  const qaInFlight = orders.filter((order) => order.fulfillmentStatus === 'awaiting_qa');
  const oldestProof = oldestAwaitingQaProof(qaInFlight, now);
  const proofTimes = paidOrders
    .map((order) => proofTimeHours(order))
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  const medianProofTimeHours = median(proofTimes);
  const maxRevision = maxRevisionRoundTrips(orders);
  const rollingDefects = rollingFiveDefectRate(paidOrders);
  const printAckDelayed = findPrintAckDelayedOrders(orders, now);

  const reasons: string[] = [];
  const slowdownReasons: string[] = [];
  const unavailableSignals: string[] = [];

  if (paidOrdersToday.length >= DAILY_PAID_CEILING) {
    reasons.push(`${paidOrdersToday.length}/${DAILY_PAID_CEILING} paid-order ceiling reached today`);
  }
  if (
    rollingDefects.ratePercent !== null &&
    rollingDefects.count >= 5 &&
    rollingDefects.ratePercent > QA_DEFECT_RATE_PAUSE_THRESHOLD
  ) {
    reasons.push(`QA defect rate ${rollingDefects.ratePercent}% over latest 5 paid orders`);
  }
  if (printAckDelayed.length > 0) {
    reasons.push(`${printAckDelayed.length} print acknowledgment delay over ${PRINT_ACK_DELAY_HOURS_PAUSE_THRESHOLD}h`);
  }

  unavailableSignals.push('Stripe dispute status is not represented in OrderRecord; verify Stripe dashboard/webhooks before traffic push');

  if (qaInFlight.length > QA_IN_FLIGHT_SLOWDOWN_THRESHOLD) {
    slowdownReasons.push(`${qaInFlight.length} orders in QA, above slowdown trigger ${QA_IN_FLIGHT_SLOWDOWN_THRESHOLD}`);
  }
  if (
    medianProofTimeHours !== null &&
    medianProofTimeHours > MEDIAN_PROOF_HOURS_SLOWDOWN_THRESHOLD
  ) {
    slowdownReasons.push(`median time-to-proof ${medianProofTimeHours}h exceeds ${MEDIAN_PROOF_HOURS_SLOWDOWN_THRESHOLD}h`);
  }
  if (maxRevision.roundTrips > MAX_REVISION_ROUND_TRIPS) {
    slowdownReasons.push(
      `order ${maxRevision.orderId} has ${maxRevision.roundTrips} revision round-trips, above ${MAX_REVISION_ROUND_TRIPS}`,
    );
  }

  const level: CapacityRecommendationLevel =
    reasons.length > 0 ? 'pause' : slowdownReasons.length > 0 ? 'slowdown' : 'open';
  const label =
    level === 'pause'
      ? 'Pause checkout'
      : level === 'slowdown'
        ? 'Slow down intake'
        : paidOrdersToday.length >= DAILY_PAID_TARGET
          ? 'At daily target; monitor closely'
          : 'Open for controlled intake';

  return {
    generatedAtIso: now.toISOString(),
    localDay,
    timezone,
    dailyPaidTarget: DAILY_PAID_TARGET,
    dailyPaidCeiling: DAILY_PAID_CEILING,
    paidOrdersToday: paidOrdersToday.length,
    paidOrdersTodayOrderIds: paidOrdersToday.map((order) => order.id),
    qaInFlight: qaInFlight.length,
    qaInFlightOrderIds: qaInFlight.map((order) => order.id),
    oldestProofAgeHours: oldestProof.ageHours,
    oldestProofOrderId: oldestProof.orderId,
    medianProofTimeHours,
    proofTimeSampleSize: proofTimes.length,
    maxRevisionRoundTrips: maxRevision.roundTrips,
    maxRevisionOrderId: maxRevision.orderId,
    rollingFiveQaDefectRatePercent: rollingDefects.ratePercent,
    rollingFiveDefectOrderCount: rollingDefects.defectCount,
    rollingFivePaidOrderCount: rollingDefects.count,
    printAckDelayedCount: printAckDelayed.length,
    printAckDelayedOrderIds: printAckDelayed.map((order) => order.id),
    stripeDisputeSignalAvailable: false,
    stripeDisputeOpen: null,
    recommendation: {
      level,
      label,
      reasons: [...reasons, ...(level === 'slowdown' ? slowdownReasons : [])],
      unavailableSignals,
    },
  };
}

function formatLocalDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getPaidReferenceDate(order: OrderRecord): Date {
  return new Date(firstAuditAt(order, 'payment_confirmed') ?? order.createdAt ?? order.updatedAt);
}

function firstAuditAt(order: OrderRecord, type: string): string | null {
  const event = (order.auditEvents ?? []).find((candidate) => candidate.type === type);
  return event?.at ?? null;
}

function awaitingQaStartedAt(order: OrderRecord): string | null {
  const event = [...(order.auditEvents ?? [])]
    .reverse()
    .find((candidate) => candidate.type === 'proof_generated' || candidate.type === 'proof_rebuilt');
  return event?.at ?? order.updatedAt ?? order.createdAt ?? null;
}

function oldestAwaitingQaProof(
  orders: OrderRecord[],
  now: Date,
): { ageHours: number | null; orderId: string | null } {
  let oldest: { ageMs: number; orderId: string } | null = null;
  for (const order of orders) {
    const startedAt = awaitingQaStartedAt(order);
    if (!startedAt) continue;
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) continue;
    const ageMs = Math.max(0, now.getTime() - startedMs);
    if (!oldest || ageMs > oldest.ageMs) {
      oldest = { ageMs, orderId: order.id };
    }
  }
  return {
    ageHours: oldest ? roundHours(oldest.ageMs / HOUR_MS) : null,
    orderId: oldest?.orderId ?? null,
  };
}

function proofTimeHours(order: OrderRecord): number | null {
  const proofAt = order.qaPassAt ?? firstAuditAt(order, 'qa_pass_recorded');
  if (!proofAt) return null;
  const startMs = getPaidReferenceDate(order).getTime();
  const proofMs = Date.parse(proofAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(proofMs) || proofMs < startMs) return null;
  return roundHours((proofMs - startMs) / HOUR_MS);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid];
  return roundHours((values[mid - 1] + values[mid]) / 2);
}

function maxRevisionRoundTrips(orders: OrderRecord[]): { roundTrips: number; orderId: string | null } {
  let max = 0;
  let orderId: string | null = null;
  for (const order of orders) {
    const roundTrips = revisionRoundTripsForOrder(order);
    if (roundTrips > max) {
      max = roundTrips;
      orderId = order.id;
    }
  }
  return { roundTrips: max, orderId };
}

function revisionRoundTripsForOrder(order: OrderRecord): number {
  const pageMax = Math.max(0, ...(order.pageArtifacts ?? []).map((page) => safeRegenerateCount(page)));
  const auditRequests = (order.auditEvents ?? []).filter(isRevisionRequestEvent).length;
  return Math.max(pageMax, auditRequests);
}

function safeRegenerateCount(page: PageArtifact): number {
  return Number.isFinite(page.regenerateCount) ? Math.max(0, page.regenerateCount) : 0;
}

function isRevisionRequestEvent(event: ReviewAuditEvent): boolean {
  return event.type === 'page_changes_requested' || event.type === 'page_regenerated';
}

function rollingFiveDefectRate(paidOrders: OrderRecord[]): {
  count: number;
  defectCount: number;
  ratePercent: number | null;
} {
  const latestFive = [...paidOrders]
    .sort((a, b) => getPaidReferenceDate(b).getTime() - getPaidReferenceDate(a).getTime())
    .slice(0, 5);
  if (latestFive.length === 0) {
    return { count: 0, defectCount: 0, ratePercent: null };
  }
  const defectCount = latestFive.filter(hasQaDefectSignal).length;
  return {
    count: latestFive.length,
    defectCount,
    ratePercent: Math.round((defectCount / latestFive.length) * 100),
  };
}

function hasQaDefectSignal(order: OrderRecord): boolean {
  const pageDefect = (order.pageArtifacts ?? []).some(
    (page) =>
      page.targetedRegenNeeded ||
      page.customerReviewStatus === 'changes_requested' ||
      page.customerRequestedChange?.lifecycleStatus === 'qa',
  );
  const auditDefect = (order.auditEvents ?? []).some(
    (event) => event.type === 'page_changes_requested' || event.type === 'whole_book_approval_rejected',
  );
  return pageDefect || auditDefect;
}

function findPrintAckDelayedOrders(orders: OrderRecord[], now: Date): OrderRecord[] {
  return orders.filter((order) => {
    if (order.fulfillmentStatus !== 'submitting_to_print') return false;
    if (order.printJobStatus) return false;
    const updatedMs = Date.parse(order.updatedAt ?? order.createdAt ?? '');
    if (!Number.isFinite(updatedMs)) return false;
    return now.getTime() - updatedMs > PRINT_ACK_DELAY_HOURS_PAUSE_THRESHOLD * HOUR_MS;
  });
}

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}
