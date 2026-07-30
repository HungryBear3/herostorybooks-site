'use client';

// Homepage 16:9 photo-to-story walkthrough.
//
// Preview-only module mounted on the editorial homepage immediately after the
// "How it works" section. It is deliberately poster-first: the initial render
// ships only the <picture> poster inside a reserved 16:9 box and never requests
// video bytes. The real <video> is mounted only after an explicit play
// interaction or when the module comes near the viewport (IntersectionObserver).
//
// The delivered edit is silent by design (no audio stream), so there is no
// WebVTT caption track — all meaning is on-screen text and is reproduced in the
// transcript <details> below, which is reachable without playing anything.
//
// Analytics extends the existing typed HSB layer (src/lib/analytics.ts). Every
// funnel event here is one-shot per page view and never throws into playback.

import { useCallback, useEffect, useRef, useState } from 'react';
import { track, type HsbEventName } from '@/lib/analytics';

const ASSET_BASE = '/assets/photo-guide/homepage';
const POSTER_AVIF = `${ASSET_BASE}/photo-walkthrough-poster.avif`;
const POSTER_WEBP = `${ASSET_BASE}/photo-walkthrough-poster.webp`;
const POSTER_JPG = `${ASSET_BASE}/photo-walkthrough-poster.jpg`;
const VIDEO_WEBM = `${ASSET_BASE}/photo-walkthrough-landscape.webm`;
const VIDEO_MP4 = `${ASSET_BASE}/photo-walkthrough-landscape.mp4`;
const TRANSCRIPT_TXT = `${ASSET_BASE}/photo-walkthrough-transcript.txt`;

const VIDEO_ID = 'homepage_photo_walkthrough_v1';
const PLACEMENT = 'homepage_after_how_it_works';
const DURATION_SECONDS = 36;
const POSTER_WIDTH = 1920;
const POSTER_HEIGHT = 1080;

// The on-screen text of the silent walkthrough, in playback order. This mirrors
// the delivered transcript and is what the transcript disclosure exposes without
// requiring playback.
const TRANSCRIPT_SEQUENCE: { time: string; lines: string[] }[] = [
  { time: '0:00', lines: ['Not sure which photos to upload?', 'Here’s how Hero Story Books works.'] },
  { time: '0:04', lines: ['Full-body and group photos can help', 'when each face is clear, well-lit, and not too small.'] },
  {
    time: '0:09',
    lines: [
      'For the best likeness',
      '1. Start with one clear, front-facing photo',
      '2. Use natural light and skip filters',
      '3. Add family, siblings, and pets separately',
      '+ Optional guided angles can improve consistency',
    ],
  },
  { time: '0:15', lines: ['Add the people and pets in the story', 'Tell us who should appear—then add clear references.'] },
  { time: '0:19', lines: ['Upload from your phone', 'Your photos stay private and are used only for your book.'] },
  { time: '0:24', lines: ['PHOTO → STORY', 'We create the character and story', 'then hand-review the proof before print.'] },
  {
    time: '0:30',
    lines: [
      'You stay in control',
      '1. Receive a private digital proof',
      '2. Review every page',
      '3. Approve it—or request changes',
      '4. Printing waits for your approval',
    ],
  },
];

function sourceFormatOf(video: HTMLVideoElement | null): 'webm' | 'mp4' | undefined {
  const src = video?.currentSrc ?? '';
  if (src.endsWith('.webm')) return 'webm';
  if (src.endsWith('.mp4')) return 'mp4';
  return undefined;
}

