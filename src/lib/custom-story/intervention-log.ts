/**
 * Intervention logging schema for the concierge lane.
 *
 * Rollout model §3/§4: a shape graduates to self-serve only after ≥10 concierge
 * orders with an operator-intervention rate below 20%. Interventions "can't be
 * reconstructed later" — the log must ship with the first concierge order. This
 * module is the schema + pure helpers for that log. It stores NO customer PII:
 * entries are keyed by orderId + shape, with operator handles, not names.
 *
 * Pure data. No persistence here — callers decide where entries live (local
 * JSON fixture, order store, etc.).
 */

import type { StoryShape } from './types.ts';
import { shapeKey } from './shapes.ts';

/**
 * The six operator-intervention categories tracked for the graduation metric
 * (rollout model §3 (b): "interventions = brief corrections, regeneration,
 * manual prose/art fixes").
 */
export type InterventionCategory =
  | 'brief_correction'
  | 'anchor_correction'
  | 'sanitization_correction'
  | 'role_cast_correction'
  | 'manual_prose_fix'
  | 'manual_art_fix';

export const INTERVENTION_CATEGORIES: readonly InterventionCategory[] = [
  'brief_correction',
  'anchor_correction',
  'sanitization_correction',
  'role_cast_correction',
  'manual_prose_fix',
  'manual_art_fix',
];

export interface InterventionLogEntry {
  /** ISO-8601 timestamp. */
  at: string;
  orderId: string;
  /** Canonical shape key (`heroStructure|storySource|childRole`). */
  shapeId: string;
  category: InterventionCategory;
  /** Short description of what the operator corrected (no customer PII). */
  detail?: string;
  /** Operator handle — not a customer identity. */
  operator?: string;
  /** Structured extras, mirroring the order audit-event meta shape. */
  meta?: Record<string, string | number | boolean | null>;
}

export interface InterventionLogInput {
  orderId: string;
  shape: StoryShape;
  category: InterventionCategory;
  detail?: string;
  operator?: string;
  meta?: Record<string, string | number | boolean | null>;
}

/**
 * Build a validated intervention log entry. `now` is injectable for
 * deterministic tests (mirrors `createOrderRecord`'s clock injection).
 */
export function createInterventionLogEntry(
  input: InterventionLogInput,
  now: string = new Date().toISOString(),
): InterventionLogEntry {
  if (!input.orderId?.trim()) {
    throw new Error('intervention log entry requires an orderId');
  }
  if (!INTERVENTION_CATEGORIES.includes(input.category)) {
    throw new Error(`unknown intervention category: ${String(input.category)}`);
  }
  const entry: InterventionLogEntry = {
    at: now,
    orderId: input.orderId,
    shapeId: shapeKey(input.shape),
    category: input.category,
  };
  if (input.detail) entry.detail = input.detail;
  if (input.operator) entry.operator = input.operator;
  if (input.meta) entry.meta = input.meta;
  return entry;
}

export interface ShapeInterventionSummary {
  shapeId: string;
  orderCount: number;
  /** Distinct orders that required ≥1 intervention. */
  interventionOrderCount: number;
  totalInterventions: number;
  byCategory: Record<InterventionCategory, number>;
  /** interventionOrderCount / orderCount, or 0 when orderCount is 0. */
  interventionRate: number;
  /** Graduation threshold from rollout model §3 (b): rate < 20%. */
  belowGraduationThreshold: boolean;
}

const GRADUATION_MAX_RATE = 0.2;

function emptyByCategory(): Record<InterventionCategory, number> {
  return {
    brief_correction: 0,
    anchor_correction: 0,
    sanitization_correction: 0,
    role_cast_correction: 0,
    manual_prose_fix: 0,
    manual_art_fix: 0,
  };
}

/**
 * Summarize the intervention rate for a shape — the self-serve graduation
 * metric. `orderCount` is the number of concierge orders completed for the
 * shape (the denominator); it is supplied by the caller because the log only
 * records orders that needed an intervention.
 */
export function summarizeShapeInterventions(
  entries: readonly InterventionLogEntry[],
  shape: StoryShape,
  orderCount: number,
): ShapeInterventionSummary {
  const id = shapeKey(shape);
  const forShape = entries.filter((e) => e.shapeId === id);
  const byCategory = emptyByCategory();
  const orders = new Set<string>();
  for (const e of forShape) {
    byCategory[e.category] += 1;
    orders.add(e.orderId);
  }
  const interventionOrderCount = orders.size;
  const rate = orderCount > 0 ? interventionOrderCount / orderCount : 0;
  return {
    shapeId: id,
    orderCount,
    interventionOrderCount,
    totalInterventions: forShape.length,
    byCategory,
    interventionRate: rate,
    belowGraduationThreshold: orderCount > 0 && rate < GRADUATION_MAX_RATE,
  };
}
