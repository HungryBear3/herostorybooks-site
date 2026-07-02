'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { PageArtifact } from '@/lib/orders';
import { InlineProofPreview } from './inline-proof-preview';

const FEEDBACK_HELPER =
  'Tell us what to change on this page — for example: fix the hands, make the child look happier, brighten the garden, or make the face look more like the uploaded photo.';
const CHANGE_REQUEST_COPY =
  'Your note saves to this proof and pauses final approval until our team marks the page ready again.';

interface Snapshot {
  orderId: string;
  childName: string;
  reviewStatus: 'not_started' | 'in_review' | 'customer_changes_requested' | 'approved';
  pageArtifacts: PageArtifact[];
  storyArtifactUrl: string | null;
  isPrint: boolean;
  bookFormat: 'digital' | 'classic' | 'premium';
  proofReviewedAt: string | null;
  deliveryMode: 'digital' | 'print' | 'combo';
  trustCopy: string;
  openRequestedChangesCount: number;
  customerNudgesPaused: boolean;
}

export default function ReviewClient({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<'idle' | 'requesting' | 'accepting' | 'approving' | 'acknowledging'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proofAck, setProofAck] = useState<boolean>(Boolean(initial.proofReviewedAt));
  const [showApprovalConfirm, setShowApprovalConfirm] = useState(false);

  const pageCount = snapshot.pageArtifacts.length;
  const selected = snapshot.pageArtifacts[selectedIdx];
  const canGoPrevious = selectedIdx > 0;
  const canGoNext = selectedIdx < pageCount - 1;
  const acceptedCount = snapshot.pageArtifacts.filter((p) => p.accepted).length;
  const allAccepted =
    pageCount > 0 &&
    acceptedCount === pageCount;

  const goToPreviousPage = useCallback(() => {
    setSelectedIdx((idx) => Math.max(0, idx - 1));
  }, []);

  const goToNextPage = useCallback(() => {
    setSelectedIdx((idx) => Math.min(Math.max(0, pageCount - 1), idx + 1));
  }, [pageCount]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const tagName = target instanceof HTMLElement ? target.tagName : '';
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT')
      ) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToPreviousPage();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToNextPage();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goToNextPage, goToPreviousPage]);

  async function requestChanges() {
    if (!selected) return;
    if (!feedback.trim()) {
      setError('Add a short note so our team knows what to adjust.');
      return;
    }
    setBusy('requesting');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/order/${snapshot.orderId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request_changes',
          pageIndex: selected.pageIndex,
          note: feedback,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError('We couldn’t save that note just now — nothing on your book changed. Please try again in a moment.');
        return;
      }
      setSnapshot((s) => ({
        ...s,
        pageArtifacts: s.pageArtifacts.map((p) =>
          p.pageIndex === selected.pageIndex ? data.page : p,
        ),
        reviewStatus: 'customer_changes_requested',
        proofReviewedAt: null,
        openRequestedChangesCount: Math.max(
          1,
          s.pageArtifacts.filter((p) =>
            p.pageIndex === selected.pageIndex
              ? true
              : p.customerReviewStatus === 'changes_requested' &&
                p.customerRequestedChange?.lifecycleStatus !== 'resolved',
          ).length,
        ),
        customerNudgesPaused: true,
      }));
      setProofAck(false);
      setFeedback('');
      setNotice('Saved. We\u2019ll review this page before asking for final approval again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy('idle');
    }
  }

  async function accept() {
    if (!selected) return;
    setBusy('accepting');
    setError(null);
    try {
      const res = await fetch(`/api/order/${snapshot.orderId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_page', pageIndex: selected.pageIndex }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError('We couldn’t save that just now — nothing on your book changed. Please try again in a moment.');
        return;
      }
      setSnapshot((s) => ({
        ...s,
        pageArtifacts: s.pageArtifacts.map((p) =>
          p.pageIndex === selected.pageIndex ? data.page : p,
        ),
        openRequestedChangesCount: s.pageArtifacts.filter((p) =>
          p.pageIndex === selected.pageIndex
            ? false
            : p.customerReviewStatus === 'changes_requested' &&
              p.customerRequestedChange?.lifecycleStatus !== 'resolved',
        ).length,
        customerNudgesPaused: s.pageArtifacts.some((p) =>
          p.pageIndex !== selected.pageIndex &&
          p.customerReviewStatus === 'changes_requested' &&
          p.customerRequestedChange?.lifecycleStatus !== 'resolved',
        ),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy('idle');
    }
  }

  return (
    <main className="min-h-screen bg-[#FDF8F4] px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 text-center">
          <h1 className="font-serif text-3xl text-[#10263d]">
            Review {snapshot.childName}&apos;s storybook
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Take your time. You can save your place, come back from your proof email later,
            and approve only when the whole book feels ready.
          </p>
          <p className="mt-2 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-900" data-testid="delivery-trust-copy">
            {snapshot.trustCopy}
          </p>
        </header>

        {/* What you're reviewing — explicit so customers don't think the
            illustrated-page cards below are the entire printed book. */}
        <section
          aria-label="Review scope"
          className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          data-testid="review-scope-banner"
        >
          <p className="font-semibold">Start with the artwork, then review the full book</p>
          <ul className="mt-1.5 list-disc pl-5 leading-relaxed">
            <li>The {snapshot.pageArtifacts.length} cards below are the <strong>illustrated story pages</strong> — check that the text is readable over the art and that the art style feels consistent page to page.</li>
            {snapshot.isPrint ? (
              <li>
                The <strong>full proof PDF</strong> is the complete assembled print proof — including
                the cover and any keepsake pages the printed book needs. Please review the full proof
                before final approval, especially the final pages where style breaks are easiest to miss.
              </li>
            ) : (
              <li>
                Your <strong>final PDF</strong> is the assembled book delivered by email.
                Open it to confirm the full layout looks right.
              </li>
            )}
          </ul>
        </section>

        {/* Thumbnails */}
        <div className="mb-6 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {snapshot.pageArtifacts.map((p, i) => (
            <button
              key={p.pageIndex}
              onClick={() => setSelectedIdx(i)}
              aria-label={`Review page ${p.pageIndex + 1}${p.accepted ? ', accepted' : ''}`}
              title={`Review page ${p.pageIndex + 1}${p.accepted ? ' — accepted' : ''}`}
              className={`relative aspect-[3/4] overflow-hidden rounded-lg border-2 transition ${
                i === selectedIdx ? 'border-[#c9a227]' : 'border-gray-200'
              }`}
              type="button"
            >
              {p.currentImageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={p.currentImageUrl}
                  alt={`Thumbnail preview for page ${p.pageIndex + 1}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-gray-100 text-xs text-gray-400">
No image yet
                </div>
              )}
              <span className="absolute left-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-bold text-[#10263d]">
                {p.pageIndex + 1}
              </span>
              {p.accepted && (
                <span className="absolute right-1 top-1 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Selected page */}
        {selected && (
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500" aria-live="polite">
                  Page {selectedIdx + 1} of {pageCount}
                </p>
                <h2 className="font-serif text-xl text-[#10263d]">
                  Page {selected.pageIndex + 1}
                </h2>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {selected.customerReviewStatus === 'changes_requested' && (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900" data-testid="page-change-status">
                    Changes requested
                  </span>
                )}
                {selected.customerReviewStatus === 'approved' || selected.accepted ? (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-900">
                    Looks good
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goToPreviousPage}
                  disabled={!canGoPrevious}
                  aria-label="Review previous page"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 text-[#10263d] transition hover:border-[#c9a227] hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={goToNextPage}
                  disabled={!canGoNext}
                  aria-label="Review next page"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 text-[#10263d] transition hover:border-[#c9a227] hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <ChevronRight className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="mb-4 overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
              {selected.currentImageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={selected.currentImageUrl}
                  alt={`Large preview for page ${selected.pageIndex + 1}`}
                  className="mx-auto block max-h-[600px] w-auto object-contain"
                />
              ) : (
                <div className="flex h-72 items-center justify-center text-sm text-gray-400">
                  Image still rendering. Refresh in a moment.
                </div>
              )}
            </div>

            <div className="sticky bottom-3 z-10 mb-4 flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white/95 p-2 shadow-sm backdrop-blur sm:static sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none">
              <button
                type="button"
                onClick={goToPreviousPage}
                disabled={!canGoPrevious}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-[#10263d] disabled:cursor-not-allowed disabled:opacity-35 sm:flex-none"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Previous
              </button>
              <span className="shrink-0 text-xs font-semibold text-gray-500">
                Page {selectedIdx + 1} of {pageCount}
              </span>
              <button
                type="button"
                onClick={goToNextPage}
                disabled={!canGoNext}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-[#10263d] disabled:cursor-not-allowed disabled:opacity-35 sm:flex-none"
              >
                Next
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mb-4 text-center">
              <a
                href="#approve-whole-book"
                data-testid="go-to-approval"
                className="text-xs font-semibold text-[#10263d] underline underline-offset-2"
              >
                Go to approval
              </a>
            </div>

            <p className="mb-3 text-sm text-gray-700">{selected.storyText}</p>
            {selected.customerRequestedChange?.note && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="saved-change-note">
                <p className="font-semibold">Your latest change note is saved.</p>
                <p className="mt-1">{selected.customerRequestedChange.note}</p>
                <p className="mt-1 text-amber-800">
                  Status: {selected.customerRequestedChange.lifecycleStatus.replace(/_/g, ' ')}
                </p>
              </div>
            )}
            <p className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              {CHANGE_REQUEST_COPY}
            </p>

            <label
              htmlFor="feedback"
              className="mb-2 block text-sm font-semibold text-[#10263d]"
            >
              {FEEDBACK_HELPER}
            </label>
            <textarea
              id="feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="What would you like changed on this page?"
              className="mb-3 w-full rounded-xl border-2 border-gray-200 px-3 py-2 text-sm focus:border-[#c9a227] focus:outline-none"
            />

            {error && (
              <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            {notice && (
              <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {notice}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={requestChanges}
                disabled={busy !== 'idle'}
                className="rounded-xl bg-[#10263d] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                data-testid="request-page-changes"
              >
                {busy === 'requesting' ? 'Saving…' : 'Ask for a new version'}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={busy !== 'idle' || !selected.currentImageUrl || selected.accepted}
                className="rounded-xl bg-[#c9a227] px-5 py-2.5 text-sm font-semibold text-[#10263d] disabled:opacity-50"
              >
                {selected.accepted ? 'Looks good ✓' : busy === 'accepting' ? 'Saving…' : 'Looks good'}
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500" data-testid="page-mark-helper">
              “Looks good” only marks this page — it does not approve your book. You’ll approve the whole book at the bottom of this page once every page is right.
            </p>

            {selected.feedbackHistory.length > 0 && (
              <details className="mt-4 text-xs text-gray-500">
                <summary className="cursor-pointer">Past feedback ({selected.feedbackHistory.length})</summary>
                <ul className="mt-2 space-y-1">
                  {selected.feedbackHistory.map((f, i) => (
                    <li key={i}>
                      <span className="text-gray-400">{new Date(f.createdAt).toLocaleString()}:</span>{' '}
                      {f.rawText || '(no text)'} {f.tags.length ? `[${f.tags.join(', ')}]` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        {/* Inline full-proof preview — distinct from the per-page section above. */}
        <div className="mt-8">
          <InlineProofPreview
            proofUrl={snapshot.storyArtifactUrl}
            isPrint={snapshot.isPrint}
            illustratedPageCount={snapshot.pageArtifacts.length}
          />
        </div>

        {/* Approve whole book */}
        <section id="approve-whole-book" className="mt-8 scroll-mt-4 rounded-2xl border-2 border-emerald-200 bg-white p-5 shadow-sm" data-testid="approval-section">
          {/* Step 1: prominent full-proof CTA */}
          {snapshot.storyArtifactUrl ? (
            <div className="mb-5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                Step 1 — open the full {snapshot.isPrint ? 'printed-book proof' : 'storybook PDF'}
              </p>
              <a
                href={snapshot.storyArtifactUrl}
                target="_blank"
                rel="noopener"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border-2 border-[#10263d] bg-[#10263d] px-5 py-3 text-base font-semibold text-white sm:w-auto"
                data-testid="full-proof-cta"
              >
📄 Open the full proof PDF
              </a>
              <p className="mt-2 text-xs text-gray-600">
                {snapshot.isPrint
                  ? `This opens the complete book we plan to print — cover, dedication/title pages, story pages, and any keepsake pages. The ${snapshot.pageArtifacts.length} illustrated story pages above are part of this proof, not the whole book.`
                  : 'This opens the complete storybook PDF we’ll send to your inbox once you approve.'}
              </p>
            </div>
          ) : (
            <p className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
Your full proof PDF isn&apos;t ready yet. It will appear here automatically once the book finishes assembling.
            </p>
          )}

          {/* Step 2: page acceptance progress */}
          <div className="mb-5">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
Step 2 — accept each illustrated story page
            </p>
            <p className="text-sm text-gray-700">
              {allAccepted
                ? `All ${snapshot.pageArtifacts.length} illustrated pages accepted.`
                : `${acceptedCount} of ${snapshot.pageArtifacts.length} illustrated pages accepted.`}
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100" aria-hidden>
              <div
                className="h-full rounded-full bg-emerald-600 transition-all"
                style={{ width: `${snapshot.pageArtifacts.length ? (acceptedCount / snapshot.pageArtifacts.length) * 100 : 0}%` }}
              />
            </div>
            {snapshot.openRequestedChangesCount > 0 && (
              <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="open-change-hold">
                {snapshot.openRequestedChangesCount} page{snapshot.openRequestedChangesCount === 1 ? '' : 's'} with requested changes. We will not nudge you for final approval while those are open.
              </p>
            )}
          </div>

          {/* Step 3: explicit acknowledgment that proof was reviewed */}
          <div className="mb-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
Step 3 — confirm you reviewed the full book — every page, cover to cover ({snapshot.isPrint ? 'printed-book proof' : 'PDF'})
            </p>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-[#10263d]">
              <input
                type="checkbox"
                checked={proofAck}
                onChange={async (e) => {
                  const next = e.target.checked;
                  setProofAck(next);
                  if (!next) return; // unchecking is a client-only revoke for this session
                  if (snapshot.proofReviewedAt) return; // already persisted
                  setBusy('acknowledging');
                  setError(null);
                  try {
                    const res = await fetch(
                      `/api/order/${snapshot.orderId}/acknowledge-proof`,
                      { method: 'POST' },
                    );
                    const data = await res.json();
                    if (!res.ok || !data.ok) {
                      setProofAck(false);
                      setError('We couldn’t save that just now. Please try again in a moment.');
                      return;
                    }
                    setSnapshot((s) => ({ ...s, proofReviewedAt: data.proofReviewedAt }));
                  } catch (err) {
                    setProofAck(false);
                    setError(err instanceof Error ? err.message : 'Network error');
                  } finally {
                    setBusy('idle');
                  }
                }}
                className="mt-0.5 h-5 w-5 cursor-pointer"
                data-testid="proof-ack-checkbox"
                disabled={!snapshot.storyArtifactUrl || busy === 'acknowledging'}
              />
              <span>
                {snapshot.isPrint
                  ? `I reviewed the full proof PDF for ${snapshot.childName}’s complete printed book — cover to cover, all pages — and I’m approving everything in it, not just the ${snapshot.pageArtifacts.length} illustrated story pages above.`
                  : 'I opened the full PDF and reviewed the complete storybook, cover to cover, before approving.'}
              </span>
            </label>
          </div>

          {/* Approve CTA — gated on all three steps */}
          <div className="text-center">
            <button
              type="button"
              disabled={
                !allAccepted ||
                !proofAck ||
                !snapshot.storyArtifactUrl ||
                busy !== 'idle' ||
                snapshot.reviewStatus === 'approved'
              }
              className="rounded-xl bg-emerald-700 px-6 py-3 text-base font-bold text-white disabled:opacity-50"
              data-testid="approve-whole-book"
              onClick={() => setShowApprovalConfirm(true)}
            >
              {snapshot.reviewStatus === 'approved'
                ? 'Approved'
                : busy === 'approving'
                  ? 'Approving\u2026'
                  : snapshot.isPrint
                    ? 'Approve the whole book and send to print'
                    : 'Approve the whole book'}
            </button>
            {!allAccepted && (
              <p className="mt-2 text-xs text-gray-500">
Accept each illustrated page first — your progress is saved, so you can come back later.
              </p>
            )}
            {allAccepted && !proofAck && snapshot.storyArtifactUrl && (
              <p className="mt-2 text-xs text-gray-500" data-testid="ack-required-hint">
Confirm you reviewed the full {snapshot.isPrint ? 'proof PDF' : 'PDF'} above to enable approval.
              </p>
            )}
          </div>
        </section>
      </div>

      {showApprovalConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approval-confirm-title"
          data-testid="approval-confirm-modal"
        >
          <div className="max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h2 id="approval-confirm-title" className="font-serif text-2xl text-[#10263d]">
              Approve the complete proof?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              This confirms you accept the full proof for {snapshot.childName}&apos;s book. For print
              orders, approval may send the finished book to print, so please only continue if the
              cover, story pages, and ending pages are ready.
            </p>
            <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setShowApprovalConfirm(false)}
                disabled={busy === 'approving'}
              >
                Go back and review
              </button>
              <button
                type="button"
                className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                data-testid="approval-confirm-submit"
                disabled={busy !== 'idle'}
                onClick={async () => {
                  setBusy('approving');
                  setError(null);
                  setNotice(null);
                  try {
                    const reviewToken = new URLSearchParams(window.location.search).get('token');
                    const res = await fetch(`/api/order/${snapshot.orderId}/approve-whole-book`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ reviewToken }),
                    });
                    const data = await res.json();
                    if (!res.ok || !data.ok) {
                      setError('We couldn’t complete that just now — nothing has been sent. Please try again in a moment.');
                      return;
                    }
                    setSnapshot((s) => ({ ...s, reviewStatus: 'approved' }));
                    setShowApprovalConfirm(false);
                    setNotice(
                      data.printApproved
                        ? 'Approved — thank you. We’re sending the finished book to print now.'
                        : 'Approved — thank you. Your final storybook is ready.',
                    );
                    setTimeout(() => {
                      window.location.href = `/status/${snapshot.orderId}`;
                    }, 1500);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Network error');
                  } finally {
                    setBusy('idle');
                  }
                }}
              >
                {busy === 'approving' ? 'Approving…' : 'Yes, approve and continue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