export function HomepageWalkthrough() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // `mounted` swaps the poster layer for a real <video>. `started` means the
  // user has initiated playback at least once (controls stay visible after).
  const [mounted, setMounted] = useState(false);
  const [started, setStarted] = useState(false);
  const [errored, setErrored] = useState(false);

  // Play once the <video> element exists after an explicit play interaction.
  const wantPlayRef = useRef(false);
  // One-shot guards. Also cross-checked against window.hsbEvents so React strict
  // mode remounts (and any accidental double-mount) never duplicate a first-view
  // event.
  const firedRef = useRef<Set<HsbEventName>>(new Set());

  const emitOnce = useCallback(
    (event: HsbEventName, extra: Record<string, string | number | boolean | null | undefined> = {}) => {
      if (firedRef.current.has(event)) return;
      // Defensive dedupe across remounts: if an event with this name already
      // exists for this video_id in the buffer, treat it as fired.
      try {
        if (
          typeof window !== 'undefined' &&
          Array.isArray(window.hsbEvents) &&
          window.hsbEvents.some((r) => r.event === event && r.video_id === VIDEO_ID)
        ) {
          firedRef.current.add(event);
          return;
        }
      } catch {
        /* never throw from analytics guard */
      }
      firedRef.current.add(event);
      const video = videoRef.current;
      track(event, {
        video_id: VIDEO_ID,
        placement: PLACEMENT,
        duration_seconds: video && Number.isFinite(video.duration) && video.duration > 0
          ? Math.round(video.duration)
          : DURATION_SECONDS,
        muted: video ? video.muted : false,
        ...(sourceFormatOf(video) ? { source_format: sourceFormatOf(video) } : {}),
        ...extra,
      });
    },
    [],
  );

  // Impression: fire once when >=50% of the module is visible for >=1s.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let visibleTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (visibleTimer == null) {
              visibleTimer = setTimeout(() => {
                emitOnce('video_impression');
              }, 1000);
            }
          } else if (visibleTimer != null) {
            clearTimeout(visibleTimer);
            visibleTimer = null;
          }
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(el);
    return () => {
      if (visibleTimer != null) clearTimeout(visibleTimer);
      observer.disconnect();
    };
  }, [emitOnce]);

  // Near-viewport mount: bring the <video> element into the tree (preload
  // metadata) before the user reaches it, without ever autoplaying.
  useEffect(() => {
    if (mounted) return;
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setMounted(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted]);

  // Honor a pending explicit play once the <video> is in the DOM.
  useEffect(() => {
    if (!mounted || !wantPlayRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const attempt = video.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => {
        // Autoplay/policy rejection: leave controls + poster usable, no throw.
      });
    }
    wantPlayRef.current = false;
  }, [mounted]);

  const handlePlayClick = useCallback(() => {
    setStarted(true);
    setErrored(false);
    emitOnce('video_play');
    if (mounted && videoRef.current) {
      const attempt = videoRef.current.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } else {
      wantPlayRef.current = true;
      setMounted(true);
    }
  }, [emitOnce, mounted]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const ratio = video.currentTime / video.duration;
    if (ratio >= 0.25) emitOnce('video_25');
    if (ratio >= 0.5) emitOnce('video_50');
    if (ratio >= 0.75) emitOnce('video_75');
  }, [emitOnce]);

  const handleEnded = useCallback(() => {
    emitOnce('video_complete');
  }, [emitOnce]);

  const handleError = useCallback(() => {
    // Whole-video failure (both sources unusable): drop back to the poster with
    // the transcript still available. A failed <source> that still has a working
    // fallback source does not bubble here.
    setErrored(true);
    setStarted(false);
  }, []);

  const handleCtaClick = useCallback(() => {
    emitOnce('video_cta_click');
  }, [emitOnce]);

  const showVideo = mounted && !errored;

  return (
    <section
      ref={sectionRef}
      id="walkthrough"
      aria-labelledby="walkthrough-title"
      className="mx-auto max-w-6xl px-5 pt-6 pb-12 md:px-8 md:pt-8 md:pb-16"
    >
      <div className="mx-auto max-w-3xl text-center">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">
          Photo-to-story walkthrough
        </div>
        <h2
          id="walkthrough-title"
          className="font-serif text-4xl font-medium leading-tight tracking-[-0.02em] text-[#1f1a16] md:text-5xl"
        >
          Watch how a photo becomes a story.
        </h2>
        <p className="mt-4 text-base leading-7 text-[#695f54] md:text-lg">
          A silent 36-second walkthrough of choosing a photo, adding your family, and approving a
          proof before anything prints.
        </p>
      </div>

      <figure className="mx-auto mt-8 max-w-4xl">
        {/* Reserved 16:9 box — poster and video share the same frame, so mounting
            the video causes no layout shift. */}
        <div className="hsb-vw-jsonly relative w-full overflow-hidden rounded-[1.75rem] border border-[#d8c6a2] bg-[#1f1a16] shadow-[0_28px_65px_-40px_rgba(31,26,22,0.6)] aspect-video">
          {showVideo ? (
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-contain bg-[#1f1a16]"
              controls={started}
              playsInline
              preload="metadata"
              poster={POSTER_JPG}
              aria-label="Silent 36-second photo-to-story walkthrough"
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
              onError={handleError}
            >
              <source src={VIDEO_WEBM} type="video/webm" />
              <source src={VIDEO_MP4} type="video/mp4" />
            </video>
          ) : (
            <picture>
              <source srcSet={POSTER_AVIF} type="image/avif" />
              <source srcSet={POSTER_WEBP} type="image/webp" />
              <img
                src={POSTER_JPG}
                width={POSTER_WIDTH}
                height={POSTER_HEIGHT}
                alt="Opening frame of the walkthrough: a family standing together, with the text “Not sure which photos to upload? Here’s how Hero Story Books works.”"
                className="absolute inset-0 h-full w-full object-cover"
                decoding="async"
              />
            </picture>
          )}

          {/* Play control — only while not yet started. Real <button>, keyboard
              activatable, >=44px target, visible focus ring. */}
          {!started && (
            <button
              type="button"
              onClick={handlePlayClick}
              className="group absolute inset-0 flex items-center justify-center focus:outline-none motion-reduce:transition-none"
              aria-label="Play the 36-second photo-to-story walkthrough"
            >
              <span className="grid h-16 w-16 place-items-center rounded-full bg-[#1f1a16]/80 text-[#fff8ec] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)] ring-2 ring-white/70 transition group-hover:bg-[#a64c4c] group-focus-visible:ring-4 group-focus-visible:ring-[#a64c4c] motion-reduce:transition-none">
                <svg viewBox="0 0 24 24" className="ml-1 h-7 w-7 fill-current" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </button>
          )}

          {errored && (
            <div className="absolute inset-x-0 bottom-0 bg-[#1f1a16]/85 px-4 py-3 text-center text-xs text-[#fff8ec]">
              The video could not be played. The full walkthrough is written out in the transcript
              below.
            </div>
          )}
        </div>

        {/* No-JavaScript / scripting-disabled fallback: hide the interactive
            poster above and render a native, user-controlled player instead. */}
        <noscript>
          {/* eslint-disable-next-line react/no-unknown-property */}
          <style>{`.hsb-vw-jsonly{display:none!important}`}</style>
          <div className="relative w-full overflow-hidden rounded-[1.75rem] border border-[#d8c6a2] bg-[#1f1a16] shadow-[0_28px_65px_-40px_rgba(31,26,22,0.6)] aspect-video">
            <video
              controls
              playsInline
              preload="none"
              poster={POSTER_JPG}
              className="absolute inset-0 h-full w-full object-contain bg-[#1f1a16]"
              aria-label="Silent 36-second photo-to-story walkthrough"
            >
              <source src={VIDEO_WEBM} type="video/webm" />
              <source src={VIDEO_MP4} type="video/mp4" />
            </video>
          </div>
        </noscript>

        <figcaption className="sr-only">
          Silent 36-second photo-to-story walkthrough. A full text transcript is available below.
        </figcaption>
      </figure>

      {/* Transcript disclosure — reachable without playback, works without JS. */}
      <details className="mx-auto mt-6 max-w-3xl rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] px-5 py-4">
        <summary className="cursor-pointer list-none font-semibold text-[#1f1a16] marker:content-none [&::-webkit-details-marker]:hidden">
          <span className="text-[#a64c4c]">Read the transcript</span>
          <span className="ml-2 text-sm font-normal text-[#695f54]">
            (silent video — every on-screen line, in order)
          </span>
        </summary>
        <div className="mt-4 space-y-4 text-sm leading-6 text-[#695f54]">
          <p className="italic">
            This walkthrough has no audio. Every meaning is conveyed by the on-screen text below, in
            playback order, so no captions track is needed.
          </p>
          <ol className="space-y-3">
            {TRANSCRIPT_SEQUENCE.map((section) => (
              <li key={section.time} className="border-l-2 border-[#d8c6a2] pl-4">
                <span className="mr-2 font-mono text-xs text-[#a64c4c]">{section.time}</span>
                {section.lines.map((line, i) => (
                  <span key={i} className={i === 0 ? 'font-semibold text-[#1f1a16]' : 'block'}>
                    {line}
                  </span>
                ))}
              </li>
            ))}
          </ol>
          <p>
            <a href={TRANSCRIPT_TXT} className="font-semibold text-[#a64c4c] hover:underline">
              Open the full text transcript
            </a>
          </p>
        </div>
      </details>

      {/* Secondary CTA — same approved copy and destination as the primary
          purchase CTA, styled subordinate (ghost, not the black pill). */}
      <div className="mt-6 flex justify-center">
        <a
          href="/checkout"
          onClick={handleCtaClick}
          className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[#c9b891] px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#1f1a16] transition hover:border-[#a64c4c] hover:text-[#a64c4c] motion-reduce:transition-none"
        >
          Start your story
        </a>
      </div>
    </section>
  );
}
