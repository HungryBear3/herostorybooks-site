/**
 * `POST /api/checkout/diagnostics` — the sanitized checkout-failure event sink.
 *
 * WHY IT EXISTS
 * -------------
 * Incident (2026-09-17, iPhone Safari): a buyer's Continue press failed before
 * `/api/order` was ever called. Production carried one `/api/recovery` 200 and
 * nothing else; the authoritative two-hour scans found zero new orders and zero
 * Stripe Checkout Sessions. There was no server-side trace of the failure at
 * all, so the buyer's report could not be matched to anything. This endpoint is
 * the missing trace, and it is the smallest one that does the job.
 *
 * WHAT IT IS NOT
 * --------------
 * It is emphatically NOT a generic logging endpoint. A generic one — "POST a
 * message, we write it out" — is a log amplifier: unbounded attacker-controlled
 * text in our operational logs, at whatever volume the attacker likes. Four
 * controls, all of them primitives this codebase already runs elsewhere, keep
 * it from becoming that:
 *
 *   1. SAME-ORIGIN. `assertBrowserMutationRequest` — the same guard the intake
 *      routes use — so this is reachable from our own checkout page, not from a
 *      cross-site form post.
 *   2. BOUNDED SIZE. The body is capped at a few hundred bytes and the cap is
 *      enforced on the bytes actually read, not on a header a client controls.
 *   3. CLOSED SCHEMA. Exactly four keys, each a closed enum or a fixed-format
 *      opaque reference. There is no string field a caller can fill with prose:
 *      an unknown key, an unknown code, or an unrecognized refusal code is a
 *      400 that logs NOTHING. Validation is fail-closed throughout.
 *   4. BOUNDED VOLUME. The existing checkout request budget, on its own
 *      `diagnostics` scope — deliberately disjoint from `intake`, because
 *      telemetry that can exhaust the upload budget would be a checkout
 *      regression, not an observability win.
 *
 * WHAT IT MAY LOG
 * ---------------
 * One record, under one fixed label: the closed diagnostic code, its phase, the
 * per-occurrence reference the buyer was shown, and the bounded refusal code.
 * The record is REBUILT from validated values rather than forwarded, so no key
 * from the request body can reach the log. No email, child/person name,
 * filename, media metadata, free-form message, URL, cookie, checkout/order/
 * session id, attempt id, user-agent, IP, or stack trace is accepted, stored,
 * or logged.
 *
 * It touches no order, attempt, lease, risk, or payment state — there is no
 * store here to touch it with.
 */
import {
  assertBrowserMutationRequest,
  createMemoryCheckoutGuardStore,
  enforceCheckoutBudget,
  resolveCheckoutGuardStore,
  type CheckoutGuardStore,
} from './checkout-request-guard.ts';
import { IntakeError } from './checkout-intake.ts';
import {
  CHECKOUT_DIAGNOSTIC_CODES,
  CHECKOUT_DIAGNOSTIC_EVENT_KEYS,
  CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE,
  CHECKOUT_DIAGNOSTIC_REFERENCE,
  CHECKOUT_ORDER_REFUSAL_CODES,
  CHECKOUT_ORDER_REFUSAL_OTHER,
  type CheckoutDiagnosticCode,
  type CheckoutDiagnosticEvent,
} from './checkout-submit-diagnostics.ts';

/** The one label every diagnostic record is written under. */
export const CHECKOUT_DIAGNOSTIC_LOG_LABEL = '[checkout-submit-diagnostic]';

/**
 * A real event serializes to ~110 bytes. The cap leaves generous headroom for
 * the longest allowlisted refusal code and nothing like enough for prose.
 */
export const CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES = 512;

/** Disjoint from `intake`: diagnostics can never starve a buyer's upload. */
export const CHECKOUT_DIAGNOSTIC_GUARD_SCOPE = 'diagnostics';

/**
 * Well under the shared default. A browser emits at most one of these per
 * failed submit, so this is already far above any honest traffic level.
 */
export const CHECKOUT_DIAGNOSTIC_REQUESTS_PER_MINUTE = 30;

export interface CheckoutDiagnosticsRouteDeps {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; production resolves the configured guard store. */
  guardStore?: CheckoutGuardStore | null;
  now?: () => number;
  requestLimit?: number;
  log?: (label: string, record: CheckoutDiagnosticEvent) => void;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The per-instance fallback counter.
 *
 * `resolveCheckoutGuardStore` fails closed with 503 when no durable store is
 * configured. That is correct for `intake`, whose budget rations scarce upload
 * capacity: a ration nobody can enforce must refuse. The diagnostics budget
 * rations LOG VOLUME, which is already a per-instance resource — so a
 * process-local counter bounds precisely the thing at risk, and the shared
 * store's "worthless across serverless instances" caveat does not apply.
 *
 * Failing closed here would instead mean this endpoint silently records nothing
 * wherever the durable guard is unconfigured, which is exactly the blind spot
 * the 2026-09-17 incident exposed. The narrower controls — same-origin, the
 * body cap, the closed schema — are unaffected either way.
 */
const processLocalDiagnosticsGuardStore = createMemoryCheckoutGuardStore();

function diagnosticsGuardStore(
  env: NodeJS.ProcessEnv,
  injected: CheckoutGuardStore | null | undefined,
): CheckoutGuardStore {
  if (injected) return injected;
  try {
    return resolveCheckoutGuardStore(env);
  } catch {
    return processLocalDiagnosticsGuardStore;
  }
}

function refuse(code: string, status: number): Response {
  // The body names only our own refusal reason. It never echoes any part of the
  // rejected input, which is the whole point of refusing it.
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel('diagnostic_too_large');
        } catch {
          // Cancellation is cleanup only; the fixed 413 response still wins.
        }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}

