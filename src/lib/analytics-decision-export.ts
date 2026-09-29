/**
 * Source-side export for the offline analytics decision packet.
 *
 * The packet is a separate, standalone tool with its own closed schemas and
 * vocabulary, which lacks most of HSB's governed labels. HSB keeps its own
 * versioned, closed export and converts it for the packet only through a
 * checked, one-to-one mapping:
 *
 *  - `hsb.decision_export.ga4_behavior` v1 — daily sessions, checkout starts
 *    (`begin_checkout`) and GA4 purchase events per governed segment. The
 *    purchase count is behavioral evidence only, never payment authority.
 *    Field-for-field it matches the packet's `ga4_behavior` v1; only the
 *    schema id and value vocabulary differ.
 *  - a read-only GA4 Data API request for that report, and an adapter that
 *    reduces the operator-supplied response to the export: every raw GA4
 *    value is re-governed through the Phase-A allowlists or collapsed into a
 *    fixed sentinel, so raw URLs, query strings, referrer hosts, identifiers
 *    and free text cannot be represented. A truncated report is refused; a
 *    sampled, thresholded or "(other)"-folded one carries no attestation;
 *  - a JSON Schema generated from the same rules, and deterministic
 *    synthetic fixtures;
 *  - the mapping contract (config/analytics/decision-packet-mapping.v1.json),
 *    validated as the semantic counterpart of every HSB value inside the
 *    pinned packet vocabulary (src/lib/decision-packet-contract.ts), and
 *    `exportDecisionPacketGa4Behavior`, which emits the packet's own
 *    `decision_packet.ga4_behavior` document or refuses when any value has
 *    no counterpart there.
 *
 * Nothing here calls GA4, reads a credential, or touches the network.
 */
import { APPROVED_PUBLIC_ROUTE_TEMPLATES } from './analytics-event-contract.ts';
import { sanitizeAttributionValue, sanitizeLandingPath } from './attribution-contract.ts';
import {
  CAMPAIGN_CONTENT_VALUES,
  CAMPAIGN_MEDIUM_VALUES,
  CAMPAIGN_SOURCE_VALUES,
  DATA_ORIGINS,
  IssueCollector,
  checkClosedObject,
  enumValue,
  forbiddenValueCode,
  hasOwn,
  integerValue,
  isCalendarDate,
  isPlainRecord,
  screenedString,
} from './campaign-governance.ts';
import {
  DECISION_PACKET_GA4_BEHAVIOR,
  DECISION_PACKET_PIN,
  decisionPacketValueValid,
  validateDecisionPacketGa4Behavior,
} from './decision-packet-contract.ts';
import { GA4_READONLY_SCOPE } from './ga4-admin-checklist.ts';
import { readGa4RunReport } from './ga4-run-report.ts';

export const HSB_GA4_BEHAVIOR_EXPORT_SCHEMA = 'hsb.decision_export.ga4_behavior';
export const HSB_GA4_BEHAVIOR_EXPORT_VERSION = 1;
export const DECISION_PACKET_MAPPING_SCHEMA = 'hsb.decision_packet_mapping';
export const DECISION_PACKET_TARGET_SCHEMA = 'decision_packet.ga4_behavior';

const DAY_MS = 86_400_000;
const MAX_ROWS = 250_000;
const MAX_RANGES = 400;
const MAX_COUNT = 1_000_000_000;
const MAX_EXPORT_DAYS = 366;
const PROPERTY_ID_RE = /^[1-9]\d{5,14}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const EXPORT_TIMEZONES = Object.freeze(['UTC', 'America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles'] as const);

// ── Export vocabulary: governed values plus fixed sentinels ─────────────────

export const EXPORT_SOURCES: readonly string[] = Object.freeze([...CAMPAIGN_SOURCE_VALUES, 'direct', 'not_set', 'other']);
export const EXPORT_MEDIUMS: readonly string[] = Object.freeze([...CAMPAIGN_MEDIUM_VALUES, 'none', 'not_set', 'other']);
export const EXPORT_CAMPAIGN_SENTINELS: readonly string[] = Object.freeze(['none', 'not_set', 'other']);
export const EXPORT_CONTENTS: readonly string[] = Object.freeze([...CAMPAIGN_CONTENT_VALUES, 'not_set', 'other']);
export const EXPORT_LANDING_PATHS: readonly string[] = Object.freeze([...APPROVED_PUBLIC_ROUTE_TEMPLATES, 'not_set', 'other']);
/** The Phase-A campaign grammar plus sentinels, for the generated JSON Schema. */
const CAMPAIGN_JSON_PATTERN =
  '^(?:none|not_set|other|launch|202[6-9]-(?:0[1-9]|1[0-2])-(?:gifts|holiday|birthdays|launch)(?:\\.v[1-9])?)$';

/** Referral hosts GA4 reports as a session source, mapped exactly to their platform. */
const SOURCE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'facebook.com': 'facebook',
  'www.facebook.com': 'facebook',
  'm.facebook.com': 'facebook',
  'l.facebook.com': 'facebook',
  'lm.facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'www.instagram.com': 'instagram',
  'l.instagram.com': 'instagram',
});
/** GA4's own placeholders for sessions with no campaign. */
const NO_CAMPAIGN_MARKERS = new Set(['(direct)', '(organic)', '(referral)', '(none)']);
const NOT_SET_MARKERS = new Set(['', '(not set)']);

