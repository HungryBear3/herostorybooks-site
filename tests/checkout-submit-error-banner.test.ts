/**
 * Source pins for the checkout page's submit-error banner and photo entry.
 *
 * The page cannot be rendered under `node:test`, so — exactly like
 * `checkout-design-layout.test.ts` — these assertions read the component
 * source. Each pin names a regression the 2026-09-04 owner incident exposed:
 *
 *   • the banner body was the raw server code;
 *   • the "download your recorded voice note" hint showed for every failure;
 *   • an unsupported photo type was not refused until the payment CTA.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const formSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('the submit banner never renders a raw error code as its primary message', () => {
  assert.match(formSource, /describeCheckoutSubmitError\(/, 'the page must route submit failures through the shared error mapper');
  // The catch block used to do `setSubmitError(error.message)` verbatim.
  assert.doesNotMatch(
    formSource,
    /setSubmitError\(\s*error instanceof Error\s*\?\s*error\.message/,
    'the raw error message must not be the banner body',
  );
});

test('recorded-note preservation guidance is conditional on an in-checkout recording', () => {
  assert.match(formSource, /SUBMIT_BANNER_RECORDED_VOICE_HINT/);
  assert.match(
    formSource,
    /submitBanner\.showRecordedVoiceHint\s*&&\s*SUBMIT_BANNER_RECORDED_VOICE_HINT/,
    'the shared hint must render only when the audited banner decision authorizes it',
  );
});

test('the mapper is given the voice source so an uploaded memo is not mistaken for a recording', () => {
  assert.match(formSource, /describeCheckoutSubmitError\(\{[\s\S]{0,300}voiceSource:\s*form\.voiceSource/);
});

test('unsupported photo types are refused at the picker, before any intake exists', () => {
  assert.match(formSource, /import \{[^}]*canonicalMediaMime[^}]*\} from "@\/lib\/checkout-media-mime"/);
  const heroHandler = formSource.indexOf('const processPhoto = useCallback(');
  const familyHandler = formSource.indexOf('const processSupportingCharacterPhoto = useCallback(');
  assert.ok(heroHandler > -1 && familyHandler > -1);
  for (const [name, start] of [['processPhoto', heroHandler], ['processSupportingCharacterPhoto', familyHandler]] as const) {
    const body = formSource.slice(start, start + 1600);
    const gate = body.indexOf('canonicalMediaMime(');
    const shrink = body.indexOf('shrinkPhotoForUpload(');
    assert.ok(gate > -1, `${name} must gate the photo type`);
    assert.ok(shrink > -1 && gate < shrink, `${name} must gate before shrinking`);
  }
});

test('the photo refusal copy is photo-specific and does not advertise HEIC', () => {
  assert.match(formSource, /photoTypeUnsupportedMessage\(|PHOTO_TYPE_UNSUPPORTED/);
  assert.doesNotMatch(formSource, /HEIC|HEIF/);
});

/*
 * Diagnostics wiring (2026-09-17 iPhone Safari incident).
 *
 * The buyer's submit failed before `/api/order`; production held one
 * `/api/recovery` 200 and nothing else, and the authoritative two-hour scans
 * found zero new orders and zero Stripe Checkout Sessions. Nothing in the
 * banner or the logs could be tied to their report. These pins keep the page
 * wired to the closed vocabulary, and keep the reporting best-effort.
 */

const submitBody = (() => {
  const start = formSource.indexOf('const handleSubmit');
  assert.ok(start > -1, 'the submit handler must be findable');
  return formSource.slice(start);
})();

test('every failure the submit path throws carries a closed diagnostic code', () => {
  assert.match(
    formSource,
    /import \{[\s\S]{0,600}?CheckoutSubmitDiagnosticError[\s\S]{0,600}?\} from "@\/lib\/checkout-submit-diagnostics"/,
    'the page must use the shared diagnostic vocabulary',
  );
  for (const code of [
    'attempt_identity_conflict',
    'attempt_storage_unavailable',
    'attempt_lease_unavailable',
    'order_request_refused',
    'stripe_handoff_unconfirmed',
    'previous_attempt_paid',
  ]) {
    assert.match(
      submitBody,
      new RegExp(`new CheckoutSubmitDiagnosticError\\(\\s*"${code}"`),
      `the submit path must be able to report ${code}`,
    );
  }
});

test('no submit failure escapes as an unclassified bare Error', () => {
  // A `throw new Error(...)` here is a failure with no diagnostic class, i.e.
  // exactly the blind spot the incident exposed.
  const bare = submitBody.match(/throw new Error\(/g) ?? [];
  assert.deepEqual(bare, [], 'every thrown submit failure must carry a diagnostic code');
});

test('the catch path classifies the failure and mints one reference per occurrence', () => {
  assert.match(submitBody, /classifyCheckoutSubmitFailure\(\{[\s\S]{0,120}error[\s\S]{0,120}\}\)/);
  assert.match(submitBody, /newCheckoutDiagnosticReference\(\)/);
  assert.equal(
    (submitBody.match(/newCheckoutDiagnosticReference\(\)/g) ?? []).length,
    1,
    'one reference per failed submit, minted in one place',
  );
});

test('the banner is given the diagnostic so the audited helper renders the reference', () => {
  assert.match(
    submitBody,
    /setSubmitError\([\s\S]{0,200}?diagnostic/,
    'the diagnostic must reach the banner through setSubmitError',
  );
  assert.match(
    formSource,
    /checkoutSubmitBanner\(\{[\s\S]{0,400}?diagnostic/,
    'only the audited banner helper may turn a diagnostic into copy',
  );
  assert.match(formSource, /submitBanner\.diagnosticLine/, 'the banner must render the reference');
});

test('reporting is fire-and-forget: it can neither block nor fail the submit', () => {
  assert.match(submitBody, /reportCheckoutSubmitDiagnostic\(/);
  assert.doesNotMatch(
    submitBody,
    /await\s+reportCheckoutSubmitDiagnostic\(/,
    'awaiting the report would let a slow diagnostics request delay the banner',
  );
  assert.doesNotMatch(
    submitBody,
    /return\s+reportCheckoutSubmitDiagnostic\(/,
    'the submit path must not depend on the report resolving',
  );
});

test('the reported event is built from the classification, never from buyer input', () => {
  const call = submitBody.slice(
    submitBody.indexOf('reportCheckoutSubmitDiagnostic('),
    submitBody.indexOf('reportCheckoutSubmitDiagnostic(') + 400,
  );
  for (const forbidden of [
    'form.email', 'form.childName', 'form.photoFile', 'error.message', 'described.message',
    'checkoutAttemptId', 'navigator.userAgent', '.name', 'label',
  ]) {
    assert.equal(call.includes(forbidden), false, `${forbidden} must not reach the diagnostic event`);
  }
});

test('the diagnostics wiring clears and rotates nothing', () => {
  // Attempt lifecycle is owned by the submit path's existing fail-closed rules.
  // A diagnostics change that touched it would be a duplicate-charge risk.
  const diagnosticLines = submitBody
    .split('\n')
    .filter((line) => /Diagnostic|diagnostic/.test(line));
  assert.ok(diagnosticLines.length > 0);
  for (const line of diagnosticLines) {
    assert.doesNotMatch(line, /clearCheckoutAttempt|storeCheckoutAttemptId|markCheckoutAttempt|newCheckoutAttemptId/);
  }
});
