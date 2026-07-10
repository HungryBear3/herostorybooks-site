/**
 * Story-shape status / gate model (rollout model §5 shape status map).
 *
 * The unit of rollout is a story shape = hero structure × story source × child
 * role. A shape's residence in a lane is temporary; the lane is permanent. This
 * module is the machine-readable form of the §5 table, plus a fail-closed lookup
 * so an unknown or not-yet-accepted shape can never be treated as sellable.
 *
 * Pure constants + lookups. No checkout, no gating enforcement side effects.
 */

import type { StoryShape } from './types.ts';

/**
 * Lane a shape lives in today.
 * - `self-serve-live`  — proven baseline, live public checkout.
 * - `gated`            — gate passed, flip is invite-capped self-serve-restricted.
 * - `sampling`         — sampling authorized; needs its own 3-sample gate.
 * - `concierge`        — operator-in-the-loop only; no self-serve.
 * - `not-accepted`     — not accepted in any lane yet (not "never").
 */
export type ShapeLane =
  | 'self-serve-live'
  | 'gated'
  | 'sampling'
  | 'concierge'
  | 'not-accepted';

export interface ShapeStatus {
  shape: StoryShape;
  lane: ShapeLane;
  /** Whether public self-serve checkout is permitted for this shape. */
  sellableSelfServe: boolean;
  /** Whether an operator-run concierge sample/order is permitted. */
  conciergeAllowed: boolean;
  /** The next gate this shape must clear to advance. */
  nextGate: string;
}

/** Canonical key for a shape: `heroStructure|storySource|childRole`. */
export function shapeKey(shape: StoryShape): string {
  return `${shape.heroStructure}|${shape.storySource}|${shape.childRole}`;
}

/**
 * The §5 shape status map (as of 2026-07-08). Keyed by `shapeKey`. Any shape not
 * present here is treated as `not-accepted` (fail-closed) by `statusForShape`.
 */
export const STORY_SHAPE_STATUS: Readonly<Record<string, ShapeStatus>> = {
  'child|guided|hero': {
    shape: { heroStructure: 'child', storySource: 'guided', childRole: 'hero' },
    lane: 'self-serve-live',
    sellableSelfServe: true,
    conciergeAllowed: true,
    nextGate: '— (the proven baseline)',
  },
  'parent|guided|recipient': {
    shape: { heroStructure: 'parent', storySource: 'guided', childRole: 'recipient' },
    lane: 'gated',
    sellableSelfServe: false,
    conciergeAllowed: true,
    nextGate: 'Flip = self-serve-restricted (invite cap) per final go/no-go; enablement checklist E-1..E-10',
  },
  'grandparent|guided|recipient': {
    shape: { heroStructure: 'grandparent', storySource: 'guided', childRole: 'recipient' },
    lane: 'sampling',
    sellableSelfServe: false,
    conciergeAllowed: true,
    nextGate: 'Own 3-sample gate + parent retro',
  },
  'dual-parent|memory|audience': {
    shape: { heroStructure: 'dual-parent', storySource: 'memory', childRole: 'audience' },
    lane: 'concierge',
    sellableSelfServe: false,
    conciergeAllowed: true,
    nextGate: 'Blockers B1–B7 → first 5 invited concierge orders (Taco Gate cohort)',
  },
} as const;

/** Hero structures that are not accepted in any lane yet (§5). */
const NOT_ACCEPTED_STRUCTURES: ReadonlySet<StoryShape['heroStructure']> = new Set([
  'sibling',
  'whole-family',
  'custom-cast',
]);

/**
 * Fail-closed status lookup. Known shapes return their mapped status; siblings /
 * whole-family / custom-cast and any unmapped combination return `not-accepted`
 * with self-serve and concierge both closed.
 */
export function statusForShape(shape: StoryShape): ShapeStatus {
  const mapped = STORY_SHAPE_STATUS[shapeKey(shape)];
  if (mapped) return mapped;
  return {
    shape,
    lane: 'not-accepted',
    sellableSelfServe: false,
    conciergeAllowed: !NOT_ACCEPTED_STRUCTURES.has(shape.heroStructure),
    nextGate: NOT_ACCEPTED_STRUCTURES.has(shape.heroStructure)
      ? 'Enter concierge only when QA capacity exists and a shape gate is defined; ≥3 identities also waits on Phase-C identity-consistency work'
      : 'No shape gate defined yet — define regression suite + sample QA before any lane',
  };
}

/** Convenience: is public self-serve checkout allowed for this shape? */
export function isSelfServeSellable(shape: StoryShape): boolean {
  return statusForShape(shape).sellableSelfServe;
}
