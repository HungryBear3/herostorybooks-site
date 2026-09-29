/**
 * Exact transaction_id purchase dedup verification, read-only.
 *
 * The webhook's settled winner sends one GA4 `purchase` per Checkout Session
 * (src/lib/purchase-analytics.ts), and GA4 dedups on `transaction_id`. This
 * module turns an operator's question — "did GA4 record exactly one purchase
 * for this Checkout Session?" — into one deterministic Data API `runReport`
 * request and one bounded verdict over its response.
 *
 * It sends no event, reads no credential, and calls nothing: the operator runs
 * the request with a read-only (`analytics.readonly`) token outside this repo
 * and feeds the JSON response back. Inputs are validated with the same
 * Checkout Session rule the purchase writer uses; relative dates are refused
 * so a request means the same thing whenever it is run. The response is read
 * only through the strict runReport reader (src/lib/ga4-run-report.ts).
 * Verdicts never echo a value from the report.
 */
import { GA4_TRANSACTION_ID_PATTERN } from './analytics-event-contract.ts';
import { isCalendarDate, isPlainRecord } from './campaign-governance.ts';
import { GA4_READONLY_SCOPE } from './ga4-admin-checklist.ts';
import { readGa4RunReport } from './ga4-run-report.ts';

const PROPERTY_ID_RE = /^[1-9]\d{5,14}$/;
const DAY_MS = 86_400_000;
/** A dedup check brackets one purchase; a quarter is the most a single check may span. */
const MAX_RANGE_DAYS = 93;
const ROW_LIMIT = 10;

export interface TransactionReadbackInput {
  propertyId: string;
  transactionId: string;
  startDate: string;
  endDate: string;
}

export interface TransactionReadbackRequest {
  method: 'POST';
  url: string;
  oauthScope: typeof GA4_READONLY_SCOPE;
  body: Record<string, unknown>;
}

export type TransactionReadbackBuild =
  | { ok: true; request: TransactionReadbackRequest }
  | { ok: false; reason: 'INPUT_INVALID' | 'TRANSACTION_ID_INVALID' | 'PROPERTY_ID_INVALID' | 'DATE_INVALID' | 'DATE_RANGE_INVALID' };

function exactFilter(fieldName: string, value: string) {
  return { filter: { fieldName, stringFilter: { matchType: 'EXACT', value, caseSensitive: true } } };
}

function isTransactionId(value: unknown): value is string {
  return typeof value === 'string' && GA4_TRANSACTION_ID_PATTERN.test(value);
}

export function buildGa4TransactionReadbackRequest(input: TransactionReadbackInput): TransactionReadbackBuild {
  if (!isPlainRecord(input)) return { ok: false, reason: 'INPUT_INVALID' };
  if (!isTransactionId(input.transactionId)) return { ok: false, reason: 'TRANSACTION_ID_INVALID' };
  if (typeof input.propertyId !== 'string' || !PROPERTY_ID_RE.test(input.propertyId)) return { ok: false, reason: 'PROPERTY_ID_INVALID' };
  if (!isCalendarDate(input.startDate) || !isCalendarDate(input.endDate)) return { ok: false, reason: 'DATE_INVALID' };
  const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / DAY_MS;
  if (span < 0 || span > MAX_RANGE_DAYS) return { ok: false, reason: 'DATE_RANGE_INVALID' };
  return {
    ok: true,
    request: {
      method: 'POST',
      url: `https://analyticsdata.googleapis.com/v1beta/properties/${input.propertyId}:runReport`,
      oauthScope: GA4_READONLY_SCOPE,
      body: {
        dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
        dimensions: [{ name: 'transactionId' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          andGroup: { expressions: [exactFilter('eventName', 'purchase'), exactFilter('transactionId', input.transactionId)] },
        },
        keepEmptyRows: false,
        limit: String(ROW_LIMIT),
      },
    },
  };
}

export type TransactionReadbackVerdict =
  | 'EXACTLY_ONE'
  | 'DUPLICATE'
  | 'MISSING'
  | 'INCONCLUSIVE'
  | 'INVALID_RESPONSE'
  | 'INVALID_REQUEST';

export interface TransactionReadbackResult {
  verdict: TransactionReadbackVerdict;
  reasons: string[];
}

/**
 * EXACTLY_ONE: one purchase event for this transaction. DUPLICATE: GA4 kept
 * more than one. MISSING: none (yet — processing can lag a day or two).
 * INCONCLUSIVE: sampled, thresholded, folded into "(other)", or truncated
 * (GA4 reports more rows than it returned). Anything that is not exactly the
 * shape this request produces — extra or missing headers, cells or fields, a
 * rowCount below the rows received, untyped metadata — is INVALID_RESPONSE.
 */
export function evaluateGa4TransactionReadback(
  request: { transactionId: string },
  response: unknown,
): TransactionReadbackResult {
  if (!isPlainRecord(request) || !isTransactionId(request.transactionId)) {
    return { verdict: 'INVALID_REQUEST', reasons: ['TRANSACTION_ID_INVALID'] };
  }
  const invalid = (reason: string): TransactionReadbackResult => ({ verdict: 'INVALID_RESPONSE', reasons: [reason] });
  const read = readGa4RunReport(response, { dimensions: ['transactionId', 'eventName'], metrics: ['eventCount'], limit: ROW_LIMIT });
  if (read.ok === false) return invalid(read.defect);
  const { rows, gaps } = read.report;
  if (gaps.length > 0) return { verdict: 'INCONCLUSIVE', reasons: [...gaps] };
  if (rows.length === 0) return { verdict: 'MISSING', reasons: [] };
  if (rows.length > 1) return invalid('ROW_DUPLICATED');
  const [transactionId, eventName] = rows[0].dimensions;
  if (transactionId !== request.transactionId || eventName !== 'purchase') return invalid('FILTER_NOT_APPLIED');
  const [count] = rows[0].metrics;
  if (!/^[1-9]\d{0,9}$/.test(count)) return invalid('METRIC_INVALID');
  return count === '1'
    ? { verdict: 'EXACTLY_ONE', reasons: [] }
    : { verdict: 'DUPLICATE', reasons: ['EVENT_COUNT_ABOVE_ONE'] };
}
