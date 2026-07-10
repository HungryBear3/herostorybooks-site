/**
 * Intervention logging schema tests (rollout model §3/§4 graduation metric).
 * No customer PII — orderId + shape + operator handle only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInterventionLogEntry,
  summarizeShapeInterventions,
  INTERVENTION_CATEGORIES,
  type InterventionLogEntry,
} from '../src/lib/custom-story/intervention-log.ts';
import type { StoryShape } from '../src/lib/custom-story/types.ts';

const SHAPE: StoryShape = { heroStructure: 'dual-parent', storySource: 'memory', childRole: 'audience' };

test('all six intervention categories are defined', () => {
  assert.deepEqual([...INTERVENTION_CATEGORIES].sort(), [
    'anchor_correction',
    'brief_correction',
    'manual_art_fix',
    'manual_prose_fix',
    'role_cast_correction',
    'sanitization_correction',
  ]);
});

test('createInterventionLogEntry fills timestamp + shapeId, keeps no PII', () => {
  const e = createInterventionLogEntry(
    { orderId: 'ord_taco_1', shape: SHAPE, category: 'brief_correction', operator: 'rex', detail: 'tightened anchor aliases' },
    '2026-07-08T12:00:00.000Z',
  );
  assert.equal(e.at, '2026-07-08T12:00:00.000Z');
  assert.equal(e.shapeId, 'dual-parent|memory|audience');
  assert.equal(e.orderId, 'ord_taco_1');
  assert.equal(e.category, 'brief_correction');
  assert.equal(e.operator, 'rex');
  // No customer-name/email fields on the entry.
  assert.ok(!('customerName' in e));
  assert.ok(!('email' in e));
});

test('createInterventionLogEntry rejects unknown category and missing orderId', () => {
  assert.throws(() =>
    createInterventionLogEntry({ orderId: 'x', shape: SHAPE, category: 'bogus' as never }),
  );
  assert.throws(() =>
    createInterventionLogEntry({ orderId: '', shape: SHAPE, category: 'brief_correction' }),
  );
});

test('summarize computes intervention rate + graduation threshold (<20%)', () => {
  const now = '2026-07-08T12:00:00.000Z';
  const entries: InterventionLogEntry[] = [
    createInterventionLogEntry({ orderId: 'o1', shape: SHAPE, category: 'brief_correction' }, now),
    createInterventionLogEntry({ orderId: 'o1', shape: SHAPE, category: 'anchor_correction' }, now),
    createInterventionLogEntry({ orderId: 'o2', shape: SHAPE, category: 'manual_art_fix' }, now),
  ];
  // 2 distinct intervened orders out of 10 completed = 20% → NOT below threshold.
  const at20 = summarizeShapeInterventions(entries, SHAPE, 10);
  assert.equal(at20.interventionOrderCount, 2);
  assert.equal(at20.totalInterventions, 3);
  assert.equal(at20.interventionRate, 0.2);
  assert.equal(at20.belowGraduationThreshold, false);
  assert.equal(at20.byCategory.brief_correction, 1);
  assert.equal(at20.byCategory.anchor_correction, 1);
  assert.equal(at20.byCategory.manual_art_fix, 1);

  // Same 2 intervened orders out of 20 completed = 10% → below threshold.
  const at10 = summarizeShapeInterventions(entries, SHAPE, 20);
  assert.equal(at10.interventionRate, 0.1);
  assert.equal(at10.belowGraduationThreshold, true);
});

test('summarize ignores entries from other shapes', () => {
  const other: StoryShape = { heroStructure: 'grandparent', storySource: 'guided', childRole: 'recipient' };
  const entries = [
    createInterventionLogEntry({ orderId: 'o1', shape: SHAPE, category: 'brief_correction' }, '2026-07-08T12:00:00.000Z'),
    createInterventionLogEntry({ orderId: 'o9', shape: other, category: 'manual_prose_fix' }, '2026-07-08T12:00:00.000Z'),
  ];
  const s = summarizeShapeInterventions(entries, SHAPE, 5);
  assert.equal(s.totalInterventions, 1);
  assert.equal(s.interventionOrderCount, 1);
});
