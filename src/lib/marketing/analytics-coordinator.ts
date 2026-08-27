/**
 * The one place that decides when a sanitized page view is actually delivered.
 *
 * ── THE RACE THIS EXISTS TO CLOSE ────────────────────────────────────────────
 *
 * GA4's scripts are rendered only after consent is granted, and they load
 * asynchronously. The consent grant and the script becoming usable are two
 * different moments. The page-view emitter used to fire on the grant, at which
 * point `window.gtag` frequently did not exist yet — and `analytics.ts` checks
 * `typeof window.gtag === 'function'` before calling it. The result was a
 * grant-time page view that was silently dropped: the visitor consented, and
 * their first page was never counted.
 *
 * No sleep or retry loop fixes that honestly. What fixes it is an explicit
 * readiness signal from the loader (`markGtagReady`, called from the GA4 inline
 * script's own `onReady`) and a coordinator that holds exactly one pending
 * route until that signal arrives.
 *
 * Readiness here means "the emitter can succeed", and only the emitter can see
 * that. So the coordinator always ASKS the emitter, which performs no GA call
 * when GA is absent; `markReady` is the retry trigger, not the permission.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────
 *
 *  - A route requested while consent is not granted is DROPPED, not queued.
 *    Consent is not a delivery delay; it is a refusal.
 *  - A route requested before readiness replaces any previously pending route.
 *    Only the CURRENT route is ever delivered — there is no backlog, because a
 *    page the visitor already left is not a page view worth inventing.
 *  - Readiness delivers the pending route exactly once. Further readiness
 *    signals, React remounts, StrictMode double effects, and repeated consent
 *    notifications are idempotent.
 *  - Withdrawal or decline before readiness CANCELS the pending route.
 *  - The delivered-route latch is written ONLY after the emitter has actually
 *    run. A route is never marked delivered because an unavailable adapter was
 *    called and quietly did nothing.
 *
 * Meta and Vercel are deliberately NOT routed through here. Meta has its own
 * controller, whose gate ordering (config → consent → route latch) is already
 * correct and already emits exactly one PageView per route. Vercel's
 * `<Analytics />` performs its own page view and is mounted only on a grant,
 * and `analytics.ts` excludes `page_view` from its custom-event forwarder.
 * Pulling either through this coordinator would create a second source of the
 * same event, which is the opposite of the point.
 */

import type { ConsentState } from './consent.ts';

export type PageViewOutcome =
  | 'delivered'
  | 'queued_awaiting_ready'
  | 'skipped_no_consent'
  | 'skipped_duplicate_route';

/** Injected so tests drive this without a browser, a clock, or a network. */
export interface CoordinatorDeps {
  /** Performs the actual emission. Must return true only if it really emitted. */
  emit: (route: string) => boolean;
  /** Current consent, read at decision time rather than cached. */
  consent: () => ConsentState;
}

export interface AnalyticsCoordinator {
  requestPageView(route: string): PageViewOutcome;
  markReady(): void;
  /** Consent moved to a non-granted state: drop anything pending. */
  cancelPending(): void;
  readonly debug: {
    ready: boolean;
    pendingRoute: string | null;
    lastDeliveredRoute: string | null;
  };
}

export function createAnalyticsCoordinator(deps: CoordinatorDeps): AnalyticsCoordinator {
  let ready = false;
  let pendingRoute: string | null = null;
  let lastDeliveredRoute: string | null = null;

  function granted(): boolean {
    try {
      return deps.consent() === 'granted';
    } catch {
      return false;
    }
  }

  /**
   * Attempt one delivery. The latch moves only on a truthful `true` from the
   * emitter, so an emitter that found no adapter leaves the route pending
   * rather than marking it done.
   */
  function deliver(route: string): boolean {
    let emitted = false;
    try {
      emitted = deps.emit(route) === true;
    } catch {
      emitted = false;
    }
    if (emitted) {
      lastDeliveredRoute = route;
      pendingRoute = null;
    }
    return emitted;
  }

  return {
    requestPageView(route: string): PageViewOutcome {
      if (!route) return 'skipped_no_consent';
      if (!granted()) {
        // Not a delay — a refusal. Anything pending is abandoned.
        pendingRoute = null;
        return 'skipped_no_consent';
      }
      if (lastDeliveredRoute === route) {
        // Already counted. Absorbs StrictMode, remounts, and repeated consent
        // notifications for the page the visitor is already on.
        pendingRoute = null;
        return 'skipped_duplicate_route';
      }
      // Replace, never append: only the current route is ever delivered.
      pendingRoute = route;
      // The EMITTER is the authority on whether delivery is possible -- it is
      // the only thing that can see whether `window.gtag` is callable. Asking
      // it is safe even before readiness: it performs no GA call when GA is not
      // there, and reports false. A failed attempt leaves the route pending
      // (set above, cleared by `deliver` only on a truthful success), so the
      // readiness signal retries it rather than losing it.
      return deliver(route) ? 'delivered' : 'queued_awaiting_ready';
    },

    markReady(): void {
      ready = true;
      const route = pendingRoute;
      if (!route) return;
      if (!granted()) {
        pendingRoute = null;
        return;
      }
      if (lastDeliveredRoute === route) {
        pendingRoute = null;
        return;
      }
      deliver(route);
    },

    cancelPending(): void {
      pendingRoute = null;
    },

    get debug() {
      return { ready, pendingRoute, lastDeliveredRoute };
    },
  };
}

/* ── Browser singleton ───────────────────────────────────────────────────── */

let browserCoordinator: AnalyticsCoordinator | null = null;
/** Readiness can be signalled before the coordinator is first constructed. */
let readyBeforeCoordinator = false;

/**
 * The coordinator for this tab. Built lazily so importing this module has no
 * side effect on the server.
 */
export function getAnalyticsCoordinator(deps: CoordinatorDeps): AnalyticsCoordinator {
  if (!browserCoordinator) {
    browserCoordinator = createAnalyticsCoordinator(deps);
    if (readyBeforeCoordinator) browserCoordinator.markReady();
  }
  return browserCoordinator;
}

/**
 * Called by the GA4 loader once its inline stub has executed, which is the
 * moment `window.gtag` becomes callable. Safe to call more than once.
 */
export function markGtagReady(): void {
  readyBeforeCoordinator = true;
  browserCoordinator?.markReady();
}

/** Test-only reset. Never called by application code. */
export function __resetAnalyticsCoordinatorForTests(): void {
  browserCoordinator = null;
  readyBeforeCoordinator = false;
}
