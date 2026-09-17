/**
 * What the buyer reads when a direct-intake upload is refused.
 *
 * The 2026-09-04 owner incident surfaced as a banner whose entire body was
 * the string `asset_mime_invalid`, followed by advice about downloading a
 * recorded voice note — for a failure that had nothing to do with recording.
 * The mapper here owns that translation so the page never shows a bare code
 * as the primary message and only mentions recorded-note preservation when
 * there is an in-checkout recording to preserve.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_ORDER_NOT_SENT_GUIDANCE,
  PREVIOUS_CHECKOUT_PAID_RECOVERY,
  PREVIOUS_CHECKOUT_UNRESOLVED_WARNING,
  checkoutSubmitErrorMessageForAttempt,
  describeCheckoutSubmitError,
} from '../src/lib/checkout-direct-intake-error-copy.ts';

const BARE_CODE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

const KNOWN_CODES = [
  'asset_mime_invalid', 'photo_type_unsupported', 'asset_too_large', 'asset_size_invalid',
  'voice_type_invalid', 'document_type_invalid', 'voice_consent_required', 'document_consent_required',
  'upload_failed', 'upload_not_reconciled', 'upload_superseded', 'reservation_failed',
  'intake_create_failed', 'intake_expired', 'intake_forbidden', 'direct_upload_unsettled',
  'direct_upload_identity_unmapped', 'direct_upload_selection_changed_reload_required',
  'intake_store_unavailable', 'intake_write_conflict',
];

test('no known code is ever the primary customer message', () => {
  for (const code of KNOWN_CODES) {
    const described = describeCheckoutSubmitError({ code });
    assert.doesNotMatch(described.message, BARE_CODE, code);
    assert.ok(described.message.length > 20, `${code} must map to a sentence`);
    assert.match(described.message, /not been charged/i, `${code} must keep the not-charged assurance`);
    assert.equal(described.reference, code, 'the code stays available as a support reference');
  }
});

test('an unknown code still maps to a sentence and keeps the code as a reference only', () => {
  const described = describeCheckoutSubmitError({ code: 'something_new_9' });
  assert.doesNotMatch(described.message, BARE_CODE);
  assert.match(described.message, /not been charged/i);
  assert.equal(described.reference, 'something_new_9');
});

test('every direct-intake code is reconciliation-safe when the attempt may have reached the server', () => {
  for (const code of [...KNOWN_CODES, 'something_new_9']) {
    const described = describeCheckoutSubmitError({
      code,
      label: 'hero photo',
      attemptMayHaveReachedServer: true,
    });
    assert.match(described.message, /do not pay again/i, code);
    assert.match(described.message, /support@herostorybooks\.com/i, code);
    assert.doesNotMatch(described.message, /not been charged|no charge|try again|retry|reload|start a fresh/i, code);
    assert.equal(described.reference, code);
  }
});

test('an old unresolved marker does not hide the actionable current-click pre-request failure', () => {
  const described = describeCheckoutSubmitError({
    code: 'asset_mime_invalid',
    label: 'hero photo',
    attemptRisk: 'previous_attempt_unresolved',
  });

  assert.match(described.message, /hero photo/i);
  assert.match(described.message, /JPG|JPEG/);
  assert.match(described.message, /PNG/);
  assert.match(described.message, /WebP/);
  assert.match(described.message, /do not pay again/i);
  assert.match(described.message, /press Continue again/i);
  assert.ok(described.message.endsWith(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING));
  assert.doesNotMatch(described.message, /not been charged|no charge/i);
  assert.doesNotMatch(described.message, /We could not confirm the status of your order/i);
  assert.equal(described.showRecordedVoiceHint, false);
  assert.equal(
    checkoutSubmitErrorMessageForAttempt(described.message, 'previous_attempt_unresolved'),
    described.message,
    'the form-level safety sink must not duplicate the warning',
  );
});

test('a current /api/order dispatch still uses the fully conservative generic copy', () => {
  const described = describeCheckoutSubmitError({
    code: 'asset_mime_invalid',
    label: 'hero photo',
    attemptRisk: 'current_order_request_sent',
  });

  assert.match(described.message, /do not pay again/i);
  assert.match(described.message, /support@herostorybooks\.com/i);
  assert.doesNotMatch(described.message, /hero photo|JPG|PNG|WebP|press Continue again/i);
});

test('a terminal old attempt keeps the current no-request error actionable without denying its prior charge history', () => {
  const described = describeCheckoutSubmitError({
    code: 'upload_failed',
    label: 'hero photo',
    attemptRisk: 'previous_attempt_resolved',
  });

  assert.match(described.message, /hero photo/i);
  assert.match(described.message, /check your connection/i);
  assert.ok(described.message.endsWith(CURRENT_ORDER_NOT_SENT_GUIDANCE));
  assert.doesNotMatch(described.message, /not been charged|no charge|do not pay again/i);
});

test('the unresolved warning does not promise to reuse an attempt the next click may retire', () => {
  // It used to say "we will re-check and safely reuse the same checkout
  // attempt". An unresolved attempt can turn out to be expired+unpaid (which
  // rotates) or completed+paid (which routes to recovery), so reuse was a
  // promise the handler cannot keep.
  assert.doesNotMatch(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /reuse the same checkout attempt/i);
  assert.match(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /do not pay again/i);
  assert.match(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /press Continue again/i);
  assert.match(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /re-check/i);
  assert.doesNotMatch(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /not been charged|no charge/i);
});

test('a previously PAID attempt gets its own recovery copy and never a no-charge claim', () => {
  const described = describeCheckoutSubmitError({
    code: 'upload_failed',
    label: 'hero photo',
    attemptRisk: 'previous_attempt_paid',
    voiceSource: 'recorded',
  });

  assert.ok(described.message.endsWith(PREVIOUS_CHECKOUT_PAID_RECOVERY));
  assert.doesNotMatch(described.message, /not been charged|no charge|nothing was charged/i);
  assert.match(described.message, /already paid/i);
  assert.match(described.message, /do not pay again/i);
  // Recovery, not a retry loop, and never an offer to buy again by accident.
  assert.doesNotMatch(PREVIOUS_CHECKOUT_PAID_RECOVERY, /press Continue again/i);
  assert.equal(described.showRecordedVoiceHint, false);
  assert.equal(
    checkoutSubmitErrorMessageForAttempt(described.message, 'previous_attempt_paid'),
    described.message,
    'the form-level safety sink must not duplicate the paid guidance',
  );
});

test('a refused voice-note MIME names the voice note and the accepted audio formats', () => {
  const described = describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'voice note', voiceSource: 'uploaded' });
  assert.match(described.message, /voice note/i);
  assert.match(described.message, /m4a|mp3|wav/i);
  assert.match(described.message, /not been charged/i);
  assert.doesNotMatch(described.message, /asset_mime_invalid/);
});

test('a refused photo MIME names the photo and the accepted still formats', () => {
  const described = describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'hero photo', voiceSource: null });
  assert.match(described.message, /hero photo/i);
  assert.match(described.message, /JPG|JPEG/);
  assert.match(described.message, /PNG/);
  assert.match(described.message, /WebP/);
  assert.doesNotMatch(described.message, /HEIC/i, 'HEIC is not advertised');
});

test('the photo-specific refusal from the pre-intake gate is a sentence with the accepted formats', () => {
  const described = describeCheckoutSubmitError({ code: 'photo_type_unsupported', label: 'photo for Dad' });
  assert.match(described.message, /photo for Dad/);
  assert.match(described.message, /JPG|JPEG/);
  assert.doesNotMatch(described.message, /HEIC/i);
});

test('recorded-note preservation guidance appears only for a fresh-attempt in-checkout recording', () => {
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'hero photo', voiceSource: 'recorded' }).showRecordedVoiceHint, true);
  assert.equal(describeCheckoutSubmitError({ code: 'upload_failed', voiceSource: 'recorded' }).showRecordedVoiceHint, true);
  assert.equal(describeCheckoutSubmitError({ code: 'upload_failed', voiceSource: 'recorded', attemptMayHaveReachedServer: true }).showRecordedVoiceHint, false);
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'voice note', voiceSource: 'uploaded' }).showRecordedVoiceHint, false);
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'hero photo', voiceSource: null }).showRecordedVoiceHint, false);
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'hero photo' }).showRecordedVoiceHint, false);
});