export interface GovernedDimensions {
  source: string;
  medium: string;
  campaign: string;
  content: string;
  landing_path: string;
}

/**
 * Raw GA4 session dimensions → governed HSB values. Nothing raw survives:
 * each value is either a Phase-A canonical label, a public route template,
 * or one of the fixed sentinels `direct`/`none`/`not_set`/`other`.
 */
export function governGa4BehaviorDimensions(raw: {
  sessionSource?: unknown;
  sessionMedium?: unknown;
  sessionCampaignName?: unknown;
  sessionManualAdContent?: unknown;
  landingPage?: unknown;
}): GovernedDimensions {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value.trim() : null);
  const source = text(raw.sessionSource);
  const medium = text(raw.sessionMedium);
  const campaign = text(raw.sessionCampaignName);
  const content = text(raw.sessionManualAdContent);
  const landing = text(raw.landingPage);
  return {
    source: source === null ? 'other'
      : NOT_SET_MARKERS.has(source) ? 'not_set'
        : source === '(direct)' ? 'direct'
          : sanitizeAttributionValue('utm_source', source) ?? sourceAlias(source) ?? 'other',
    medium: medium === null ? 'other'
      : NOT_SET_MARKERS.has(medium) ? 'not_set'
        : medium === '(none)' ? 'none'
          : sanitizeAttributionValue('utm_medium', medium) ?? 'other',
    campaign: campaign === null ? 'other'
      : NOT_SET_MARKERS.has(campaign) ? 'not_set'
        : NO_CAMPAIGN_MARKERS.has(campaign) ? 'none'
          : sanitizeAttributionValue('utm_campaign', campaign) ?? 'other',
    content: content === null ? 'other'
      : NOT_SET_MARKERS.has(content) ? 'not_set'
        : sanitizeAttributionValue('utm_content', content) ?? 'other',
    landing_path: landing === null ? 'other'
      : NOT_SET_MARKERS.has(landing) ? 'not_set'
        : governedLandingPath(landing),
  };
}

function sourceAlias(raw: string): string | null {
  const host = raw.toLowerCase();
  return hasOwn(SOURCE_ALIASES, host) ? SOURCE_ALIASES[host] : null;
}

function governedLandingPath(raw: string): string {
  const template = sanitizeLandingPath(raw);
  return template !== null && APPROVED_PUBLIC_ROUTE_TEMPLATES.includes(template) ? template : 'other';
}

// ── Read-only report request ────────────────────────────────────────────────

const REPORT_DIMENSIONS = ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'sessionManualAdContent', 'landingPage'];
const REPORT_METRICS = ['sessions', 'checkouts', 'ecommercePurchases'];

export function buildGa4BehaviorExportRequest(input: { propertyId: string; startDate: string; endDate: string }):
  | { ok: true; request: { method: 'POST'; url: string; oauthScope: typeof GA4_READONLY_SCOPE; body: Record<string, unknown> } }
  | { ok: false; reason: 'PROPERTY_ID_INVALID' | 'DATE_INVALID' | 'DATE_RANGE_INVALID' } {
  if (typeof input?.propertyId !== 'string' || !PROPERTY_ID_RE.test(input.propertyId)) return { ok: false, reason: 'PROPERTY_ID_INVALID' };
  if (!isCalendarDate(input.startDate) || !isCalendarDate(input.endDate)) return { ok: false, reason: 'DATE_INVALID' };
  const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / DAY_MS;
  if (span < 0 || span >= MAX_EXPORT_DAYS) return { ok: false, reason: 'DATE_RANGE_INVALID' };
  return {
    ok: true,
    request: {
      method: 'POST',
      url: `https://analyticsdata.googleapis.com/v1beta/properties/${input.propertyId}:runReport`,
      oauthScope: GA4_READONLY_SCOPE,
      body: {
        dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
        dimensions: REPORT_DIMENSIONS.map((name) => ({ name })),
        metrics: REPORT_METRICS.map((name) => ({ name })),
        keepEmptyRows: false,
        limit: String(MAX_ROWS),
      },
    },
  };
}

// ── The closed export document ──────────────────────────────────────────────

const HEADER_KEYS = [
  'schema', 'schema_version', 'data_origin', 'business', 'timezone', 'generated_at', 'coverage',
  'attested_complete_ranges', 'quality', 'rows',
] as const;
const ROW_KEYS = [
  'date', 'source', 'medium', 'campaign', 'content', 'landing_path', 'sessions', 'checkout_starts', 'purchase_events',
] as const;
const QUALITY_KEYS = ['sampled', 'thresholded', 'other_row'] as const;
const DIMENSION_KEYS = ['source', 'medium', 'campaign', 'content', 'landing_path'] as const;
const COUNT_KEYS = ['sessions', 'checkout_starts', 'purchase_events'] as const;

export interface DateRange { start: string; end: string }

export interface Ga4BehaviorExportRow extends GovernedDimensions {
  date: string;
  sessions: number;
  checkout_starts: number;
  purchase_events: number;
}

