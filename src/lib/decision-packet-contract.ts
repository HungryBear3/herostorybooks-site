/**
 * The offline decision packet's `ga4_behavior` v1 input contract, copied from
 * one pinned packet commit and bound to the SHA-256 of the exact source files
 * it was copied from.
 *
 * The packet is a separate, standalone Python tool. HSB never imports or runs
 * it at runtime; this module is the copy that the compatibility export in
 * src/lib/analytics-decision-export.ts is checked against:
 *
 *  - `DECISION_PACKET_PIN` — the packet commit and the SHA-256 of each source
 *    file the copy (and the vendored test validator) come from;
 *  - `DECISION_PACKET_GA4_BEHAVIOR` — its closed keys, vocabularies, naming
 *    grammar and limits, value for value;
 *  - `validateDecisionPacketGa4Behavior` — its acceptance rules for one
 *    document, at least as strict as the packet: whatever this accepts, the
 *    packet accepts.
 *
 * tests/decision-packet-compat.test.ts proves the copy against the pinned
 * files themselves (vendored byte for byte under
 * tests/fixtures/decision-packet-d64d095/): it checks their hashes, reads
 * every value above back out of them, and runs their validator. Re-pinning
 * is a reviewed code change here, there and in the mapping contract.
 */
import {
  IssueCollector,
  checkClosedObject,
  enumValue,
  integerValue,
  isCalendarDate,
  isPlainRecord,
} from './campaign-governance.ts';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DECISION_PACKET_PIN = deepFreeze({
  commit: 'd64d095f361dc10b939289a8787f25dc6d5d925c',
  sources: {
    'decision_packet/__init__.py': 'bcbb5de1e2ef5451ee9ac259de2ccdd6fae08a186304d9ec4e09535396f45e4a',
    'decision_packet/errors.py': '7f3a71ba1b050c5f98ab869bf68b02d88992d44e06f336f9cbc7af674ea0f10b',
    'decision_packet/evidence.py': 'b29f45bba500aa1e0ed6086dd2bb4ef41f93ef11e29a44b5e04e4bc06309a705',
    'decision_packet/identifiers.py': 'aab0dc55ab110b11f97db0a02b033b434bd119639f9333651d7afee5ccff4f58',
    'decision_packet/jsonio.py': '111a5acf0933637f6afe86407a4752ce902cca628ba71131358809bc46a56128',
    'decision_packet/naming.py': 'f0bdaae63568ecf23ad159aed7cf6370b1e70ea8bc6b8655aad409d2cbf5d684',
    'decision_packet/schemas.py': 'f787163c48b13394425511d51ba60d58ce18974cee2f19b44acad2190d58309a',
    'decision_packet/vocab.py': 'fc82cc4405b4aa818e108c5016f52cc57750eb9e43719a198467a382b1ffa05f',
  },
} as const);

