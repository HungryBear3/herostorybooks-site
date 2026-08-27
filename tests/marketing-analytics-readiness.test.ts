/**
 * GA4 readiness coordination, and the Preview validation switch.
 *
 * The coordinator is driven directly with injected `emit` and `consent`, so
 * every case here is behavioural and touches no browser, clock, or network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createAnalyticsCoordinator,
  type PageViewOutcome,
} from '../src/lib/marketing/analytics-coordinator.ts';
import {
  PREVIEW_MEASUREMENT_ID_ENV,
  PREVIEW_VALIDATION_FLAG_ENV,
  resolveAnalyticsMode,
} from '../src/lib/marketing/preview-validation.ts';
import type { ConsentState } from '../src/lib/marketing/consent.ts';

const PROD_ID = 'G-68FKEDZEG3';

function harness(initial: ConsentState = 'granted', gtagAvailable = true) {
  const consent = { state: initial };
  const emitted: string[] = [];
  // "Not ready" IS "gtag not yet callable" -- the emitter is the only thing
  // that can see it, so the harness models it the same way.
  const gtag = { available: gtagAvailable };
  const coordinator = createAnalyticsCoordinator({
    emit: (route) => {
      // Mirrors deliverGa4PageView: only a real emission returns true.
      if (!gtag.available) return false;
      emitted.push(route);
      return true;
    },
    consent: () => consent.state,
  });
  return { coordinator, consent, emitted, gtag };
}

/* ── 1. Grant before readiness ──────────────────────────────────────────── */

test('a grant before gtag is ready emits nothing yet, and queues the current route', () => {
  const { coordinator, emitted } = harness('granted', false);
  const outcome: PageViewOutcome = coordinator.requestPageView('/checkout');
  assert.equal(outcome, 'queued_awaiting_ready');
  assert.deepEqual(emitted, [], 'a page view was emitted before gtag existed');
  assert.equal(coordinator.debug.pendingRoute, '/checkout');
  assert.equal(coordinator.debug.lastDeliveredRoute, null, 'the latch moved without an emission');
});

test('readiness delivers the queued route exactly once', () => {
  const { coordinator, emitted, gtag } = harness('granted', false);
  coordinator.requestPageView('/checkout');
  gtag.available = true; // the script finished loading
  coordinator.markReady();
  assert.deepEqual(emitted, ['/checkout']);
  assert.equal(coordinator.debug.pendingRoute, null);
  assert.equal(coordinator.debug.lastDeliveredRoute, '/checkout');
});

test('a route change before readiness delivers ONLY the latest route', () => {
  const { coordinator, emitted, gtag } = harness('granted', false);
  coordinator.requestPageView('/');
  coordinator.requestPageView('/samples');
  coordinator.requestPageView('/checkout');
  gtag.available = true;
  coordinator.markReady();
  assert.deepEqual(emitted, ['/checkout'], 'a backlog of earlier routes was replayed');
});

test('after readiness, a request is delivered immediately', () => {
  const { coordinator, emitted } = harness();
  coordinator.markReady();
  assert.equal(coordinator.requestPageView('/'), 'delivered');
  assert.deepEqual(emitted, ['/']);
});

/* ── 2. Idempotence across every duplicate signal ───────────────────────── */

test('repeated readiness notifications do not duplicate the page view', () => {
  const { coordinator, emitted, gtag } = harness('granted', false);
  coordinator.requestPageView('/checkout');
  gtag.available = true;
  coordinator.markReady();
  coordinator.markReady();
  coordinator.markReady();
  assert.deepEqual(emitted, ['/checkout']);
});

test('remounts and StrictMode double effects do not duplicate the page view', () => {
  const { coordinator, emitted } = harness();
  coordinator.markReady();
  coordinator.requestPageView('/checkout');
  // Same route reported again by a second effect run, then by a remount.
  assert.equal(coordinator.requestPageView('/checkout'), 'skipped_duplicate_route');
  assert.equal(coordinator.requestPageView('/checkout'), 'skipped_duplicate_route');
  assert.deepEqual(emitted, ['/checkout']);
});

test('a repeated consent notification for the current route does not re-emit', () => {
  const { coordinator, consent, emitted } = harness();
  coordinator.markReady();
  coordinator.requestPageView('/');
  // The store notifies again with the same value; the component re-requests.
  consent.state = 'granted';
  coordinator.requestPageView('/');
  assert.deepEqual(emitted, ['/']);
});

test('each genuine navigation still emits exactly one page view', () => {
  const { coordinator, emitted } = harness();
  coordinator.markReady();
  coordinator.requestPageView('/');
  coordinator.requestPageView('/samples');
  coordinator.requestPageView('/samples');
  coordinator.requestPageView('/checkout');
  assert.deepEqual(emitted, ['/', '/samples', '/checkout']);
});

/* ── 3. Consent refusals and cancellation ───────────────────────────────── */

