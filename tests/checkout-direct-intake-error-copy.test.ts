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

import { describeCheckoutSubmitError } from '../src/lib/checkout-direct-intake-error-copy.ts';

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

test('recorded-note preservation guidance appears only for an in-checkout recording', () => {
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'hero photo', voiceSource: 'recorded' }).showRecordedVoiceHint, true);
  assert.equal(describeCheckoutSubmitError({ code: 'upload_failed', voiceSource: 'recorded' }).showRecordedVoiceHint, true);
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'voice note', voiceSource: 'uploaded' }).showRecordedVoiceHint, false);
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'hero photo', voiceSource: null }).showRecordedVoiceHint, false);
  assert.equal(describeCheckoutSubmitError({ code: 'asset_mime_invalid', label: 'hero photo' }).showRecordedVoiceHint, false);
});
