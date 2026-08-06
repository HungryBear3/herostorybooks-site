import type { ProofCardOverride, ProofTextColor } from './fulfillment-types.ts';

/**
 * Server-authoritative schema, bounds, clamping, and revision-binding for the
 * per-page proof text-card override (the bounded customer layout editor's
 * positioned legibility card).
 *
 * Everything here is normalized and resolution-independent (origin = page
 * top-left, unit = fraction of page width/height). These bounds are the single
 * source of truth; the client UI mirrors them, but the server clamps again so a
 * hand-crafted request can never exceed them.
 *
 * Ported from the reviewed internal proof-layout editor (PR #125) and re-homed
 * for the customer tokenized review route. Dedication-page overrides are out of
 * scope here (a separate design lane).
 */

export interface ProofCardGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  fontScale: number;
}

/** Strict boundary guard for raw client/service input. Clamping is only for
 * finite numeric values outside the allowed box; malformed/missing values must
 * never be converted into a reset or canonical minimum. */
export function isCompleteProofCardGeometry(value: unknown): value is ProofCardGeometry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height', 'opacity', 'fontScale']
    .every((key) => typeof o[key] === 'number' && Number.isFinite(o[key]));
}

/** Conservative, server-enforced min/max for each control. */
export const PROOF_CARD_BOUNDS = {
  width: { min: 0.15, max: 0.9 },
  height: { min: 0.06, max: 0.5 },
  opacity: { min: 0.35, max: 0.92 },
  fontScale: { min: 0.85, max: 1.15 },
} as const;

/** Fraction of the page kept clear on each edge (trim/safe margin). */
export const PROOF_CARD_SAFE_MARGIN = 0.05;
/** Extra bottom reserve so the card can never intersect the folio/page-number
 *  strip that the renderer draws near the page bottom. */
export const PROOF_CARD_FOLIO_RESERVE = 0.06;

/** The ONE precision at which geometry is canonicalized. Persisted, rendered,
 *  fingerprinted, echoed, and audited values are all this precision — there is
 *  no full-precision path anywhere, so a rendered layout and its identity can
 *  never diverge. */
export const PROOF_CARD_PRECISION = 4;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  const f = 10 ** PROOF_CARD_PRECISION;
  return Math.round(value * f) / f;
}

/**
 * Clamp arbitrary (possibly hostile) client geometry into the allowed box.
 * Size is clamped first, then position is clamped so the WHOLE card stays
 * inside the safe area and off the bottom folio strip. Pure, no I/O.
 */
export function clampProofCardGeometry(input: Partial<ProofCardGeometry>): ProofCardGeometry {
  const width = clamp(Number(input.width), PROOF_CARD_BOUNDS.width.min, PROOF_CARD_BOUNDS.width.max);
  const height = clamp(Number(input.height), PROOF_CARD_BOUNDS.height.min, PROOF_CARD_BOUNDS.height.max);
  const opacity = clamp(Number(input.opacity), PROOF_CARD_BOUNDS.opacity.min, PROOF_CARD_BOUNDS.opacity.max);
  const fontScale = clamp(Number(input.fontScale), PROOF_CARD_BOUNDS.fontScale.min, PROOF_CARD_BOUNDS.fontScale.max);

  // Horizontal safe band: [margin, 1 - margin]; card left in [margin, 1-margin-width].
  const xMin = PROOF_CARD_SAFE_MARGIN;
  const xMax = Math.max(xMin, 1 - PROOF_CARD_SAFE_MARGIN - width);
  const x = clamp(Number(input.x), xMin, xMax);

  // Vertical safe band: top margin .. (1 - folio reserve); card top in
  // [margin, 1 - folioReserve - height].
  const yMin = PROOF_CARD_SAFE_MARGIN;
  const yMax = Math.max(yMin, 1 - PROOF_CARD_FOLIO_RESERVE - height);
  const y = clamp(Number(input.y), yMin, yMax);

  return { x, y, width, height, opacity, fontScale };
}

/**
 * THE canonicalization function. Clamps into the allowed box and snaps every
 * value to PROOF_CARD_PRECISION decimals, computing the position bounds from
 * the already-rounded size so the result is a fixed point (idempotent:
 * canonicalize(canonicalize(g)) === canonicalize(g)).
 *
 * Single source of truth used for validation, persistence, rendering, API
 * responses, audit payloads, UI hydration and proof fingerprinting.
 */