/** Copied from decision_packet/{vocab,naming,schemas,evidence,jsonio}.py at the pinned commit. */
export const DECISION_PACKET_GA4_BEHAVIOR = deepFreeze({
  schema: 'decision_packet.ga4_behavior',
  schemaVersion: 1,
  headerKeys: [
    'schema', 'schema_version', 'data_origin', 'business', 'timezone', 'generated_at', 'coverage',
    'attested_complete_ranges', 'quality', 'rows',
  ],
  rowKeys: [
    'date', 'source', 'medium', 'campaign', 'content', 'landing_path', 'sessions', 'checkout_starts', 'purchase_events',
  ],
  qualityKeys: ['sampled', 'thresholded', 'other_row'],
  rangeKeys: ['start', 'end'],
  businesses: ['hsb', 'ot'],
  dataOrigins: ['synthetic_fixture', 'operator_export'],
  timezones: ['UTC', 'America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles'],
  sources: [
    'direct', 'google', 'bing', 'duckduckgo', 'yahoo', 'facebook', 'instagram', 'tiktok', 'pinterest', 'youtube',
    'linkedin', 'reddit', 'x', 'nextdoor', 'newsletter', 'chatgpt', 'perplexity', 'referral_other', 'other', 'not_set',
  ],
  mediums: [
    'none', 'organic', 'cpc', 'paid_social', 'social', 'email', 'referral', 'display', 'affiliate', 'sms', 'qr', 'other',
    'not_set',
  ],
  campaignSentinels: ['none', 'not_set', 'other'],
  contentSentinels: ['none', 'not_set', 'other'],
  landingPathSentinels: ['not_set', 'other'],
  campaignMonthPattern: '20[2-9]\\d(?:0[1-9]|1[0-2])',
  campaignObjectives: ['acq', 'rtg', 'ret', 'brand', 'season'],
  campaignSlugs: ['fallbooks', 'synthalpha', 'synthbeta', 'synthgamma', 'synthappeal', 'synthreminder', 'ab'],
  contentFormats: ['img', 'vid', 'txt', 'car', 'eml', 'srch'],
  contentVariants: ['a', 'b', 'b2', 'v2'],
  landingPaths: [
    '/', '/fall-books', '/books/fall-2026', '/a/b/c/d', '/synthetic-offer-a', '/synthetic-offer-b', '/synthetic-offer-c',
    '/synthetic-appeal-check', '/synthetic-guide', '/synthetic-deadline',
  ],
  maxRows: 250_000,
  maxRanges: 400,
  maxCount: 1_000_000_000,
  maxCoverageDays: 400,
  maxInputBytes: 16 * 1024 * 1024,
});

const P = DECISION_PACKET_GA4_BEHAVIOR;
const DAY_MS = 86_400_000;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MONTH_RE = new RegExp(`^${P.campaignMonthPattern}$`);

export type DecisionPacketDimension = 'source' | 'medium' | 'campaign' | 'content' | 'landing_path';

/** A packet campaign name: `<business>_<yyyymm>_<objective>_<slug>`, each part from the reviewed lists. */
function campaignNameValid(value: string, business: string): boolean {
  const parts = value.split('_');
  return parts.length === 4 && parts[0] === business && MONTH_RE.test(parts[1])
    && P.campaignObjectives.includes(parts[2]) && P.campaignSlugs.includes(parts[3]);
}

/** Whether `value` is a value the pinned packet accepts for one row dimension of `business`. */
export function decisionPacketValueValid(field: DecisionPacketDimension, value: unknown, business: string): boolean {
  if (typeof value !== 'string') return false;
  const one = (list: readonly string[]) => list.includes(value);
  switch (field) {
    case 'source': return one(P.sources);
    case 'medium': return one(P.mediums);
    case 'campaign': return one(P.campaignSentinels) || campaignNameValid(value, business);
    case 'content': {
      // `<format>_<variant>`, each part from the reviewed lists.
      const parts = value.split('_');
      return one(P.contentSentinels)
        || (parts.length === 2 && P.contentFormats.includes(parts[0]) && P.contentVariants.includes(parts[1]));
    }
    case 'landing_path': return one(P.landingPathSentinels) || one(P.landingPaths);
  }
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace('Z', '.000Z');
}

function rangeOf(value: unknown, path: string, out: IssueCollector): { start: string; end: string } | null {
  if (!checkClosedObject(value, P.rangeKeys, path, out)) return null;
  if (!isCalendarDate(value.start) || !isCalendarDate(value.end)) {
    out.add('INVALID_DATE', path);
    return null;
  }
  return { start: value.start, end: value.end };
}

/**
 * Value-free `CODE@$.path` issues for one `decision_packet.ga4_behavior` v1
 * document under the pinned packet's closed schema and evidence rules; empty
 * means the packet accepts it. Where exactness would need the packet's
 * time-zone arithmetic it is stricter: the document must be generated after
 * the last covered day ended in UTC, which for every allowed zone is after
 * that day began locally.
 */
