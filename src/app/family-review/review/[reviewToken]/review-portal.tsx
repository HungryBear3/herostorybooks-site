'use client';

import { useState } from 'react';

import { Icon, Rating, Wordmark } from '@/components/family-review/atoms';
import { sampleBriefLabelForDirection } from '@/lib/family-review/sample-briefs';
import type {
  Direction,
  FamilyReviewSubmission,
  ParentFeedback,
  SampleAsset,
  SubmissionStatus,
} from '@/lib/family-review/store';

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: 'Received',
  samples_in_progress: 'Reviewer is preparing your samples',
  samples_ready: 'Samples are ready',
  feedback_received: 'Feedback received — thank you',
  invited_to_order: 'Beta invite open',
  archived: 'Closed',
};

const STATUS_TONE: Record<SubmissionStatus, 'pending' | 'ok' | 'soft'> = {
  submitted: 'pending',
  samples_in_progress: 'pending',
  samples_ready: 'ok',
  feedback_received: 'ok',
  invited_to_order: 'ok',
  archived: 'soft',
};

// Beta discount code shown when admin marks a submission invited_to_order
// AND the record itself carries betaDiscountCode. Backend redemption is
// NOT wired in this round (checkout has no promo support) — surface the
// code as a manual-redeem display only.
const FALLBACK_BETA_CODE = 'BETAHERO20';

export default function ReviewPortal({
  submission: initialSubmission,
}: {
  submission: FamilyReviewSubmission;
}) {
  // Local copy so the feedback form can optimistically update the UI
  // without re-fetching the whole page.
  const [submission, setSubmission] = useState(initialSubmission);

  const status = submission.status;
  const tone = STATUS_TONE[status];
  const childName = submission.child.firstName;
  const samplesReady = submission.samples.length > 0;
  const showFeedbackForm = samplesReady && status !== 'archived';
  const showInvite =
    status === 'invited_to_order' || submission.betaDiscountCode !== undefined;
  const discountCode = submission.betaDiscountCode || FALLBACK_BETA_CODE;

  return (
    <>
      <header className="topbar">
        <Wordmark size={14} />
        <span className="meta">private review</span>
      </header>

      <main className="fr-container">
        <section
          className="stack-20"
          style={{ paddingTop: 28, paddingBottom: 16 }}
        >
          <StatusBanner status={status} tone={tone} childName={childName} />

          <div className="card card-warm" style={{ padding: 16 }}>
            <div className="eyebrow forest" style={{ marginBottom: 6 }}>
              Submission summary
            </div>
            <div className="stack-6">
              <SummaryRow label="Child" value={`${childName} · age ${submission.child.ageRange}`} />
              <SummaryRow
                label="Story direction"
                value={
                  submission.direction === 'dinosaur'
                    ? 'Dinosaur adventure'
                    : submission.direction === 'bedtime'
                    ? 'Bedtime wonder'
                    : 'Space explorer'
                }
              />
              <SummaryRow
                label="Reference photos"
                value={`${submission.photos.count} uploaded privately`}
              />
              <SummaryRow label="Status" value={STATUS_LABEL[status]} />
              <SummaryRow
                label="Submitted"
                value={new Date(submission.receivedAt).toLocaleDateString()}
              />
            </div>
          </div>

          {samplesReady ? (
            <SamplesGrid
              samples={submission.samples}
              reviewToken={submission.reviewToken}
              direction={submission.direction}
            />
          ) : (
            <NotReadyYet status={status} />
          )}

          {showFeedbackForm && (
            <FeedbackForm
              submissionId={submission.id}
              reviewToken={submission.reviewToken}
              samples={submission.samples}
              childName={childName}
              direction={submission.direction}
              existingFeedback={submission.feedback}
              onSubmitted={(fb) =>
                setSubmission((prev) => ({
                  ...prev,
                  feedback: fb,
                  status: 'feedback_received',
                }))
              }
            />
          )}

          {submission.feedback && (
            <FeedbackSummary feedback={submission.feedback} />
          )}

          {showInvite && (
            <BetaInviteCard
              code={discountCode}
              childName={childName}
              direction={submission.direction}
            />
          )}

          <DeletionRequestPanel
            reviewToken={submission.reviewToken}
            existing={submission.deletionRequestedAt}
            onRequested={(at) =>
              setSubmission((prev) => ({ ...prev, deletionRequestedAt: at }))
            }
          />
        </section>
      </main>
    </>
  );
}