function isDiagnosticCode(value: unknown): value is CheckoutDiagnosticCode {
  return typeof value === 'string'
    && (CHECKOUT_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

/**
 * Validate the body into an event, or throw.
 *
 * Fail-closed and exact: every key must be present, no key may be unknown, and
 * the phase must be the canonical phase for the code rather than merely a
 * member of the phase enum. A caller who disagrees with the mapping is a caller
 * we do not understand, and an event we do not understand is not worth a log
 * line.
 */
function readDiagnosticEvent(body: unknown): CheckoutDiagnosticEvent {
  const invalid = () => new IntakeError('diagnostic_invalid', 400);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();

  const keys = Object.keys(body as Record<string, unknown>);
  const allowed = new Set<string>(CHECKOUT_DIAGNOSTIC_EVENT_KEYS);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) throw invalid();

  const raw = body as Record<string, unknown>;
  if (!isDiagnosticCode(raw.code)) throw invalid();
  const code = raw.code;
  if (raw.phase !== CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE[code]) throw invalid();
  if (typeof raw.reference !== 'string' || !CHECKOUT_DIAGNOSTIC_REFERENCE.test(raw.reference)) {
    throw invalid();
  }
  // `null` or an allowlisted code. `other` is the browser's own sanitized
  // stand-in, so it is accepted; anything else means the browser sent something
  // it should have bounded, and we refuse rather than bound it for them.
  const rawServerCode = raw.serverCode;
  let serverCode: string | null;
  if (rawServerCode === null) {
    serverCode = null;
  } else {
    if (typeof rawServerCode !== 'string'
      || (rawServerCode !== CHECKOUT_ORDER_REFUSAL_OTHER
        && !CHECKOUT_ORDER_REFUSAL_CODES.includes(rawServerCode))) {
      throw invalid();
    }
    serverCode = rawServerCode;
  }

  // Rebuilt, not forwarded: the returned object shares no reference with `raw`.
  return { code, phase: CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE[code], reference: raw.reference, serverCode };
}

export async function handleCheckoutDiagnosticsRequest(
  request: Request,
  deps: CheckoutDiagnosticsRouteDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();

  try {
    assertBrowserMutationRequest(request);
  } catch {
    return refuse('origin_forbidden', 403);
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return refuse('content_type_invalid', 415);

  // Checked on the declared length first — cheap — and again on the bytes we
  // actually read, so a lying `content-length` buys nothing.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES) {
    return refuse('diagnostic_too_large', 413);
  }
  const boundedBody = await readBoundedRequestText(request, CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES);
  if (boundedBody.ok === false) {
    return refuse(
      boundedBody.tooLarge ? 'diagnostic_too_large' : 'diagnostic_invalid',
      boundedBody.tooLarge ? 413 : 400,
    );
  }
  const text = boundedBody.text;

  let event: CheckoutDiagnosticEvent;
  try {
    event = readDiagnosticEvent(JSON.parse(text));
  } catch {
    return refuse('diagnostic_invalid', 400);
  }

  // Spent only once the event is known-good, so malformed traffic cannot burn
  // the budget out from under honest reports.
  try {
    await enforceCheckoutBudget({
      scope: CHECKOUT_DIAGNOSTIC_GUARD_SCOPE,
      env,
      store: diagnosticsGuardStore(env, deps.guardStore),
      now,
      requestLimit: deps.requestLimit ?? CHECKOUT_DIAGNOSTIC_REQUESTS_PER_MINUTE,
      cost: { requestCount: 1 },
    });
  } catch (error) {
    const status = error instanceof IntakeError ? error.status : 503;
    return refuse(error instanceof IntakeError ? error.code : 'diagnostic_unavailable', status);
  }

  try {
    (deps.log ?? defaultLog)(CHECKOUT_DIAGNOSTIC_LOG_LABEL, event);
  } catch {
    // Diagnostics are best-effort. A failed sink must not create a second
    // checkout error or expose implementation details in the response.
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}

function defaultLog(label: string, record: CheckoutDiagnosticEvent): void {
  // One line, one label, four closed values. Nothing here is interpolated from
  // a request body, so there is no format string to inject into.
  console.warn(label, JSON.stringify(record));
}
