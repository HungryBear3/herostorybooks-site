/**
 * Content-type spoofing guards for BOTH Family Review upload paths.
 *
 * The admin sample upload previously trusted the client-declared
 * File.type with no byte-level check. Both paths now resolve the type
 * from the bytes, and a declared type that contradicts the bytes is a
 * hard rejection rather than a silent relabel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveUploadImageType,
  sniffImageType,
} from '../src/lib/family-review/image-type.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
]);
const HEIC = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
]);
const HEIF_MIF1 = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0,
]);
const HTML = new Uint8Array(
  Array.from('<!DOCTYPE html><script>').map((c) => c.charCodeAt(0)),
).slice(0, 16);

function fileOf(bytes: Uint8Array, type: string): File {
  return new File([bytes as unknown as BlobPart], 'ignored-by-design', { type });
}

test('sniffing identifies each supported format from its magic bytes', () => {
  assert.equal(sniffImageType(JPEG)?.mime, 'image/jpeg');
  assert.equal(sniffImageType(PNG)?.mime, 'image/png');
  assert.equal(sniffImageType(WEBP)?.mime, 'image/webp');
  assert.equal(sniffImageType(HEIC)?.mime, 'image/heic');
  assert.equal(sniffImageType(HTML), null, 'HTML is not an image');
});

test('a file whose declared type contradicts its bytes is REJECTED', async () => {
  // The classic spoof: HTML bytes wearing an image content type.
  assert.equal(await resolveUploadImageType(fileOf(HTML, 'image/png')), null);
  // And a real image mislabeled as a different real image.
  assert.equal(await resolveUploadImageType(fileOf(PNG, 'image/jpeg')), null);
  assert.equal(await resolveUploadImageType(fileOf(JPEG, 'image/webp')), null);
});

test('a declared type that AGREES with the bytes is accepted', async () => {
  assert.equal((await resolveUploadImageType(fileOf(JPEG, 'image/jpeg')))?.mime, 'image/jpeg');
  assert.equal((await resolveUploadImageType(fileOf(PNG, 'image/png')))?.mime, 'image/png');
  assert.equal((await resolveUploadImageType(fileOf(WEBP, 'image/webp')))?.mime, 'image/webp');
});

test('equivalent spellings are not mistaken for a spoof', async () => {
  // image/jpg and image/jpeg are the same format.
  assert.equal((await resolveUploadImageType(fileOf(JPEG, 'image/jpg')))?.mime, 'image/jpeg');
  // HEIF and HEIC share one container; the sniffer reports image/heic
  // for every ftyp brand, so a genuine image/heif upload must still pass.
  assert.equal((await resolveUploadImageType(fileOf(HEIF_MIF1, 'image/heif')))?.mime, 'image/heic');
  assert.equal((await resolveUploadImageType(fileOf(HEIC, 'image/heif')))?.mime, 'image/heic');
});

test('a blank or nonstandard declared type falls back to the bytes', async () => {
  // Mobile cameras routinely send these; the bytes decide.
  assert.equal((await resolveUploadImageType(fileOf(JPEG, '')))?.mime, 'image/jpeg');
  assert.equal((await resolveUploadImageType(fileOf(HEIC, 'application/octet-stream')))?.mime, 'image/heic');
});

test('no supported magic bytes means no upload, whatever the declaration', async () => {
  for (const declared of ['image/png', 'image/jpeg', '', 'text/html']) {
    assert.equal(
      await resolveUploadImageType(fileOf(HTML, declared)),
      null,
      `HTML bytes declared "${declared}" must be refused`,
    );
  }
});