export function canonicalizeProofCardGeometry(input: Partial<ProofCardGeometry>): ProofCardGeometry {
  const width = round4(clamp(Number(input.width), PROOF_CARD_BOUNDS.width.min, PROOF_CARD_BOUNDS.width.max));
  const height = round4(clamp(Number(input.height), PROOF_CARD_BOUNDS.height.min, PROOF_CARD_BOUNDS.height.max));
  const opacity = round4(clamp(Number(input.opacity), PROOF_CARD_BOUNDS.opacity.min, PROOF_CARD_BOUNDS.opacity.max));
  const fontScale = round4(clamp(Number(input.fontScale), PROOF_CARD_BOUNDS.fontScale.min, PROOF_CARD_BOUNDS.fontScale.max));
  // Bounds derived from the ROUNDED size, themselves rounded, so a canonical
  // value is always its own fixed point.
  const xMax = round4(Math.max(PROOF_CARD_SAFE_MARGIN, 1 - PROOF_CARD_SAFE_MARGIN - width));
  const yMax = round4(Math.max(PROOF_CARD_SAFE_MARGIN, 1 - PROOF_CARD_FOLIO_RESERVE - height));
  const x = round4(clamp(Number(input.x), PROOF_CARD_SAFE_MARGIN, xMax));
  const y = round4(clamp(Number(input.y), PROOF_CARD_SAFE_MARGIN, yMax));
  return { x, y, width, height, opacity, fontScale };
}

// ── Approved text-color palette (fixed production values) ────────────────────
//
// Absence / no explicit color === legacy_default = the existing text token
// FOREST #1F3A5F (a deep desaturated BLUE, never called brown) on the cream card
// (#FFF8F0) — so no-color renders byte-identically to today. The THREE explicit
// selectable choices are a FIXED (text, scrim-fill) pair each, shared by the UI
// preview and the PDF renderer.

export interface ResolvedTextColor {
  /** Text ink hex. */ text: string;
  /** Card/wash scrim fill hex the text sits on. */ fill: string;
}

/**
 * The exact legacy default proof text color, used when NO explicit color is
 * chosen. The existing FOREST token `#1F3A5F` (a deep desaturated blue, NOT a
 * brown) on the cream card — so absence reproduces today's output exactly. Kept
 * OUTSIDE the selectable enum precisely so blue is never mislabeled "brown".
 */
export const LEGACY_DEFAULT_TEXT_COLOR: ResolvedTextColor = { text: '#1F3A5F', fill: '#FFF8F0' };

/**
 * The three EXPLICIT, selectable approved colors. `dark_brown` is a genuine warm
 * dark brown (`#4E342E`), RGB-distinct from the legacy default, so choosing it
 * produces a different canonical identity and a different raster.
 */
export const PROOF_TEXT_COLORS: Record<ProofTextColor, ResolvedTextColor> = {
  dark_brown: { text: '#4E342E', fill: '#FFF8F0' },
  cream: { text: '#FFF9F1', fill: '#1F3A5F' },
  charcoal: { text: '#262626', fill: '#FFF8F0' },
};

/** WCAG 2.x normal-text minimum. Never lowered to force a selection to pass. */
export const PROOF_CONTRAST_THRESHOLD = 4.5;

export function isProofTextColor(v: unknown): v is ProofTextColor {
  return v === 'dark_brown' || v === 'cream' || v === 'charcoal';
}

/**
 * Shared runtime guard for UNTRUSTED persisted override values. Validity is
 * decided on the COMPLETE shape BEFORE canonicalization supplies any default,
 * so a malformed / legacy `{}` (or null/array/wrong-type/non-finite) can never
 * become an active card just because canonicalization would clamp a missing
 * field to a bound. Must gate every trust boundary that consumes a persisted
 * `proofCardOverride`: the render path, the fingerprint projection, and the
 * PageArtifact→StoryContent projection — so render and identity always agree.
 *
 * A malformed override is treated as ABSENT (bottom band, no fingerprint
 * change). A structurally valid override MAY omit the optional `textColor`
 * (it then resolves to the approved legacy default).
 */
export function isValidProofCardOverride(value: unknown): value is ProofCardOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!finite(o.x) || !finite(o.y) || !finite(o.width) || !finite(o.height)) return false;
  if (!finite(o.opacity) || !finite(o.fontScale)) return false;
  // textColor is optional: absent/null → legacy default; if present it must be
  // an approved enum value (never arbitrary color input).
  if (o.textColor != null && !isProofTextColor(o.textColor)) return false;
  const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!nonEmptyString(o.authoredAgainstProofVersion)) return false;
  if (!nonEmptyString(o.authoredAgainstFingerprint)) return false;
  if (!nonEmptyString(o.appliedAt)) return false;
  if (!nonEmptyString(o.appliedBy)) return false;
  return true;
}