test('an unknown-consent request is dropped, never queued', () => {
  const { coordinator, emitted } = harness('unknown', false);
  assert.equal(coordinator.requestPageView('/checkout'), 'skipped_no_consent');
  assert.equal(coordinator.debug.pendingRoute, null, 'consent is a refusal, not a delay');
  coordinator.markReady();
  assert.deepEqual(emitted, []);
});

test('declining before readiness cancels the pending emission', () => {
  const { coordinator, consent, emitted, gtag } = harness('granted', false);
  coordinator.requestPageView('/checkout');
  assert.equal(coordinator.debug.pendingRoute, '/checkout');

  consent.state = 'denied';
  coordinator.cancelPending();
  gtag.available = true;
  coordinator.markReady();
  assert.deepEqual(emitted, [], 'a cancelled page view was still delivered');
});

test('withdrawal before readiness cancels even without an explicit cancel call', () => {
  const { coordinator, consent, emitted, gtag } = harness('granted', false);
  coordinator.requestPageView('/checkout');
  consent.state = 'unknown'; // withdrawn
  gtag.available = true;
  coordinator.markReady();
  assert.deepEqual(emitted, [], 'readiness delivered a page view after withdrawal');
});

test('withdrawal after a grant stops future events', () => {
  const { coordinator, consent, emitted } = harness();
  coordinator.markReady();
  coordinator.requestPageView('/');
  consent.state = 'unknown';
  assert.equal(coordinator.requestPageView('/samples'), 'skipped_no_consent');
  assert.deepEqual(emitted, ['/']);
});

test('a later re-grant emits exactly one CURRENT-route page view', () => {
  const { coordinator, consent, emitted } = harness();
  coordinator.markReady();
  coordinator.requestPageView('/');

  consent.state = 'denied';
  coordinator.requestPageView('/samples');
  coordinator.requestPageView('/about');
  assert.deepEqual(emitted, ['/'], 'routes browsed while declined were queued');

  consent.state = 'granted';
  coordinator.requestPageView('/checkout');
  assert.deepEqual(emitted, ['/', '/checkout'], 'a backlog was replayed on re-grant');
});

/* ── 4. The latch is only written on a real emission ────────────────────── */

test('an unavailable adapter leaves the route pending, not marked delivered', () => {
  const { coordinator, emitted, gtag } = harness();
  coordinator.markReady();
  gtag.available = false; // gtag vanished / never became callable

  const outcome = coordinator.requestPageView('/checkout');
  assert.equal(outcome, 'queued_awaiting_ready');
  assert.deepEqual(emitted, []);
  assert.equal(coordinator.debug.lastDeliveredRoute, null, 'the latch moved on a failed emission');
  assert.equal(coordinator.debug.pendingRoute, '/checkout');

  // When it becomes available, the still-pending route is delivered once.
  gtag.available = true;
  coordinator.markReady();
  assert.deepEqual(emitted, ['/checkout']);
});

test('an emitter that throws is treated as a failure, not a delivery', () => {
  const consent = { state: 'granted' as ConsentState };
  const coordinator = createAnalyticsCoordinator({
    emit: () => {
      throw new Error('adapter exploded');
    },
    consent: () => consent.state,
  });
  coordinator.markReady();
  assert.equal(coordinator.requestPageView('/'), 'queued_awaiting_ready');
  assert.equal(coordinator.debug.lastDeliveredRoute, null);
});

