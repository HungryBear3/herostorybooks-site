/**
 * The bounded analytics context that travels with one checkout.
 *
 * Browser → checkout API → Stripe Session metadata, and nothing more: the
 * validated attribution state plus the property-specific GA session. The
 * pre-existing `gaClientId` field keeps its own place in the request.
 *
 * Every hop re-validates with the shared contracts, so a field that is
 * ambiguous (sent twice), malformed, or unpaired is dropped rather than
 * repaired, and none of these fields may ever change a checkout's identity —
 * `checkoutRequestFingerprint` excludes them (see CHECKOUT_ANALYTICS_FORM_FIELDS).
 *
 * Isomorphic: the checkout form and the order route share it.
 */
import {
  ATTRIBUTION_ACCEPT_MAX_AGE_MS,
  ATTRIBUTION_STORAGE_KEY,
  ATTRIBUTION_WINDOW_MS,
  attributionToStripeMetadata,
  parseAttributionState,
  serializeAttributionState,
  type AttributionState,
  type AttributionStorage,
} from './attribution-contract.ts';
import {
  readGaCookieIdentity,
  sanitizeGaSessionId,
  sanitizeGaSessionNumber,
} from './ga-cookie-identity.ts';

/** Analytics-only form fields. They describe the visit, not the purchased book. */
export const CHECKOUT_ANALYTICS_FORM_FIELDS = ['attribution', 'gaSessionId', 'gaSessionNumber'] as const;

export interface CheckoutRequestAnalytics {
  gaSessionId: string | null;
  gaSessionNumber: string | null;
}

const NO_SESSION: CheckoutRequestAnalytics = Object.freeze({ gaSessionId: null, gaSessionNumber: null });

function pairedSession(sessionId: unknown, sessionNumber: unknown): CheckoutRequestAnalytics {
  const id = sanitizeGaSessionId(sessionId);
  const number = sanitizeGaSessionNumber(sessionNumber);
  return id && number ? { gaSessionId: id, gaSessionNumber: number } : { ...NO_SESSION };
}

// ── Browser ─────────────────────────────────────────────────────────────────

/** The fields the checkout form attaches, from validated storage and fail-closed cookies. */
export function checkoutAnalyticsFormFields(input: {
  storage: Pick<AttributionStorage, 'getItem'> | null | undefined;
  cookie: unknown;
  now: number;
}): Record<string, string> {
  const fields: Record<string, string> = {};
  const ga = readGaCookieIdentity(input.cookie);
  if (ga.clientId) {
    fields.gaClientId = ga.clientId;
    if (ga.sessionId && ga.sessionNumber) {
      fields.gaSessionId = ga.sessionId;
      fields.gaSessionNumber = ga.sessionNumber;
    }
  }
  let stored: string | null = null;
  try {
    stored = input.storage?.getItem(ATTRIBUTION_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  const state = parseAttributionState(stored, { now: input.now, maxAgeMs: ATTRIBUTION_WINDOW_MS });
  if (state) fields.attribution = serializeAttributionState(state);
  return fields;
}

/** The browser adapter: this document's localStorage and cookies, never throwing. */
export function browserCheckoutAnalyticsFormFields(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  let storage: Pick<AttributionStorage, 'getItem'> | null = null;
  let cookie: string | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  try {
    cookie = typeof document === 'undefined' ? undefined : document.cookie;
  } catch {
    cookie = undefined;
  }
  return checkoutAnalyticsFormFields({ storage, cookie, now: Date.now() });
}

// ── Checkout API ────────────────────────────────────────────────────────────

interface AnalyticsFormLike {
  getAll(name: string): unknown[];
}

function singleText(form: AnalyticsFormLike, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
}

/**
 * Re-validate the browser's analytics fields. A GA session is kept only
 * alongside the request's validated client id — a session means nothing
 * without the client it belongs to.
 */
export function parseCheckoutAnalyticsForm(
  form: AnalyticsFormLike,
  opts: { now: number; gaClientId: string | null },
): { attribution: AttributionState | null; analytics: CheckoutRequestAnalytics } {
  const attribution = parseAttributionState(singleText(form, 'attribution'), {
    now: opts.now,
    maxAgeMs: ATTRIBUTION_ACCEPT_MAX_AGE_MS,
  });
  const analytics = opts.gaClientId
    ? pairedSession(singleText(form, 'gaSessionId'), singleText(form, 'gaSessionNumber'))
    : { ...NO_SESSION };
  return { attribution, analytics };
}

/** The bounded Stripe Session metadata for this checkout's analytics context. */
export function checkoutAnalyticsStripeMetadata(input: {
  attribution: AttributionState | null | undefined;
  analytics: CheckoutRequestAnalytics | null | undefined;
}): Record<string, string> {
  const metadata = attributionToStripeMetadata(input.attribution);
  const session = pairedSession(input.analytics?.gaSessionId, input.analytics?.gaSessionNumber);
  if (session.gaSessionId && session.gaSessionNumber) {
    metadata.gaSessionId = session.gaSessionId;
    metadata.gaSessionNumber = session.gaSessionNumber;
  }
  return metadata;
}
