import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EXPERIMENT_BOARD_SCHEMA_VERSION,
  validateExperimentBoard,
} from '../src/lib/marketing/experiments-board.ts';

const boardUrl = new URL('../docs/marketing/experiments-board.json', import.meta.url);
const board = JSON.parse(readFileSync(boardUrl, 'utf8')) as Record<string, unknown>;

function clone(): any {
  return JSON.parse(JSON.stringify(board));
}

test('the checked-in 30-day board is valid', () => {
  const result = validateExperimentBoard(board);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(board.schema_version, EXPERIMENT_BOARD_SCHEMA_VERSION);
});

test('every checked-in row is still proposed and carries no granted approval', () => {
  for (const row of board.experiments as any[]) {
    assert.equal(row.status, 'proposed', `${row.experiment_id} is no longer proposed`);
    for (const kind of ['public_posting', 'account_connection', 'paid_spend']) {
      assert.equal(row.approvals[kind].granted, false, `${row.experiment_id}.${kind} is granted`);
    }
    assert.equal(row.actual.value, null, `${row.experiment_id} reports an actual result`);
  }
});

test('the human Markdown view has not drifted from the authoritative JSON', () => {
  const markdown = readFileSync(new URL('../docs/marketing/experiments-board.md', import.meta.url), 'utf8');
  assert.match(markdown, /Human view\. Not authoritative\./);
  for (const row of board.experiments as any[]) {
    assert.ok(markdown.includes(row.experiment_id), `${row.experiment_id} is missing from the Markdown view`);
    assert.ok(
      markdown.includes(`\`${row.experiment_id}\` |`),
      `${row.experiment_id} is not listed as a row in the Markdown status table`,
    );
    assert.ok(markdown.includes(row.utm.utm_medium), `medium ${row.utm.utm_medium} is missing from the Markdown view`);
    assert.ok(
      markdown.includes(`$${row.spend_cap_usd}`),
      `spend cap for ${row.experiment_id} is missing from the Markdown view`,
    );
  }
  // The Markdown must not claim an approval or a live status the JSON does not carry.
  assert.match(markdown, /Every row is `proposed`\./);
});

test('rejects a duplicate experiment_id', () => {
  const bad = clone();
  bad.experiments.push({ ...bad.experiments[0], utm: { ...bad.experiments[0].utm, utm_content: 'other-card' } });
  const result = validateExperimentBoard(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: string) => e.includes('duplicate experiment_id')));
});

test('rejects colliding governed UTM tuples across distinct experiments', () => {
  const bad = clone();
  bad.experiments[1].utm = { ...bad.experiments[0].utm };
  const result = validateExperimentBoard(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: string) => e.includes('shares its governed UTM tuple')));
});