test('the real emitter reports truthfully on every precondition', () => {
  const src = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');
  const fn = src.slice(
    src.indexOf('export function deliverGa4PageView'),
    src.indexOf('export function trackPageView'),
  );
  assert.match(fn, /if \(typeof window === 'undefined'\) return false;/);
  assert.match(fn, /if \(!optionalAnalyticsAllowed\(\)\) return false;/);
  // GA absent: buffer locally for observability, report FALSE so the route
  // stays pending rather than being marked delivered.
  assert.match(fn, /if \(typeof window\.gtag !== 'function'\) \{[\s\S]*?bufferHsbEvent\('page_view'[\s\S]*?return false;/);
  // GA present: the real emission, reported true.
  assert.match(fn, /track\('page_view', \{ pathname: route \}\);\s*\n\s*return true;/);
});

/* ── 5. Meta and Vercel keep their own single lifecycle ─────────────────── */

test('the coordinator drives GA4 only, so Meta and Vercel cannot be duplicated', () => {
  const coordSrc = readFileSync(
    new URL('../src/lib/marketing/analytics-coordinator.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['metaHandle', 'meta-bridge', 'trackVercelEvent', '@vercel/analytics']) {
    assert.equal(coordSrc.includes(forbidden), false, `the coordinator reaches ${forbidden}`);
  }
  const pageViewSrc = readFileSync(
    new URL('../src/components/analytics-page-view.tsx', import.meta.url),
    'utf8',
  );
  assert.match(pageViewSrc, /deliverGa4PageView/);
  assert.equal(pageViewSrc.includes('metaHandle'), false);
});

test('page_view is still excluded from the Vercel custom-event forwarder', () => {
  const src = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(event !== 'page_view'\) \{/);
});

test('the loader signals readiness from the script that defines gtag', () => {
  const src = readFileSync(
    new URL('../src/components/marketing/browser-analytics.tsx', import.meta.url),
    'utf8',
  );
  assert.match(src, /onReady=\{markGtagReady\}/);
  // On the inline stub, which is what makes window.gtag callable.
  const idx = src.indexOf('id="google-analytics-gtag"');
  assert.ok(idx > 0 && src.indexOf('onReady={markGtagReady}') > idx);
  assert.doesNotMatch(src, /setTimeout|setInterval/, 'no arbitrary sleep may stand in for readiness');
});

/* ── 6. Preview validation switch ───────────────────────────────────────── */

test('production is unchanged and ignores the preview switch entirely', () => {
  for (const flag of ['true', undefined, 'false']) {
    const result = resolveAnalyticsMode({
      vercelEnv: 'production',
      productionMeasurementId: PROD_ID,
      previewFlag: flag,
      previewMeasurementId: 'G-PREVIEW01',
    });
    assert.deepEqual(result, { mode: 'production', measurementId: PROD_ID });
  }
});

test('the switch is inert when absent', () => {
  const result = resolveAnalyticsMode({
    vercelEnv: 'preview',
    productionMeasurementId: PROD_ID,
    previewFlag: undefined,
    previewMeasurementId: 'G-PREVIEW01',
  });
  assert.equal(result.mode, 'disabled');
  assert.equal(result.measurementId, null);
  assert.equal(result.reason, 'preview_flag_absent');
});

test('the switch cannot operate outside Preview', () => {
  for (const env of [undefined, '', 'development', 'local', 'PREVIEW', 'staging']) {
    const result = resolveAnalyticsMode({
      vercelEnv: env,
      productionMeasurementId: PROD_ID,
      previewFlag: 'true',
      previewMeasurementId: 'G-PREVIEW01',
    });
    assert.equal(result.mode, 'disabled', `env=${String(env)} armed preview validation`);
    assert.equal(result.measurementId, null);
  }
});

test('Preview validation cannot use the Production measurement id', () => {
  const result = resolveAnalyticsMode({
    vercelEnv: 'preview',
    productionMeasurementId: PROD_ID,
    previewFlag: 'true',
    previewMeasurementId: PROD_ID,
  });
  assert.equal(result.mode, 'disabled');
  assert.equal(result.reason, 'preview_id_collides_with_production');
});

test('a missing or malformed preview id disables the mode rather than falling back', () => {
  for (const id of [undefined, '', '   ', 'not-an-id', 'UA-12345', 'G-', 'g-lowercase']) {
    const result = resolveAnalyticsMode({
      vercelEnv: 'preview',
      productionMeasurementId: PROD_ID,
      previewFlag: 'true',
      previewMeasurementId: id,
    });
    assert.equal(result.mode, 'disabled', `id=${String(id)} was accepted`);
    assert.notEqual(
      result.measurementId,
      PROD_ID,
      'a bad preview id must never fall back to Production',
    );
  }
});

test('a correctly configured Preview arms the mode with the throwaway id', () => {
  const result = resolveAnalyticsMode({
    vercelEnv: 'preview',
    productionMeasurementId: PROD_ID,
    previewFlag: 'true',
    previewMeasurementId: 'G-PREVIEW01',
  });
  assert.deepEqual(result, { mode: 'preview_validation', measurementId: 'G-PREVIEW01' });
});

test('Preview validation does not relax the consent gate', () => {
  const src = readFileSync(
    new URL('../src/components/marketing/browser-analytics.tsx', import.meta.url),
    'utf8',
  );
  const modeGate = src.indexOf('if (mode === "disabled" || !measurementId) return null;');
  const consentGate = src.indexOf('if (consent !== "granted") return null;');
  assert.ok(modeGate > 0 && consentGate > modeGate, 'consent must still be checked after the mode');
  // No branch anywhere lets preview mode bypass consent. Checked against CODE
  // rather than prose: the doc comment legitimately discusses both.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    (code.match(/return null;/g) ?? []).length,
    2,
    'exactly two early returns: the mode gate and the consent gate',
  );
  // "preview" may appear in the import path; what must not exist is a
  // CONDITIONAL on it, which is how a bypass would be written.
  assert.doesNotMatch(
    code,
    /if\s*\([^)]*preview/i,
    'a preview-specific conditional exists in the component body',
  );
  assert.doesNotMatch(code, /mode === "preview_validation"/);
});

test('neither preview variable is a secret, and neither is server-only', () => {
  assert.ok(PREVIEW_VALIDATION_FLAG_ENV.startsWith('NEXT_PUBLIC_'));
  assert.ok(PREVIEW_MEASUREMENT_ID_ENV.startsWith('NEXT_PUBLIC_'));
  const src = readFileSync(
    new URL('../src/lib/marketing/preview-validation.ts', import.meta.url),
    'utf8',
  );
  for (const secret of ['GA4_API_SECRET', 'ACCESS_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'STRIPE']) {
    assert.equal(src.includes(secret), src.includes('GA4_API_SECRET') && secret === 'GA4_API_SECRET');
  }
});
