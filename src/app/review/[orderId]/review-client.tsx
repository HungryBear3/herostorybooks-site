'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PageArtifact } from '@/lib/orders';
import { hasUnresolvedChangeRequests } from '@/lib/customer-text-change-request';
import {
  canOfferCustomerLayoutEditing,
  createReviewMutationCoordinator,
  customerLayoutUnavailableMessage,
  editorIdentityKey,
} from '@/lib/proof-layout-editor-core';
import type { ProofLayoutEditCapability } from '@/lib/page-review';
import { InlineProofPreview } from './inline-proof-preview';
import CustomerProofLayoutEditor from './customer-proof-layout-editor';

function reviewTokenFromUrl(): string | null {
  return typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('token') : null;
}

const FEEDBACK_HELPER =
  'Tell us what to change on this page — for example: fix the hands, make the child look happier, brighten the garden, or make the face look more like the uploaded photo.';
const REGENERATION_POLICY =
  'Regenerations are included for small fixes. After 3 tries on one page, we may step in to help; after 5, the page is flagged for a human quality check so we do not burn your time or the book budget.';

interface Snapshot {
  orderId: string;
  childName: string;
  reviewStatus: 'not_started' | 'in_review' | 'customer_changes_requested' | 'approved';
  pageArtifacts: PageArtifact[];
  /**
   * The IMMUTABLE persisted proof URL, or null when no usable proof exists.
   * The server nulls this whenever the published proof no longer matches the
   * current pages, so it is authoritative: null means nothing may be
   * acknowledged or approved. Nothing here is session-local — a reload
   * re-derives the identical state from the server.
   */
  storyArtifactUrl: string | null;
  /** Revision that must be echoed back when acknowledging. */
  proofVersion: string | null;
  /** Current proof source fingerprint (content-hash ETag) the layout editor
   *  echoes back for optimistic concurrency. Null unless a fresh proof exists. */
  proofSourceFingerprint: string | null;
  /** Revision already acknowledged, if any. */
  proofReviewedVersion: string | null;
  proofReviewedAt: string | null;
  proofAvailable: boolean;
  proofFresh: boolean;
  /** Server-derived, fail-closed capability gating the layout editor. */
  proofLayoutEditing: ProofLayoutEditCapability;
  isPrint: boolean;
  bookFormat: 'digital' | 'classic' | 'premium';
}

/**
 * The capability token lives only in the tokenized review URL and is forwarded
 * on every customer mutation. It is never rendered into page content. Every
 * mutation route rejects a bare order id server-side, so a missing token fails
 * closed rather than silently acting.
 */
function tokenQuery(): string {
  const token =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('token')
      : null;
  return token ? `?token=${encodeURIComponent(token)}` : '';
}

