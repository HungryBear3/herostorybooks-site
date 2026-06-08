/**
 * Phase 1 — guided reference photo persistence + no-charge safety.
 *
 * The order route runs collectGuidedReferencePhotos() BEFORE creating a Stripe
 * Checkout Session and aborts on any failure, so a MIME/size/persistence problem
 * never charges the customer. These tests drive that orchestrator directly
 * (Stripe-free) plus the order-record persistence of the metadata.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectGuidedReferencePhotos,
  isAcceptedGuidedPhotoFile,
  MAX_GUIDED_PHOTO_BYTES,
  type GuidedPhotoUploadRef,
} from '../src/lib/guided-photo-capture.ts';
import { createOrderRecord } from '../src/lib/orders.ts';

function jpeg(name: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}
function form(entries: Record<string, unknown>): { get(n: string): FormDataEntryValue | null } {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (v instanceof File) fd.append(k, v);
    else if (v != null) fd.append(k, String(v));
  }
  return fd;
}
const okUpload = async (_o: string, i: number): Promise<GuidedPhotoUploadRef> => ({
  pathname: `orders/o/guided-${i + 1}-photo.jpg`,
  url: `https://blob.example/guided-${i + 1}.jpg`,
});

// ── MIME guard (still images only, never video) ───────────────────────────────

test('isAcceptedGuidedPhotoFile: still images pass; video + non-image reject', () => {
  for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    assert.equal(isAcceptedGuidedPhotoFile({ type: t }), true, t);
  }
  for (const t of ['video/mp4', 'video/quicktime', 'application/pdf', 'audio/mpeg', 'text/plain', '']) {
    assert.equal(isAcceptedGuidedPhotoFile({ type: t }), false, t);
  }
  assert.equal(isAcceptedGuidedPhotoFile(null), false);
});

// ── orchestrator ──────────────────────────────────────────────────────────────

test('no guided photos → ok with empty records (feature simply not used)', async () => {
  const r = await collectGuidedReferencePhotos(form({}), 'o', { upload: okUpload });
  assert.equal(r.ok, true);
  assert.deepEqual((r as { records: unknown[] }).records, []);
});

test('valid guided photos persist (upload called per file) BEFORE returning records', async () => {
  const calls: number[] = [];
  const upload = async (_o: string, i: number): Promise<GuidedPhotoUploadRef> => {
    calls.push(i);
    return { pathname: `p${i}`, url: `https://blob/${i}` };
  };
  const r = await collectGuidedReferencePhotos(
    form({
      guidedPhoto_0: jpeg('front.jpg'),
      guidedPhoto_1: jpeg('left.jpg'),
      guidedPhotoConsent: 'true',
      guidedPhotoLabels: JSON.stringify(['front', 'left']),
    }),
    'o',
    { upload, now: () => new Date('2026-06-08T00:00:00Z') },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.records.length, 2);
  assert.deepEqual(calls, [0, 1]);
  assert.equal(r.records[0]!.source, 'guided_capture');
  assert.equal(r.records[0]!.label, 'front');
  assert.equal(r.records[0]!.photoBlobPath, 'p0');
  assert.equal(r.records[0]!.consentAt, '2026-06-08T00:00:00.000Z');
});

test('missing consent aborts before any upload', async () => {
  let uploaded = false;
  const r = await collectGuidedReferencePhotos(
    form({ guidedPhoto_0: jpeg('front.jpg') }),
    'o',
    { upload: async () => { uploaded = true; return null; } },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'guided_photo_consent_required');
  assert.equal(r.status, 400);
  assert.equal(uploaded, false, 'must not upload without consent');
});

test('invalid MIME (video) rejected before any upload (still-images-only)', async () => {
  let uploaded = false;
  const r = await collectGuidedReferencePhotos(
    form({
      guidedPhoto_0: new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' }),
      guidedPhotoConsent: 'true',
    }),
    'o',
    { upload: async () => { uploaded = true; return null; } },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'guided_photo_invalid_type');
  assert.equal(r.status, 400);
  assert.equal(uploaded, false);
});

test('oversized single still rejected (size guard before upload)', async () => {
  const big = new File([new Uint8Array(MAX_GUIDED_PHOTO_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' });
  const r = await collectGuidedReferencePhotos(
    form({ guidedPhoto_0: big, guidedPhotoConsent: 'true' }),
    'o',
    { upload: okUpload },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'guided_photo_too_large');
  assert.equal(r.status, 413);
});

test('combined oversize rejected before upload', async () => {
  // 5 × 10MB = 50MB combined (each under per-file 12MB limit) > 48MB combined cap.
  const tenMb = () => new File([new Uint8Array(10 * 1024 * 1024)], 'p.jpg', { type: 'image/jpeg' });
  const r = await collectGuidedReferencePhotos(
    form({
      guidedPhoto_0: tenMb(), guidedPhoto_1: tenMb(), guidedPhoto_2: tenMb(),
      guidedPhoto_3: tenMb(), guidedPhoto_4: tenMb(),
      guidedPhotoConsent: 'true',
    }),
    'o',
    { upload: okUpload },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'guided_photo_too_large');
});

test('persistence failure aborts before Stripe with a no-charge message', async () => {
  const r = await collectGuidedReferencePhotos(
    form({ guidedPhoto_0: jpeg('front.jpg'), guidedPhotoConsent: 'true' }),
    'o',
    { upload: async () => { throw new Error('blob put failed'); } },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'guided_photo_persist_failed');
  assert.equal(r.status, 503);
  assert.match(r.error, /no charge was made/i);
});

// ── order record persists the metadata ────────────────────────────────────────

test('createOrderRecord persists guidedReferencePhotos metadata', () => {
  const order = createOrderRecord({
    childName: 'Luna', bookFormat: 'digital', email: 'l@example.com',
    guidedReferencePhotos: [
      { label: 'front', fileName: 'front.jpg', photoBlobPath: 'p0', photoBlobUrl: 'u0', source: 'guided_capture', consentAt: '2026-06-08T00:00:00.000Z' },
    ],
  });
  assert.equal(order.guidedReferencePhotos?.length, 1);
  assert.equal(order.guidedReferencePhotos?.[0]?.source, 'guided_capture');
  // Absent → null (not undefined), so diagnostics/round-trip stay clean.
  const none = createOrderRecord({ childName: 'Leo', bookFormat: 'digital', email: 'a@b.com' });
  assert.equal(none.guidedReferencePhotos, null);
});