export interface Ga4BehaviorExport {
  schema: typeof HSB_GA4_BEHAVIOR_EXPORT_SCHEMA;
  schema_version: typeof HSB_GA4_BEHAVIOR_EXPORT_VERSION;
  data_origin: (typeof DATA_ORIGINS)[number];
  business: 'hsb';
  timezone: (typeof EXPORT_TIMEZONES)[number];
  generated_at: string;
  coverage: DateRange;
  attested_complete_ranges: DateRange[];
  quality: { sampled: boolean; thresholded: boolean; other_row: boolean };
  rows: Ga4BehaviorExportRow[];
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace('Z', '.000Z');
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function rangeValue(value: unknown, path: string, out: IssueCollector): DateRange | null {
  if (!checkClosedObject(value, ['start', 'end'], path, out)) return null;
  if (!isCalendarDate(value.start) || !isCalendarDate(value.end)) {
    out.add('INVALID_DATE', path);
    return null;
  }
  if (value.start > value.end) {
    out.add('RANGE_INVALID', path);
    return null;
  }
  return { start: value.start, end: value.end };
}

function exportDimension(field: (typeof DIMENSION_KEYS)[number], value: unknown, path: string, out: IssueCollector): void {
  const text = screenedString(value, path, out);
  if (text === null) return;
  const vocabulary: Record<string, readonly string[]> = {
    source: EXPORT_SOURCES,
    medium: EXPORT_MEDIUMS,
    content: EXPORT_CONTENTS,
    landing_path: EXPORT_LANDING_PATHS,
  };
  if (field === 'campaign') {
    if (EXPORT_CAMPAIGN_SENTINELS.includes(text) || sanitizeAttributionValue('utm_campaign', text) === text) return;
    out.add(sanitizeAttributionValue('utm_campaign', text) === null ? 'VALUE_NOT_GOVERNED' : 'VALUE_NOT_CANONICAL', path);
    return;
  }
  if (vocabulary[field].includes(text)) return;
  out.add(field === 'landing_path' ? 'LANDING_PATH_NOT_APPROVED' : 'VALUE_NOT_GOVERNED', path);
}

/** Value-free `CODE@$.path` issues; an empty array means the export is closed and governed. */
export function validateHsbGa4BehaviorExport(doc: unknown): string[] {
  const out = new IssueCollector();
  if (!isPlainRecord(doc)) {
    out.add('DOCUMENT_NOT_OBJECT', '$');
    return out.issues;
  }
  if (doc.schema !== HSB_GA4_BEHAVIOR_EXPORT_SCHEMA) {
    out.add('SCHEMA_INVALID', '$.schema');
    return out.issues;
  }
  if (doc.schema_version !== HSB_GA4_BEHAVIOR_EXPORT_VERSION) {
    out.add('SCHEMA_VERSION_UNSUPPORTED', '$.schema_version');
    return out.issues;
  }
  checkClosedObject(doc, HEADER_KEYS, '$', out);
  enumValue(DATA_ORIGINS, doc.data_origin, '$.data_origin', out);
  enumValue(['hsb'], doc.business, '$.business', out);
  enumValue(EXPORT_TIMEZONES, doc.timezone, '$.timezone', out);
  const generatedAt = isTimestamp(doc.generated_at) ? doc.generated_at : null;
  if (generatedAt === null) out.add('INVALID_TIMESTAMP', '$.generated_at');
  const coverage = rangeValue(doc.coverage, '$.coverage', out);
  if (coverage && generatedAt && Date.parse(`${addDays(coverage.end, 1)}T00:00:00.000Z`) > Date.parse(generatedAt)) {
    out.add('COVERAGE_AFTER_GENERATED_AT', '$.coverage.end');
  }
  if (!Array.isArray(doc.attested_complete_ranges) || doc.attested_complete_ranges.length > MAX_RANGES) {
    out.add('TYPE_ARRAY', '$.attested_complete_ranges');
  } else {
    doc.attested_complete_ranges.forEach((item, index) => {
      const path = `$.attested_complete_ranges[${index}]`;
      const range = rangeValue(item, path, out);
      if (range && coverage && (range.start < coverage.start || range.end > coverage.end)) out.add('RANGE_OUTSIDE_COVERAGE', path);
    });
  }
  if (checkClosedObject(doc.quality, QUALITY_KEYS, '$.quality', out)) {
    for (const key of QUALITY_KEYS) {
      if (typeof doc.quality[key] !== 'boolean') out.add('TYPE_BOOLEAN', `$.quality.${key}`);
    }
    // GA4 reported data loss: no day of this export can be attested complete.
    const quality = doc.quality;
    if (QUALITY_KEYS.some((key) => quality[key] === true)
      && Array.isArray(doc.attested_complete_ranges) && doc.attested_complete_ranges.length > 0) {
      out.add('ATTESTATION_CONTRADICTS_QUALITY', '$.attested_complete_ranges');
    }
  }
  if (!Array.isArray(doc.rows) || doc.rows.length > MAX_ROWS) {
    out.add('TYPE_ARRAY', '$.rows');
    return out.issues;
  }
  const seen = new Set<string>();
  doc.rows.forEach((row, index) => {
    const path = `$.rows[${index}]`;
    const before = out.count;
    if (!checkClosedObject(row, ROW_KEYS, path, out)) return;
    if (!isCalendarDate(row.date)) out.add('INVALID_DATE', `${path}.date`);
    else if (coverage && (row.date < coverage.start || row.date > coverage.end)) out.add('ROW_OUTSIDE_COVERAGE', `${path}.date`);
    for (const field of DIMENSION_KEYS) exportDimension(field, row[field], `${path}.${field}`, out);
    for (const field of COUNT_KEYS) integerValue(row[field], 0, MAX_COUNT, `${path}.${field}`, out);
    if (out.count !== before) return;
    const key = JSON.stringify([row.date, ...DIMENSION_KEYS.map((field) => row[field])]);
    if (seen.has(key)) out.add('DUPLICATE_ROW', path);
    seen.add(key);
  });
  return out.issues;
}

// ── GA4 report → export ─────────────────────────────────────────────────────

export interface ExportHeaderInput {
  dataOrigin: string;
  generatedAt: string;
  coverage: DateRange;
  attestedCompleteRanges: DateRange[];
}

function compareRows(a: Ga4BehaviorExportRow, b: Ga4BehaviorExportRow): number {
  for (const key of ['date', ...DIMENSION_KEYS] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/**
 * ATTESTED: GA4 flagged no data loss, so the operator's attested ranges stand
 * (the packet still applies its own settle lag). INSUFFICIENT_EVIDENCE: GA4
 * sampled, thresholded or folded rows into "(other)"; the export carries those
 * flags and no attested range.
 */
export type ExportCompleteness = 'ATTESTED' | 'INSUFFICIENT_EVIDENCE';

/**
 * Reduce an operator-supplied GA4 `runReport` response (from
 * `buildGa4BehaviorExportRequest`) to the closed export. The response is read
 * only through the strict reader (src/lib/ga4-run-report.ts). Rows that
 * collapse to the same governed segment are summed. Refuses — rather than
 * repairs — a truncated report (GA4 reports more rows than it returned: the
 * row cap or pagination), a malformed or ambiguous response, malformed
 * metrics, dates outside coverage, foreign headers or timezones.
 */
export function projectGa4BehaviorReport(response: unknown, header: ExportHeaderInput):
  | { ok: true; document: Ga4BehaviorExport; completeness: ExportCompleteness; reasons: string[] }
  | { ok: false; issues: string[] } {
  const out = new IssueCollector();
  const refuse = () => ({ ok: false as const, issues: out.issues });
  if (!isPlainRecord(header) || !(DATA_ORIGINS as readonly string[]).includes(header.dataOrigin as string)) out.add('HEADER_INVALID', '$.dataOrigin');
  if (!isPlainRecord(header) || !isTimestamp(header.generatedAt)) out.add('HEADER_INVALID', '$.generatedAt');
  const coverage = isPlainRecord(header) ? rangeValue(header.coverage, '$.coverage', new IssueCollector()) : null;
  if (!coverage) out.add('HEADER_INVALID', '$.coverage');
  const attested = isPlainRecord(header) && Array.isArray(header.attestedCompleteRanges)
    ? header.attestedCompleteRanges.map((range) => rangeValue(range, '$', new IssueCollector()))
    : null;
  if (!attested || attested.some((range) => range === null)) out.add('HEADER_INVALID', '$.attestedCompleteRanges');
  if (out.count > 0) return refuse();

  const read = readGa4RunReport(response, { dimensions: REPORT_DIMENSIONS, metrics: REPORT_METRICS, limit: MAX_ROWS });
  if (read.ok === false) {
    out.add(read.defect, read.path);
    return refuse();
  }
  const { rows, timeZone: timezone, gaps } = read.report;
  // Rows GA4 counted but did not return cannot be summed, so no export exists.
  if (gaps.includes('TRUNCATED')) {
    out.add('REPORT_TRUNCATED', '$.rowCount');
    return refuse();
  }
  if (timezone === null || !(EXPORT_TIMEZONES as readonly string[]).includes(timezone)) {
    out.add('TIMEZONE_UNSUPPORTED', '$.metadata.timeZone');
    return refuse();
  }

  const merged = new Map<string, Ga4BehaviorExportRow>();
  rows.forEach(({ dimensions, metrics }, index) => {
    const path = `$.rows[${index}]`;
    const [rawDate, sessionSource, sessionMedium, sessionCampaignName, sessionManualAdContent, landingPage] = dimensions;
    const date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}` : null;
    if (!date || !isCalendarDate(date)) {
      out.add('DATE_INVALID', path);
      return;
    }
    if (date < coverage!.start || date > coverage!.end) {
      out.add('ROW_OUTSIDE_COVERAGE', path);
      return;
    }
    if (!metrics.every((value) => /^\d{1,10}$/.test(value) && Number(value) <= MAX_COUNT)) {
      out.add('METRIC_INVALID', path);
      return;
    }
    const [sessions, checkoutStarts, purchaseEvents] = metrics.map(Number);
    const governed = governGa4BehaviorDimensions({ sessionSource, sessionMedium, sessionCampaignName, sessionManualAdContent, landingPage });
    const key = JSON.stringify([date, ...DIMENSION_KEYS.map((field) => governed[field])]);
    const existing = merged.get(key);
    if (existing) {
      existing.sessions += sessions;
      existing.checkout_starts += checkoutStarts;
      existing.purchase_events += purchaseEvents;
      if (COUNT_KEYS.some((field) => existing[field] > MAX_COUNT)) out.add('METRIC_OVERFLOW', path);
    } else {
      merged.set(key, {
        date,
        ...governed,
        sessions,
        checkout_starts: checkoutStarts,
        purchase_events: purchaseEvents,
      });
    }
  });
  if (out.count > 0) return refuse();

  const quality = {
    sampled: gaps.includes('SAMPLED'),
    thresholded: gaps.includes('THRESHOLDED'),
    other_row: gaps.includes('OTHER_ROW'),
  };
  const document: Ga4BehaviorExport = {
    schema: HSB_GA4_BEHAVIOR_EXPORT_SCHEMA,
    schema_version: HSB_GA4_BEHAVIOR_EXPORT_VERSION,
    data_origin: header.dataOrigin as Ga4BehaviorExport['data_origin'],
    business: 'hsb',
    timezone: timezone as Ga4BehaviorExport['timezone'],
    generated_at: header.generatedAt,
    coverage: { start: coverage!.start, end: coverage!.end },
    // GA4-reported data loss withdraws every complete-range attestation.
    attested_complete_ranges: gaps.length > 0 ? [] : attested!.map((range) => ({ start: range!.start, end: range!.end })),
    quality,
    rows: [...merged.values()].sort(compareRows),
  };
  // Revalidate at the boundary: the adapter's output must pass the same closed schema as any other input.
  const issues = validateHsbGa4BehaviorExport(document);
  if (issues.length > 0) return { ok: false, issues };
  return gaps.length > 0
    ? { ok: true, document, completeness: 'INSUFFICIENT_EVIDENCE', reasons: [...gaps] }
    : { ok: true, document, completeness: 'ATTESTED', reasons: [] };
}

// ── Deterministic synthetic fixture ─────────────────────────────────────────

type SyntheticSegments = ReadonlyArray<{ dimensions: GovernedDimensions; base: readonly [number, number, number] }>;

const SYNTHETIC_SEGMENTS: Readonly<Record<SyntheticProfile, SyntheticSegments>> = {
  // Governed HSB campaigns: the pinned packet can represent none of them.
  governed: [
    { dimensions: { source: 'direct', medium: 'none', campaign: 'none', content: 'not_set', landing_path: '/' }, base: [30, 2, 1] },
    {
      dimensions: { source: 'facebook', medium: 'paid_social', campaign: '2026-09-gifts', content: 'video-a', landing_path: '/gifts/birthdays' },
      base: [25, 3, 1],
    },
    { dimensions: { source: 'newsletter', medium: 'email', campaign: 'launch', content: 'text-b', landing_path: '/' }, base: [12, 1, 0] },
  ],
  // Only values with a counterpart in the pinned packet vocabulary.
  packet_representable: [
    { dimensions: { source: 'direct', medium: 'none', campaign: 'none', content: 'not_set', landing_path: '/' }, base: [30, 2, 1] },
    { dimensions: { source: 'google', medium: 'organic', campaign: 'none', content: 'not_set', landing_path: '/' }, base: [22, 2, 1] },
    { dimensions: { source: 'facebook', medium: 'social', campaign: 'not_set', content: 'video-a', landing_path: '/' }, base: [14, 1, 0] },
    { dimensions: { source: 'newsletter', medium: 'email', campaign: 'not_set', content: 'text-b', landing_path: 'other' }, base: [9, 1, 0] },
  ],
};

export type SyntheticProfile = 'governed' | 'packet_representable';

/** Synthetic, clearly-labelled fixture data — never business results. Pure function of its input. */
export function generateSyntheticGa4BehaviorExport(input: { startDate: string; days: number; profile?: SyntheticProfile }): Ga4BehaviorExport {
  if (!isCalendarDate(input.startDate) || !Number.isSafeInteger(input.days) || input.days < 1 || input.days > MAX_EXPORT_DAYS) {
    throw new RangeError('synthetic export needs a calendar start date and 1-366 days');
  }
  const profile = input.profile ?? 'governed';
  if (!hasOwn(SYNTHETIC_SEGMENTS, profile)) throw new RangeError('unknown synthetic profile');
  const segments = SYNTHETIC_SEGMENTS[profile];
  const end = addDays(input.startDate, input.days - 1);
  const rows: Ga4BehaviorExportRow[] = [];
  for (let day = 0; day < input.days; day += 1) {
    const date = addDays(input.startDate, day);
    for (const { dimensions, base } of segments) {
      rows.push({
        date,
        source: dimensions.source,
        medium: dimensions.medium,
        campaign: dimensions.campaign,
        content: dimensions.content,
        landing_path: dimensions.landing_path,
        sessions: base[0] + day,
        checkout_starts: base[1],
        purchase_events: base[2],
      });
    }
  }
  return {
    schema: HSB_GA4_BEHAVIOR_EXPORT_SCHEMA,
    schema_version: HSB_GA4_BEHAVIOR_EXPORT_VERSION,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    timezone: 'America/Chicago',
    generated_at: `${addDays(end, 3)}T12:00:00Z`,
    coverage: { start: input.startDate, end },
    attested_complete_ranges: [{ start: input.startDate, end }],
    quality: { sampled: false, thresholded: false, other_row: false },
    rows,
  };
}

// ── Generated JSON Schema ───────────────────────────────────────────────────

/** A closed JSON Schema (2020-12) for the export, generated from the same vocabulary. */
export function hsbGa4BehaviorExportJsonSchema(): Record<string, unknown> {
  const closed = (properties: Record<string, unknown>) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:hsb:schema:${HSB_GA4_BEHAVIOR_EXPORT_SCHEMA}:v${HSB_GA4_BEHAVIOR_EXPORT_VERSION}`,
    title: 'HSB GA4 behavior decision export',
    description: 'Daily GA4 behavior per governed segment. Purchase events are behavioral evidence, never payment authority.',
    ...closed({
      schema: { const: HSB_GA4_BEHAVIOR_EXPORT_SCHEMA },
      schema_version: { const: HSB_GA4_BEHAVIOR_EXPORT_VERSION },
      data_origin: { enum: [...DATA_ORIGINS] },
      business: { const: 'hsb' },
      timezone: { enum: [...EXPORT_TIMEZONES] },
      generated_at: { type: 'string', pattern: TIMESTAMP_RE.source },
      coverage: { $ref: '#/$defs/range' },
      attested_complete_ranges: { type: 'array', maxItems: MAX_RANGES, items: { $ref: '#/$defs/range' } },
      quality: closed({ sampled: { type: 'boolean' }, thresholded: { type: 'boolean' }, other_row: { type: 'boolean' } }),
      rows: { type: 'array', maxItems: MAX_ROWS, items: { $ref: '#/$defs/row' } },
    }),
    $defs: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      range: closed({ start: { $ref: '#/$defs/date' }, end: { $ref: '#/$defs/date' } }),
      count: { type: 'integer', minimum: 0, maximum: MAX_COUNT },
      row: closed({
        date: { $ref: '#/$defs/date' },
        source: { enum: [...EXPORT_SOURCES] },
        medium: { enum: [...EXPORT_MEDIUMS] },
        campaign: { type: 'string', pattern: CAMPAIGN_JSON_PATTERN },
        content: { enum: [...EXPORT_CONTENTS] },
        landing_path: { enum: [...EXPORT_LANDING_PATHS] },
        sessions: { $ref: '#/$defs/count' },
        checkout_starts: { $ref: '#/$defs/count' },
        purchase_events: { $ref: '#/$defs/count' },
      }),
    },
  };
}

// ── Mapping contract to the standalone packet ───────────────────────────────

const MAPPING_KEYS = ['schema', 'schema_version', 'source', 'target', 'header_fields', 'row_fields', 'value_maps', 'extensions_required'] as const;
const MAPPED_HEADER_FIELDS = HEADER_KEYS.filter((key) => key !== 'schema' && key !== 'rows');
const EXTENSION_CODE_RE = /^PACKET_[A-Z_]{1,60}$/;
/** The one mapping key that stands for every governed Phase-A campaign label. */
const GOVERNED_CAMPAIGN = 'governed';

type MappedField = (typeof DIMENSION_KEYS)[number];

const MAPPED_VOCABULARY: Readonly<Record<MappedField, readonly string[]>> = {
  source: EXPORT_SOURCES,
  medium: EXPORT_MEDIUMS,
  campaign: [GOVERNED_CAMPAIGN, ...EXPORT_CAMPAIGN_SENTINELS],
  content: EXPORT_CONTENTS,
  landing_path: EXPORT_LANDING_PATHS,
};

/** HSB placeholders; each must cross as the identical packet placeholder. */
const HSB_PLACEHOLDERS: Readonly<Record<MappedField, readonly string[]>> = {
  source: ['direct', 'not_set', 'other'],
  medium: ['none', 'not_set', 'other'],
  campaign: EXPORT_CAMPAIGN_SENTINELS,
  content: ['not_set', 'other'],
  landing_path: ['not_set', 'other'],
};

/** Packet values that name nothing in particular: a governed value mapped onto one is lost. */
const PACKET_CATCH_ALLS: readonly string[] = ['none', 'not_set', 'other', 'referral_other'];
const PACKET_CONTENT_FORMATS: Readonly<Record<string, string>> = { video: 'vid', image: 'img', carousel: 'car', text: 'txt' };

/**
 * The packet value that means the same thing as one HSB export value, or null
 * when the pinned packet vocabulary has none. Placeholders map to themselves;
 * sources, mediums and landing routes keep their name; content `{format}-{v}`
 * is the packet's `{fmt}_{v}`. No governed campaign has one: packet campaign
 * names need an objective and one of the packet's reviewed slugs.
 */
function packetCounterpart(field: MappedField, value: string): string | null {
  let candidate: string | null = value;
  if (field === 'campaign' && value === GOVERNED_CAMPAIGN) candidate = null;
  else if (field === 'content' && !HSB_PLACEHOLDERS.content.includes(value)) {
    const [format, variant] = value.split('-');
    candidate = hasOwn(PACKET_CONTENT_FORMATS, format) ? `${PACKET_CONTENT_FORMATS[format]}_${variant}` : null;
  }
  return candidate !== null && decisionPacketValueValid(field, candidate, 'hsb') ? candidate : null;
}

/** Field names must be the pinned packet's, each carried by the HSB field of the same meaning (the same name). */
function checkFieldMap(value: unknown, keys: readonly string[], packetKeys: readonly string[], path: string, out: IssueCollector): void {
  if (!checkClosedObject(value, keys, path, out)) return;
  for (const key of keys) {
    const target = value[key];
    if (typeof target !== 'string' || !packetKeys.includes(target)) out.add('MAPPING_TARGET_NOT_IN_PACKET_SCHEMA', `${path}.${key}`);
    else if (target !== key) out.add('MAPPING_FIELD_CORRESPONDENCE', `${path}.${key}`);
  }
}

/** Why one value-map entry is wrong, or null; records the targets and extension codes it legitimately uses. */
function mappingEntryIssue(
  field: MappedField,
  value: string,
  entry: unknown,
  accepted: Set<string>,
  declared: ReadonlySet<string>,
  used: Set<string>,
): string | null {
  const counterpart = packetCounterpart(field, value);
  if (isPlainRecord(entry) && Object.keys(entry).join(',') === 'to') {
    const target = entry.to;
    if (typeof target !== 'string' || target.length === 0 || forbiddenValueCode(target) !== null) return 'MAPPING_TARGET_FORBIDDEN';
    if (!decisionPacketValueValid(field, target, 'hsb')) return 'MAPPING_TARGET_NOT_IN_PACKET_VOCABULARY';
    if (accepted.has(target)) return 'MAPPING_TARGET_DUPLICATE';
    if (!HSB_PLACEHOLDERS[field].includes(value) && PACKET_CATCH_ALLS.includes(target)) return 'MAPPING_LOSSY';
    if (counterpart === null) return 'MAPPING_NO_PACKET_COUNTERPART';
    if (target !== counterpart) return 'MAPPING_SEMANTIC_MISMATCH';
    accepted.add(target);
    return null;
  }
  if (isPlainRecord(entry) && Object.keys(entry).join(',') === 'blocked') {
    if (typeof entry.blocked !== 'string' || !declared.has(entry.blocked)) return 'MAPPING_EXTENSION_UNDECLARED';
    if (counterpart !== null) return 'MAPPING_BLOCK_UNNECESSARY';
    used.add(entry.blocked);
    return null;
  }
  return 'MAPPING_ENTRY_INVALID';
}

/**
 * Value-free issues for the mapping contract. It must name the pinned packet
 * schema and commit, carry every HSB field into the packet field of the same
 * meaning, and map every HSB export value to exactly its packet counterpart —
 * one-to-one, never onto a catch-all such as `other` — or declare it blocked
 * (no counterpart exists) with a declared extension code. A blocked value can
 * never cross: the export refuses rather than falls back.
 */
export function validateDecisionPacketMapping(doc: unknown): string[] {
  const out = new IssueCollector();
  if (!isPlainRecord(doc)) {
    out.add('DOCUMENT_NOT_OBJECT', '$');
    return out.issues;
  }
  if (doc.schema !== DECISION_PACKET_MAPPING_SCHEMA) {
    out.add('SCHEMA_INVALID', '$.schema');
    return out.issues;
  }
  if (doc.schema_version !== 1) {
    out.add('SCHEMA_VERSION_UNSUPPORTED', '$.schema_version');
    return out.issues;
  }
  checkClosedObject(doc, MAPPING_KEYS, '$', out);
  if (checkClosedObject(doc.source, ['schema', 'schema_version'], '$.source', out)
    && (doc.source.schema !== HSB_GA4_BEHAVIOR_EXPORT_SCHEMA || doc.source.schema_version !== HSB_GA4_BEHAVIOR_EXPORT_VERSION)) {
    out.add('MAPPING_SOURCE_SCHEMA', '$.source');
  }
  if (checkClosedObject(doc.target, ['schema', 'schema_version', 'reference_commit'], '$.target', out)) {
    if (doc.target.schema !== DECISION_PACKET_GA4_BEHAVIOR.schema) out.add('MAPPING_TARGET_SCHEMA', '$.target.schema');
    if (doc.target.schema_version !== DECISION_PACKET_GA4_BEHAVIOR.schemaVersion) out.add('MAPPING_TARGET_SCHEMA', '$.target.schema_version');
    if (doc.target.reference_commit !== DECISION_PACKET_PIN.commit) out.add('MAPPING_TARGET_SCHEMA', '$.target.reference_commit');
  }
  checkFieldMap(doc.header_fields, MAPPED_HEADER_FIELDS, DECISION_PACKET_GA4_BEHAVIOR.headerKeys, '$.header_fields', out);
  checkFieldMap(doc.row_fields, ROW_KEYS, DECISION_PACKET_GA4_BEHAVIOR.rowKeys, '$.row_fields', out);

  const declared = new Set<string>();
  const extensions = doc.extensions_required;
  if (!Array.isArray(extensions) || !extensions.every((code) => typeof code === 'string' && EXTENSION_CODE_RE.test(code))
    || new Set(extensions).size !== extensions.length) {
    out.add('MAPPING_EXTENSIONS_INVALID', '$.extensions_required');
  } else {
    for (const code of extensions) declared.add(code);
  }

  const used = new Set<string>();
  if (checkClosedObject(doc.value_maps, Object.keys(MAPPED_VOCABULARY), '$.value_maps', out)) {
    for (const field of DIMENSION_KEYS) {
      const vocabulary = MAPPED_VOCABULARY[field];
      const map = doc.value_maps[field];
      const path = `$.value_maps.${field}`;
      if (!isPlainRecord(map)) {
        out.add('TYPE_OBJECT', path);
        continue;
      }
      if (vocabulary.some((value) => !hasOwn(map, value))) out.add('MAPPING_INCOMPLETE', path);
      if (Object.keys(map).some((value) => !vocabulary.includes(value))) out.add('MAPPING_UNKNOWN_VALUE', path);
      const accepted = new Set<string>();
      for (const value of vocabulary) {
        if (!hasOwn(map, value)) continue;
        const issue = mappingEntryIssue(field, value, map[value], accepted, declared, used);
        if (issue) out.add(issue, `${path}.${value}`);
      }
    }
  }
  if ([...declared].some((code) => !used.has(code))) out.add('MAPPING_EXTENSION_UNUSED', '$.extensions_required');
  return out.issues;
}

/** Which HSB values the packet cannot represent today, per field. Assumes a valid mapping. */
export function summarizeDecisionPacketMapping(doc: unknown): {
  target: { schema: string; schema_version: number };
  blocked: Record<string, string[]>;
  extensions_required: string[];
} {
  const mapping = doc as {
    target: { schema: string; schema_version: number };
    value_maps: Record<string, Record<string, { blocked?: string }>>;
    extensions_required: string[];
  };
  const blocked: Record<string, string[]> = {};
  for (const field of DIMENSION_KEYS) {
    blocked[field] = Object.entries(mapping.value_maps[field])
      .filter(([, entry]) => typeof entry.blocked === 'string')
      .map(([value]) => value)
      .sort();
  }
  return {
    target: { schema: mapping.target.schema, schema_version: mapping.target.schema_version },
    blocked,
    extensions_required: [...mapping.extensions_required].sort(),
  };
}

// ── The packet's own document ───────────────────────────────────────────────

export interface DecisionPacketGa4Behavior {
  schema: typeof DECISION_PACKET_TARGET_SCHEMA;
  schema_version: 1;
  data_origin: Ga4BehaviorExport['data_origin'];
  business: 'hsb';
  timezone: Ga4BehaviorExport['timezone'];
  generated_at: string;
  coverage: DateRange;
  attested_complete_ranges: DateRange[];
  quality: Ga4BehaviorExport['quality'];
  rows: Ga4BehaviorExportRow[];
}

/** The exact bytes a packet document is written as; its size is bounded by the packet's input limit. */
export function serializeDecisionPacketDocument(document: DecisionPacketGa4Behavior): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The packet's own `decision_packet.ga4_behavior` v1 document for one HSB
 * export, or a refusal before any document exists. Every value crosses
 * through the validated mapping, so every packet value is exactly the
 * counterpart of its HSB value and the rows map back one for one. A value
 * with no counterpart — today every governed campaign, content variant `c`,
 * source `telegram` and every landing route but `/` — refuses the whole
 * export with its value-free extension code: nothing is collapsed into
 * `other` and no row is dropped. The packet's evidence rules the HSB schema
 * does not already imply (coverage length, ordered attested ranges, checkout
 * starts and purchases within sessions, input size) are refused here too, and
 * the document is revalidated against the pinned packet contract.
 */
export function exportDecisionPacketGa4Behavior(doc: unknown, mapping: unknown):
  | { ok: true; document: DecisionPacketGa4Behavior }
  | { ok: false; issues: string[] } {
  if (validateDecisionPacketMapping(mapping).length > 0) return { ok: false, issues: ['MAPPING_INVALID@$'] };
  const exportIssues = validateHsbGa4BehaviorExport(doc);
  if (exportIssues.length > 0) return { ok: false, issues: exportIssues };
  const source = doc as Ga4BehaviorExport;
  const maps = (mapping as { value_maps: Record<MappedField, Record<string, { to?: string; blocked?: string }>> }).value_maps;
  const out = new IssueCollector();

  const coverageDays = (Date.parse(source.coverage.end) - Date.parse(source.coverage.start)) / DAY_MS + 1;
  if (coverageDays > DECISION_PACKET_GA4_BEHAVIOR.maxCoverageDays) out.add('COVERAGE_TOO_LONG', '$.coverage');
  let previousEnd: string | null = null;
  source.attested_complete_ranges.forEach((range, index) => {
    if (previousEnd !== null && range.start <= previousEnd) out.add('ATTESTED_RANGE_INVALID', `$.attested_complete_ranges[${index}]`);
    else previousEnd = range.end;
  });

  const rows = source.rows.map((row, index) => {
    const path = `$.rows[${index}]`;
    if (row.checkout_starts > row.sessions || row.purchase_events > row.sessions) out.add('METRIC_INVARIANT', path);
    const mapped = { ...row };
    for (const field of DIMENSION_KEYS) {
      const key = field === 'campaign' && !EXPORT_CAMPAIGN_SENTINELS.includes(row.campaign) ? GOVERNED_CAMPAIGN : row[field];
      const entry = hasOwn(maps[field], key) ? maps[field][key] : {};
      if (typeof entry.to === 'string') mapped[field] = entry.to;
      else out.add(entry.blocked ?? 'MAPPING_INCOMPLETE', `${path}.${field}`);
    }
    return mapped;
  });
  if (out.count > 0) return { ok: false, issues: out.issues };

  const document: DecisionPacketGa4Behavior = {
    schema: DECISION_PACKET_TARGET_SCHEMA,
    schema_version: 1,
    data_origin: source.data_origin,
    business: source.business,
    timezone: source.timezone,
    generated_at: source.generated_at,
    coverage: { start: source.coverage.start, end: source.coverage.end },
    attested_complete_ranges: source.attested_complete_ranges.map((range) => ({ start: range.start, end: range.end })),
    quality: { sampled: source.quality.sampled, thresholded: source.quality.thresholded, other_row: source.quality.other_row },
    rows,
  };
  const issues = validateDecisionPacketGa4Behavior(document);
  if (issues.length > 0) return { ok: false, issues };
  if (new TextEncoder().encode(serializeDecisionPacketDocument(document)).length > DECISION_PACKET_GA4_BEHAVIOR.maxInputBytes) {
    return { ok: false, issues: ['INPUT_TOO_LARGE@$'] };
  }
  return { ok: true, document };
}
