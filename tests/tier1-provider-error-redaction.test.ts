/**
 * Tier1 B — provider error redaction.
 *
 * The centralized `redactProviderError` keeps only a stable type/code
 * classifier (provider + HTTP status + Error name) and DROPS the raw provider
 * message body, which can echo customer PII (a child's name) or internal
 * prompts. Verified both as a unit and through a real image-provider sink.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactProviderError } from '../src/lib/redact-secrets.ts';
import { falImageProvider } from '../src/lib/image-provider-fal.ts';

test('redactProviderError keeps provider + HTTP status, drops body', () => {
  assert.equal(redactProviderError(null, { provider: 'FAL', status: 429 }), 'FAL 429');
  assert.equal(redactProviderError(null, { provider: 'OpenAI', status: 401 }), 'OpenAI 401');
});

test('redactProviderError strips PII / secret-bearing message bodies', () => {
  const out = redactProviderError(
    new Error('Incorrect API key sk-proj-ABCDEFGH12345678 for child Lucas (photo lucas-face.jpg)'),
    { provider: 'OpenAI' },
  );
  assert.doesNotMatch(out, /sk-proj/);
  assert.doesNotMatch(out, /Lucas/);
  assert.doesNotMatch(out, /Incorrect/);
  assert.doesNotMatch(out, /lucas-face/);
  assert.match(out, /OpenAI/);
});

test('redactProviderError sniffs HTTP status off an error-like object', () => {
  assert.equal(redactProviderError({ status: 503 }, { provider: 'OpenAI' }), 'OpenAI 503');
});

test('redactProviderError falls back to a stable classifier when nothing is known', () => {
  assert.equal(redactProviderError(null), 'provider_error');
  // A raw string is never echoed back — only the classifier survives.
  assert.equal(redactProviderError('raw body with sk-proj-ABCDEFGH12345678 and child Lucas'), 'provider_error');
});

test('FAL provider HTTP failure persists only a redacted classifier (no body)', async () => {
  const prev = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key';
  try {
    const fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited: key fal-SECRETTOKEN1234 for child Lucas',
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;
    const r = await falImageProvider.generate({ prompt: 'p' }, { fetch });
    assert.equal(r.error, 'FAL 429');
    assert.doesNotMatch(r.error ?? '', /Lucas|fal-SECRET|rate limited/);
  } finally {
    if (prev === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = prev;
  }
});

test('FAL provider thrown error persists provider classifier, not the message', async () => {
  const prev = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key';
  try {
    const fetch = (async () => {
      throw new Error('connect failed to 10.0.0.1 while rendering child Lucas');
    }) as unknown as typeof globalThis.fetch;
    const r = await falImageProvider.generate({ prompt: 'p' }, { fetch });
    assert.doesNotMatch(r.error ?? '', /Lucas/);
    assert.doesNotMatch(r.error ?? '', /10\.0\.0\.1/);
    assert.match(r.error ?? '', /FAL/);
  } finally {
    if (prev === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = prev;
  }
});
