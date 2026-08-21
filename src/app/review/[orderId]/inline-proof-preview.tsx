'use client';

import { useEffect, useRef, useState } from 'react';

type Props = {
  proofUrl: string | null;
  isPrint: boolean;
  /** Number of illustrated story pages above this preview block. Used to
   *  describe the proof relationship truthfully — print proofs include the
   *  cover, intentional matter pages, and any safety-net keepsake pages
   *  beyond just the illustrated story pages. Defaults to a generic
   *  "illustrated story pages" mention if omitted (legacy callers). */
  illustratedPageCount?: number;
  testId?: string;
};

/**
 * Inline preview of the full assembled proof PDF.
 *
 * - Lazy-mounts the <iframe> only after the section scrolls into view, so the
 *   initial /review render is not blocked on the PDF download.
 * - Uses native browser PDF rendering via <iframe>. This is reliable on
 *   desktop Chrome / Firefox / Safari and on Android Chrome. iOS Safari and
 *   in-app webviews (Instagram, Facebook, Gmail) are inconsistent — for
 *   those users the explicit "Open in new tab" / "Download" CTAs below the
 *   iframe are the supported path.
 * - Handles missing proof gracefully with an explicit shell.
 */
export function InlineProofPreview({ proofUrl, isPrint, illustratedPageCount, testId = 'inline-proof-preview' }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldMount, setShouldMount] = useState(false);
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!containerRef.current || shouldMount) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Old browser — skip lazy-mount, render immediately.
      setShouldMount(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShouldMount(true);
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(containerRef.current);
    return () => io.disconnect();
  }, [shouldMount]);

  // Detect environments where inline <iframe> PDF rendering is known to be
  // unreliable (iOS Safari, most in-app webviews). We render the shell + the
  // explicit Open/Download CTAs in those cases instead of the broken iframe.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua);
    const inAppWebview =
      /(FBAN|FBAV|Instagram|Line|MicroMessenger|Twitter|GSA|Snapchat)/i.test(ua);
    if (iOS || inAppWebview) setIframeBlocked(true);
  }, []);

  if (!proofUrl) {
    return (
      <section
        className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"
        data-testid={`${testId}-missing`}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">
          Full assembled proof
        </p>
        <p className="mt-1 text-sm text-amber-900">
          The full proof PDF isn&apos;t ready yet — it appears here automatically once
          page generation finishes. Refresh in a moment.
        </p>
      </section>
    );
  }

  return (
    <section
      ref={containerRef}
      className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      data-testid={testId}
    >
      <div className="mb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Full assembled proof
        </p>
        <h2 className="mt-1 font-serif text-xl text-[#10263d]">
          {isPrint ? 'Complete print proof' : 'Complete assembled PDF'}
        </h2>
        <p className="mt-1 text-xs text-gray-600">
          {isPrint
            ? `This is the full assembled book that will be printed — including the cover, intentional title/dedication/end-note pages, and any keepsake pages added if needed to meet the printer\u2019s minimum length. The ${illustratedPageCount ?? ''}${illustratedPageCount ? ' ' : ''}illustrated story pages above are part of this proof, not the whole book.`.replace(/\s+/g, ' ').trim()
            : 'This is the full assembled PDF that was emailed to you.'}
        </p>
      </div>

      {/* Embedded preview (desktop + Android Chrome). On iOS / in-app webviews
          we skip the iframe and rely on the CTAs below. */}
      {!iframeBlocked && shouldMount && (
        <div
          className="relative mb-3 w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50"
          style={{ height: 'min(80vh, 720px)' }}
        >
          {!loaded && (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-500"
              aria-hidden
            >
              Loading proof preview…
            </div>
          )}
          {/* eslint-disable-next-line jsx-a11y/iframe-has-title */}
          <iframe
            src={`${proofUrl}#view=FitH&toolbar=1`}
            title="Full assembled proof PDF"
            className="h-full w-full"
            onLoad={() => setLoaded(true)}
            data-testid={`${testId}-iframe`}
          />
        </div>
      )}

      {iframeBlocked && (
        <div
          className="mb-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-900"
          data-testid={`${testId}-fallback-notice`}
        >
          Inline preview isn&apos;t supported in this browser. Use the buttons below to
          open or download the full proof PDF.
        </div>
      )}

      <div className="flex flex-wrap gap-3" data-testid={`${testId}-ctas`}>
        <a
          href={proofUrl}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 rounded-xl border-2 border-[#10263d] bg-[#10263d] px-4 py-2 text-sm font-semibold text-white"
          data-testid={`${testId}-open`}
        >
          📄 Open in new tab
        </a>
        <a
          href={proofUrl}
          download
          className="inline-flex items-center gap-2 rounded-xl border-2 border-gray-200 px-4 py-2 text-sm font-semibold text-[#10263d] hover:bg-gray-50"
          data-testid={`${testId}-download`}
        >
          ⬇ Download PDF
        </a>
      </div>
    </section>
  );
}
