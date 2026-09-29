/**
 * Source-side export for the offline analytics decision packet.
 *
 * The packet is a separate, standalone tool with its own closed schemas and
 * vocabulary. Emitting its documents from here would couple the two
 * repositories, and its campaign/content/landing vocabulary does not contain
 * HSB's governed labels, so HSB emits its own versioned, closed export instead:
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
 *    and free text cannot be represented;
 *  - a JSON Schema generated from the same rules, a deterministic synthetic
 *    fixture, and a validator for the checked-in mapping contract
 *    (config/analytics/decision-packet-mapping.v1.json) that says exactly
 *    which values the packet accepts today and which need a reviewed packet
 *    vocabulary extension.
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
import { GA4_READONLY_SCOPE } from './ga4-admin-checklist.ts';

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

function headerNames(value: unknown): string | null {
  if (!Array.isArray(value) || !value.every((item) => isPlainRecord(item) && typeof item.name === 'string')) return null;
  return value.map((item) => item.name).join(',');
}

function cellValues(values: unknown, length: number): string[] | null {
  if (!Array.isArray(values) || values.length !== length) return null;
  const cells = values.map((item) => (isPlainRecord(item) && typeof item.value === 'string' ? item.value : null));
  return cells.every((cell): cell is string => cell !== null) ? cells : null;
}

function compareRows(a: Ga4BehaviorExportRow, b: Ga4BehaviorExportRow): number {
  for (const key of ['date', ...DIMENSION_KEYS] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/**
 * Reduce an operator-supplied GA4 `runReport` response (from
 * `buildGa4BehaviorExportRequest`) to the closed export. Rows that collapse
 * to the same governed segment are summed. Refuses — rather than repairs —
 * malformed metrics, dates outside coverage, foreign headers or timezones.
 */
export function projectGa4BehaviorReport(response: unknown, header: ExportHeaderInput):
  | { ok: true; document: Ga4BehaviorExport }
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

  if (!isPlainRecord(response)) {
    out.add('RESPONSE_SHAPE', '$');
    return refuse();
  }
  if (headerNames(response.dimensionHeaders) !== REPORT_DIMENSIONS.join(',') || headerNames(response.metricHeaders) !== REPORT_METRICS.join(',')) {
    out.add('HEADERS_MISMATCH', '$');
    return refuse();
  }
  const metadata = isPlainRecord(response.metadata) ? response.metadata : {};
  const timezone = metadata.timeZone;
  if (typeof timezone !== 'string' || !(EXPORT_TIMEZONES as readonly string[]).includes(timezone)) {
    out.add('TIMEZONE_UNSUPPORTED', '$.metadata.timeZone');
    return refuse();
  }
  const rows = response.rows === undefined ? [] : response.rows;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    out.add('RESPONSE_SHAPE', '$.rows');
    return refuse();
  }

  const merged = new Map<string, Ga4BehaviorExportRow>();
  rows.forEach((row, index) => {
    const path = `$.rows[${index}]`;
    const dimensions = isPlainRecord(row) ? cellValues(row.dimensionValues, REPORT_DIMENSIONS.length) : null;
    const metrics = isPlainRecord(row) ? cellValues(row.metricValues, REPORT_METRICS.length) : null;
    if (!dimensions || !metrics) {
      out.add('RESPONSE_SHAPE', path);
      return;
    }
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

  const document: Ga4BehaviorExport = {
    schema: HSB_GA4_BEHAVIOR_EXPORT_SCHEMA,
    schema_version: HSB_GA4_BEHAVIOR_EXPORT_VERSION,
    data_origin: header.dataOrigin as Ga4BehaviorExport['data_origin'],
    business: 'hsb',
    timezone: timezone as Ga4BehaviorExport['timezone'],
    generated_at: header.generatedAt,
    coverage: { start: coverage!.start, end: coverage!.end },
    attested_complete_ranges: attested!.map((range) => ({ start: range!.start, end: range!.end })),
    quality: {
      sampled: Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length > 0,
      thresholded: metadata.subjectToThresholding === true,
      other_row: metadata.dataLossFromOtherRow === true,
    },
    rows: [...merged.values()].sort(compareRows),
  };
  // Revalidate at the boundary: the adapter's output must pass the same closed schema as any other input.
  const issues = validateHsbGa4BehaviorExport(document);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, document };
}

// ── Deterministic synthetic fixture ─────────────────────────────────────────

