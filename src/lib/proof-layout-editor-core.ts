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
 * Offer layout editing ONLY when the server-derived capability says so. This is
 * fail-closed: any missing/malformed capability data (older snapshot, partial
 * payload, wrong type) yields false. The server re-enforces the full
 * lifecycle/CAS gate on every write; this only decides whether to render the
 * control. The authoritative reasons (approved / lifecycle-closed / proof not
 * ready) live server-side so the client never duplicates the state machine.
 */
export function canOfferCustomerLayoutEditing(
  snapshot: Pick<ReviewSnapshot, 'proofLayoutEditing'> | null | undefined,
): boolean {
  const cap = snapshot?.proofLayoutEditing as { allowed?: unknown } | undefined;
  return cap != null && cap.allowed === true;
}

/** The honest, non-jargon explanation shown when editing is unavailable. Any
 *  unknown/malformed reason falls through to the safe generic message. */
export function customerLayoutUnavailableMessage(
  snapshot: Pick<ReviewSnapshot, 'proofLayoutEditing'> | null | undefined,
): string | null {
  const cap = snapshot?.proofLayoutEditing as { allowed?: unknown; reason?: unknown } | undefined;
  if (cap && cap.allowed === true) return null;
  switch (cap?.reason) {
    case 'proof_not_ready':
      return 'An updated proof is being prepared — you’ll be able to adjust this page’s text placement once it’s ready.';
    case 'review_approved':
      return null; // Approved books are frozen; no editing prompt is shown.
    case 'lifecycle_closed':
      return 'This book has moved into production, so text placement can no longer be changed here. Reply to your order email if something looks off.';
    case 'order_refunded':
      return 'This order was refunded, so its pages can no longer be edited here. Reply to your order email if you have questions.';
    case 'payment_incomplete':
      return 'This order isn’t active yet, so text placement can’t be changed. Check your order email for next steps.';
    default:
      // Unknown/malformed reason: fail closed and NEVER invent a production state.
      return null;
  }
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

// ── Response-contract interpretation (B4/B7) ─────────────────────────────────
//
// Parse the FULL contract (ok, noop, snapshot, error) so the UI never fakes a
// success on a malformed 200 and never claims a proof rebuild for a no-op.

/** Error codes whose only honest remedy is to reload the current proof (not to
 *  keep retrying the same stale request). */
const RELOAD_ERROR_CODES = new Set([
  'no_live_proof', 'proof_stale', 'binding_required', 'stale_revision', 'stale_fingerprint',
]);

export type LayoutMutationOp = 'save' | 'reset' | 'help';

/** Flat outcome shape (no discriminated union — narrowing on `!ok` is unreliable
 *  under this repo's non-strict TS). When `ok`, `snapshot` is present and
 *  `message` is null; when not, `message` is set and `snapshot` is null. */
export interface LayoutMutationOutcome {
  ok: boolean;
  /** True when the server made no change (equivalent geometry / already recorded). */
  noop: boolean;
  snapshot: ReviewSnapshot | null;
  message: string | null;
  /** True → instruct the customer to reload; false → a retry may help. */
  reload: boolean;
}

function isStringOrNull(v: unknown): boolean {
  return v === null || typeof v === 'string';
}

/** A page artifact carries at least a numeric index and string story text. */
function isValidPageArtifactLike(p: unknown): boolean {
  return !!p
    && typeof p === 'object'
    && typeof (p as { pageIndex?: unknown }).pageIndex === 'number'
    && typeof (p as { storyText?: unknown }).storyText === 'string';
}

/**
 * Strict validation of a render-critical ReviewSnapshot bound to the EXPECTED
 * order. Every field the review UI renders must have the right shape; a partial
 * or cross-order snapshot is rejected. No coercion — malformed is malformed.
 */
function isValidReviewSnapshot(value: unknown, expectedOrderId: string): value is ReviewSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  // Order binding: the response must be for the order we are editing.
  if (typeof s.orderId !== 'string' || s.orderId !== expectedOrderId) return false;
  if (typeof s.childName !== 'string') return false;
  if (typeof s.reviewStatus !== 'string') return false;
  if (typeof s.bookFormat !== 'string') return false;
  if (!Array.isArray(s.pageArtifacts) || !s.pageArtifacts.every(isValidPageArtifactLike)) return false;
  // Nullable string identity/freshness fields.
  for (const k of ['storyArtifactUrl', 'proofVersion', 'proofSourceFingerprint', 'proofReviewedVersion', 'proofReviewedAt']) {
    if (!isStringOrNull(s[k])) return false;
  }
  // Render-critical booleans.
  for (const k of ['proofAvailable', 'proofFresh', 'isPrint']) {
    if (typeof s[k] !== 'boolean') return false;
  }
  // The capability the UI gates on.
  const cap = s.proofLayoutEditing as { allowed?: unknown; reason?: unknown } | undefined;
  if (!cap || typeof cap.allowed !== 'boolean' || typeof cap.reason !== 'string') return false;
  return true;
}

