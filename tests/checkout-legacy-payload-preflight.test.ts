/**
 * The legacy multipart submit has a size cliff the buyer never sees.
 *
 * 2026-09-17, real iPhone Safari: the banner said
 * `current_order_request_sent`, Vercel logged NO `/api/order` invocation, and
 * neither an order nor a Stripe Session existed. With direct upload unset in
 * production, checkout posts ONE multipart request carrying the hero photo,
 * every supporting photo (~1.1 MiB each), plus a voice note or document whose
 * own caps are 15/10 MiB. Past the platform body boundary the request dies in
 * the edge before any function runs, so the browser cannot tell "refused
 * upstream" from "the server may have taken my money".
 *
 * The fix is local and conservative: measure the REAL media bytes in the final
 * FormData and refuse above 3.5 MiB — comfortably under the ~4.5 MiB edge
 * boundary, leaving room for multipart overhead and the text fields — before
 * the attempt is ever marked sent. These tests execute the helper on real
 * Blob/File entries; the source-ordering guards only pin WHERE it runs, which
 * behaviour alone cannot show.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  LEGACY_CHECKOUT_MEDIA_BYTE_CAP,
  LegacyCheckoutPayloadTooLargeError,
  assertLegacyCheckoutPayloadWithinLimit,
  inspectLegacyCheckoutPayload,
  legacyCheckoutMediaByteSize,
} from '../src/lib/checkout-legacy-payload-preflight.ts';
import {
  checkoutSubmitBanner,
  describeCheckoutSubmitError,
  NOT_CHARGED,
} from '../src/lib/checkout-direct-intake-error-copy.ts';
import { checkoutSubmitAttemptRisk } from '../src/lib/checkout-saved-draft.ts';

const MIB = 1024 * 1024;
const FORM = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

/** Run the real preflight and hand back whatever it threw. */
function preflightFailure(payload: FormData): LegacyCheckoutPayloadTooLargeError {
  try {
    assertLegacyCheckoutPayloadWithinLimit(payload);
  } catch (error) {
    assert.ok(
      error instanceof LegacyCheckoutPayloadTooLargeError,
      'the preflight must throw the typed local failure',
    );
    return error;
  }
  throw new assert.AssertionError({ message: 'the preflight accepted an oversized payload' });
}

