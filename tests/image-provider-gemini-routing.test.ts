/**
 * Orchestrator-level routing contract for the direct Gemini image path.
 *
 * Asserts the chain composition that `defaultProviderOrder` produces for
 * each combination of:
 *   - reference photo present / absent
 *   - HSB_ENABLE_GEMINI_IMAGE on / off
 *   - GOOGLE_GEMINI_API_KEY set / unset
 *   - HSB_GEMINI_IMAGE_FAL_FALLBACK on / off
 *
 * The contract from the brief:
 *   1. Direct Gemini/Google is primary when configured.
 *   2. FAL fallback is allowed only when Gemini is unavailable/blocked AND
 *      `HSB_GEMINI_IMAGE_FAL_FALLBACK=true` is set.
 *   3. No accidental OpenAI route for photo-conditioned page images.
 *   4. Missing Gemini config fails safely — falls back to the legacy
 *      Seedream/FAL chain rather than silently doing nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultProviderOrder } from '../src/lib/image-generator.ts';

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T,
): T {
  const originals: Record<string, string | undefined> = {};
  const keys = [
    'HSB_ENABLE_GEMINI_IMAGE',
    'HSB_GEMINI_IMAGE_FAL_FALLBACK',
    'GOOGLE_GEMINI_API_KEY',
    'HSB_ENABLE_OPENAI_IMAGE',
  ];
  for (const key of keys) originals[key] = process.env[key];
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = originals[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('routing: photo absent → empty chain regardless of Gemini gate state', () => {
  withEnv(
    { HSB_ENABLE_GEMINI_IMAGE: 'true', GOOGLE_GEMINI_API_KEY: 'k' },
    () => {
      const chain = defaultProviderOrder({ prompt: 'p' });
      assert.equal(chain.length, 0, 'photo-absent branch must never produce a chain');
    },
  );
});

test('routing: gate OFF → legacy [seedream, fal_edit] chain unchanged', () => {
  withEnv(
    {
      HSB_ENABLE_GEMINI_IMAGE: undefined,
      GOOGLE_GEMINI_API_KEY: 'k',
      HSB_GEMINI_IMAGE_FAL_FALLBACK: undefined,
    },
    () => {
      const chain = defaultProviderOrder({
        prompt: 'p',
        referenceImageUrl: 'https://photos/kid.jpg',
      });
      assert.equal(chain.length, 2);
      // Legacy chain. Note both Seedream + Nano Banana edit providers use
      // the same provider name 'fal_edit' (they both go through fal.run),
      // so identity is the only reliable assertion here.
      assert.notEqual(chain[0]!.name, 'gemini', 'gemini must not appear when gate is off');
      assert.notEqual(chain[1]!.name, 'gemini', 'gemini must not appear when gate is off');
    },
  );
});

test('routing: gate ON, key MISSING → falls back to legacy chain (fails safely)', () => {
  withEnv(
    { HSB_ENABLE_GEMINI_IMAGE: 'true', GOOGLE_GEMINI_API_KEY: undefined },
    () => {
      const chain = defaultProviderOrder({
        prompt: 'p',
        referenceImageUrl: 'https://photos/kid.jpg',
      });
      assert.equal(chain.length, 2);
      for (const p of chain) {
        assert.notEqual(p.name, 'gemini', 'gemini must not appear when key is missing');
      }
    },
  );
});

test('routing: gate ON + key set + fallback OFF → [gemini] only, FAL not in chain', () => {
  withEnv(
    {
      HSB_ENABLE_GEMINI_IMAGE: 'true',
      GOOGLE_GEMINI_API_KEY: 'k',
      HSB_GEMINI_IMAGE_FAL_FALLBACK: undefined,
    },
    () => {
      const chain = defaultProviderOrder({
        prompt: 'p',
        referenceImageUrl: 'https://photos/kid.jpg',
      });
      assert.equal(chain.length, 1, 'chain must contain only gemini when fallback flag is off');
      assert.equal(chain[0]!.name, 'gemini');
    },
  );
});

test('routing: gate ON + key set + fallback ON → [gemini, seedream, fal_edit] in that order', () => {
  withEnv(
    {
      HSB_ENABLE_GEMINI_IMAGE: 'true',
      GOOGLE_GEMINI_API_KEY: 'k',
      HSB_GEMINI_IMAGE_FAL_FALLBACK: 'true',
    },
    () => {
      const chain = defaultProviderOrder({
        prompt: 'p',
        referenceImageUrl: 'https://photos/kid.jpg',
      });
      assert.equal(chain.length, 3, 'chain must include gemini + both FAL providers');
      assert.equal(chain[0]!.name, 'gemini', 'gemini must be primary');
      // Both fallback providers use name 'fal_edit' today (Seedream and
      // Nano Banana both go through fal.run). Their order is enforced by
      // PHOTO_EDIT_CHAIN in image-generator.ts — Seedream first.
      assert.equal(chain[1]!.name, 'fal_edit');
      assert.equal(chain[2]!.name, 'fal_edit');
    },
  );
});

test('routing: gate ON + empty-string key → falls back to legacy chain', () => {
  withEnv(
    { HSB_ENABLE_GEMINI_IMAGE: 'true', GOOGLE_GEMINI_API_KEY: '   ' },
    () => {
      const chain = defaultProviderOrder({
        prompt: 'p',
        referenceImageUrl: 'https://photos/kid.jpg',
      });
      for (const p of chain) {
        assert.notEqual(p.name, 'gemini', 'whitespace-only key must not count as configured');
      }
      assert.equal(chain.length, 2);
    },
  );
});

test('routing: imageUrls array (no referenceImageUrl) also triggers Gemini primary when gated on', () => {
  withEnv(
    { HSB_ENABLE_GEMINI_IMAGE: 'true', GOOGLE_GEMINI_API_KEY: 'k' },
    () => {
      const chain = defaultProviderOrder({
        prompt: 'p',
        imageUrls: ['https://photos/kid.jpg'],
      });
      assert.equal(chain.length, 1);
      assert.equal(chain[0]!.name, 'gemini');
    },
  );
});

test('routing: gate ON + fallback ON does not introduce an openai provider', () => {
  withEnv(
    {
      HSB_ENABLE_GEMINI_IMAGE: 'true',
      GOOGLE_GEMINI_API_KEY: 'k',
      HSB_GEMINI_IMAGE_FAL_FALLBACK: 'true',
      HSB_ENABLE_OPENAI_IMAGE: 'true',
    },
    () => {
      const chain = defaultProviderOrder({
        prompt: 'p',
        referenceImageUrl: 'https://photos/kid.jpg',
      });
      for (const p of chain) {
        assert.notEqual(p.name, 'openai', 'default chain must never include OpenAI');
      }
    },
  );
});
