import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isCheckoutStoryMediaEnabled } from '../src/lib/checkout-direct-flags.ts';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const checkoutPageSource = readFileSync('src/app/checkout/page.tsx', 'utf8');
const playwrightSource = readFileSync('playwright.config.ts', 'utf8');
const env = (values: Record<string, string | undefined>) => values as unknown as NodeJS.ProcessEnv;

test('Custom Story text stays available while audio/document controls require server persistence capability', () => {
  assert.doesNotMatch(checkoutFormSource, /NEXT_PUBLIC_HSB_STORY_UPLOAD/);
  assert.match(checkoutFormSource, /isCustomStorySelected && \([\s\S]*?data-testid="custom-story-intake-panel"/);
  assert.match(checkoutFormSource, /data-testid="custom-story-intake-panel"[\s\S]*?storyMediaEnabled && \([\s\S]*?<VoiceRecorderSection/);
  assert.match(checkoutPageSource, /storyMediaEnabled=\{isCheckoutStoryMediaEnabled\(\)\}/);
});

test('story media capability fails closed unless persistence is configured', () => {
  assert.equal(isCheckoutStoryMediaEnabled(env({})), false);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    HSB_BLOB_ACCESS_MODE: 'public',
    BLOB_READ_WRITE_TOKEN: 'token',
  })), false);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    HSB_BLOB_ACCESS_MODE: 'private',
    BLOB_READ_WRITE_TOKEN: '',
  })), false);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    HSB_BLOB_ACCESS_MODE: 'private',
    BLOB_READ_WRITE_TOKEN: 'token',
  })), true);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
  })), false);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    HSB_BLOB_ACCESS_MODE: 'private',
    BLOB_READ_WRITE_TOKEN: 'token',
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
  })), true);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'false',
  })), false);
  assert.equal(isCheckoutStoryMediaEnabled(env({
    HSB_E2E_STORY_MEDIA_ENABLED: 'true',
    HSB_ORDER_STORE_DIR: '/tmp/project/.e2e-store',
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
  })), true);
});

test('hermetic browser QA enables media UI without restoring Blob credentials', () => {
  assert.match(playwrightSource, /HSB_E2E_STORY_MEDIA_ENABLED: 'true'/);
  assert.doesNotMatch(playwrightSource, /BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_privstore_testonly'/);
});
