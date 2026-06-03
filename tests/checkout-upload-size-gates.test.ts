/**
 * Source-level wiring assertions for the Phase 1 checkout upload-size gates.
 * The checkout form is a heavy client component; these assert the gates are
 * actually wired (the prior bug was that the resize helper existed but was
 * never called). Pure-logic behavior is covered in upload-limits.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FORM = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const VOICE = readFileSync('src/components/checkout/VoiceRecorderSection.tsx', 'utf8');

// ── Req 1: main photo resize is wired (was previously NOT) ───────────────────

test('checkout imports the resize helper and the HEIC-honest guards', () => {
  assert.match(FORM, /from "@\/lib\/photo-upload"/);
  assert.match(FORM, /shrinkPhotoForUpload/);
  assert.match(FORM, /shouldAutoShrinkPhoto/);
  assert.match(FORM, /isHeicLikePhoto/);
  assert.match(FORM, /MAX_PHOTO_BYTES/);
});

test('main photo processing actually calls the resize/size gate (not a raw passthrough)', () => {
  // processPhoto must route through preparePhotoFile (which resizes / gates).
  assert.match(FORM, /const processPhoto = useCallback\([\s\S]{0,200}preparePhotoFile\(/);
  // The old raw passthrough (storing the original File with no gate) is gone.
  assert.doesNotMatch(FORM, /photoFile: file,\n\s*photoDataUrl: e\.target/);
});

// ── Req 2: supporting character photos use the SAME gate ─────────────────────

test('supporting character photos route through the same resize/size gate', () => {
  assert.match(FORM, /const processSupportingCharacterPhoto = useCallback\([\s\S]{0,260}preparePhotoFile\(/);
  // Both processors share the gate helper.
  assert.ok((FORM.match(/preparePhotoFile\(/g) || []).length >= 2, 'both photo processors must call preparePhotoFile');
  assert.match(FORM, /supportingPhotoErrors/);
});

// ── Req 3: voice/audio/doc size gate before attach ───────────────────────────

test('voice section enforces a max upload size before attaching', () => {
  assert.match(VOICE, /from '@\/lib\/upload-limits'/);
  assert.match(VOICE, /isVoiceUploadTooLarge\(file\.size\)/);
  assert.match(VOICE, /voiceTooLargeMessage/);
  // Recorded blobs are guarded too.
  assert.match(VOICE, /isVoiceUploadTooLarge\(blob\.size\)/);
});

// ── Req 4: combined payload guard before submit (no network wait) ────────────

test('combined-payload guard runs before the /api/order request', () => {
  assert.match(FORM, /estimateTotalUploadBytes\(/);
  assert.match(FORM, /isCombinedUploadTooLarge\(/);
  const guardIdx = FORM.indexOf('isCombinedUploadTooLarge(');
  const fetchIdx = FORM.indexOf('fetch("/api/order"');
  assert.ok(guardIdx > -1 && fetchIdx > -1, 'both guard and order fetch must exist');
  assert.ok(guardIdx < fetchIdx, 'combined guard must block BEFORE the order request');
  assert.match(FORM, /combinedTooLargeMessage\(/);
});

// ── Req 6: copy constraints + error surfaces ─────────────────────────────────

test('error surfaces exist and the not-charged reassurance is preserved', () => {
  assert.match(FORM, /\{photoError &&/);
  assert.match(FORM, /\{supportingPhotoErrors\[character\.id\] &&/);
  // submit-failure reassurance still present in the form.
  assert.match(FORM, /You have not been charged/i);
  // Proof-before-print preserved.
  assert.match(FORM, /PRINT_PREVIEW_PROMISE/);
});
