/**
 * Strict reader for a GA4 Data API `runReport` response to one of this
 * repository's own read-only requests: the decision export, the
 * transaction-id readback and the Admin dimension probe. No verdict may rest
 * on a response the reader did not fully understand, so it accepts exactly:
 *
 *  - the fields a response to those requests carries, and no others (none of
 *    them asks for totals, quotas or another page);
 *  - the requested dimension and metric headers, in order (every requested
 *    metric is an integer count);
 *  - rows exactly as wide as the headers, every cell exactly `{ value }`;
 *  - a `rowCount` beside any row, never below the rows received;
 *  - known metadata only, each flag with its documented type.
 *
 * What a well-formed response still cannot rule out is returned as a gap,
 * never guessed away: `SAMPLED`, `THRESHOLDED` and `OTHER_ROW` from the
 * metadata, and `TRUNCATED` when GA4 reports more rows than were received (a
 * row cap or pagination). Defects and gaps are value-free codes.
 */
import { hasOwn, isPlainRecord } from './campaign-governance.ts';

export type Ga4ReportGap = 'SAMPLED' | 'THRESHOLDED' | 'OTHER_ROW' | 'TRUNCATED';
export type Ga4ReportDefect = 'RESPONSE_SHAPE' | 'HEADERS_MISMATCH' | 'METADATA_INVALID' | 'ROW_SHAPE' | 'ROW_COUNT_INVALID';

export interface Ga4ReportRow {
  dimensions: string[];
  metrics: string[];
}

export interface Ga4Report {
  rows: Ga4ReportRow[];
  timeZone: string | null;
  /** Why the rows may not be the whole answer, in a fixed order; empty only for a complete, unsampled report. */
  gaps: Ga4ReportGap[];
}

export interface Ga4ReportRequestShape {
  dimensions: readonly string[];
  metrics: readonly string[];
  /** The request's row `limit`; GA4 never returns more. */
  limit: number;
}

const RESPONSE_KIND = 'analyticsData#runReport';
const RESPONSE_FIELDS = new Set(['kind', 'dimensionHeaders', 'metricHeaders', 'rows', 'rowCount', 'metadata']);
const ROW_FIELDS = new Set(['dimensionValues', 'metricValues']);
const METADATA_TEXT = ['currencyCode', 'timeZone', 'emptyReason'] as const;
const METADATA_FLAGS = ['subjectToThresholding', 'dataLossFromOtherRow'] as const;
const METADATA_FIELDS = new Set<string>([...METADATA_TEXT, ...METADATA_FLAGS, 'samplingMetadatas']);

function headerNames(value: unknown, metric: boolean): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.name !== 'string') return null;
    if (Object.keys(item).some((key) => key !== 'name' && !(metric && key === 'type'))) return null;
    if (metric && hasOwn(item, 'type') && item.type !== 'TYPE_INTEGER') return null;
    names.push(item.name);
  }
  return names;
}

function sameList(actual: string[] | null, expected: readonly string[]): boolean {
  return actual !== null && actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function cellValues(value: unknown, width: number): string[] | null {
  if (!Array.isArray(value) || value.length !== width) return null;
  const cells: string[] = [];
  for (const cell of value) {
    if (!isPlainRecord(cell) || Object.keys(cell).length !== 1 || typeof cell.value !== 'string') return null;
    cells.push(cell.value);
  }
  return cells;
}

export function readGa4RunReport(response: unknown, request: Ga4ReportRequestShape):
  | { ok: true; report: Ga4Report }
  | { ok: false; defect: Ga4ReportDefect; path: string } {
  const fail = (defect: Ga4ReportDefect, path: string) => ({ ok: false as const, defect, path });
  if (!isPlainRecord(response) || Object.keys(response).some((key) => !RESPONSE_FIELDS.has(key))) return fail('RESPONSE_SHAPE', '$');
  if (hasOwn(response, 'kind') && response.kind !== RESPONSE_KIND) return fail('RESPONSE_SHAPE', '$');
  if (!sameList(headerNames(response.dimensionHeaders, false), request.dimensions)
    || !sameList(headerNames(response.metricHeaders, true), request.metrics)) {
    return fail('HEADERS_MISMATCH', '$');
  }

  const metadata = response.metadata === undefined ? {} : response.metadata;
  if (!isPlainRecord(metadata) || Object.keys(metadata).some((key) => !METADATA_FIELDS.has(key))) return fail('METADATA_INVALID', '$.metadata');
  for (const key of METADATA_TEXT) {
    if (hasOwn(metadata, key) && typeof metadata[key] !== 'string') return fail('METADATA_INVALID', `$.metadata.${key}`);
  }
  for (const key of METADATA_FLAGS) {
    if (hasOwn(metadata, key) && typeof metadata[key] !== 'boolean') return fail('METADATA_INVALID', `$.metadata.${key}`);
  }
  const sampling = metadata.samplingMetadatas;
  if (hasOwn(metadata, 'samplingMetadatas') && (!Array.isArray(sampling) || !sampling.every(isPlainRecord))) {
    return fail('METADATA_INVALID', '$.metadata.samplingMetadatas');
  }

  const received = response.rows === undefined ? [] : response.rows;
  if (!Array.isArray(received) || received.length > request.limit) return fail('RESPONSE_SHAPE', '$.rows');
  const rows: Ga4ReportRow[] = [];
  for (const [index, row] of received.entries()) {
    const shaped = isPlainRecord(row) && Object.keys(row).every((key) => ROW_FIELDS.has(key));
    const dimensions = shaped ? cellValues(row.dimensionValues, request.dimensions.length) : null;
    const metrics = shaped ? cellValues(row.metricValues, request.metrics.length) : null;
    if (!dimensions || !metrics) return fail('ROW_SHAPE', `$.rows[${index}]`);
    rows.push({ dimensions, metrics });
  }

  // GA4 omits a zero rowCount, so it may be absent only when no row arrived.
  const rowCount = response.rowCount;
  if (rowCount === undefined ? rows.length > 0
    : typeof rowCount !== 'number' || !Number.isSafeInteger(rowCount) || rowCount < rows.length) {
    return fail('ROW_COUNT_INVALID', '$.rowCount');
  }

  const gaps: Ga4ReportGap[] = [];
  if (Array.isArray(sampling) && sampling.length > 0) gaps.push('SAMPLED');
  if (metadata.subjectToThresholding === true) gaps.push('THRESHOLDED');
  if (metadata.dataLossFromOtherRow === true) gaps.push('OTHER_ROW');
  if (typeof rowCount === 'number' && rowCount > rows.length) gaps.push('TRUNCATED');
  return { ok: true, report: { rows, timeZone: typeof metadata.timeZone === 'string' ? metadata.timeZone : null, gaps } };
}
