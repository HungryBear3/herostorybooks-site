/**
 * Browser → Stripe Checkout hand-off.
 *
 * Incident (2026-08-26, ~23:55 CDT): the backend created a durable draft order,
 * bound it to an open Stripe Checkout Session, and returned HTTP 200 — but no
 * payment ever started and no PaymentIntent was bound. Production error logs
 * showed no matching server failure, because the failure was not on the server:
 * the checkout form scheduled its navigation to Stripe inside a 1.2-second
 * `setTimeout`, and everything that could go wrong inside that window produced
 * exactly this signature (order + session created, no payment, no error).
 *
 * This module owns the hand-off so it can be reasoned about and tested without
 * a DOM. Two rules it exists to enforce:
 *
 *  1. NOTHING runs between a validated Stripe URL and the navigation — no
 *     timer, animation, toast, analytics call, awaited promise, or storage
 *     write. Cleanup happens strictly AFTER `navigate` has been called, and a
 *     cleanup failure can never undo or prevent the hand-off.
 *  2. The redirect target is validated FAIL-CLOSED. An unexpected target is a
 *     failed hand-off, never something to navigate to.
 */

/**
 * Stripe Checkout hosts this application accepts as a hand-off target.
 *
 * Deliberately an exact-host allowlist, not a suffix match: `endsWith(...)`
 * would also accept `checkout.stripe.com.example.invalid`. This is the same
 * single host the app already special-cases elsewhere for Stripe return
 * traffic (see src/app/layout.tsx and src/lib/analytics.ts). HSB does not use
 * a Stripe custom checkout domain; if one is ever configured, it must be added
 * here explicitly.
 */
export const ALLOWED_STRIPE_CHECKOUT_HOSTS: readonly string[] = ['checkout.stripe.com'];

/**
 * True only for an absolute HTTPS URL on an allowlisted Stripe Checkout host.
 *
 * Rejects, among others: non-strings, empty/whitespace values, relative paths,
 * `javascript:` / `data:` / `blob:` URLs, plain HTTP, credential-embedding
 * URLs (`https://checkout.stripe.com@attacker.example`, whose real host is the
 * attacker), and lookalike hosts (`checkout.stripe.com.attacker.example`,
 * `notcheckout.stripe.com`).
 */
export function isAllowedStripeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;

  let parsed: URL;
  try {
    // No base argument: a relative value throws instead of resolving against
    // the current origin, so a same-origin open-redirect cannot slip through.
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return ALLOWED_STRIPE_CHECKOUT_HOSTS.includes(parsed.hostname.toLowerCase());
}

export type StripeHandoffFailureReason = 'invalid_url' | 'navigation_failed';

/**
 * Flat result object rather than a discriminated union: this project compiles
 * with `strict: false`, where TypeScript will not narrow a union by a boolean
 * literal discriminant, so a caller could not read `reason` off a narrowed
 * value.
 */
export interface StripeHandoffResult {
  /** True when a same-tab navigation to `url` was started. */
  ok: boolean;
  /**
   * The validated Stripe Checkout URL, or null when the response carried no
   * acceptable one. Safe to offer to the customer as a manual link whenever it
   * is non-null: following it resumes the SAME Stripe Checkout Session.
   */
  url: string | null;
  /** Why the hand-off failed. Null when `ok` is true. */
  reason: StripeHandoffFailureReason | null;
}

export interface StripeHandoffDeps {
  /** Same-tab hard navigation. Called at most once, and before any cleanup. */
  navigate: (url: string) => void;
  /** Best-effort: drop the saved checkout draft. May throw; ignored. */
  clearSavedDraft?: () => void;
  /**
   * Best-effort: drop the checkout attempt id. May throw; ignored.
   * Only called when navigation was accepted — if the hand-off failed, the
   * attempt id must survive so a retry resumes the SAME order and Stripe
   * Session (src/app/api/order/route.ts returns the existing open session for
   * a repeated checkoutAttemptId) instead of creating a second one.
   */
  clearAttemptId?: () => void;
}

/**
 * Hand off to Stripe immediately, then clean up.
 *
 * Returns without navigating when the URL is not an allowlisted Stripe
 * Checkout URL. Callers must treat `ok: false` as a failed submission and keep
 * their existing "you have not been charged" recovery behaviour.
 */
export function performStripeHandoff(
  redirectTo: unknown,
  deps: StripeHandoffDeps,
): StripeHandoffResult {
  if (!isAllowedStripeCheckoutUrl(redirectTo)) {
    return { ok: false, reason: 'invalid_url', url: null };
  }
  const url = redirectTo.trim();

  try {
    deps.navigate(url);
  } catch {
    // The browser refused the navigation. Leave the attempt id in place and
    // let the caller offer the already-created URL as a manual link.
    return { ok: false, reason: 'navigation_failed', url };
  }

  // Everything below is post-hand-off housekeeping. Each call is isolated so a
  // throwing storage implementation (Safari private mode, storage disabled,
  // quota) cannot turn a successful hand-off into a failure — the exact shape
  // of the original bug, where an unguarded localStorage.removeItem sat
  // between the success state and the navigation timer.
  try {
    deps.clearSavedDraft?.();
  } catch {
    /* storage unavailable — the hand-off already started */
  }
  try {
    deps.clearAttemptId?.();
  } catch {
    /* storage unavailable — the hand-off already started */
  }

  return { ok: true, url, reason: null };
}

export interface SubmitLock {
  /** True exactly once until `release()`. */
  acquire: () => boolean;
  release: () => void;
  readonly held: boolean;
}

/**
 * One-shot guard around checkout submission.
 *
 * A ref-backed lock rather than the `isSubmitting` React state: state updates
 * are batched, so two clicks landing in the same batch (a fast double-tap, a
 * touch+click pair on mobile) both read the pre-update value and both start an
 * order. It is also immune to stale closures and to re-render/StrictMode
 * re-entry. Released only when a submit fails, so a successful hand-off can
 * never be started twice.
 */
export function createSubmitLock(): SubmitLock {
  let held = false;
  return {
    acquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
    get held() {
      return held;
    },
  };
}