const SYNTHETIC_SEGMENTS: ReadonlyArray<{ dimensions: GovernedDimensions; base: readonly [number, number, number] }> = [
  { dimensions: { source: 'direct', medium: 'none', campaign: 'none', content: 'not_set', landing_path: '/' }, base: [30, 2, 1] },
  {
    dimensions: { source: 'facebook', medium: 'paid_social', campaign: '2026-09-gifts', content: 'video-a', landing_path: '/gifts/birthdays' },
    base: [25, 3, 1],
  },
  { dimensions: { source: 'newsletter', medium: 'email', campaign: 'launch', content: 'text-b', landing_path: '/' }, base: [12, 1, 0] },
];

/** Synthetic, clearly-labelled fixture data — never business results. Pure function of its input. */
export function generateSyntheticGa4BehaviorExport(input: { startDate: string; days: number }): Ga4BehaviorExport {
  if (!isCalendarDate(input.startDate) || !Number.isSafeInteger(input.days) || input.days < 1 || input.days > MAX_EXPORT_DAYS) {
    throw new RangeError('synthetic export needs a calendar start date and 1-366 days');
  }
  const end = addDays(input.startDate, input.days - 1);
  const rows: Ga4BehaviorExportRow[] = [];
  for (let day = 0; day < input.days; day += 1) {
    const date = addDays(input.startDate, day);
    for (const { dimensions, base } of SYNTHETIC_SEGMENTS) {
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
const FIELD_NAME_RE = /^[a-z][a-z_]{0,39}$/;
const EXTENSION_CODE_RE = /^PACKET_[A-Z_]{1,60}$/;
/** Collapsing an unmappable value may only ever lose information, never keep it. */
const MAPPING_FALLBACKS = new Set(['other']);

const MAPPED_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  source: EXPORT_SOURCES,
  medium: EXPORT_MEDIUMS,
  campaign: ['governed', ...EXPORT_CAMPAIGN_SENTINELS],
  content: EXPORT_CONTENTS,
  landing_path: EXPORT_LANDING_PATHS,
};

function checkFieldMap(value: unknown, keys: readonly string[], path: string, out: IssueCollector): void {
  if (!checkClosedObject(value, keys, path, out)) return;
  for (const key of keys) {
    const target = value[key];
    if (typeof target !== 'string' || !FIELD_NAME_RE.test(target)) out.add('MAPPING_TARGET_FORBIDDEN', `${path}.${key}`);
  }
}

/** Value-free issues for the mapping contract; it must cover the HSB export vocabulary exactly. */
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
    if (doc.target.schema !== DECISION_PACKET_TARGET_SCHEMA) out.add('MAPPING_TARGET_SCHEMA', '$.target.schema');
    if (doc.target.schema_version !== 1) out.add('MAPPING_TARGET_SCHEMA', '$.target.schema_version');
    if (typeof doc.target.reference_commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(doc.target.reference_commit)) {
      out.add('MAPPING_TARGET_SCHEMA', '$.target.reference_commit');
    }
  }
  checkFieldMap(doc.header_fields, MAPPED_HEADER_FIELDS, '$.header_fields', out);
  checkFieldMap(doc.row_fields, ROW_KEYS, '$.row_fields', out);

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
    for (const [field, vocabulary] of Object.entries(MAPPED_VOCABULARY)) {
      const map = doc.value_maps[field];
      const path = `$.value_maps.${field}`;
      if (!isPlainRecord(map)) {
        out.add('TYPE_OBJECT', path);
        continue;
      }
      if (vocabulary.some((value) => !hasOwn(map, value))) out.add('MAPPING_INCOMPLETE', path);
      if (Object.keys(map).some((value) => !vocabulary.includes(value))) out.add('MAPPING_UNKNOWN_VALUE', path);
      for (const value of vocabulary) {
        if (!hasOwn(map, value)) continue;
        const entry = map[value];
        const entryPath = `${path}.${value}`;
        if (isPlainRecord(entry) && Object.keys(entry).join(',') === 'to') {
          if (typeof entry.to !== 'string' || entry.to.length === 0 || forbiddenValueCode(entry.to) !== null) {
            out.add('MAPPING_TARGET_FORBIDDEN', entryPath);
          }
        } else if (isPlainRecord(entry) && Object.keys(entry).sort().join(',') === 'blocked,fallback') {
          if (typeof entry.blocked !== 'string' || !declared.has(entry.blocked)) out.add('MAPPING_EXTENSION_UNDECLARED', entryPath);
          else used.add(entry.blocked);
          if (typeof entry.fallback !== 'string' || !MAPPING_FALLBACKS.has(entry.fallback)) out.add('MAPPING_FALLBACK_INVALID', entryPath);
        } else {
          out.add('MAPPING_ENTRY_INVALID', entryPath);
        }
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
  for (const field of Object.keys(MAPPED_VOCABULARY)) {
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