const AMBIGUOUS_SUCCESS_MESSAGE =
  'We couldn’t confirm the change — the server didn’t return the updated proof state. Please reload and try again.';

/**
 * Interpret a proof-layout / request-help response against the EXPECTED order.
 * A success requires: HTTP ok, `ok === true`, an EXACT boolean `noop`, and a
 * fully-validated render-critical snapshot whose orderId matches. Anything
 * else — malformed/partial/cross-order snapshot, missing/non-boolean noop,
 * ok!==true — is a failure that keeps the editor open (never a fake success).
 * Stale-proof errors are flagged reload. Nothing is coerced or defaulted.
 */
export function interpretLayoutMutationResponse(
  httpOk: boolean,
  status: number,
  body: unknown,
  expectedOrderId: string,
): LayoutMutationOutcome {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const ok = b?.ok === true;
  const error = typeof b?.error === 'string' ? (b.error as string) : undefined;
  if (httpOk && ok) {
    const noopIsBoolean = typeof b?.noop === 'boolean';
    if (noopIsBoolean && isValidReviewSnapshot(b?.snapshot, expectedOrderId)) {
      return { ok: true, noop: b!.noop as boolean, snapshot: b!.snapshot as ReviewSnapshot, message: null, reload: false };
    }
    // ok but ambiguous/malformed success — never synthesize proof state.
    return { ok: false, noop: false, snapshot: null, reload: true, message: AMBIGUOUS_SUCCESS_MESSAGE };
  }
  return {
    ok: false,
    noop: false,
    snapshot: null,
    reload: error != null && RELOAD_ERROR_CODES.has(error),
    message: customerLayoutErrorMessage(error, status),
  };
}

/**
 * Honest, durable notice copy for a completed mutation. A no-op NEVER claims a
 * proof rebuild; a real Save/Reset does; request-help is audit-only and always
 * states no email was sent.
 */
export function layoutMutationNotice(op: LayoutMutationOp, noop: boolean): string {
  switch (op) {
    case 'save':
      return noop
        ? 'No changes to save — this page already uses that text placement.'
        : 'Layout saved. We’ll prepare an updated proof for you to review before final approval.';
    case 'reset':
      return noop
        ? 'This page already uses the standard placement — there was nothing to reset.'
        : 'Layout reset to the standard placement. We’ll prepare an updated proof for you to review.';
    case 'help':
      return noop
        ? 'You’ve already asked us to help with this page’s layout — it’s on our list. No email has been sent.'
        : 'Thanks — we’ve noted that you’d like help with this page’s layout. Our team will take a look; no email has been sent yet.';
  }
}

// ── Accessible geometry announcement (B5) ────────────────────────────────────

/** A concise, screen-reader-friendly description of the card's position/size —
 *  announced on keyboard move/resize so a non-sighted user knows the result. */
export function describeCardGeometry(geo: ProofCardGeometry): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return `Text card at ${pct(geo.x)} from left, ${pct(geo.y)} from top, ${pct(geo.width)} wide, ${pct(geo.height)} tall.`;
}

// ── Single customer-mutation coordinator (B6) ────────────────────────────────
//
// One lock shared by EVERY customer review mutation (layout save/reset/help,
// regenerate, accept, wording, acknowledgment, approval): at most one is active,
// and a token issued for an older mutation can never apply its snapshot once a
// newer mutation has begun. Pure + framework-free so the ordering guarantee is
// unit-tested; the React surface wraps it and mirrors isBusy() into every
// control's disabled state.

export interface ReviewMutationCoordinator {
  /** True while a mutation holds the lock. */
  isBusy(): boolean;
  /** The op currently holding the lock, or null. */
  activeOp(): string | null;
  /** Acquire the lock for `op`; returns a token, or null if one is already held. */
  begin(op: string): number | null;
  /** True only if `token` is the newest issued AND still the active owner — i.e.
   *  its response is safe to apply. A superseded/settled token returns false. */
  isCurrent(token: number): boolean;
  /** Release the lock IFF `token` is the current owner (owner-aware cleanup). */
  settle(token: number): void;
}

export function createReviewMutationCoordinator(): ReviewMutationCoordinator {
  let activeGen = 0; // 0 = idle
  let lastGen = 0; // highest token ever issued
  let op: string | null = null;
  return {
    isBusy: () => activeGen !== 0,
    activeOp: () => op,
    begin(nextOp: string): number | null {
      if (activeGen !== 0) return null; // single active mutation
      lastGen += 1;
      activeGen = lastGen;
      op = nextOp;
      return activeGen;
    },
    isCurrent(token: number): boolean {
      return token === activeGen && token === lastGen;
    },
    settle(token: number): void {
      if (token === activeGen) {
        activeGen = 0;
        op = null;
      }
    },
  };
}
