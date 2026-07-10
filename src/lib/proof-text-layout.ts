// Pure validation/clamping helpers for the constrained proof text layout editor.
//
// This module owns the single source of truth for the SAFE placement bounds and
// the size-preset vocabulary. It is intentionally free of React, blob, and PDF
// dependencies so it can be unit-tested directly and imported from both the
// server (review route / page-review service) and the PDF renderer.
//
// Design contract: a layout patch coming off the wire is UNTRUSTED. Every field
// is validated against a fixed vocabulary or clamped into a safe range; an
// out-of-range or garbage value is coerced to the nearest legal value (never
// rejected with a throw, never allowed to push copy off the printable page).

import type {
  PageTextLayout,
  PageTextPosition,
  TextColorMode,
  TextPanelStyle,
  TextSizePreset,
  TextZone,
} from './fulfillment-types.ts';

/** Inclusive percentage bounds for a text block, expressed as % of the page.
 *  Chosen to keep the block inside the printable margin on every edge for both
 *  proof (portrait) and print (square) geometries. */
export const TEXT_POSITION_BOUNDS = {
  // xPct.max + widthPct.min must stay <= MAX_RIGHT_EDGE_PCT so a min-width block
  // pinned to the far right never spills past the safe margin.
  xPct: { min: 3, max: 70 },
  yPct: { min: 4, max: 90 },
  widthPct: { min: 25, max: 94 },
} as const;

/** Right-edge safety margin: xPct + widthPct may never exceed this, so a wide
 *  block dragged to the right can't spill off the page. */
export const MAX_RIGHT_EDGE_PCT = 97;

export const VALID_COLOR_MODES: readonly TextColorMode[] = ['light', 'dark', 'auto'];
export const VALID_SIZE_PRESETS: readonly TextSizePreset[] = ['small', 'medium', 'large'];
export const VALID_PANEL_STYLES: readonly TextPanelStyle[] = [
  'none',
  'translucent_cream',
  'translucent_dark',
  'soft_scrim',
];
export const VALID_ZONES: readonly TextZone[] = [
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
  'bottom_band',
  'top_band',
  'natural',
];

export const DEFAULT_SIZE_PRESET: TextSizePreset = 'medium';

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Round to 2 decimals so persisted layouts stay compact and deterministic. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Clamp a raw position into the safe printable zone. Returns null when the input
 * doesn't carry usable x/y numbers (caller treats that as "no override").
 */
export function clampTextPosition(input: unknown): PageTextPosition | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const xRaw = Number(raw.xPct);
  const yRaw = Number(raw.yPct);
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;

  const xPct = clamp(xRaw, TEXT_POSITION_BOUNDS.xPct.min, TEXT_POSITION_BOUNDS.xPct.max);
  const yPct = clamp(yRaw, TEXT_POSITION_BOUNDS.yPct.min, TEXT_POSITION_BOUNDS.yPct.max);

  const position: PageTextPosition = { xPct: round2(xPct), yPct: round2(yPct) };

  if (raw.widthPct !== undefined && raw.widthPct !== null) {
    let widthPct = clamp(
      Number(raw.widthPct),
      TEXT_POSITION_BOUNDS.widthPct.min,
      TEXT_POSITION_BOUNDS.widthPct.max,
    );
    // Never let the block's right edge spill past the safe margin.
    widthPct = Math.min(widthPct, MAX_RIGHT_EDGE_PCT - xPct);
    if (widthPct < TEXT_POSITION_BOUNDS.widthPct.min) {
      widthPct = TEXT_POSITION_BOUNDS.widthPct.min;
    }
    position.widthPct = round2(widthPct);
  }

  return position;
}

function asColorMode(value: unknown, fallback: TextColorMode): TextColorMode {
  return VALID_COLOR_MODES.includes(value as TextColorMode) ? (value as TextColorMode) : fallback;
}

function asSizePreset(value: unknown): TextSizePreset | undefined {
  return VALID_SIZE_PRESETS.includes(value as TextSizePreset)
    ? (value as TextSizePreset)
    : undefined;
}

function asPanelStyle(value: unknown, fallback: TextPanelStyle): TextPanelStyle {
  return VALID_PANEL_STYLES.includes(value as TextPanelStyle)
    ? (value as TextPanelStyle)
    : fallback;
}

function asZone(value: unknown, fallback: TextZone): TextZone {
  return VALID_ZONES.includes(value as TextZone) ? (value as TextZone) : fallback;
}

/**
 * Build a fully-formed, validated PageTextLayout from an untrusted patch layered
 * over an optional existing layout. This is the server-side gate the review
 * route must run before persisting anything onto a PageArtifact.
 *
 * Rules:
 * - `colorMode` / `sizePreset` are validated against their fixed vocabularies.
 * - `position` is clamped into the safe printable zone; an explicit `null`
 *   clears any prior override (the editor's "reset" path), while `undefined`
 *   preserves the base position.
 * - `zone` / `panelStyle` are NOT exposed in the editor UI; they are preserved
 *   from the base (or sane defaults) so legibility treatment never regresses.
 */
export function sanitizeTextLayoutPatch(
  patch: unknown,
  base?: PageTextLayout | null,
): PageTextLayout {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;

  const layout: PageTextLayout = {
    zone: asZone(p.zone, base?.zone ?? 'natural'),
    colorMode: asColorMode(p.colorMode, base?.colorMode ?? 'auto'),
    panelStyle: asPanelStyle(p.panelStyle, base?.panelStyle ?? 'translucent_cream'),
  };

  // Size preset: patch wins if valid; otherwise keep the base preset if any.
  const presetFromPatch = asSizePreset(p.sizePreset);
  const preset = presetFromPatch ?? base?.sizePreset ?? undefined;
  if (preset) layout.sizePreset = preset;

  // Position: explicit null clears; undefined preserves base; object is clamped.
  if (p.position === null) {
    layout.position = null;
  } else if (p.position !== undefined) {
    layout.position = clampTextPosition(p.position);
  } else if (base?.position) {
    layout.position = clampTextPosition(base.position);
  }

  return layout;
}