/** Resolve a color to fixed hex. Absent/null (no explicit choice) === the exact
 *  legacy default (#1F3A5F); the three enum members resolve to their fixed
 *  approved values. There is no path by which absence renders as `dark_brown`. */
export function resolveProofTextColor(color?: ProofTextColor | null): ResolvedTextColor {
  if (!isProofTextColor(color)) return LEGACY_DEFAULT_TEXT_COLOR;
  return PROOF_TEXT_COLORS[color];
}

/** Geometry projection folded into the proof fingerprint — exactly the canonical
 *  geometry the renderer draws. Operational metadata (appliedAt, appliedBy,
 *  authoredAgainst*) is excluded so it cannot invalidate a proof. */
export function proofCardGeometryForFingerprint(override: ProofCardGeometry): ProofCardGeometry {
  return canonicalizeProofCardGeometry(override);
}

/** Byte-affecting color projection folded into the proof fingerprint: the
 *  RESOLVED text+fill hex the renderer draws, so two colors collide only if
 *  their rendered RGB is identical. */
export function proofTextColorForFingerprint(color?: ProofTextColor | null): ResolvedTextColor {
  return resolveProofTextColor(color);
}

// ── Deterministic WCAG contrast (server-authoritative) ───────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function channelLin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
/** WCAG relative luminance of an sRGB hex. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLin(r) + 0.7152 * channelLin(g) + 0.0722 * channelLin(b);
}
/** WCAG contrast ratio between two sRGB hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}
/** Composite an opaque fill at alpha over an opaque backdrop → hex. */
export function compositeOverBackdrop(fillHex: string, alpha: number, backdropHex: string): string {
  const [fr, fg, fb] = hexToRgb(fillHex);
  const [br, bg, bb] = hexToRgb(backdropHex);
  const mix = (f: number, b: number) => f * alpha + b * (1 - alpha);
  return `#${toHex(mix(fr, br))}${toHex(mix(fg, bg))}${toHex(mix(fb, bb))}`;
}

export interface ContrastResult {
  ok: boolean;
  ratio: number;
  threshold: number;
  textHex: string;
  effectiveBackgroundHex: string;
}

/**
 * Server-authoritative, deterministic contrast check. It is NOT artwork-aware:
 * because the renderer cannot know the underlying artwork pixels at save time,
 * it composites the card's own scrim FILL at the card opacity over the
 * conservative worst-case backdrop for the text's polarity (black behind dark
 * text, white behind light text) and measures WCAG contrast of the text against
 * that effective background. This rejects the readability-worst case.
 */
export function evaluateProofTextContrast(color: ProofTextColor | undefined | null, opacity: number): ContrastResult {
  const { text, fill } = resolveProofTextColor(color);
  const textIsDark = relativeLuminance(text) < 0.5;
  const worstBackdrop = textIsDark ? '#000000' : '#FFFFFF';
  const alpha = clamp(Number(opacity), PROOF_CARD_BOUNDS.opacity.min, PROOF_CARD_BOUNDS.opacity.max);
  const effectiveBackgroundHex = compositeOverBackdrop(fill, alpha, worstBackdrop);
  const ratio = contrastRatio(text, effectiveBackgroundHex);
  return {
    ok: ratio >= PROOF_CONTRAST_THRESHOLD,
    ratio: Math.round(ratio * 100) / 100,
    threshold: PROOF_CONTRAST_THRESHOLD,
    textHex: text,
    effectiveBackgroundHex,
  };
}

/**
 * Assemble a persisted override from already-clamped geometry plus binding and
 * audit metadata. Overflow is checked separately by the caller (against the
 * renderer) so this module stays pure and pdfkit-free.
 */
export function assembleProofCardOverride(params: {
  geometry: ProofCardGeometry;
  textColor?: ProofTextColor | null;
  authoredAgainstProofVersion: string;
  authoredAgainstFingerprint: string;
  appliedBy: string;
  appliedAt: string;
}): ProofCardOverride {
  // Canonicalize at the single persistence choke point so every stored override
  // is already at PROOF_CARD_PRECISION — persist == render == fingerprint. Only
  // an EXPLICIT approved color is stored; absence renders the legacy default.
  return {
    ...canonicalizeProofCardGeometry(params.geometry),
    ...(isProofTextColor(params.textColor) ? { textColor: params.textColor } : {}),
    authoredAgainstProofVersion: params.authoredAgainstProofVersion,
    authoredAgainstFingerprint: params.authoredAgainstFingerprint,
    appliedAt: params.appliedAt,
    appliedBy: params.appliedBy,
  };
}
