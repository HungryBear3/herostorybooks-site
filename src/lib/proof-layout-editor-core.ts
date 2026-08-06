/**
 * Framework-free interaction + wiring core shared by the admin and customer
 * proof-layout editors, so geometry / keyboard / eligibility / request-shaping
 * behaviour does NOT fork between surfaces. Pure and React-free (node-testable);
 * only imports the pure Slice 1 geometry/palette primitives + types.
 *
 * The two surfaces differ ONLY in their transport (endpoint URL + auth) and
 * copy, which live in their respective adapters — never here.
 */
import type { ProofCardGeometry } from './proof-layout-override.ts';
import { canonicalizeProofCardGeometry } from './proof-layout-override.ts';
import type { ProofCardOverride, ProofTextColor } from './fulfillment-types.ts';
import type { ReviewSnapshot } from './page-review.ts';

/** Legacy default (no explicit color) plus the three approved enum colors. */
export type LayoutColorChoice = 'legacy_default' | ProofTextColor;

/** Keyboard nudge steps (page-relative fractions): 1% normal, 5% with Shift. */
export const KEY_STEP = 0.01;
export const KEY_STEP_LARGE = 0.05;

/** The Release-1 bottom-band geometry, used as the starting card when a page
 *  has no override yet. Canonicalized so it is already a fixed point. */
export function defaultCardGeometry(): ProofCardGeometry {
  return canonicalizeProofCardGeometry({
    x: 42 / 595.28,
    y: 650 / 841.89,
    width: (595.28 - 84) / 595.28,
    height: 156 / 841.89,
    opacity: 0.9,
    fontScale: 1,
  });
}

/** Initial editor geometry: the page's persisted override, else the default. */
export function geometryFromOverride(override: ProofCardOverride | null | undefined): ProofCardGeometry {
  return override ? canonicalizeProofCardGeometry(override) : defaultCardGeometry();
}

/** Initial color choice from the persisted override (absent = legacy default). */
export function colorChoiceFromOverride(override: ProofCardOverride | null | undefined): LayoutColorChoice {
  return override?.textColor ?? 'legacy_default';
}

// ── Pointer interaction (normalized page-fraction deltas) ────────────────────

/** Move the card by a normalized delta from a drag-start geometry. */
export function applyPointerMove(startGeo: ProofCardGeometry, dxNorm: number, dyNorm: number): ProofCardGeometry {
  return canonicalizeProofCardGeometry({ ...startGeo, x: startGeo.x + dxNorm, y: startGeo.y + dyNorm });
}

/** Resize the card by a normalized delta from a drag-start geometry. */
export function applyPointerResize(startGeo: ProofCardGeometry, dwNorm: number, dhNorm: number): ProofCardGeometry {
  return canonicalizeProofCardGeometry({ ...startGeo, width: startGeo.width + dwNorm, height: startGeo.height + dhNorm });
}

// ── Keyboard interaction ─────────────────────────────────────────────────────

export interface KeyboardModifiers {
  shift?: boolean;
  alt?: boolean;
}

/**
 * Apply an arrow-key nudge. `Alt` switches from move to resize; `Shift` uses the
 * larger step. Returns the new canonical geometry, or `null` for a key the
 * editor does not handle (so the caller does not preventDefault it).
 */
export function applyKeyboardGeometry(
  geo: ProofCardGeometry,
  key: string,
  mods: KeyboardModifiers = {},
): ProofCardGeometry | null {
  const step = mods.shift ? KEY_STEP_LARGE : KEY_STEP;
  const resize = Boolean(mods.alt);
  let patch: Partial<ProofCardGeometry>;
  switch (key) {
    case 'ArrowLeft': patch = resize ? { width: geo.width - step } : { x: geo.x - step }; break;
    case 'ArrowRight': patch = resize ? { width: geo.width + step } : { x: geo.x + step }; break;
    case 'ArrowUp': patch = resize ? { height: geo.height - step } : { y: geo.y - step }; break;
    case 'ArrowDown': patch = resize ? { height: geo.height + step } : { y: geo.y + step }; break;
    default: return null;
  }
  return canonicalizeProofCardGeometry({ ...geo, ...patch });
}

/** True for the arrow keys the editor consumes (so the caller preventDefaults). */
export function isEditorArrowKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

// ── Eligibility + binding (drives whether editing is offered) ────────────────

/** The current proof revision + fingerprint binding, or null when a fresh proof
 *  identity is not available. Both are echoed back on every apply/reset. */
export function layoutBinding(
  snapshot: Pick<ReviewSnapshot, 'proofVersion' | 'proofSourceFingerprint'>,
): { authoredAgainstProofVersion: string; authoredAgainstFingerprint: string } | null {
  if (!snapshot.proofVersion || !snapshot.proofSourceFingerprint) return null;
  return {
    authoredAgainstProofVersion: snapshot.proofVersion,
    authoredAgainstFingerprint: snapshot.proofSourceFingerprint,
  };
}