export function validateDecisionPacketGa4Behavior(doc: unknown): string[] {
  const out = new IssueCollector();
  if (!isPlainRecord(doc)) {
    out.add('TYPE_OBJECT', '$');
    return out.issues;
  }
  if (doc.schema !== P.schema) {
    out.add('UNKNOWN_SCHEMA', '$.schema');
    return out.issues;
  }
  if (doc.schema_version !== P.schemaVersion) {
    out.add('UNSUPPORTED_SCHEMA_VERSION', '$.schema_version');
    return out.issues;
  }
  checkClosedObject(doc, P.headerKeys, '$', out);
  enumValue(P.dataOrigins, doc.data_origin, '$.data_origin', out);
  const business = enumValue(P.businesses, doc.business, '$.business', out);
  enumValue(P.timezones, doc.timezone, '$.timezone', out);
  const generatedAt = isTimestamp(doc.generated_at) ? Date.parse(doc.generated_at) : null;
  if (generatedAt === null) out.add('INVALID_TIMESTAMP', '$.generated_at');

  const coverage = rangeOf(doc.coverage, '$.coverage', out);
  if (coverage) {
    const days = (Date.parse(coverage.end) - Date.parse(coverage.start)) / DAY_MS + 1;
    if (days < 1) out.add('COVERAGE_RANGE_INVALID', '$.coverage');
    else if (days > P.maxCoverageDays) out.add('COVERAGE_TOO_LONG', '$.coverage');
    if (generatedAt !== null && Date.parse(coverage.end) + DAY_MS > generatedAt) out.add('COVERAGE_AFTER_GENERATED_AT', '$.coverage.end');
  }

  if (!Array.isArray(doc.attested_complete_ranges) || doc.attested_complete_ranges.length > P.maxRanges) {
    out.add('TYPE_ARRAY', '$.attested_complete_ranges');
  } else {
    let previousEnd: string | null = null;
    doc.attested_complete_ranges.forEach((item, index) => {
      const path = `$.attested_complete_ranges[${index}]`;
      const range = rangeOf(item, path, out);
      if (!range) return;
      const ordered = previousEnd === null || range.start > previousEnd;
      if (range.start > range.end || !ordered || (coverage && (range.start < coverage.start || range.end > coverage.end))) {
        out.add('ATTESTED_RANGE_INVALID', path);
        return;
      }
      previousEnd = range.end;
    });
  }

  if (checkClosedObject(doc.quality, P.qualityKeys, '$.quality', out)) {
    for (const key of P.qualityKeys) if (typeof doc.quality[key] !== 'boolean') out.add('TYPE_BOOLEAN', `$.quality.${key}`);
  }

  if (!Array.isArray(doc.rows) || doc.rows.length > P.maxRows) {
    out.add('TYPE_ARRAY', '$.rows');
    return out.issues;
  }
  const seen = new Set<string>();
  doc.rows.forEach((row, index) => {
    const path = `$.rows[${index}]`;
    const before = out.count;
    if (!checkClosedObject(row, P.rowKeys, path, out)) return;
    if (!isCalendarDate(row.date)) out.add('INVALID_DATE', `${path}.date`);
    else if (coverage && (row.date < coverage.start || row.date > coverage.end)) out.add('ROW_OUTSIDE_COVERAGE', `${path}.date`);
    for (const field of ['source', 'medium', 'campaign', 'content', 'landing_path'] as const) {
      if (!decisionPacketValueValid(field, row[field], business ?? '')) out.add('VALUE_NOT_IN_PACKET_VOCABULARY', `${path}.${field}`);
    }
    const sessions = integerValue(row.sessions, 0, P.maxCount, `${path}.sessions`, out);
    const checkoutStarts = integerValue(row.checkout_starts, 0, P.maxCount, `${path}.checkout_starts`, out);
    const purchaseEvents = integerValue(row.purchase_events, 0, P.maxCount, `${path}.purchase_events`, out);
    if (out.count !== before) return;
    if (checkoutStarts! > sessions! || purchaseEvents! > sessions!) out.add('METRIC_INVARIANT', path);
    // The packet drops an exact duplicate and rejects a conflicting one; this rejects both.
    const key = JSON.stringify([row.date, row.source, row.medium, row.campaign, row.content, row.landing_path]);
    if (seen.has(key)) out.add('DUPLICATE_ROW', path);
    seen.add(key);
  });
  return out.issues;
}
