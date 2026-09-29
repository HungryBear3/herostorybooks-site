/**
 * Exact transaction_id purchase dedup readback: a read-only GA4 Data API
 * request built deterministically from a validated Checkout Session id, and
 * an evaluator that turns the report into one bounded verdict. Nothing here
 * sends an event, reads a credential, or calls the network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGa4TransactionReadbackRequest,
  evaluateGa4TransactionReadback,
} from '../src/lib/ga4-transaction-readback.ts';

const TXN = 'cs_live_a1B2c3D4e5F6g7H8';
const INPUT = { propertyId: '123456789', transactionId: TXN, startDate: '2026-09-20', endDate: '2026-09-28' };

test('the readback request is an exact, deterministic, read-only runReport', () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; throw new Error('no network'); }) as typeof fetch;
  try {
    const built = buildGa4TransactionReadbackRequest(INPUT);
    assert.deepEqual(built, {
      ok: true,
      request: {
        method: 'POST',
        url: 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport',
        oauthScope: 'https://www.googleapis.com/auth/analytics.readonly',
        body: {
          dateRanges: [{ startDate: '2026-09-20', endDate: '2026-09-28' }],
          dimensions: [{ name: 'transactionId' }, { name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            andGroup: {
              expressions: [
                { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'purchase', caseSensitive: true } } },
                { filter: { fieldName: 'transactionId', stringFilter: { matchType: 'EXACT', value: TXN, caseSensitive: true } } },
              ],
            },
          },
          keepEmptyRows: false,
          limit: '10',
        },
      },
    });
    assert.equal(JSON.stringify(built), JSON.stringify(buildGa4TransactionReadbackRequest({ ...INPUT })));
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('only an exact Checkout Session id, a numeric property and absolute bounded dates are accepted', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ transactionId: 'ord_ZQXSYNTH7731' }, 'TRANSACTION_ID_INVALID'],
    [{ transactionId: 'cs_live_' }, 'TRANSACTION_ID_INVALID'],
    [{ transactionId: 'cs_live_abc def' }, 'TRANSACTION_ID_INVALID'],
    [{ transactionId: 'CS_LIVE_ABC123' }, 'TRANSACTION_ID_INVALID'],
    [{ transactionId: 'cs_live_abc"}],"x' }, 'TRANSACTION_ID_INVALID'],
    [{ transactionId: ` ${TXN}` }, 'TRANSACTION_ID_INVALID'],
    [{ transactionId: 'jane@example.com' }, 'TRANSACTION_ID_INVALID'],
    [{ transactionId: 12345 }, 'TRANSACTION_ID_INVALID'],
    [{ propertyId: 'G-68FKEDZEG3' }, 'PROPERTY_ID_INVALID'],
    [{ propertyId: '0123' }, 'PROPERTY_ID_INVALID'],
    [{ startDate: 'yesterday' }, 'DATE_INVALID'],
    [{ endDate: 'today' }, 'DATE_INVALID'],
    [{ startDate: '2026-02-29', endDate: '2026-03-01' }, 'DATE_INVALID'],
    [{ startDate: '2026-09-28', endDate: '2026-09-20' }, 'DATE_RANGE_INVALID'],
    [{ startDate: '2026-01-01', endDate: '2026-09-28' }, 'DATE_RANGE_INVALID'],
  ];
  for (const [change, reason] of cases) {
    assert.deepEqual(buildGa4TransactionReadbackRequest({ ...INPUT, ...change } as never), { ok: false, reason }, JSON.stringify(change));
  }
  assert.deepEqual(buildGa4TransactionReadbackRequest(null as never), { ok: false, reason: 'INPUT_INVALID' });
  assert.equal(buildGa4TransactionReadbackRequest({ ...INPUT, transactionId: 'cs_test_a1B2c3D4' }).ok, true);
});

function report(rows: Array<[string, string, string]>, metadata: Record<string, unknown> = {}) {
  return {
    dimensionHeaders: [{ name: 'transactionId' }, { name: 'eventName' }],
    metricHeaders: [{ name: 'eventCount', type: 'TYPE_INTEGER' }],
    rows: rows.map(([transactionId, eventName, count]) => ({
      dimensionValues: [{ value: transactionId }, { value: eventName }],
      metricValues: [{ value: count }],
    })),
    rowCount: rows.length,
    metadata: { currencyCode: 'USD', timeZone: 'America/Chicago', ...metadata },
    kind: 'analyticsData#runReport',
  };
}

test('the evaluator returns one bounded verdict per report shape', () => {
  const cases: Array<[string, unknown, { verdict: string; reasons: string[] }]> = [
    ['exactly one', report([[TXN, 'purchase', '1']]), { verdict: 'EXACTLY_ONE', reasons: [] }],
    ['duplicate', report([[TXN, 'purchase', '2']]), { verdict: 'DUPLICATE', reasons: ['EVENT_COUNT_ABOVE_ONE'] }],
    ['missing', report([]), { verdict: 'MISSING', reasons: [] }],
    ['missing without rows key', { ...report([]), rows: undefined, rowCount: 0 }, { verdict: 'MISSING', reasons: [] }],
    ['thresholded', report([[TXN, 'purchase', '1']], { subjectToThresholding: true }), { verdict: 'INCONCLUSIVE', reasons: ['THRESHOLDED'] }],
    ['sampled', report([[TXN, 'purchase', '1']], { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }] }),
      { verdict: 'INCONCLUSIVE', reasons: ['SAMPLED'] }],
    ['other row', report([], { dataLossFromOtherRow: true }), { verdict: 'INCONCLUSIVE', reasons: ['OTHER_ROW'] }],
    ['filter not applied', report([['cs_live_zzzzzzzz', 'purchase', '1']]), { verdict: 'INVALID_RESPONSE', reasons: ['FILTER_NOT_APPLIED'] }],
    ['other event', report([[TXN, 'refund', '1']]), { verdict: 'INVALID_RESPONSE', reasons: ['FILTER_NOT_APPLIED'] }],
    ['two rows', report([[TXN, 'purchase', '1'], [TXN, 'purchase', '1']]), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_DUPLICATED'] }],
    ['zero count', report([[TXN, 'purchase', '0']]), { verdict: 'INVALID_RESPONSE', reasons: ['METRIC_INVALID'] }],
    ['float count', report([[TXN, 'purchase', '1.5']]), { verdict: 'INVALID_RESPONSE', reasons: ['METRIC_INVALID'] }],
    ['headers', { ...report([[TXN, 'purchase', '1']]), dimensionHeaders: [{ name: 'eventName' }, { name: 'transactionId' }] },
      { verdict: 'INVALID_RESPONSE', reasons: ['HEADERS_MISMATCH'] }],
    ['not an object', 'jane', { verdict: 'INVALID_RESPONSE', reasons: ['RESPONSE_SHAPE'] }],
  ];
  for (const [label, response, expected] of cases) {
    assert.deepEqual(evaluateGa4TransactionReadback({ transactionId: TXN }, response), expected, label);
  }
  assert.deepEqual(evaluateGa4TransactionReadback({ transactionId: 'ord_ZQXSYNTH7731' }, report([])),
    { verdict: 'INVALID_REQUEST', reasons: ['TRANSACTION_ID_INVALID'] });
});

test('a verdict never echoes identifiers from the report', () => {
  const hostile = report([['jane@example.com', 'purchase', '1']]);
  const result = evaluateGa4TransactionReadback({ transactionId: TXN }, hostile);
  assert.doesNotMatch(JSON.stringify(result), /jane|cs_live/);
});

// ── A verdict rests only on a complete, exactly-shaped report ──────────────

test('the reviewer reproducer: extra cells and a rowCount mismatch are never EXACTLY_ONE', () => {
  const response = {
    dimensionHeaders: [{ name: 'transactionId' }, { name: 'eventName' }],
    metricHeaders: [{ name: 'eventCount' }],
    rows: [{
      dimensionValues: [{ value: 'cs_test_abc' }, { value: 'purchase' }, { value: 'unexpected' }],
      metricValues: [{ value: '1' }, { value: '99' }],
    }],
    rowCount: 2,
  };
  assert.deepEqual(evaluateGa4TransactionReadback({ transactionId: 'cs_test_abc' }, response),
    { verdict: 'INVALID_RESPONSE', reasons: ['ROW_SHAPE'] });
});

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

test('malformed, truncated or quality-flagged reports never yield a definitive verdict', () => {
  const one = report([[TXN, 'purchase', '1']]);
  const row = (dimensionValues: unknown, metricValues: unknown, extra: Record<string, unknown> = {}) =>
    ({ ...one, rows: [{ dimensionValues, metricValues, ...extra }] });
  const dims = [{ value: TXN }, { value: 'purchase' }];
  const count = [{ value: '1' }];
  const flags = { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }], subjectToThresholding: true, dataLossFromOtherRow: true };
  const cases: Array<[string, unknown, { verdict: string; reasons: string[] }]> = [
    ['rowCount above the rows received', { ...one, rowCount: 2 }, { verdict: 'INCONCLUSIVE', reasons: ['TRUNCATED'] }],
    ['rowCount above the request limit', { ...one, rowCount: 11 }, { verdict: 'INCONCLUSIVE', reasons: ['TRUNCATED'] }],
    ['rowCount without rows', { ...report([]), rowCount: 3 }, { verdict: 'INCONCLUSIVE', reasons: ['TRUNCATED'] }],
    ['rowCount below the rows received', { ...one, rowCount: 0 }, { verdict: 'INVALID_RESPONSE', reasons: ['ROW_COUNT_INVALID'] }],
    ['rowCount missing beside rows', without(one, 'rowCount'), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_COUNT_INVALID'] }],
    ['rowCount as text', { ...one, rowCount: '1' }, { verdict: 'INVALID_RESPONSE', reasons: ['ROW_COUNT_INVALID'] }],
    ['fractional rowCount', { ...one, rowCount: 1.5 }, { verdict: 'INVALID_RESPONSE', reasons: ['ROW_COUNT_INVALID'] }],
    ['extra dimension cell', row([...dims, { value: 'x' }], count), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_SHAPE'] }],
    ['extra metric cell', row(dims, [...count, { value: '99' }]), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_SHAPE'] }],
    ['missing metric cell', row(dims, []), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_SHAPE'] }],
    ['extra row field', row(dims, count, { note: 'x' }), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_SHAPE'] }],
    ['cell with an extra field', row([{ value: TXN, oneValue: 'x' }, dims[1]], count), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_SHAPE'] }],
    ['non-string cell', row(dims, [{ value: 1 }]), { verdict: 'INVALID_RESPONSE', reasons: ['ROW_SHAPE'] }],
    ['extra dimension header', { ...one, dimensionHeaders: [...one.dimensionHeaders, { name: 'date' }] },
      { verdict: 'INVALID_RESPONSE', reasons: ['HEADERS_MISMATCH'] }],
    ['missing metric headers', without(one, 'metricHeaders'), { verdict: 'INVALID_RESPONSE', reasons: ['HEADERS_MISMATCH'] }],
    ['header with an extra field', { ...one, dimensionHeaders: [{ name: 'transactionId', type: 'x' }, { name: 'eventName' }] },
      { verdict: 'INVALID_RESPONSE', reasons: ['HEADERS_MISMATCH'] }],
    ['non-integer metric type', { ...one, metricHeaders: [{ name: 'eventCount', type: 'TYPE_FLOAT' }] },
      { verdict: 'INVALID_RESPONSE', reasons: ['HEADERS_MISMATCH'] }],
    ['unrequested totals', { ...one, totals: [{ dimensionValues: [], metricValues: [{ value: '1' }] }] },
      { verdict: 'INVALID_RESPONSE', reasons: ['RESPONSE_SHAPE'] }],
    ['pagination token', { ...one, nextPageToken: 'x' }, { verdict: 'INVALID_RESPONSE', reasons: ['RESPONSE_SHAPE'] }],
    ['foreign response kind', { ...one, kind: 'analyticsData#batchRunReports' }, { verdict: 'INVALID_RESPONSE', reasons: ['RESPONSE_SHAPE'] }],
    ['thresholding flag as text', report([[TXN, 'purchase', '1']], { subjectToThresholding: 'true' }),
      { verdict: 'INVALID_RESPONSE', reasons: ['METADATA_INVALID'] }],
    ['other-row flag as text', report([[TXN, 'purchase', '1']], { dataLossFromOtherRow: 'yes' }),
      { verdict: 'INVALID_RESPONSE', reasons: ['METADATA_INVALID'] }],
    ['sampling metadata not a list', report([[TXN, 'purchase', '1']], { samplingMetadatas: {} }),
      { verdict: 'INVALID_RESPONSE', reasons: ['METADATA_INVALID'] }],
    ['unknown metadata field', report([[TXN, 'purchase', '1']], { rowsTruncated: true }),
      { verdict: 'INVALID_RESPONSE', reasons: ['METADATA_INVALID'] }],
    ['metadata not an object', { ...one, metadata: 'complete' }, { verdict: 'INVALID_RESPONSE', reasons: ['METADATA_INVALID'] }],
    ['every gap at once', { ...report([[TXN, 'purchase', '1']], flags), rowCount: 2 },
      { verdict: 'INCONCLUSIVE', reasons: ['SAMPLED', 'THRESHOLDED', 'OTHER_ROW', 'TRUNCATED'] }],
  ];
  for (const [label, response, expected] of cases) {
    assert.deepEqual(evaluateGa4TransactionReadback({ transactionId: TXN }, response), expected, label);
  }
});
