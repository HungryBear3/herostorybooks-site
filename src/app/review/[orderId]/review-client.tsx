'use client';

import { useState } from 'react';

import type { PageArtifact } from '@/lib/orders';
import { InlineProofPreview } from './inline-proof-preview';

const FEEDBACK_HELPER =
  'Tell us what to change on this page — for example: fix the hands, make the child look happier, brighten the garden, or make the face look more like the uploaded photo.';
const REGENERATION_POLICY =
  'Regenerations are included for small fixes. After 3 tries on one page, we may step in to help; after 5, the page is flagged for a human quality check so we do not burn your time or the book budget.';

interface Snapshot {
  orderId: string;
  childName: string;
  reviewStatus: 'not_started' | 'in_review' | 'customer_changes_requested' | 'approved';
  pageArtifacts: PageArtifact[];
  storyArtifactUrl: string | null;
  isPrint: boolean;
  bookFormat: 'digital' | 'classic' | 'premium';
  proofReviewedAt: string | null;
}

export default function ReviewClient({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<'idle' | 'regenerating' | 'accepting' | 'approving' | 'acknowledging'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proofAck, setProofAck] = useState<boolean>(Boolean(initial.proofReviewedAt));
  const [showApprovalConfirm, setShowApprovalConfirm] = useState(false);

  const selected = snapshot.pageArtifacts[selectedIdx];
  const acceptedCount = snapshot.pageArtifacts.filter((p) => p.accepted).length;
  const allAccepted =
    snapshot.pageArtifacts.length > 0 &&
    acceptedCount === snapshot.pageArtifacts.length;

  async function regenerate() {
    if (!selected) return;
    setBusy('regenerating');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/order/${snapshot.orderId}/regenerate-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageIndex: selected.pageIndex, feedback }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data?.error ?? `Regeneration failed (${res.status})`);
        return;
      }
      setSnapshot((s) => ({
        ...s,
        pageArtifacts: s.pageArtifacts.map((p) =>
          p.pageIndex === selected.pageIndex ? data.page : p,
        ),
        reviewStatus: 'customer_changes_requested',
      }));
      setFeedback('');
      if (data.warning === 'regen_manual_review_threshold') {
        setNotice('We\u2019ve regenerated this page several times. Our team will also take a look to make sure it lands right.');
      } else if (data.warning === 'regen_threshold_warning') {
        setNotice('Got it. If you\u2019re still not seeing what you want after a few tries, reply to your order email and we\u2019ll help directly.');
      }
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
      const res = await fetch(`/api/order/${snapshot.orderId}/accept-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageIndex: selected.pageIndex }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data?.error ?? `Accept failed (${res.status})`);
        return;
      }
      setSnapshot((s) => ({
        ...s,
        pageArtifacts: s.pageArtifacts.map((p) =>
          p.pageIndex === selected.pageIndex ? data.page : p,
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
              <h2 className="font-serif text-xl text-[#10263d]">
                Page {selected.pageIndex + 1}
              </h2>
              <span className="text-xs text-gray-500">
                Regenerated {selected.regenerateCount}{' '}
                {selected.regenerateCount === 1 ? 'time' : 'times'}
              </span>
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

            <p className="mb-3 text-sm text-gray-700">{selected.storyText}</p>
            <p className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              {REGENERATION_POLICY}
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
                onClick={regenerate}
                disabled={busy !== 'idle'}
                className="rounded-xl bg-[#10263d] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy === 'regenerating' ? 'Regenerating\u2026' : 'Regenerate this page'}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={busy !== 'idle' || !selected.currentImageUrl || selected.accepted}
                className="rounded-xl bg-[#c9a227] px-5 py-2.5 text-sm font-semibold text-[#10263d] disabled:opacity-50"
              >
                {selected.accepted ? 'Accepted' : busy === 'accepting' ? 'Accepting…' : 'Accept this page'}
              </button>
            </div>

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
        <section className="mt-8 rounded-2xl border-2 border-emerald-200 bg-white p-5 shadow-sm" data-testid="approval-section">
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
          </div>

          {/* Step 3: explicit acknowledgment that proof was reviewed */}
          <div className="mb-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
Step 3 — confirm you reviewed the whole {snapshot.isPrint ? 'printed-book proof' : 'PDF'}
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
                      setError(data?.error ?? `Could not save acknowledgment (${res.status})`);
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
                  ? `I reviewed the full proof PDF for ${snapshot.childName}’s complete printed book and I’m approving everything in it — not just the ${snapshot.pageArtifacts.length} illustrated story pages above.`
                  : 'I opened the full PDF and reviewed the complete storybook before approving.'}
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
                    const res = await fetch(`/api/order/${snapshot.orderId}/approve-whole-book`, {
                      method: 'POST',
                    });
                    const data = await res.json();
                    if (!res.ok || !data.ok) {
                      setError(data?.error ?? `Approval failed (${res.status})`);
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