test('rejects malformed and PII-like UTM values', () => {
  for (const [value, fragment] of [
    ['Fall Partnership 2026', 'malformed'],
    ['jane-at-gmail-com', 'pii_like'],
    ['5551234567', 'pii_like'],
    ['ord_synthetic0001', 'pii_like'],
    ['x'.repeat(41), 'too_long'],
  ] as const) {
    const bad = clone();
    bad.experiments[0].utm.utm_campaign = value;
    const result = validateExperimentBoard(bad);
    assert.equal(result.ok, false, `expected ${value} to be rejected`);
    assert.ok(
      result.errors.some((e: string) => e.includes(fragment)),
      `expected ${value} to be rejected as ${fragment}, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test('rejects a medium outside the closed vocabulary', () => {
  const bad = clone();
  bad.experiments[0].utm.utm_medium = 'cpc';
  const result = validateExperimentBoard(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: string) => e.includes('medium_not_allowlisted')));
});

test('rejects invalid and inverted dates', () => {
  const badDate = clone();
  badDate.experiments[0].start_date = '2026-13-45';
  assert.ok(validateExperimentBoard(badDate).errors.some((e: string) => e.includes('start_date must be an ISO date')));

  const inverted = clone();
  inverted.experiments[0].end_date = '2026-08-01';
  assert.ok(validateExperimentBoard(inverted).errors.some((e: string) => e.includes('end_date is before start_date')));
});

test('rejects an unknown status', () => {
  const bad = clone();
  bad.experiments[0].status = 'running';
  assert.ok(validateExperimentBoard(bad).errors.some((e: string) => e.includes('status must be one of')));
});

test('rejects a negative spend cap', () => {
  const bad = clone();
  const paid = bad.experiments.find((r: any) => r.utm.utm_medium === 'paid_social');
  paid.spend_cap_usd = -1;
  assert.ok(validateExperimentBoard(bad).errors.some((e: string) => e.includes('must not be negative')));
});

test('rejects a live row without a granted public_posting approval', () => {
  const bad = clone();
  bad.experiments[0].status = 'live';
  const result = validateExperimentBoard(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: string) => e.includes("without a granted public_posting approval")));
});

test('rejects a live paid row without spend and account approvals, even with posting approved', () => {
  const bad = clone();
  const paid = bad.experiments.find((r: any) => r.utm.utm_medium === 'paid_social');
  paid.status = 'live';
  paid.approvals.public_posting = {
    granted: true, approver: 'Alexy', date: '2026-09-14', evidence: 'docs/marketing/experiments-board.md',
  };
  const result = validateExperimentBoard(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: string) => e.includes('without a granted paid_spend approval')));
  assert.ok(result.errors.some((e: string) => e.includes('without a granted account_connection approval')));
});

test('rejects a granted approval with no approver, date, or evidence', () => {
  const bad = clone();
  bad.experiments[0].approvals.public_posting = { granted: true, approver: null, date: null, evidence: null };
  const result = validateExperimentBoard(bad);
  assert.ok(result.errors.some((e: string) => e.includes('granted with no approver')));
  assert.ok(result.errors.some((e: string) => e.includes('granted with no valid ISO date')));
  assert.ok(result.errors.some((e: string) => e.includes('granted with no evidence reference')));
});

test('rejects a paid row with a zero spend cap', () => {
  const bad = clone();
  const paid = bad.experiments.find((r: any) => r.utm.utm_medium === 'paid_social');
  paid.spend_cap_usd = 0;
  assert.ok(validateExperimentBoard(bad).errors.some((e: string) => e.includes('no positive spend cap')));
});

test('rejects a spend cap on a non-paid medium', () => {
  const bad = clone();
  bad.experiments[0].spend_cap_usd = 25;
  assert.ok(validateExperimentBoard(bad).errors.some((e: string) => e.includes('declares a spend cap on non-paid medium')));
});

test('rejects a missing or duplicated checkpoint', () => {
  const missing = clone();
  missing.experiments[0].checkpoints = missing.experiments[0].checkpoints.filter((c: any) => c.at !== '48h');
  assert.ok(validateExperimentBoard(missing).errors.some((e: string) => e.includes('missing the 48h checkpoint')));

  const duplicated = clone();
  duplicated.experiments[0].checkpoints[1].at = '24h';
  assert.ok(validateExperimentBoard(duplicated).errors.some((e: string) => e.includes('duplicate checkpoints')));
});

test('rejects a missing decision or next_action', () => {
  for (const field of ['decision', 'next_action']) {
    const bad = clone();
    bad.experiments[0][field] = '';
    assert.ok(
      validateExperimentBoard(bad).errors.some((e: string) => e.includes(`${field} must be a non-empty string`)),
      `expected empty ${field} to be rejected`,
    );
  }
});

test('rejects an invented result: measured quality with no value, or a value not marked as an estimate', () => {
  const noValue = clone();
  noValue.experiments[0].actual = { metric: 'trusted_paid_purchases_over_30d', value: null, quality: 'measured', note: 'from GA4' };
  assert.ok(validateExperimentBoard(noValue).errors.some((e: string) => e.includes("claims quality 'measured' with no value")));

  const unmarked = clone();
  unmarked.experiments[0].actual = { metric: 'trusted_paid_purchases_over_30d', value: 7, quality: 'unverified', note: 'looked good' };
  assert.ok(validateExperimentBoard(unmarked).errors.some((e: string) => e.includes('does not mark it as an estimate or unverified')));
});

test('rejects a board with the wrong schema version or a non-array experiments field', () => {
  const wrongVersion = clone();
  wrongVersion.schema_version = '0.9.0';
  assert.ok(validateExperimentBoard(wrongVersion).errors.some((e: string) => e.includes('schema_version must be')));

  assert.equal(validateExperimentBoard({ schema_version: EXPERIMENT_BOARD_SCHEMA_VERSION, generated_by: 'x', experiments: {} }).ok, false);
  assert.equal(validateExperimentBoard(null).ok, false);
});
