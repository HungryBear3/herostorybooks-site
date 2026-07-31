import assert from 'node:assert/strict';
import test from 'node:test';

import { falImageProvider } from '../src/lib/image-provider-fal.ts';

test('text-only FAL provider fails closed when a reference image is required but missing', async () => {
  const originalKey = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key-that-must-not-be-used';
  let fetchCalls = 0;
  try {
    const result = await falImageProvider.generate(
      { prompt: 'p', referenceImageRequired: true },
      {
        fetch: async () => {
          fetchCalls += 1;
          throw new Error('network must not be called');
        },
      },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(result.imageUrl, null);
    assert.equal(result.conditioning, 'photo_edit');
    assert.match(result.error ?? '', /reference image required but missing/i);
  } finally {
    if (originalKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = originalKey;
  }
});