function StatusBanner({
  status,
  tone,
  childName,
}: {
  status: SubmissionStatus;
  tone: 'pending' | 'ok' | 'soft';
  childName: string;
}) {
  const headline = (() => {
    switch (status) {
      case 'submitted':
        return `We have ${childName}'s submission — a reviewer is reading it now.`;
      case 'samples_in_progress':
        return `Your reviewer is hand-preparing ${childName}'s sample illustrations.`;
      case 'samples_ready':
        return `Your three sample illustrations are ready.`;
      case 'feedback_received':
        return `Thanks for your feedback on ${childName}'s samples.`;
      case 'invited_to_order':
        return `Beta invite: turn ${childName}'s samples into a full book.`;
      case 'archived':
        return `This review session is closed.`;
    }
  })();

  const iconColor =
    tone === 'ok' ? 'var(--forest)' : tone === 'pending' ? 'var(--ochre-2)' : 'var(--ink-3)';
  const iconBg =
    tone === 'ok' ? 'var(--leaf)' : tone === 'pending' ? '#f0e7d4' : 'var(--paper-2)';

  return (
    <div className="stack-12" style={{ textAlign: 'center' }}>
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: iconBg,
          color: iconColor,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto',
        }}
      >
        <Icon
          name={tone === 'ok' ? 'check' : 'sparkle'}
          size={28}
          color={iconColor}
          stroke={2.2}
        />
      </div>
      <div className="stack-6">
        <div className="eyebrow ochre">{STATUS_LABEL[status]}</div>
        <h1 className="fr-h1 serif" style={{ lineHeight: 1.25 }}>
          {headline}
        </h1>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fr-row-between">
      <span className="meta">{label}</span>
      <span style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}

function NotReadyYet({ status }: { status: SubmissionStatus }) {
  return (
    <div className="card card-quiet" style={{ padding: 14, textAlign: 'left' }}>
      <div className="eyebrow forest" style={{ marginBottom: 6 }}>
        What happens next
      </div>
      <p className="help" style={{ marginBottom: 6 }}>
        1. A reviewer reads your form details and reference photos, then
        emails you to confirm. No automated image generation runs on
        submit.
      </p>
      <p className="help" style={{ marginBottom: 6 }}>
        2. Two named reviewers hand-prepare three sample directions: a
        cover hero portrait, one page matched to your story direction,
        and a bedtime keepsake page. This takes a few days, not seconds.
      </p>
      <p className="help">
        3. When the samples land here you&apos;ll get an email and can
        leave feedback on this page.
        {status === 'samples_in_progress' && (
          <>
            {' '}
            <strong>A reviewer is working on it now.</strong>
          </>
        )}
      </p>
    </div>
  );
}

function sampleViewerUrl(reviewToken: string, assetId: string): string {
  return `/family-review/review/${encodeURIComponent(reviewToken)}/image/${encodeURIComponent(assetId)}`;
}

function sampleProxyUrl(reviewToken: string, assetId: string): string {
  return `/api/family-review/review/${encodeURIComponent(reviewToken)}/sample/${encodeURIComponent(assetId)}`;
}

function sampleLabel(sample: SampleAsset, direction: Direction): string {
  if (
    direction !== 'dinosaur' &&
    sample.briefId === 'dinosaur-adventure' &&
    /dinosaur|t-rex|prehistoric/i.test(sample.note ?? '')
  ) {
    return 'Dinosaur adventure page';
  }
  return sampleBriefLabelForDirection(sample.briefId, direction);
}

