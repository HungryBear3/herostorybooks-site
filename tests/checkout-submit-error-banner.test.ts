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
  const hint = formSource.indexOf('download it from the section above before retrying');
  assert.ok(hint > -1, 'the preservation hint still exists for recorded notes');
  const guard = formSource.lastIndexOf('showRecordedVoiceHint', hint);
  assert.ok(guard > -1 && hint - guard < 600, 'the hint must be rendered only when the mapper says a recorded note is at risk');
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