export default function ReviewClient({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [wordingNote, setWordingNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showApprovalConfirm, setShowApprovalConfirm] = useState(false);
  const [layoutEditorOpen, setLayoutEditorOpen] = useState(false);

  // ── Single shared customer-mutation coordinator (B6) ──
  // Every customer mutation (regenerate/accept/wording/ack/approval AND the
  // layout editor's save/reset/help) runs through this ONE lock, so at most one
  // is active and an older response can never overwrite a newer snapshot.
  const coordinator = useRef(createReviewMutationCoordinator()).current;
  const [activeOp, setActiveOp] = useState<string | null>(null);
  const busy = activeOp !== null;

  const runMutation = useCallback(
    async (op: string, fn: (token: number) => Promise<void>) => {
      const token = coordinator.begin(op);
      if (token == null) return; // a mutation is already in flight — ignore
      setActiveOp(op);
      try {
        await fn(token);
      } finally {
        coordinator.settle(token);
        setActiveOp(coordinator.activeOp());
      }
    },
    [coordinator],
  );
  // Adopt an authoritative snapshot ONLY if this token is still the current op.
  const applyIfCurrent = useCallback(
    (token: number, next: unknown) => {
      if (coordinator.isCurrent(token)) setSnapshot(next as Snapshot);
    },
    [coordinator],
  );

  // ── Focus management for the layout editor (B5) ──
  const openerRef = useRef<HTMLButtonElement>(null);
  const layoutNoticeRef = useRef<HTMLParagraphElement>(null);
  const [pendingFocus, setPendingFocus] = useState<null | 'opener' | 'notice'>(null);
  useEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus === 'opener') openerRef.current?.focus();
    else layoutNoticeRef.current?.focus();
    setPendingFocus(null);
  }, [pendingFocus, layoutEditorOpen, notice]);

  const selected = snapshot.pageArtifacts[selectedIdx];
  const canEditLayout = canOfferCustomerLayoutEditing(snapshot);
  const acceptedCount = snapshot.pageArtifacts.filter((p) => p.accepted).length;
  const allAccepted =
    snapshot.pageArtifacts.length > 0 &&
    acceptedCount === snapshot.pageArtifacts.length;
  const unresolvedWording = hasUnresolvedChangeRequests(snapshot.pageArtifacts);
  const proofAck = Boolean(snapshot.proofReviewedAt) &&
    snapshot.proofReviewedVersion != null &&
    snapshot.proofReviewedVersion === snapshot.proofVersion;

  async function regenerate() {
    if (!selected) return;
    await runMutation('regenerate', async (token) => {
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/order/${snapshot.orderId}/regenerate-page${tokenQuery()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageIndex: selected.pageIndex, feedback }),
        });
        const data = await res.json();
        // A failed provider call may still have committed review/audit state.
        // Adopt any authoritative snapshot (stale-ordering guarded) before
        // surfacing an error so the browser never advertises voided state.
        if (data.snapshot) applyIfCurrent(token, data.snapshot);
        if (!res.ok || !data.ok) {
          setError(data?.error ?? `Regeneration failed (${res.status})`);
          return;
        }
        if (!data.snapshot) {
          setError('The server did not return the updated book state. Refresh before continuing.');
          return;
        }
        setFeedback('');
        if (data.warning === 'regen_manual_review_threshold') {
          setNotice('We\u2019ve regenerated this page several times. Our team will also take a look to make sure it lands right.');
        } else if (data.warning === 'regen_threshold_warning') {
          setNotice('Got it. If you\u2019re still not seeing what you want after a few tries, reply to your order email and we\u2019ll help directly.');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      }
    });
  }

  async function accept() {
    if (!selected) return;
    await runMutation('accept', async (token) => {
      setError(null);
      try {
        const res = await fetch(`/api/order/${snapshot.orderId}/accept-page${tokenQuery()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageIndex: selected.pageIndex }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data?.error ?? `Accept failed (${res.status})`);
          return;
        }
        if (!data.snapshot) {
          setError('The server did not return the updated book state. Refresh before continuing.');
          return;
        }
        applyIfCurrent(token, data.snapshot);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      }
    });
  }

  async function requestWordingChange() {
    if (!selected || !wordingNote.trim()) return;
    await runMutation('wording', async (token) => {
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/order/${snapshot.orderId}/request-text-change${tokenQuery()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageIndex: selected.pageIndex, note: wordingNote }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data?.error ?? `Wording request failed (${res.status})`);
          return;
        }
        if (!data.snapshot) {
          setError('The server did not return the updated book state. Refresh before continuing.');
          return;
        }
        applyIfCurrent(token, data.snapshot);
        setWordingNote('');
        setNotice('Wording change requested. Approval is paused until our team resolves it and publishes a new proof.');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      }
    });
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

            {/* ── Bounded page-layout editor (customer surface) ── */}
            {canEditLayout ? (
              layoutEditorOpen ? (
                <CustomerProofLayoutEditor
                  key={editorIdentityKey(snapshot.orderId, selected.pageIndex, snapshot, selected.proofCardOverride)}
                  orderId={snapshot.orderId}
                  reviewToken={reviewTokenFromUrl()}
                  pageIndex={selected.pageIndex}
                  imageUrl={selected.currentImageUrl}
                  storyText={selected.storyText}
                  proofVersion={snapshot.proofVersion!}
                  sourceFingerprint={snapshot.proofSourceFingerprint!}
                  initialOverride={selected.proofCardOverride ?? null}
                  busyOp={activeOp}
                  runMutation={runMutation}
                  applyIfCurrent={applyIfCurrent}
                  onCommitted={(msg: string) => {
                    // Snapshot already adopted (guarded) inside the editor's
                    // mutation. Surface the durable notice in the PARENT so it
                    // survives the editor's unmount, and return focus.
                    setNotice(msg);
                    setLayoutEditorOpen(false);
                    setPendingFocus('notice');
                  }}
                  onClose={() => {
                    setLayoutEditorOpen(false);
                    setPendingFocus('opener');
                  }}
                />
              ) : (
                <button
                  type="button"
                  ref={openerRef}
                  onClick={() => setLayoutEditorOpen(true)}
                  disabled={busy}
                  className="mb-4 min-h-11 rounded-full border border-forest px-4 text-sm font-semibold text-forest disabled:opacity-50"
                  data-testid="open-layout-editor"
                >
                  Adjust this page’s text placement
                </button>
              )
            ) : customerLayoutUnavailableMessage(snapshot) ? (
              <p
                className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                data-testid="layout-unavailable-note"
              >
                {customerLayoutUnavailableMessage(snapshot)}
              </p>
            ) : null}

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
              <p
                ref={layoutNoticeRef}
                tabIndex={-1}
                role="status"
                aria-live="polite"
                className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 outline-none"
                data-testid="review-notice"
              >
                {notice}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={regenerate}
                disabled={busy}
                className="rounded-xl bg-[#10263d] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {activeOp === 'regenerate' ? 'Regenerating\u2026' : 'Regenerate this page'}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={busy || !selected.currentImageUrl || selected.accepted}
                className="rounded-xl bg-[#c9a227] px-5 py-2.5 text-sm font-semibold text-[#10263d] disabled:opacity-50"
              >
                {selected.accepted ? 'Accepted' : activeOp === 'accept' ? 'Accepting…' : 'Accept this page'}
              </button>
            </div>

            <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50 p-4" data-testid="wording-change-panel">
              <label htmlFor="wording-note" className="block text-sm font-semibold text-violet-950">
                Request a wording change
              </label>
              <p className="mt-1 text-xs text-violet-800">
                Use this only for story wording. It does not regenerate the artwork. A request pauses final approval until our team resolves it and publishes a new proof.
              </p>
              {selected.customerRequestedChange &&
                selected.customerRequestedChange.lifecycleStatus !== 'resolved' && (
                  <p className="mt-3 rounded-md border border-violet-200 bg-white px-3 py-2 text-xs text-violet-900" data-testid="pending-wording-request">
                    Pending request: {selected.customerRequestedChange.note}
                  </p>
                )}
              <textarea
                id="wording-note"
                value={wordingNote}
                onChange={(event) => setWordingNote(event.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="What should this page say instead?"
                className="mt-3 w-full rounded-xl border-2 border-violet-200 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={requestWordingChange}
                disabled={busy || !wordingNote.trim()}
                className="mt-3 rounded-xl border border-violet-700 px-4 py-2 text-sm font-semibold text-violet-900 disabled:opacity-50"
              >
                {activeOp === 'wording' ? 'Saving request…' : 'Submit wording request'}
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
                  if (!next) return; // persisted acknowledgments are revision-bound, not session toggles
                  // Already persisted for THIS revision — nothing to send.
                  if (
                    snapshot.proofReviewedAt &&
                    snapshot.proofReviewedVersion === snapshot.proofVersion
                  ) return;
                  if (!snapshot.proofVersion) {
                    setError('The proof is being rebuilt. Refresh in a moment to review the latest version.');
                    return;
                  }
                  await runMutation('acknowledge', async (token) => {
                    setError(null);
                    try {
                      const res = await fetch(
                        `/api/order/${snapshot.orderId}/acknowledge-proof${tokenQuery()}`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          // Bind the acknowledgment to the exact revision shown.
                          body: JSON.stringify({ proofVersion: snapshot.proofVersion }),
                        },
                      );
                      const data = await res.json();
                      if (!res.ok || !data.ok) {
                        setError(data?.error ?? `Could not save acknowledgment (${res.status})`);
                        return;
                      }
                      if (!data.snapshot) {
                        setError('The server did not return the updated book state. Refresh before continuing.');
                        return;
                      }
                      applyIfCurrent(token, data.snapshot);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Network error');
                    }
                  });
                }}
                className="mt-0.5 h-5 w-5 cursor-pointer"
                data-testid="proof-ack-checkbox"
                disabled={!snapshot.storyArtifactUrl || busy}
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
                unresolvedWording ||
                !proofAck ||
                !snapshot.storyArtifactUrl ||
                busy ||
                snapshot.reviewStatus === 'approved'
              }
              className="rounded-xl bg-emerald-700 px-6 py-3 text-base font-bold text-white disabled:opacity-50"
              data-testid="approve-whole-book"
              onClick={() => setShowApprovalConfirm(true)}
            >
              {snapshot.reviewStatus === 'approved'
                ? 'Approved'
                : activeOp === 'approve'
                  ? 'Approving\u2026'
                  : 'Approve the complete book'}
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
            {unresolvedWording && (
              <p className="mt-2 text-xs text-violet-700" data-testid="wording-request-blocks-approval">
                Approval is paused while a wording request is unresolved.
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
              This confirms you accept the full proof for {snapshot.childName}&apos;s book. This locks
              your review approval. Print release happens separately after our final production checks.
            </p>
            <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setShowApprovalConfirm(false)}
                disabled={busy}
              >
                Go back and review
              </button>
              <button
                type="button"
                className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                data-testid="approval-confirm-submit"
                disabled={busy}
                onClick={() => runMutation('approve', async (token) => {
                  setError(null);
                  setNotice(null);
                  try {
                    const res = await fetch(`/api/order/${snapshot.orderId}/approve-whole-book${tokenQuery()}`, {
                      method: 'POST',
                    });
                    const data = await res.json();
                    if (!res.ok || !data.ok) {
                      setError(data?.error ?? `Approval failed (${res.status})`);
                      return;
                    }
                    if (!data.snapshot) {
                      setError('The server did not return the updated book state. Refresh before continuing.');
                      return;
                    }
                    applyIfCurrent(token, data.snapshot);
                    setShowApprovalConfirm(false);
                    setNotice('Approved — thank you. Our team will complete the final production check before print release.');
                    setTimeout(() => {
                      window.location.href = `/status/${snapshot.orderId}`;
                    }, 1500);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Network error');
                  }
                })}
              >
                {activeOp === 'approve' ? 'Approving…' : 'Yes, approve and continue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
