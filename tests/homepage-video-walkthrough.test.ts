import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const componentSource = readFileSync(
  new URL('../src/components/homepage-walkthrough.tsx', import.meta.url),
  'utf8',
);
const homeSource = readFileSync(new URL('../src/components/editorial-site.tsx', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');
const checkoutFormSource = readFileSync(
  new URL('../src/app/checkout/checkout-form.tsx', import.meta.url),
  'utf8',
);
const checkoutPageSource = readFileSync(new URL('../src/app/checkout/page.tsx', import.meta.url), 'utf8');

const ASSET_DIR = 'public/assets/photo-guide/homepage';

// ── Placement ──────────────────────────────────────────────────────────────
test('walkthrough is mounted immediately after "How it works" and before the photo guide', () => {
  const howIdx = homeSource.indexOf('<HowItWorksSection />');
  const walkIdx = homeSource.indexOf('<HomepageWalkthrough />');
  const guideIdx = homeSource.indexOf('<PhotoSubmissionGuide />');
  assert.ok(howIdx > -1, 'HowItWorksSection present');
  assert.ok(walkIdx > -1, 'HomepageWalkthrough present');
  assert.ok(guideIdx > -1, 'PhotoSubmissionGuide present');
  assert.ok(howIdx < walkIdx && walkIdx < guideIdx, 'order is How it works → walkthrough → photo guide');
  assert.match(homeSource, /import \{ HomepageWalkthrough \} from '@\/components\/homepage-walkthrough'/);
});

test('real hero and existing "How it works" heading are untouched', () => {
  assert.match(homeSource, /A custom book without the custom-project chaos\./);
  assert.match(homeSource, /Your child becomes <em[^>]*>the hero<\/em> of the story\./);
  assert.match(homeSource, /<PhotoSubmissionGuide \/>/); // existing 9:16 guide still rendered
});

// ── Checkout stays video-module-free ─────────────────────────────────────────
test('checkout does not include the homepage walkthrough module', () => {
  assert.doesNotMatch(checkoutFormSource, /HomepageWalkthrough/);
  assert.doesNotMatch(checkoutPageSource, /HomepageWalkthrough/);
});

// ── Assets present, canonical names ──────────────────────────────────────────
test('all final 16:9 assets are staged under the contract directory', () => {
  for (const f of [
    'photo-walkthrough-landscape.mp4',
    'photo-walkthrough-landscape.webm',
    'photo-walkthrough-poster.avif',
    'photo-walkthrough-poster.webp',
    'photo-walkthrough-poster.jpg',
    'photo-walkthrough-transcript.txt',
  ]) {
    assert.ok(existsSync(`${ASSET_DIR}/${f}`), `${f} exists`);
  }
});

test('no old 9:16 master or placeholder media is referenced by the new module', () => {
  assert.doesNotMatch(componentSource, /photo-submission-walkthrough\.mp4/);
  assert.doesNotMatch(componentSource, /walkthrough-poster\.png/);
  assert.doesNotMatch(componentSource, /placehold\.co/);
});

// ── Poster-first + lazy mount ────────────────────────────────────────────────
test('poster-first: <picture> with AVIF/WebP/JPG and reserved 16:9 box', () => {
  assert.match(componentSource, /<picture>/);
  assert.match(componentSource, /type="image\/avif"/);
  assert.match(componentSource, /type="image\/webp"/);
  assert.match(componentSource, /POSTER_JPG/);
  assert.match(componentSource, /aspect-video/);
  assert.match(componentSource, /width=\{POSTER_WIDTH\}/);
  assert.match(componentSource, /height=\{POSTER_HEIGHT\}/);
});

test('video mounts only on interaction or near-viewport, never eager, never loading=lazy', () => {
  // Video element is conditionally rendered behind `mounted` state.
  assert.match(componentSource, /const \[mounted, setMounted\] = useState\(false\)/);
  assert.match(componentSource, /\{mounted && !errored && \(/); // video layer gated on mount
  assert.match(componentSource, /new IntersectionObserver/);
  assert.match(componentSource, /rootMargin: '200px 0px'/); // near-viewport mount
  assert.match(componentSource, /preload="metadata"/);
  // native <video> has no loading="lazy"; it must not be used or documented.
  assert.doesNotMatch(componentSource, /loading=["']lazy["']/);
});

test('poster/loading layer stays until the video paints a frame (no black flash), no layout shift', () => {
  // Readiness state + handlers that flip it on a real frame.
  assert.match(componentSource, /const \[videoReady, setVideoReady\] = useState\(false\)/);
  assert.match(componentSource, /onLoadedData=\{handleReady\}/);
  assert.match(componentSource, /onCanPlay=\{handleReady\}/);
  assert.match(componentSource, /onPlaying=\{handleReady\}/);
  assert.match(componentSource, /setVideoReady\(true\)/);
  // Poster is NOT swapped out when the video mounts — it co-exists on top and
  // fades only when videoReady. (No showVideo ternary that unmounts the poster.)
  assert.doesNotMatch(componentSource, /showVideo/);
  assert.match(componentSource, /videoReady \? 'opacity-0 pointer-events-none' : 'opacity-100'/);
  // Fade is opacity-only over an absolutely-positioned layer => no layout shift,
  // and is suppressed under reduced motion.
  assert.match(componentSource, /transition-opacity[^`']*motion-reduce:transition-none/);
  // Hard error resets readiness so the poster/notice path is correct.
  assert.match(componentSource, /setVideoReady\(false\)/);
});

test('sources are WebM then MP4 (WebM→MP4 fallback)', () => {
  const webmIdx = componentSource.indexOf('VIDEO_WEBM');
  const mp4Idx = componentSource.indexOf('VIDEO_MP4');
  assert.ok(webmIdx > -1 && mp4Idx > -1);
  assert.match(componentSource, /<source src=\{VIDEO_WEBM\} type="video\/webm" \/>/);
  assert.match(componentSource, /<source src=\{VIDEO_MP4\} type="video\/mp4" \/>/);
});

// ── Accessibility ────────────────────────────────────────────────────────────
test('accessible play control: real <button>, accessible name, visible focus, >=44px', () => {
  assert.match(componentSource, /<button/);
  assert.match(componentSource, /aria-label="Play the 36-second photo-to-story walkthrough"/);
  assert.match(componentSource, /group-focus-visible:ring/);
  assert.match(componentSource, /h-16 w-16/); // 64px target ≥ 44px
});

test('transcript is reachable without playback and describes the silent video honestly', () => {
  assert.match(componentSource, /<details/);
  assert.match(componentSource, /Read the transcript/);
  assert.match(componentSource, /no audio|silent/i);
  assert.match(componentSource, /Open the full text transcript/);
  // silent video: no invented empty captions track.
  assert.doesNotMatch(componentSource, /\.vtt/);
  assert.doesNotMatch(componentSource, /kind="captions"/);
});

test('reduced motion: decorative transitions removed under prefers-reduced-motion', () => {
  assert.match(componentSource, /motion-reduce:transition-none/);
});

test('no-JavaScript fallback renders a native controlled player and hides the JS poster', () => {
  assert.match(componentSource, /<noscript>/);
  assert.match(componentSource, /\.hsb-vw-jsonly\{display:none!important\}/);
  assert.match(componentSource, /<video\s+[\s\S]*?controls/);
});

test('video-error falls back to poster + transcript, not a broken box', () => {
  assert.match(componentSource, /onError=\{handleError\}/);
  assert.match(componentSource, /setErrored\(true\)/);
  assert.match(componentSource, /could not be played/i);
});

// ── Analytics contract ───────────────────────────────────────────────────────
test('analytics union declares the seven one-shot video events', () => {
  for (const ev of [
    'video_impression',
    'video_play',
    'video_25',
    'video_50',
    'video_75',
    'video_complete',
    'video_cta_click',
  ]) {
    assert.match(analyticsSource, new RegExp(`'${ev}'`), `${ev} in HsbEventName`);
  }
});

test('module extends the existing typed layer (no second tracker) with agreed props', () => {
  assert.match(componentSource, /from '@\/lib\/analytics'/);
  assert.match(componentSource, /\btrack\(event,/);
  assert.match(componentSource, /video_id: VIDEO_ID/);
  assert.match(componentSource, /placement: PLACEMENT/);
  assert.match(componentSource, /duration_seconds:/);
  assert.match(componentSource, /muted:/);
  assert.match(componentSource, /source_format/);
  assert.equal(componentSource.includes('homepage_photo_walkthrough_v1'), true);
  assert.equal(componentSource.includes('homepage_after_how_it_works'), true);
});

test('one-shot semantics guard against seek/pause/replay and strict-mode remount', () => {
  // local guard set + defensive dedupe against the shared buffer
  assert.match(componentSource, /firedRef\.current\.has\(event\)/);
  assert.match(componentSource, /window\.hsbEvents\.some\(\(r\) => r\.event === event && r\.video_id === VIDEO_ID\)/);
  // play fires once, from the initial state — not on every resumed play event
  assert.match(componentSource, /emitOnce\('video_play'\)/);
  // quartiles are threshold-based and each fires once regardless of seeking back
  assert.match(componentSource, /ratio >= 0\.25.*emitOnce\('video_25'\)/);
  assert.match(componentSource, /ratio >= 0\.5.*emitOnce\('video_50'\)/);
  assert.match(componentSource, /ratio >= 0\.75.*emitOnce\('video_75'\)/);
  assert.match(componentSource, /emitOnce\('video_complete'\)/);
});

test('impression requires >=50% visibility for >=1s', () => {
  assert.match(componentSource, /intersectionRatio >= 0\.5/);
  assert.match(componentSource, /setTimeout\(\(\) => \{\s*emitOnce\('video_impression'\)/);
  assert.match(componentSource, /1000\)/);
});

test('CTA is subordinate, reuses approved copy/destination, and fires before navigation', () => {
  assert.match(componentSource, /href="\/checkout"/);
  assert.match(componentSource, /Start your story/);
  assert.match(componentSource, /onClick=\{handleCtaClick\}/);
  assert.match(componentSource, /emitOnce\('video_cta_click'\)/);
  // subordinate styling: bordered ghost, not the black pill
  assert.match(componentSource, /rounded-full border border-\[#c9b891\]/);
});

// ── Runtime: the new events flow through the real analytics layer, no PII ─────
test('video events forward through track() to the buffer and gtag with non-PII props', async () => {
  const calls: unknown[][] = [];
  const storage = new Map<string, string>();
  const mockWindow: Record<string, unknown> = {
    location: new URL('https://herostorybooks.com/?childName=PrivateName'),
    gtag: (...args: unknown[]) => calls.push(args),
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  };
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: '' } });

  try {
    const { track } = await import('../src/lib/analytics.ts');
    const common = {
      video_id: 'homepage_photo_walkthrough_v1',
      placement: 'homepage_after_how_it_works',
      duration_seconds: 36,
      muted: false,
      source_format: 'webm',
    };
    track('video_impression', common);
    track('video_play', common);
    track('video_complete', common);

    const buffer = (mockWindow.hsbEvents as { event: string; video_id?: string }[]) ?? [];
    const names = buffer.map((r) => r.event);
    assert.ok(names.includes('video_impression'));
    assert.ok(names.includes('video_play'));
    assert.ok(names.includes('video_complete'));

    const impression = buffer.find((r) => r.event === 'video_impression') as Record<string, unknown>;
    assert.equal(impression.video_id, 'homepage_photo_walkthrough_v1');
    assert.equal(impression.placement, 'homepage_after_how_it_works');
    assert.equal(impression.duration_seconds, 36);

    const gtagEvents = calls.filter((c) => c[0] === 'event').map((c) => c[1]);
    assert.ok(gtagEvents.includes('video_impression'));

    const serialized = JSON.stringify({ calls, buffer });
    assert.doesNotMatch(serialized, /PrivateName|childName/); // no PII leaks in props
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
});