/**
 * Offer layout editing only when a FRESH proof identity binding exists and the
 * review lifecycle is still open at the UI level (an approved book is frozen).
 * The server re-enforces the full lifecycle/CAS gate on every write; this is the
 * honest client-side "offer it or explain why not" decision.
 */
export function canOfferCustomerLayoutEditing(
  snapshot: Pick<ReviewSnapshot, 'proofFresh' | 'proofVersion' | 'proofSourceFingerprint' | 'reviewStatus'>,
): boolean {
  if (snapshot.reviewStatus === 'approved') return false;
  if (!snapshot.proofFresh) return false;
  return layoutBinding(snapshot) !== null;
}

// ── Request shaping (endpoint URLs + bodies) ─────────────────────────────────

/** The tokenized CUSTOMER endpoint. The token stays in the capability query,
 *  NEVER in the body. Never the admin route. */
export function customerProofLayoutUrl(orderId: string, token: string | null | undefined): string {
  return `/api/order/${encodeURIComponent(orderId)}/proof-layout?token=${encodeURIComponent(token ?? '')}`;
}
export function customerRequestHelpUrl(orderId: string, token: string | null | undefined): string {
  return `/api/order/${encodeURIComponent(orderId)}/request-help?token=${encodeURIComponent(token ?? '')}`;
}

type LayoutBinding = { authoredAgainstProofVersion: string; authoredAgainstFingerprint: string };

/** Apply-body: exact page index, canonical geometry, optional approved color
 *  (omitted for legacy default), and the current revision+fingerprint binding.
 *  Never `appliedBy` (server fixes it to 'customer'); never the token. */
export function buildLayoutApplyBody(
  pageIndex: number,
  geometry: ProofCardGeometry,
  color: LayoutColorChoice,
  binding: LayoutBinding,
): Record<string, unknown> {
  return {
    pageIndex,
    geometry: canonicalizeProofCardGeometry(geometry),
    ...(color === 'legacy_default' ? {} : { textColor: color }),
    ...binding,
  };
}

/** Reset-body: `geometry: null` with the SAME current binding. */
export function buildLayoutResetBody(pageIndex: number, binding: LayoutBinding): Record<string, unknown> {
  return { pageIndex, geometry: null, ...binding };
}

// ── Remount identity (so unsaved state never leaks across pages/revisions) ──

/** A stable key that changes whenever the authoritative binding, page, or
 *  persisted override changes — used to remount/reset local editor state. */
export function editorIdentityKey(
  orderId: string,
  pageIndex: number,
  snapshot: Pick<ReviewSnapshot, 'proofVersion' | 'proofSourceFingerprint' | 'proofFresh'>,
  override: ProofCardOverride | null | undefined,
): string {
  return JSON.stringify([
    orderId,
    pageIndex,
    snapshot.proofVersion,
    snapshot.proofSourceFingerprint,
    snapshot.proofFresh,
    override
      ? {
          x: override.x, y: override.y, width: override.width, height: override.height,
          opacity: override.opacity, fontScale: override.fontScale,
          textColor: override.textColor ?? null,
          authoredAgainstProofVersion: override.authoredAgainstProofVersion,
          authoredAgainstFingerprint: override.authoredAgainstFingerprint,
          appliedAt: override.appliedAt, appliedBy: override.appliedBy,
        }
      : null,
  ]);
}

// ── Honest, jargon-free error copy for the customer ──────────────────────────

/** Map a server error code / HTTP status to visible, specific, honest customer
 *  copy. Never a generic success on failure; failures always fail closed. */
export function customerLayoutErrorMessage(error: string | undefined, status: number): string {
  switch (error) {
    case 'text_overflow':
      return 'That text is too large to fit the card here. Make the card bigger or reduce the font size.';
    case 'insufficient_contrast':
      return 'That text colour is hard to read at this panel opacity. Pick another colour or increase the panel.';
    case 'invalid_text_color':
      return 'That text colour isn’t available. Please choose one of the offered colours.';
    case 'no_live_proof':
    case 'proof_stale':
    case 'binding_required':
    case 'stale_revision':
    case 'stale_fingerprint':
      return 'This layout was based on an earlier proof. Reload the page to get the current proof, then try again.';
    case 'order_approved':
    case 'order_shipped':
    case 'order_in_production':
    case 'print_submitted':
    case 'order_finalized':
      return 'This book is finalised, so its page layout can no longer be changed.';
    case 'invalid_or_missing_token':
    case 'order_not_eligible':
    case 'order_refunded':
      return 'We couldn’t verify your review link. Please reopen it from your email.';
    case 'page_not_found':
    case 'order_not_found':
      return 'We couldn’t find that page to update. Reload and try again.';
    default:
      return status === 0
        ? 'We couldn’t reach the server. Check your connection and try again.'
        : 'Something went wrong saving your layout. Please try again.';
  }
}
