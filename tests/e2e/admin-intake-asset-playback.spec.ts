/**
 * Chromium regression for the one thing only a browser can decide: whether the
 * policy the intake-asset route sends with a voice note lets an operator
 * actually play it.
 *
 * The route serves audio `inline`, so a browser opens the URL as a MEDIA
 * DOCUMENT: Chromium synthesises a document containing a media element whose
 * source is that same URL, and governs that element's fetch with the CSP the
 * response itself carried. Under `default-src 'none'` with no media allowance
 * the element is refused, the player sits at readyState 0, and §4.4 of the
 * manual Custom Story runbook advertises a workflow that cannot happen. A unit
 * assertion on the header string cannot see any of that — only a real engine
 * applying the policy can.
 *
 * Nothing here reaches a real order, a credential, or a provider. The bytes are
 * a WAV synthesised in-process and the response is fulfilled by Playwright at
 * the same-origin URL; the live server is used only to confirm that the route
 * an operator would really call sends the strict refusal policy.
 */
import { test, expect } from './fixtures.ts';
import { intakeAssetContentSecurityPolicy } from '../../src/lib/admin-intake-asset-route-handler.ts';

const ASSET_URL = `/api/admin/orders/ord_e2e_playback/intake-assets/asset_${'a'.repeat(32)}`;

/** The policy this correction replaced. Kept only as the negative control. */
const PRE_FIX_POLICY =
  "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A real, decodable 16-bit PCM WAV — `audio/wav` is an accepted intake MIME. */
function wavBytes(seconds = 0.25, sampleRate = 8000): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const samples = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    samples.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

const WAV = wavBytes();

/**
 * Serve the WAV at the route's own URL with the route's own response shape.
 * Only the policy under test varies between the two cases below.
 */
async function serveVoiceNote(page: import('@playwright/test').Page, policy: string) {
  await page.route(`**${ASSET_URL}`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(WAV.byteLength),
        'Content-Disposition': 'inline; filename="hsb-intake-voice.wav"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy': policy,
      },
      body: WAV,
    });
  });
}

function cspViolations(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

test('a voice note served under the route policy reaches a playable readyState', async ({ page }) => {
  const violations = cspViolations(page);
  await serveVoiceNote(page, intakeAssetContentSecurityPolicy('audio'));

  await page.goto(ASSET_URL);

  const player = page.locator('video, audio');
  await expect(player).toHaveCount(1);
  // HAVE_ENOUGH_DATA. A quarter second of PCM is fully buffered, so anything
  // short of it means the element never got its bytes.
  await expect
    .poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState))
    .toBe(4);
  expect(violations, 'playback must not depend on a policy the browser reports as violated')
    .toEqual([]);
});

test('NEGATIVE CONTROL: the pre-fix policy leaves the same WAV unloadable', async ({ page }) => {
  // Not a claim that this policy is correct — it is the bug. This case exists
  // so the assertion above cannot pass vacuously: if Chromium ever stopped
  // enforcing the policy on a media document, this test would go green and
  // announce that the one above proves nothing.
  const violations = cspViolations(page);
  await serveVoiceNote(page, PRE_FIX_POLICY);

  await page.goto(ASSET_URL);

  await expect.poll(() => violations.length).toBeGreaterThan(0);
  expect(violations.join('\n')).toMatch(/media/i);
  const player = page.locator('video, audio');
  expect(await player.evaluate((element: HTMLMediaElement) => element.readyState)).toBe(0);
});

test('the live route still refuses an unauthenticated read under the strict policy', async ({ request }) => {
  const response = await request.get(ASSET_URL, { failOnStatusCode: false });

  expect(response.status()).toBe(401);
  const served = response.headers()['content-security-policy'];
  expect(served).toBe(intakeAssetContentSecurityPolicy(null));
  expect(served, 'the media allowance belongs to audio bytes, not to a refusal').not.toContain('media-src');
});
