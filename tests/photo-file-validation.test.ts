import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import {
  MAX_ORDER_PHOTO_BYTES,
  validateOrderPhotoFile,
} from '../src/lib/photo-file-validation.ts';

function file(bytes: Uint8Array | Buffer, name: string, type: string): File {
  return new File([bytes], name, { type });
}

async function onePixel(format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> {
  const image = sharp({
    create: { width: 2, height: 2, channels: 3, background: '#336699' },
  });
  if (format === 'jpeg') return image.jpeg().toBuffer();
  if (format === 'png') return image.png().toBuffer();
  return image.webp().toBuffer();
}

test('fully decodes JPEG, PNG, and WebP then emits canonical metadata-free JPEG bytes', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const declaredType = `image/${format}`;
    const result = await validateOrderPhotoFile(
      file(await onePixel(format), `hero.${format}`, declaredType),
    );
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.format, format);
    assert.equal(result.contentType, 'image/jpeg');
    assert.equal(result.extension, 'jpg');
    assert.ok(result.normalizedBytes.length > 100);
    const normalized = await sharp(result.normalizedBytes).metadata();
    assert.equal(normalized.format, 'jpeg');
    assert.equal(normalized.width, 2);
    assert.equal(normalized.height, 2);
  }
});

test('rejects HEIC and HEIF before decode until deployed codec support is proven', async () => {
  for (const type of ['image/heic', 'image/heif']) {
    assert.deepEqual(
      await validateOrderPhotoFile(file(await onePixel('jpeg'), 'hero.heic', type)),
      { ok: false, code: 'photo_invalid_type' },
    );
  }
});

test('rejects header-only and executable payloads even when caller claims image/jpeg', async () => {
  for (const bytes of [
    Uint8Array.from([0xff, 0xd8, 0xff, ...Buffer.from('<script>alert(1)</script>')]),
    Uint8Array.from(Buffer.from('<script>alert(1)</script>')),
  ]) {
    assert.deepEqual(
      await validateOrderPhotoFile(file(bytes, 'hero.jpg', 'image/jpeg')),
      { ok: false, code: 'photo_invalid_content' },
    );
  }
});

test('strips a valid-image prefix polyglot to canonical decoded pixels before storage', async () => {
  const source = Buffer.concat([
    await onePixel('jpeg'),
    Buffer.from('<script>maliciousTrailingPayload()</script>'),
  ]);
  const result = await validateOrderPhotoFile(file(source, 'hero.jpg', 'image/jpeg'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.normalizedBytes.includes(Buffer.from('maliciousTrailingPayload')), false);
  assert.equal((await sharp(result.normalizedBytes).metadata()).format, 'jpeg');
});

test('rejects AVIF declared as HEIC at the declared-type boundary', async () => {
  const avif = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#336699' },
  }).avif().toBuffer();
  assert.deepEqual(
    await validateOrderPhotoFile(file(avif, 'hero.heic', 'image/heic')),
    { ok: false, code: 'photo_invalid_type' },
  );
});

test('rejects mismatched MIME and decoded format', async () => {
  const result = await validateOrderPhotoFile(
    file(await onePixel('png'), 'hero.jpg', 'image/jpeg'),
  );
  assert.deepEqual(result, { ok: false, code: 'photo_invalid_content' });
});

test('rejects unaccepted declared types and oversized files before decode', async () => {
  assert.deepEqual(
    await validateOrderPhotoFile(file(await onePixel('jpeg'), 'hero.bin', 'application/octet-stream')),
    { ok: false, code: 'photo_invalid_type' },
  );
  const oversized = new File([new Uint8Array(MAX_ORDER_PHOTO_BYTES + 1)], 'hero.jpg', {
    type: 'image/jpeg',
  });
  assert.deepEqual(await validateOrderPhotoFile(oversized), {
    ok: false,
    code: 'photo_too_large',
  });
});