function blobOf(bytes: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

function fileOf(bytes: number, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** A legacy payload with the text fields the real submit always sets. */
function legacyPayload(): FormData {
  const payload = new FormData();
  payload.set('checkoutAttemptId', 'a'.repeat(32));
  payload.set('childName', 'Ada');
  payload.set('email', 'parent@example.com');
  payload.set('theme', 'space');
  return payload;
}

test('the cap is 3.5 MiB and keeps real headroom under the ~4.5 MiB edge boundary', () => {
  assert.equal(LEGACY_CHECKOUT_MEDIA_BYTE_CAP, 3.5 * MIB);
  assert.ok(
    LEGACY_CHECKOUT_MEDIA_BYTE_CAP < 4.5 * MIB,
    'the media cap must leave multipart overhead below the platform body boundary',
  );
  assert.ok(
    4.5 * MIB - LEGACY_CHECKOUT_MEDIA_BYTE_CAP >= MIB,
    'at least a MiB of overhead headroom, so boundary estimates do not need to be exact',
  );
});

test('only real Blob/File entries are counted — text fields do not', () => {
  const payload = legacyPayload();
  payload.set('giftMessage', 'x'.repeat(5000));
  assert.equal(legacyCheckoutMediaByteSize(payload), 0);

  payload.set('photo', fileOf(1024, 'hero.jpg', 'image/jpeg'));
  assert.equal(legacyCheckoutMediaByteSize(payload), 1024);
});

test('multiple media entries sum, including repeated appends', () => {
  const payload = legacyPayload();
  payload.set('photo', fileOf(1_100_000, 'hero.jpg', 'image/jpeg'));
  payload.append('familyPhoto', fileOf(1_100_000, 'mum.jpg', 'image/jpeg'));
  payload.append('familyPhoto', fileOf(1_100_000, 'dad.jpg', 'image/jpeg'));
  payload.append('guidedCapture', blobOf(50_000, 'image/png'));
  assert.equal(legacyCheckoutMediaByteSize(payload), 3_350_000);
});

test('a payload under the cap passes, and exactly at the cap passes', () => {
  const under = legacyPayload();
  under.set('photo', fileOf(LEGACY_CHECKOUT_MEDIA_BYTE_CAP - 1, 'hero.jpg', 'image/jpeg'));
  assert.doesNotThrow(() => assertLegacyCheckoutPayloadWithinLimit(under));
  assert.equal(inspectLegacyCheckoutPayload(under).withinLimit, true);

  const exact = legacyPayload();
  exact.set('photo', fileOf(LEGACY_CHECKOUT_MEDIA_BYTE_CAP, 'hero.jpg', 'image/jpeg'));
  assert.doesNotThrow(() => assertLegacyCheckoutPayloadWithinLimit(exact));
  const inspected = inspectLegacyCheckoutPayload(exact);
  assert.equal(inspected.mediaBytes, LEGACY_CHECKOUT_MEDIA_BYTE_CAP);
  assert.equal(inspected.withinLimit, true);
});

test('one byte over the cap fails with a typed, stable local failure', () => {
  const payload = legacyPayload();
  payload.set('photo', fileOf(LEGACY_CHECKOUT_MEDIA_BYTE_CAP + 1, 'hero.jpg', 'image/jpeg'));
  assert.equal(inspectLegacyCheckoutPayload(payload).withinLimit, false);

  const error = preflightFailure(payload);
  assert.equal(error.code, 'legacy_media_payload_too_large');
  assert.equal(error.mediaBytes, LEGACY_CHECKOUT_MEDIA_BYTE_CAP + 1);
  assert.equal(error.limitBytes, LEGACY_CHECKOUT_MEDIA_BYTE_CAP);
  assert.ok(error instanceof Error, 'the failure must travel the existing catch path');
});

test('the buyer message is actionable and claims nothing about payment or an older attempt', () => {
  const payload = legacyPayload();
  payload.set('voice', fileOf(4 * MIB, 'memory.m4a', 'audio/mp4'));
  const error = preflightFailure(payload);

  assert.match(error.message, /too large/i);
  assert.match(error.message, /secure checkout/i);
  assert.match(error.message, /this click did not send a new order request/i);
  assert.match(error.message, /voice note/i);
  assert.match(error.message, /photos|documents/i);
  // Nothing about money or a previous attempt: this helper only knows that THIS
  // click stopped locally. The banner owns any charge statement.
  assert.doesNotMatch(error.message, /charge|paid|payment|refund/i);
  assert.doesNotMatch(error.message, /previous|earlier|older attempt/i);
});

/**
 * The exact tail of the legacy submit, in the order checkout-form.tsx runs it.
 * Behaviour, not regex: the real helper decides, and a fetch that happens is
 * recorded. The source guards below prove the production form has this shape.
 */
function runLegacySubmitTail(input: {
  directIntakeSubmission: unknown;
  payload: FormData;
}): string[] {
  const steps: string[] = [];
  if (!input.directIntakeSubmission) {
    assertLegacyCheckoutPayloadWithinLimit(input.payload);
  }
  steps.push('markCheckoutAttemptSent');
  steps.push('requestSent=true');
  steps.push('fetch:/api/order');
  return steps;
}

test('an oversized legacy payload reaches no order fetch, and reads as local/unsent', () => {
  const payload = legacyPayload();
  payload.set('photo', fileOf(1_100_000, 'hero.jpg', 'image/jpeg'));
  payload.append('familyPhoto', fileOf(1_100_000, 'mum.jpg', 'image/jpeg'));
  payload.set('voice', fileOf(3 * MIB, 'memory.m4a', 'audio/mp4'));

  let requestSent = false;
  let steps: string[] = [];
  let thrown: unknown = null;
  try {
    steps = runLegacySubmitTail({ directIntakeSubmission: null, payload });
    requestSent = true;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof LegacyCheckoutPayloadTooLargeError);
  assert.equal(requestSent, false);
  assert.deepEqual(steps, [], 'nothing past the preflight may run');

  const attemptRisk = checkoutSubmitAttemptRisk({ requestSent, previouslySent: false });
  assert.equal(attemptRisk, 'none');
  const described = describeCheckoutSubmitError({
    code: 'order_request_failed',
    attemptRisk,
    serverMessage: (thrown as Error).message,
  });
  assert.equal(described.message, (thrown as Error).message, 'the sentence reaches the buyer intact');
  const banner = checkoutSubmitBanner({ message: described.message, attemptRisk });
  assert.equal(banner.noChargeReassurance, true);
  assert.ok(banner.lines.includes(NOT_CHARGED));
});

test('the local payload refusal preserves conservative prior-attempt banners without false no-charge copy', () => {
  const error = new LegacyCheckoutPayloadTooLargeError(4 * MIB, LEGACY_CHECKOUT_MEDIA_BYTE_CAP);
  for (const risk of [
    'previous_attempt_unresolved',
    'previous_attempt_resolved',
    'previous_attempt_paid',
  ] as const) {
    const described = describeCheckoutSubmitError({
      code: error.code,
      attemptRisk: risk,
      serverMessage: error.message,
    });
    const banner = checkoutSubmitBanner({ message: described.message, attemptRisk: risk });
    assert.equal(banner.noChargeReassurance, false, `${risk} must never claim no charge`);
    assert.equal(banner.lines.includes(NOT_CHARGED), false);
  }
});

test('a direct-intake submission bypasses the legacy cap entirely', () => {
  const payload = legacyPayload();
  // Direct intake would never put these bytes here, but if it did the legacy
  // cap must still not fire: that lane has its own per-asset limits and never
  // posts media through `/api/order`.
  payload.set('photo', fileOf(LEGACY_CHECKOUT_MEDIA_BYTE_CAP + 1, 'hero.jpg', 'image/jpeg'));
  const steps = runLegacySubmitTail({
    directIntakeSubmission: { intakeId: 'intake_1' },
    payload,
  });
  assert.deepEqual(steps, ['markCheckoutAttemptSent', 'requestSent=true', 'fetch:/api/order']);
});

test('the form runs the preflight after every legacy media append and before the send markers', () => {
  const preflightAt = FORM.indexOf('assertLegacyCheckoutPayloadWithinLimit(payload)');
  assert.ok(preflightAt > 0, 'checkout-form.tsx must run the final-FormData preflight');

  const legacyAppends = [
    'applyPrimaryAndSupportingMediaToOrderPayload(payload',
    'payload.set("voice", attachedStoryFile)',
    'payload.set("document", attachedStoryFile)',
    'appendGuidedCaptureToFormData(payload, guidedFrames)',
  ];
  for (const append of legacyAppends) {
    const at = FORM.indexOf(append);
    assert.ok(at > 0, `${append} must still exist`);
    assert.ok(at < preflightAt, `${append} must be appended before the preflight measures`);
  }

  for (const after of [
    'markCheckoutAttemptSent(checkoutAttemptId)',
    'requestSent = true',
    'fetch("/api/order"',
  ]) {
    const at = FORM.indexOf(after);
    assert.ok(at > 0, `${after} must still exist`);
    assert.ok(preflightAt < at, `the preflight must run before ${after}`);
  }
});

/** Brace depth of `FORM` between two offsets — how deeply nested a line sits. */
function braceDepthBetween(from: number, to: number): number {
  let depth = 0;
  for (const character of FORM.slice(from, to)) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
  }
  return depth;
}

test('the preflight is gated on the legacy lane only', () => {
  const preflightAt = FORM.indexOf('assertLegacyCheckoutPayloadWithinLimit(payload)');
  const legacyBranchAt = FORM.indexOf('if (directIntakeSubmission && preparedDirectIntake) {');
  assert.ok(legacyBranchAt > 0 && legacyBranchAt < preflightAt);
  const elseAt = FORM.indexOf('} else {', legacyBranchAt);
  assert.ok(
    elseAt > 0 && elseAt < preflightAt,
    'the preflight must live inside the no-direct-submission branch',
  );
  const elseBodyAt = elseAt + '} else {'.length;

  // Still INSIDE the `else` when the preflight runs: a direct-intake
  // submission therefore never reaches it, and direct upload is untouched.
  assert.ok(
    braceDepthBetween(elseBodyAt, preflightAt) >= 0,
    'the preflight must not sit after the legacy branch closed',
  );
  // …and the branch has closed by the time the attempt is marked sent, which
  // is what makes the assertion above discriminating rather than vacuous.
  const sentMarkerAt = FORM.indexOf('if (!serverLeaseBacked && !markCheckoutAttemptSent(');
  assert.ok(sentMarkerAt > preflightAt);
  assert.equal(
    braceDepthBetween(elseBodyAt, sentMarkerAt),
    -1,
    'the sent marker runs after the legacy branch closes, on both lanes',
  );
});