function SamplesGrid({
  samples,
  reviewToken,
  direction,
}: {
  samples: SampleAsset[];
  reviewToken: string;
  direction: Direction;
}) {
  const [savingAssetId, setSavingAssetId] = useState<string | null>(null);
  // Group by briefId so the cards always render in a consistent order
  // (cover-hero, dinosaur, bedtime). Multiple uploads per brief land
  // newest-first.
  const ORDER: SampleAsset['briefId'][] = [
    'cover-hero',
    'dinosaur-adventure',
    'bedtime-keepsake',
  ];
  const byBrief = new Map<SampleAsset['briefId'], SampleAsset[]>();
  for (const s of samples) {
    if (!byBrief.has(s.briefId)) byBrief.set(s.briefId, []);
    byBrief.get(s.briefId)!.push(s);
  }
  for (const arr of byBrief.values()) {
    arr.sort((a, b) =>
      a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0,
    );
  }

  const openSaveFallback = (assetId: string) => {
    const opened = window.open(
      sampleViewerUrl(reviewToken, assetId),
      '_blank',
      'noopener,noreferrer',
    );
    if (!opened) {
      window.location.href = sampleViewerUrl(reviewToken, assetId);
    }
  };

  const saveSampleToPhotos = (sample: SampleAsset) => {
    setSavingAssetId(sample.assetId);
    openSaveFallback(sample.assetId);
    window.setTimeout(() => {
      setSavingAssetId(null);
    }, 600);
  };

  return (
    <div className="stack-12">
      <div className="eyebrow forest">Your sample illustrations</div>
      {ORDER.map((briefId) => {
        const list = byBrief.get(briefId) ?? [];
        const newest = list[0];
        const label = newest
          ? sampleLabel(newest, direction)
          : sampleBriefLabelForDirection(briefId, direction);
        return (
          <div key={briefId} className="card" style={{ padding: 12 }}>
            <div className="stack-8">
              <div className="fr-row-between">
                <span className="fr-h3 serif">{label}</span>
                {newest && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => saveSampleToPhotos(newest)}
                    disabled={savingAssetId === newest.assetId}
                  >
                    {savingAssetId === newest.assetId ? 'Opening...' : 'Download'}
                  </button>
                )}
              </div>
              {newest ? (
                <a
                  href={sampleViewerUrl(reviewToken, newest.assetId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${label} image for saving`}
                  style={{ display: 'block' }}
                >
                  <div
                    style={{
                      borderRadius: 6,
                      overflow: 'hidden',
                      border: '1px solid var(--line-2)',
                      aspectRatio: '4 / 5',
                      background: 'var(--paper-2)',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={sampleProxyUrl(reviewToken, newest.assetId)}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                </a>
              ) : (
                <div
                  className="card card-quiet"
                  style={{
                    padding: 18,
                    textAlign: 'center',
                    color: 'var(--ink-3)',
                  }}
                >
                  <span className="help">Not uploaded yet.</span>
                </div>
              )}
              {newest?.note && (
                <p className="help">Reviewer note: {newest.note}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FeedbackForm({
  reviewToken,
  samples,
  childName,
  direction,
  existingFeedback,
  onSubmitted,
}: {
  submissionId: string;
  reviewToken: string;
  samples: SampleAsset[];
  childName: string;
  direction: Direction;
  existingFeedback?: ParentFeedback;
  onSubmitted: (feedback: ParentFeedback) => void;
}) {
  const [rating, setRating] = useState(existingFeedback?.rating ?? 0);
  const [looksLikeChild, setLooksLikeChild] = useState<
    'yes' | 'somewhat' | 'no' | null
  >(existingFeedback?.looksLikeChild ?? null);
  const [favorite, setFavorite] = useState<string | undefined>(
    existingFeedback?.favoriteSampleAssetId,
  );
  const [notes, setNotes] = useState(existingFeedback?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = rating > 0 && looksLikeChild !== null && !submitting;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/family-review/review/${reviewToken}/feedback`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            rating,
            looksLikeChild,
            favoriteSampleAssetId: favorite,
            notes: notes.slice(0, 2000),
          }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        feedback?: ParentFeedback;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.feedback) {
        setError(data.error ?? `Couldn't save feedback (HTTP ${res.status}).`);
        setSubmitting(false);
        return;
      }
      onSubmitted(data.feedback);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network_error');
      setSubmitting(false);
    }
  };

  return (
    <div className="card card-warm" style={{ padding: 18 }}>
      <div className="stack-16">
        <div className="stack-6">
          <div className="eyebrow forest">Your feedback</div>
          <p className="body">
            {existingFeedback
              ? `Want to update your notes after a new sample pass? Does this look like ${childName} now?`
              : `Honest beats kind. Does this look like ${childName}? What feels off?`}
          </p>
        </div>

        <div className="stack-8">
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>
            Overall rating
          </span>
          <Rating value={rating} onSelect={setRating} />
          <span className="help">1 = far off, 5 = unmistakably them.</span>
        </div>

        <div className="stack-8">
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>
            Does this look like {childName}?
          </span>
          <div className="pillrow">
            {(['yes', 'somewhat', 'no'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={
                  'pill tone-forest' + (looksLikeChild === v ? ' on' : '')
                }
                onClick={() => setLooksLikeChild(v)}
                aria-pressed={looksLikeChild === v}
                style={{ minWidth: 88, justifyContent: 'center' }}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {samples.length > 1 && (
          <div className="stack-8">
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>
              Favorite sample (optional)
            </span>
            <div className="pillrow">
              {samples.map((s) => (
                <button
                  key={s.assetId}
                  type="button"
                  className={
                    'pill tone-forest' + (favorite === s.assetId ? ' on' : '')
                  }
                  onClick={() =>
                    setFavorite(favorite === s.assetId ? undefined : s.assetId)
                  }
                  aria-pressed={favorite === s.assetId}
                >
                  {sampleLabel(s, direction)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="stack-8">
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>
            What feels off? <span className="opt">optional</span>
          </span>
          <textarea
            className="textarea"
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Hair, eyes, expression, mood — anything that pulled you out."
            style={{ resize: 'none' }}
          />
        </div>

        {error && (
          <p className="help" style={{ color: 'var(--err)' }}>
            {error}
          </p>
        )}

        <button
          type="button"
          className="btn btn-forest btn-block btn-lg"
          onClick={onSubmit}
          disabled={!canSubmit}
        >
          {submitting
            ? 'Sending…'
            : existingFeedback
              ? 'Update feedback'
              : 'Send feedback'}
        </button>
      </div>
    </div>
  );
}

function FeedbackSummary({ feedback }: { feedback: ParentFeedback }) {
  return (
    <div className="card card-quiet" style={{ padding: 14 }}>
      <div className="eyebrow forest" style={{ marginBottom: 6 }}>
        Your feedback (saved)
      </div>
      <div className="stack-6">
        <SummaryRow label="Rating" value={`${feedback.rating} / 5`} />
        <SummaryRow
          label="Likeness"
          value={
            feedback.looksLikeChild === 'yes'
              ? 'Looks like our child'
              : feedback.looksLikeChild === 'somewhat'
              ? 'Somewhat'
              : "Doesn't look like our child"
          }
        />
        {feedback.notes.trim() && (
          <div className="stack-4">
            <span className="meta">Notes</span>
            <p
              className="help"
              style={{
                background: 'var(--paper)',
                padding: 10,
                borderRadius: 6,
                border: '1px solid var(--line)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {feedback.notes}
            </p>
          </div>
        )}
        <SummaryRow
          label="Sent"
          value={new Date(feedback.submittedAt).toLocaleString()}
        />
      </div>
    </div>
  );
}

// Surfaced only when the voice-note beta flag is on. Lives behind the
// same NEXT_PUBLIC_HSB_VOICE_BETA gate as the checkout-form recorder so
// we never advertise a feature that isn't actually mounted on /checkout.
const VOICE_BETA_ENABLED =
  process.env.NEXT_PUBLIC_HSB_VOICE_BETA === 'true';

function BetaInviteCard({
  code,
  childName,
  direction,
}: {
  code: string;
  childName: string;
  direction: 'dinosaur' | 'bedtime' | 'space';
}) {
  return (
    <div
      className="card"
      style={{
        padding: 18,
        background: 'linear-gradient(180deg, #f4eedf 0%, #ecdfc8 100%)',
        borderColor: 'var(--line-2)',
      }}
    >
      <div className="stack-12">
        <div className="eyebrow ochre">Beta invite</div>
        <h2 className="fr-h2 serif" style={{ marginBottom: 0 }}>
          Turn {childName}&apos;s samples into a full book.
        </h2>
        <p className="body">
          You&apos;re invited to the full-length book pilot for 20% off.
          The code below applies to a full personalized book — not just
          the three samples above. The code is shown for manual entry
          today; checkout redemption is still in progress, so please
          mention the code to your reviewer when you place the order.
        </p>
        <div className="stack-6">
          <span className="meta">Beta discount code</span>
          <code
            className="mono"
            style={{
              display: 'block',
              padding: '10px 12px',
              background: 'var(--paper)',
              border: '1px dashed var(--line-2)',
              borderRadius: 6,
              fontSize: 16,
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: 'var(--ink)',
              fontWeight: 600,
            }}
          >
            {code}
          </code>
          <span className="help">
            20% off a full-length book for {childName}. Reply to your invite
            email when you&apos;re ready and mention {code}.
          </span>
        </div>
        {VOICE_BETA_ENABLED && (
          <div
            className="card card-quiet"
            style={{ padding: 12 }}
          >
            <div className="fr-row" style={{ gap: 8, marginBottom: 4 }}>
              <Icon name="sparkle" size={12} color="var(--forest)" />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--forest)',
                }}
              >
                Optional voice note (beta)
              </span>
            </div>
            <p className="help" style={{ marginBottom: 0 }}>
              On checkout you&apos;ll see an optional short voice-note
              section for {childName}. It&apos;s used as story inspiration
              only — never for voice cloning, never published. Skipping it
              is fine; consent is required if you do attach one.
            </p>
          </div>
        )}
        <a
          href={`/checkout?direction=${encodeURIComponent(direction)}`}
          className="btn btn-forest btn-block btn-lg"
          style={{ textDecoration: 'none', borderBottom: 'none' }}
        >
          Open the book checkout
          <Icon name="arrow-right" size={16} color="#f7f1e3" />
        </a>
      </div>
    </div>
  );
}

function DeletionRequestPanel({
  reviewToken,
  existing,
  onRequested,
}: {
  reviewToken: string;
  existing?: string;
  onRequested: (at: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const requested = Boolean(existing);

  const onConfirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/family-review/review/${encodeURIComponent(reviewToken)}/deletion-request`,
        { method: 'POST' },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        deletionRequestedAt?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.deletionRequestedAt) {
        setErr(data.error ?? `HTTP ${res.status}`);
        setBusy(false);
        return;
      }
      onRequested(data.deletionRequestedAt);
      setConfirming(false);
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'network_error');
      setBusy(false);
    }
  };

  return (
    <div
      className="card card-quiet"
      style={{ padding: 14, textAlign: 'left' }}
    >
      <div className="eyebrow forest" style={{ marginBottom: 6 }}>
        Privacy &amp; deletion
      </div>
      <p className="help" style={{ marginBottom: 8 }}>
        Don&apos;t share this page link — anyone with it can see what you
        submitted. We never post your photos or your child&apos;s name
        publicly without separate written permission.
      </p>
      {requested ? (
        <div
          role="status"
          style={{
            padding: '10px 12px',
            background: 'rgba(193, 73, 50, 0.08)',
            border: '1px solid rgba(193, 73, 50, 0.35)',
            borderRadius: 6,
            color: 'var(--terracotta-2, #8a3a23)',
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <strong>Deletion requested.</strong> A reviewer was notified at{' '}
          {new Date(existing!).toLocaleString()}. We&apos;ll confirm by
          email within 48 hours. You can also reply to your invite email
          to follow up.
        </div>
      ) : confirming ? (
        <div className="stack-8">
          <p className="help">
            This asks our team to delete everything on file for this
            submission: your form details, your reference photos, and any
            samples we prepared. We&apos;ll confirm by email within 48
            hours.
          </p>
          {err && (
            <p className="help" style={{ color: 'var(--err)' }}>
              {err}
            </p>
          )}
          <div className="fr-row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-forest btn-sm"
              onClick={onConfirm}
              disabled={busy}
              style={{ background: 'var(--terracotta-2, #8a3a23)' }}
            >
              {busy ? 'Sending…' : 'Yes, request deletion'}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-8">
          <p className="help">
            You can ask us to delete everything we have on file. Reply to
            your invite email, or use the button below — we confirm within
            48 hours, but the deletion itself is processed manually so
            there is no instant erase.
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirming(true)}
            style={{ alignSelf: 'flex-start', color: 'var(--terracotta-2, #8a3a23)' }}
          >
            Request deletion
          </button>
        </div>
      )}
    </div>
  );
}
