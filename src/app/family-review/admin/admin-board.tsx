'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Icon,
  PhotoPH,
  Rating,
  StoryArt,
  Wordmark,
} from '@/components/family-review/atoms';
import {
  renderBriefsForSubmission,
} from '@/lib/family-review/sample-briefs';
import type {
  FamilyReviewSubmission,
  SubmissionStatus,
} from '@/lib/family-review/store';

interface Submission {
  id: string;
  parent: string;
  child: string;
  age: string;
  direction: 'Dinosaur' | 'Bedtime' | 'Space';
  status: 'new' | 'generating' | 'ready' | 'passed' | 'failed' | 'invited';
  time: string;
  email: string;
  // Optional flag for the mock — when true, the detail view renders a
  // red blocking banner in the consent card and reviewers should stop.
  deletionRequested?: boolean;
}

const STATIC_ROWS: Submission[] = [
  { id: 'HF-0241', parent: 'Priya M.', child: 'Nour', age: '5–6', direction: 'Dinosaur', status: 'ready', time: '12m ago', email: 'priya.m@example.com' },
  { id: 'HF-0240', parent: 'Janelle K.', child: 'Theo', age: '3–4', direction: 'Bedtime', status: 'ready', time: '1h ago', email: 'janelle.k@example.com' },
  { id: 'HF-0239', parent: 'Marcus O.', child: 'Ada', age: '7–8', direction: 'Space', status: 'generating', time: '3h ago', email: 'marcus.o@example.com' },
  { id: 'HF-0238', parent: 'Sade R.', child: 'Kemi', age: '5–6', direction: 'Dinosaur', status: 'new', time: '5h ago', email: 'sade.r@example.com' },
  { id: 'HF-0237', parent: 'Hiroshi T.', child: 'Yuki', age: '3–4', direction: 'Bedtime', status: 'passed', time: 'yesterday', email: 'hiroshi.t@example.com' },
  { id: 'HF-0236', parent: 'Amelia W.', child: 'Rowan', age: '5–6', direction: 'Dinosaur', status: 'failed', time: 'yesterday', email: 'amelia.w@example.com' },
  { id: 'HF-0235', parent: 'Devon P.', child: 'Otis', age: '7–8', direction: 'Space', status: 'invited', time: '2d ago', email: 'devon.p@example.com' },
];

const STATIC_PREVIEW_ENABLED = process.env.NODE_ENV !== 'production';

const FILTERS: { k: string; label: string; tone?: string }[] = [
  { k: 'all', label: 'All submissions' },
  { k: 'submitted', label: 'Submitted', tone: 's-new' },
  { k: 'samples_in_progress', label: 'Samples in progress', tone: 's-gen' },
  { k: 'samples_ready', label: 'Ready for parent review', tone: 's-ready' },
  { k: 'feedback_received', label: 'Feedback received', tone: 's-pass' },
  { k: 'invited_to_order', label: 'Invited to book pilot', tone: 's-invited' },
  { k: 'archived', label: 'Archived', tone: 's-fail' },
];

const STATUS_LABEL: Record<Submission['status'], string> = {
  new: 'New',
  generating: 'Generating',
  ready: 'Ready',
  passed: 'Passed',
  failed: 'Failed',
  invited: 'Invited',
};

const STATUS_CHIP: Record<Submission['status'], string> = {
  new: 's-new',
  generating: 's-gen',
  ready: 's-ready',
  passed: 's-pass',
  failed: 's-fail',
  invited: 's-invited',
};

const TONE_DOT: Record<string, string> = {
  's-new': 'var(--ink-3)',
  's-gen': 'var(--ochre)',
  's-ready': 'var(--forest)',
  's-pass': 'var(--ok)',
  's-fail': 'var(--terracotta)',
  's-invited': 'var(--dusk)',
};

/**
 * Two-letter monogram from a parent display string like "Priya M." → "PM"
 * or "Marcus O." → "MO". Falls back to first two letters of the first
 * token if no second token / initial is present. Used by submission-list
 * avatars instead of the previous striped placeholder.
 */
/**
 * Build a proxy URL for a single asset (photo or sample) on a
 * submission. Admin auth rides on the fr_admin_session HttpOnly cookie
 * — the reviewer key is NEVER included in the URL, so this function
 * takes no key parameter.
 */
function adminAssetUrl(submissionId: string, assetId: string): string {
  return `/api/family-review/admin/submissions/${encodeURIComponent(submissionId)}/asset/${encodeURIComponent(assetId)}`;
}

function monogram(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '?';
  const first = tokens[0].replace(/[^A-Za-z]/g, '');
  const last = (tokens[tokens.length - 1] || '').replace(/[^A-Za-z]/g, '');
  if (tokens.length === 1) {
    return (first.slice(0, 2) || '?').toUpperCase();
  }
  const a = (first[0] || '').toUpperCase();
  const b = (last[0] || '').toUpperCase();
  return (a + b) || '?';
}

/* ---------- real submissions plumbing ----------------------------------- */

interface FetchState {
  phase: 'idle' | 'loading' | 'loaded' | 'error' | 'disabled';
  rows: FamilyReviewSubmission[];
  error?: string;
}

/**
 * Map a real captured submission onto the row-shape the admin list expects.
 * The `realId` field carries the captured submission id so we can route
 * the detail pane back to the original record.
 */
function realToRow(s: FamilyReviewSubmission): Submission & { realId: string } {
  const status =
    s.status === 'submitted'
      ? 'new'
      : s.status === 'samples_in_progress'
      ? 'generating'
      : s.status === 'samples_ready'
      ? 'ready'
      : s.status === 'feedback_received'
      ? 'passed'
      : s.status === 'invited_to_order'
      ? 'invited'
      : 'failed';
  return {
    id: `R-${s.id.slice(-6).toUpperCase()}`,
    parent: s.parent.name,
    child: s.child.firstName,
    age: s.child.ageRange,
    direction:
      s.direction === 'dinosaur'
        ? 'Dinosaur'
        : s.direction === 'bedtime'
        ? 'Bedtime'
        : 'Space',
    status,
    time: timeAgo(s.receivedAt),
    email: s.parent.email,
    realId: s.id,
  };
}

function realStatusToRowStatus(status: SubmissionStatus): Submission['status'] {
  return status === 'submitted'
    ? 'new'
    : status === 'samples_in_progress'
      ? 'generating'
      : status === 'samples_ready'
        ? 'ready'
        : status === 'feedback_received'
          ? 'passed'
          : status === 'invited_to_order'
            ? 'invited'
            : 'failed';
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'just now';
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}

function isSmokeSubmission(s: FamilyReviewSubmission): boolean {
  return (
    s.parent.email.toLowerCase().startsWith('smoke+family-review@') ||
    s.parent.name.toLowerCase() === 'smoke tester'
  );
}

function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  return `"${raw.replaceAll('"', '""')}"`;
}

function feedbackRowsForExport(submissions: FamilyReviewSubmission[]) {
  return submissions.flatMap((s) => {
    const allFeedback = [
      ...(s.feedbackHistory ?? []),
      ...(s.feedback &&
      !(s.feedbackHistory ?? []).some(
        (fb) => fb.submittedAt === s.feedback?.submittedAt,
      )
        ? [s.feedback]
        : []),
    ];
    return allFeedback.map((fb) => ({
      submissionId: s.id,
      parentName: s.parent.name,
      parentEmail: s.parent.email,
      childFirstName: s.child.firstName,
      direction: s.direction,
      status: s.status,
      rating: fb.rating,
      looksLikeChild: fb.looksLikeChild,
      favoriteSampleAssetId: fb.favoriteSampleAssetId ?? '',
      sampleRunId: fb.sampleRunId ?? '',
      sampleAssetIds: (fb.sampleAssetIds ?? []).join(' '),
      submittedAt: fb.submittedAt,
      notes: fb.notes,
    }));
  });
}

function buildFeedbackCsv(submissions: FamilyReviewSubmission[]): string {
  const rows = feedbackRowsForExport(submissions);
  const headers = [
    'submissionId',
    'parentName',
    'parentEmail',
    'childFirstName',
    'direction',
    'status',
    'rating',
    'looksLikeChild',
    'favoriteSampleAssetId',
    'sampleRunId',
    'sampleAssetIds',
    'submittedAt',
    'notes',
  ] as const;
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ].join('\n');
}

function samplesReadyForParent(submission: FamilyReviewSubmission): boolean {
  return submission.samples.length >= 3 && submission.status === 'samples_ready';
}

function buildParentSampleEmail(submission: FamilyReviewSubmission, reviewUrl: string) {
  const child = submission.child.firstName;
  const subject = `${child} Hero Story Books samples are ready`;
  const body = [
    `Hi ${submission.parent.name.split(/\s+/)[0] || 'there'},`,
    '',
    `We have ${child}'s Hero Story Books sample illustrations ready for review:`,
    reviewUrl,
    '',
    'When you open the link, you can view the samples, save any images you like, and leave quick feedback on likeness and gift quality.',
    '',
    'Thank you for helping us test the family preview.',
    '',
    'Hero Story Books',
  ].join('\n');
  return { subject, body };
}

export default function AdminBoard() {
  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string>('');
  const [fetched, setFetched] = useState<FetchState>({
    phase: 'idle',
    rows: [],
  });
  const [quickActionBusy, setQuickActionBusy] = useState<string | null>(null);
  const [quickActionErr, setQuickActionErr] = useState<string | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'downloaded'>('idle');

  useEffect(() => {
    let cancelled = false;
    setFetched((prev) => ({ ...prev, phase: 'loading' }));
    // Admin auth rides on the fr_admin_session HttpOnly cookie; no
    // query-string key is built into this URL.
    fetch(`/api/family-review/submissions?limit=10`, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const data = (await res.json()) as {
          ok?: boolean;
          storeEnabled?: boolean;
          submissions?: FamilyReviewSubmission[];
          reason?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setFetched({
            phase: 'error',
            rows: [],
            error: data.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        if (!data.storeEnabled) {
          setFetched({ phase: 'disabled', rows: [] });
          return;
        }
        setFetched({
          phase: 'loaded',
          rows: data.submissions ?? [],
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setFetched({
          phase: 'error',
          rows: [],
          error: err instanceof Error ? err.message : 'fetch_failed',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const realRows = useMemo(
    () => fetched.rows.filter((s) => !isSmokeSubmission(s)).slice(0, 10).map(realToRow),
    [fetched.rows],
  );
  const visibleStaticRows = STATIC_PREVIEW_ENABLED ? STATIC_ROWS : [];
  const visibleRealSubmissions = useMemo(
    () => fetched.rows.filter((s) => !isSmokeSubmission(s)),
    [fetched.rows],
  );
  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: visibleRealSubmissions.length,
      submitted: 0,
      samples_in_progress: 0,
      samples_ready: 0,
      feedback_received: 0,
      invited_to_order: 0,
      archived: 0,
    };
    for (const submission of visibleRealSubmissions) {
      counts[submission.status] = (counts[submission.status] ?? 0) + 1;
    }
    return counts;
  }, [visibleRealSubmissions]);
  const feedbackExportCount = useMemo(
    () => feedbackRowsForExport(visibleRealSubmissions).length,
    [visibleRealSubmissions],
  );
  const filteredRealRows = useMemo(() => {
    if (activeFilter === 'all') return realRows;
    return realRows.filter((row) => {
      const record = fetched.rows.find((s) => s.id === row.realId);
      return record?.status === activeFilter;
    });
  }, [activeFilter, fetched.rows, realRows]);

  const allRows: (Submission & { realId?: string; isReal?: boolean })[] = useMemo(
    () => [
      ...filteredRealRows.map((r) => ({ ...r, isReal: true })),
      ...(activeFilter === 'all'
        ? visibleStaticRows.map((r) => ({ ...r, isReal: false }))
        : []),
    ],
    [activeFilter, filteredRealRows, visibleStaticRows],
  );

  const selected =
    allRows.find((r) => r.id === selectedId) ??
    (allRows[0] ?? null);

  // For real rows, look up the original record so the detail pane can
  // show the photo COUNT (the only photo metadata we ever store) plus
  // an explicit "files not uploaded" caveat.
  const selectedRealRecord =
    selected?.isReal && selected.realId
      ? fetched.rows.find((s) => s.id === selected.realId)
      : undefined;

  const replaceFetchedSubmission = (next: FamilyReviewSubmission) => {
    setFetched((prev) => ({
      ...prev,
      rows: prev.rows.map((s) => (s.id === next.id ? next : s)),
    }));
  };

  const onExportFeedback = () => {
    if (feedbackExportCount === 0 || typeof window === 'undefined') return;
    const csv = buildFeedbackCsv(visibleRealSubmissions);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hsb-family-review-feedback-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setExportState('downloaded');
    setTimeout(() => setExportState('idle'), 1500);
  };

  const onQuickStatus = async (
    nextStatus: SubmissionStatus,
    actionLabel: string,
  ) => {
    if (!selected?.isReal || !selectedRealRecord) {
      setQuickActionErr('Select a real submission first.');
      return;
    }
    setQuickActionBusy(actionLabel);
    setQuickActionErr(null);
    try {
      const res = await fetch(
        `/api/family-review/admin/submissions/${selectedRealRecord.id}/status`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        submission?: FamilyReviewSubmission;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.submission) {
        setQuickActionErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      replaceFetchedSubmission(data.submission);
    } catch (err) {
      setQuickActionErr(err instanceof Error ? err.message : 'network_error');
    } finally {
      setQuickActionBusy(null);
    }
  };

  return (
    <div className="admin-shell">
      {/* RAIL */}
      <aside className="admin-rail">
        <div className="fr-row" style={{ gap: 10 }}>
          <Wordmark size={14} />
          <span
            className="chip"
            style={{
              height: 22,
              fontSize: 10.5,
              background: 'var(--leaf)',
              borderColor: 'var(--line-2)',
              color: 'var(--forest)',
            }}
          >
            internal
          </span>
        </div>

        <div className="stack-8">
          <div className="eyebrow" style={{ paddingLeft: 4 }}>Pipeline</div>
          <div className="stack-4">
            {FILTERS.map((f) => {
              const on = activeFilter === f.k;
              const count = filterCounts[f.k] ?? 0;
              return (
                <button
                  key={f.k}
                  type="button"
                  className="fr-row-between"
                  onClick={() => setActiveFilter(f.k)}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 6,
                    background: on ? 'rgba(184,138,62,0.12)' : 'transparent',
                    border: 0,
                    cursor: 'pointer',
                    width: '100%',
                    textAlign: 'left',
                    color: 'inherit',
                  }}
                >
                  <span className="fr-row" style={{ gap: 8 }}>
                    {f.tone && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 999,
                          background: TONE_DOT[f.tone] ?? 'var(--ink-3)',
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: 13,
                        color: on ? 'var(--ink)' : 'var(--ink-2)',
                        fontWeight: on ? 500 : 400,
                      }}
                    >
                      {f.label}
                    </span>
                  </span>
                  <span className="mono" style={{ color: 'var(--ink-3)' }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="stack-8" style={{ marginTop: 'auto' }}>
          <div
            style={{
              padding: 12,
              background: 'rgba(61,82,64,0.07)',
              borderRadius: 8,
              border: '1px solid rgba(61,82,64,0.18)',
            }}
          >
            <div className="fr-row" style={{ gap: 6, marginBottom: 4 }}>
              <Icon name="shield" size={12} color="var(--forest)" />
              <span style={{ fontSize: 11, color: 'var(--forest)', fontWeight: 500 }}>
                Internal preview
              </span>
            </div>
            <span className="help" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
              Static mock — these submissions aren&apos;t real. Don&apos;t screenshot reference photos.
            </span>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <div className="admin-main">
        {/* LIST */}
        <section className="admin-list">
          <header className="admin-list-head">
            <div className="stack-4">
              <h2 className="fr-h2 serif">Ready for review</h2>
              <span className="meta">
                {fetched.phase === 'loaded' && visibleRealSubmissions.length > 0
                  ? `${visibleRealSubmissions.length} real captured · ${filteredRealRows.length} shown`
                  : STATIC_PREVIEW_ENABLED
                    ? 'Static preview · no real submissions yet'
                    : 'No real submissions yet'}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onExportFeedback}
              disabled={feedbackExportCount === 0}
              title={
                feedbackExportCount === 0
                  ? 'No parent feedback to export yet'
                  : 'Download parent feedback history as CSV'
              }
            >
              {exportState === 'downloaded'
                ? 'Exported'
                : `Export feedback${feedbackExportCount ? ` (${feedbackExportCount})` : ''}`}
            </button>
          </header>

          {/* Store status banner — tells the reviewer at a glance whether
              real submissions are wired up, soft-disabled (no token), or
              the fetch errored. Static rows still render either way. */}
          <div
            style={{
              padding: '10px 22px',
              borderBottom: '1px solid var(--hair)',
              fontSize: 11.5,
              color: 'var(--ink-3)',
              lineHeight: 1.45,
            }}
          >
            {fetched.phase === 'loading' && 'Loading real submissions…'}
            {fetched.phase === 'loaded' && realRows.length > 0 && (
              <>
                <strong style={{ color: 'var(--forest)' }}>Real submissions live</strong>
                {' '}
                — {realRows.length} shown newest first.
              </>
            )}
            {fetched.phase === 'loaded' && realRows.length === 0 && (
              <>
                <strong style={{ color: 'var(--forest)' }}>Store enabled</strong>
                {' '}— no real family submissions yet.
              </>
            )}
            {fetched.phase === 'disabled' && (
              <>
                <strong style={{ color: 'var(--ochre-2)' }}>Capture disabled</strong>
                {' '}— set <code className="mono">BLOB_READ_WRITE_TOKEN</code> to
                start receiving real submissions.
              </>
            )}
            {fetched.phase === 'error' && (
              <>
                <strong style={{ color: 'var(--terracotta-2)' }}>Fetch failed</strong>
                {' '}— {fetched.error}.
              </>
            )}
          </div>

          {STATIC_PREVIEW_ENABLED && visibleStaticRows.length > 0 && (
            <div
              style={{
                padding: '8px 22px',
                background: 'var(--leaf)',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--forest)',
                letterSpacing: 0.06,
                textTransform: 'uppercase',
              }}
            >
              Real captured · needs sample prep
            </div>
          )}

          <div className="admin-list-rows">
            {filteredRealRows.map((r) => {
              const on = r.id === selected.id;
              const record = fetched.rows.find((s) => s.id === r.realId);
              const readyToEmail = record ? samplesReadyForParent(record) : false;
              return (
                <button
                  key={r.id}
                  type="button"
                  className={'list-row' + (on ? ' on' : '')}
                  onClick={() => setSelectedId(r.id)}
                  style={{
                    background: on ? undefined : 'rgba(184,138,62,0.04)',
                    border: 0,
                    width: '100%',
                    textAlign: 'left',
                  }}
                >
                  <div
                    className="avatar avatar-monogram"
                    aria-hidden="true"
                    style={{
                      background: 'var(--leaf, #e9e8d6)',
                      backgroundImage: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: 'var(--serif)',
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--forest, #3d5240)',
                      letterSpacing: 0.5,
                    }}
                  >
                    {monogram(r.parent)}
                  </div>
                  <div className="who">
                    <div className="fr-row" style={{ gap: 8 }}>
                      <span className="who-name">{r.parent}</span>
                      <span className="mono" style={{ color: 'var(--ink-4)' }}>·</span>
                      <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                        {r.child}, {r.age}
                      </span>
                    </div>
                    <div className="meta">
                      {r.id} · {r.direction} · {r.time}
                    </div>
                  </div>
                  <span
                    className={
                      'chip has-dot ' +
                      (readyToEmail ? 's-ready' : STATUS_CHIP[r.status])
                    }
                    title={
                      readyToEmail
                        ? 'Three samples are uploaded and ready to email to the parent'
                        : `Current workflow status: ${record?.status.replaceAll('_', ' ') ?? r.status}`
                    }
                  >
                    {readyToEmail ? 'Email ready' : STATUS_LABEL[r.status]}
                  </span>
                </button>
              );
            })}
            {filteredRealRows.length === 0 && activeFilter !== 'all' && (
              <div
                className="card card-quiet"
                style={{
                  margin: 16,
                  padding: 14,
                  fontSize: 12.5,
                  color: 'var(--ink-3)',
                }}
              >
                No submissions in this status.
              </div>
            )}
          </div>

          {realRows.length > 0 && (
            <div
              style={{
                padding: '8px 22px',
                background: 'var(--paper-2)',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--ink-3)',
                letterSpacing: 0.06,
                textTransform: 'uppercase',
              }}
            >
              Static preview · no real data
            </div>
          )}

          {STATIC_PREVIEW_ENABLED && visibleStaticRows.length > 0 && (
          <div className="admin-list-rows">
            {visibleStaticRows.map((r) => {
              const on = r.id === selected.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  className={'list-row' + (on ? ' on' : '')}
                  onClick={() => setSelectedId(r.id)}
                  style={{ background: 'transparent', border: 0, width: '100%', textAlign: 'left' }}
                >
                  {/* Monogram tile (e.g. "Priya M." → PM). Replaces the
                      previous striped-stripe placeholder which read as
                      broken art. Decorative — real name is in .who. */}
                  <div
                    className="avatar avatar-monogram"
                    aria-hidden="true"
                    style={{
                      background: 'var(--leaf, #e9e8d6)',
                      backgroundImage: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: 'var(--serif)',
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--forest, #3d5240)',
                      letterSpacing: 0.5,
                    }}
                  >
                    {monogram(r.parent)}
                  </div>
                  <div className="who">
                    <div className="fr-row" style={{ gap: 8 }}>
                      <span className="who-name">{r.parent}</span>
                      <span className="mono" style={{ color: 'var(--ink-4)' }}>·</span>
                      <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                        {r.child}, {r.age}
                      </span>
                    </div>
                    <div className="meta">
                      {r.id} · {r.direction} · {r.time}
                    </div>
                  </div>
                  <span className={'chip has-dot ' + STATUS_CHIP[r.status]}>
                    {STATUS_LABEL[r.status]}
                  </span>
                </button>
              );
            })}
          </div>
          )}
        </section>

        {/* DETAIL */}
        <section className="detail">
          {!selected ? (
            <div className="card card-quiet" style={{ padding: 20 }}>
              <div className="eyebrow forest" style={{ marginBottom: 8 }}>
                No submissions yet
              </div>
              <h1 className="fr-h1 serif" style={{ lineHeight: 1.2, margin: 0 }}>
                Waiting for the first family review
              </h1>
              <p className="help" style={{ marginTop: 10 }}>
                Production admin shows real captured submissions only. Static
                demo rows are hidden so reviewers do not confuse mock data for
                family submissions.
              </p>
            </div>
          ) : (
          <>
          {/* Header restructured 2026-05-19: chips, heading, and meta
              line each occupy their own row with explicit spacing so
              the large h-1 heading can't visually overlap or crowd the
              meta line at any viewport. Action buttons live on their
              own row below the title block so the heading is never
              compressed by a flex-shrink action cluster. */}
          <div className="stack-12">
            {selected.isReal && selectedRealRecord?.deletionRequestedAt && (
              <div
                role="alert"
                style={{
                  padding: '12px 14px',
                  background: 'rgba(193, 73, 50, 0.14)',
                  border: '1.5px solid rgba(193, 73, 50, 0.55)',
                  borderRadius: 8,
                  color: 'var(--terracotta-2, #8a3a23)',
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: 1.45,
                }}
              >
                <strong>Deletion requested by parent</strong> at{' '}
                {new Date(selectedRealRecord.deletionRequestedAt).toLocaleString()}.
                STOP all sample prep. Purge reference photos and any samples
                from Blob, then archive the submission. Confirm by email
                within 48 hours.
              </div>
            )}
            <div className="fr-row" style={{ gap: 10, flexWrap: 'wrap', rowGap: 8 }}>
              <span className="mono" style={{ color: 'var(--ink-3)' }}>{selected.id}</span>
              <span className={'chip has-dot ' + STATUS_CHIP[selected.status]}>
                {STATUS_LABEL[selected.status]}
              </span>
              <span
                className="chip"
                style={{
                  background: 'var(--leaf)',
                  color: 'var(--forest)',
                  borderColor: 'var(--line-2)',
                }}
              >
                <Icon name="check" size={11} color="var(--forest)" stroke={2.2} /> Consent on file
              </span>
              {selected.isReal && selectedRealRecord?.deletionRequestedAt && (
                <span
                  className="chip"
                  style={{
                    background: 'rgba(193, 73, 50, 0.14)',
                    color: 'var(--terracotta-2, #8a3a23)',
                    borderColor: 'rgba(193, 73, 50, 0.55)',
                  }}
                >
                  Deletion requested
                </span>
              )}
            </div>
            <h1 className="fr-h1 serif" style={{ lineHeight: 1.25, margin: 0 }}>
              {selected.parent} · {selected.child}, age {selected.age}
            </h1>
            <div className="admin-detail-toolbar">
              <div className="admin-detail-meta">
                <span className="meta" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{selected.email}</span>
                <span className="meta" aria-hidden="true">·</span>
                {selected.isReal ? (
                  selectedRealRecord?.photos.uploadedToServer ? (
                    <span
                      className="meta"
                      style={{ color: 'var(--forest)', fontWeight: 500 }}
                      title="Reference photos uploaded privately. Filenames stripped."
                    >
                      {selectedRealRecord.photos.count} private photo
                      {selectedRealRecord.photos.count === 1 ? '' : 's'} uploaded
                    </span>
                  ) : (
                    <span
                      className="meta"
                      style={{ color: 'var(--ochre-2)', fontWeight: 500 }}
                      title="Legacy record from before private upload was enabled."
                    >
                      {selectedRealRecord?.photos.count ?? 0} photo
                      {(selectedRealRecord?.photos.count ?? 0) === 1
                        ? ''
                        : 's'}{' '}
                      · legacy record, no server-stored files
                    </span>
                  )
                ) : (
                  <span className="meta">2 reference photos · mock</span>
                )}
                <span className="meta" aria-hidden="true">·</span>
                <span className="meta">Direction: {selected.direction}</span>
              </div>
              <div className="admin-detail-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => onQuickStatus('submitted', 'Request reshoot')}
                  disabled={!selected.isReal || quickActionBusy !== null}
                  title="Moves this submission back to Submitted. Email follow-up is still manual."
                >
                  {quickActionBusy === 'Request reshoot'
                    ? 'Saving...'
                    : 'Request reshoot'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() =>
                    onQuickStatus('samples_in_progress', 'Regenerate')
                  }
                  disabled={!selected.isReal || quickActionBusy !== null}
                >
                  {quickActionBusy === 'Regenerate'
                    ? 'Saving...'
                    : 'Regenerate'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => onQuickStatus('archived', 'Mark failed')}
                  disabled={!selected.isReal || quickActionBusy !== null}
                  style={{ color: 'var(--terracotta-2, #8a3a23)' }}
                >
                  {quickActionBusy === 'Mark failed'
                    ? 'Saving...'
                    : 'Mark failed'}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  onClick={() =>
                    onQuickStatus('feedback_received', 'Mark passed')
                  }
                  disabled={!selected.isReal || quickActionBusy !== null}
                >
                  {quickActionBusy === 'Mark passed'
                    ? 'Saving...'
                    : 'Mark passed'}
                </button>
              </div>
            </div>
            {quickActionErr && (
              <p className="help" style={{ color: 'var(--err)', margin: 0 }}>
                {quickActionErr}
              </p>
            )}
          </div>

          <div className="admin-detail-grid">
            <div className="stack-16">
              <div className="stack-8">
                <div className="fr-row-between">
                  <div className="eyebrow forest">References</div>
                  {selected.isReal ? (
                    <span
                      className="meta"
                      style={{ color: 'var(--ochre-2)', fontWeight: 500 }}
                    >
                      {selectedRealRecord?.photos.count ?? 0} photo
                      {(selectedRealRecord?.photos.count ?? 0) === 1
                        ? ''
                        : 's'}{' '}
                      · count only
                    </span>
                  ) : (
                    <span className="meta">2 photos · mock</span>
                  )}
                </div>
                {selected.isReal ? (
                  selectedRealRecord?.photos.uploadedToServer &&
                  selectedRealRecord.photos.assets.length > 0 ? (
                    <div className="stack-8">
                      <div
                        role="alert"
                        style={{
                          padding: '8px 10px',
                          borderRadius: 6,
                          background: 'rgba(193, 73, 50, 0.10)',
                          border: '1px solid rgba(193, 73, 50, 0.40)',
                          color: 'var(--terracotta-2, #8a3a23)',
                          fontSize: 11.5,
                          fontWeight: 500,
                          lineHeight: 1.4,
                        }}
                      >
                        Do NOT screenshot or share these photos. Child
                        reference photos for private sample generation only.
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr',
                          gap: 6,
                        }}
                      >
                        {selectedRealRecord.photos.assets.map((p, i) => {
                          const proxyUrl = adminAssetUrl(
                            selectedRealRecord.id,
                            p.assetId,
                          );
                          return (
                            <a
                              key={p.assetId}
                              href={proxyUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                borderRadius: 6,
                                overflow: 'hidden',
                                border: '1px solid var(--line-2)',
                                aspectRatio: '3 / 4',
                                display: 'block',
                                background: 'var(--paper-2)',
                                borderBottom: 'none',
                              }}
                              title={`Reference ${i + 1} · ${p.mime} · ${Math.round(p.size / 1024)} KB`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={proxyUrl}
                                alt=""
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                }}
                              />
                            </a>
                          );
                        })}
                      </div>
                      <span className="help">
                        Filenames are stripped at upload — paths use random
                        ids only. Click a thumbnail to open the bytes via
                        the admin-key-gated proxy.
                      </span>
                    </div>
                  ) : (
                    <div
                      className="card card-quiet"
                      style={{
                        padding: 14,
                        textAlign: 'center',
                        color: 'var(--ink-3)',
                        fontSize: 12.5,
                        lineHeight: 1.5,
                      }}
                    >
                      <Icon name="shield" size={14} color="var(--forest)" />
                      <div style={{ marginTop: 6, fontWeight: 500, color: 'var(--ink-2)' }}>
                        Photos not stored on server
                      </div>
                      <div style={{ marginTop: 4 }}>
                        This is a legacy record from before private upload
                        was enabled. Email the parent for references.
                      </div>
                    </div>
                  )
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <PhotoPH label="01" tone="warm" aspect="3 / 4" />
                    <PhotoPH label="02" tone="ochre" aspect="3 / 4" />
                  </div>
                )}
              </div>

              {/* Consent & deletion. Mock data has NO deletion request,
                  so the deletion banner stays quiet (single muted row).
                  If a future mock toggles deletionRequested=true the
                  red blocking banner appears at the top of the card.
                  Marketing release "not granted" is shown with explicit
                  caution tone + "Do not use externally" so reviewers
                  can't accidentally treat it as approved. */}
              <div className="card" style={{ padding: 12 }}>
                <div className="eyebrow forest" style={{ marginBottom: 8 }}>
                  Consent &amp; deletion
                </div>
                {selected.deletionRequested ? (
                  <div
                    role="alert"
                    style={{
                      marginBottom: 10,
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'rgba(193, 73, 50, 0.12)',
                      border: '1px solid rgba(193, 73, 50, 0.45)',
                      color: 'var(--terracotta-2, #8a3a23)',
                      fontSize: 12.5,
                      fontWeight: 500,
                      lineHeight: 1.4,
                    }}
                  >
                    Deletion request on file — STOP review and purge references.
                  </div>
                ) : null}
                <div className="stack-6">
                  {[
                    { t: 'Consent signed', v: '12 min ago', tone: 'ok' as const },
                    { t: 'Photos for evaluation only', v: 'agreed', tone: 'ok' as const },
                    {
                      t: 'Marketing release',
                      v: 'not granted',
                      tone: 'caution' as const,
                      note: 'Do not use externally',
                    },
                    { t: 'Deletion request', v: '—', tone: 'quiet' as const },
                  ].map((row) => {
                    const valueColor =
                      row.tone === 'ok'
                        ? 'var(--forest)'
                        : row.tone === 'caution'
                          ? 'var(--ochre-2, #8a6a2a)'
                          : 'var(--ink-3)';
                    return (
                      <div
                        key={row.t}
                        className="fr-row-between"
                        style={{
                          padding: '4px 0',
                          ...(row.tone === 'caution'
                            ? {
                                background: 'rgba(184, 138, 62, 0.08)',
                                borderRadius: 4,
                                padding: '6px 8px',
                              }
                            : {}),
                          alignItems: 'flex-start',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{row.t}</span>
                        <span
                          className="mono"
                          style={{
                            color: valueColor,
                            fontWeight: row.tone === 'caution' ? 500 : 400,
                            textAlign: 'right',
                          }}
                        >
                          {row.v}
                        </span>
                        {row.tone === 'caution' && row.note ? (
                          <span
                            style={{
                              flexBasis: '100%',
                              fontSize: 11.5,
                              color: 'var(--ochre-2, #8a6a2a)',
                              fontWeight: 500,
                              lineHeight: 1.4,
                            }}
                          >
                            {row.note}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="stack-16">
              {selected.isReal && selectedRealRecord && (
                <RealWorkflow
                  submission={selectedRealRecord}
                  onUpdated={(next) => {
                    setFetched((prev) => ({
                      ...prev,
                      rows: prev.rows.map((r) => (r.id === next.id ? next : r)),
                    }));
                  }}
                />
              )}
              {!selected.isReal && (
              <div className="stack-8">
                <div className="fr-row-between">
                  <div className="eyebrow forest">Generated samples</div>
                  <span className="meta">3 illustrations · static mock</span>
                </div>
                <div className="admin-samples-grid">
                  {(['dino', 'bedtime', 'space'] as const).map((k, i) => (
                    <div key={k} className="illu">
                      <StoryArt kind={k} />
                      <span className="illu-meta">v{i + 1} · {selected.direction.toLowerCase()}</span>
                    </div>
                  ))}
                </div>
              </div>
              )}

              {!selected.isReal && (
              <div className="card" style={{ padding: 16 }}>
                <div className="fr-row-between" style={{ marginBottom: 12 }}>
                  <div className="eyebrow forest">Reviewer score</div>
                  <span className="meta">Internal draft (static mock)</span>
                </div>

                <div className="admin-rating-grid">
                  <div className="stack-8">
                    <div className="fr-row-between">
                      <span style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 }}>
                        Likeness
                      </span>
                      <span className="mono" style={{ color: 'var(--ink)' }}>4 / 5</span>
                    </div>
                    <Rating value={4} />
                    <span className="help">Reads as the same child across all three.</span>
                  </div>
                  <div className="stack-8">
                    <div className="fr-row-between">
                      <span style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 }}>
                        Consistency
                      </span>
                      <span className="mono" style={{ color: 'var(--ink)' }}>5 / 5</span>
                    </div>
                    <Rating value={5} />
                    <span className="help">Hair, expression, build all hold up.</span>
                  </div>
                </div>

                <hr className="rule" style={{ margin: '16px 0' }} />

                <div className="stack-10">
                  <div className="fr-row-between">
                    <span style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 }}>
                      Gift quality
                    </span>
                    <span className="meta">would a parent be proud to give this?</span>
                  </div>
                  <div className="pillrow">
                    {[
                      { v: 'yes', label: 'Yes — gift-worthy', on: true },
                      { v: 'maybe', label: 'Maybe — needs polish' },
                      { v: 'no', label: 'No — not yet' },
                    ].map((g) => (
                      <span
                        key={g.v}
                        className={'pill tone-forest' + (g.on ? ' on' : '')}
                        style={{ height: 34, padding: '0 14px' }}
                      >
                        {g.label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="field" style={{ marginTop: 16 }}>
                  <label className="field-label" htmlFor="reviewer-notes">Reviewer notes</label>
                  <textarea
                    id="reviewer-notes"
                    className="textarea"
                    rows={3}
                    defaultValue="Bedtime piece is the strongest. Slight skin-tone shift on v3, double-check against ref 02. Recommend sending."
                    style={{ resize: 'none' }}
                  />
                </div>
              </div>
              )}
            </div>
          </div>
          </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Real-submission workflow                                          */
/* ---------------------------------------------------------------- */

const SAMPLE_MIME = 'image/jpeg,image/png,image/webp';
const STATUS_OPTIONS: { v: SubmissionStatus; label: string }[] = [
  { v: 'submitted', label: 'Submitted' },
  { v: 'samples_in_progress', label: 'Samples in progress' },
  { v: 'samples_ready', label: 'Samples ready' },
  { v: 'feedback_received', label: 'Feedback received' },
  { v: 'invited_to_order', label: 'Invited to order' },
  { v: 'archived', label: 'Archived' },
];

function feedbackRunLabel(runId?: string) {
  if (!runId) return 'legacy sample run';
  return runId.replace(/^run_/, 'run ');
}

function submissionTimeline(submission: FamilyReviewSubmission) {
  const feedbackHistory = submission.feedbackHistory ?? [];
  const sampleUploadedAt = submission.samples
    .map((s) => s.uploadedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const items = [
    {
      label: 'Submitted',
      detail: `${submission.parent.name} submitted ${submission.photos.count} reference photo${submission.photos.count === 1 ? '' : 's'}.`,
      at: submission.receivedAt,
      tone: 'quiet',
    },
  ];
  if (sampleUploadedAt) {
    items.push({
      label: submission.samples.length >= 3 ? 'Sample run ready' : 'Sample run in progress',
      detail: `${submission.samples.length}/3 samples uploaded${submission.currentSampleRunId ? ` · ${feedbackRunLabel(submission.currentSampleRunId)}` : ''}.`,
      at: sampleUploadedAt,
      tone: submission.samples.length >= 3 ? 'ok' : 'warn',
    });
  }
  for (const feedback of feedbackHistory) {
    items.push({
      label: 'Parent feedback',
      detail: `Rating ${feedback.rating}/5 · likeness ${feedback.looksLikeChild} · ${feedbackRunLabel(feedback.sampleRunId)}`,
      at: feedback.submittedAt,
      tone: 'ok',
    });
  }
  if (submission.feedback && !feedbackHistory.some((f) => f.submittedAt === submission.feedback?.submittedAt)) {
    items.push({
      label: 'Current feedback',
      detail: `Rating ${submission.feedback.rating}/5 · likeness ${submission.feedback.looksLikeChild} · ${feedbackRunLabel(submission.feedback.sampleRunId)}`,
      at: submission.feedback.submittedAt,
      tone: 'ok',
    });
  }
  items.push({
    label: `Current status: ${submission.status.replaceAll('_', ' ')}`,
    detail: submission.status === 'samples_in_progress'
      ? 'Reviewer is preparing a new sample pass.'
      : 'Latest workflow state.',
    at: submission.updatedAt,
    tone: submission.status === 'archived' ? 'bad' : 'quiet',
  });
  return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function RealWorkflow({
  submission,
  onUpdated,
}: {
  submission: FamilyReviewSubmission;
  onUpdated: (next: FamilyReviewSubmission) => void;
}) {
  const briefs = renderBriefsForSubmission({
    childFirstName: submission.child.firstName,
    ageRange: submission.child.ageRange,
    pronoun: submission.child.pronoun,
    direction: submission.direction,
  });
  const hasReviewToken =
    typeof submission.reviewToken === 'string' && submission.reviewToken.length > 0;
  const reviewUrl = hasReviewToken
    ? typeof window !== 'undefined'
      ? `${window.location.origin}/family-review/review/${submission.reviewToken}`
      : `/family-review/review/${submission.reviewToken}`
    : null;

  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [copyEmailState, setCopyEmailState] = useState<'idle' | 'copied'>('idle');
  const [busyStatus, setBusyStatus] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const priorFeedback = (submission.feedbackHistory ?? []).filter(
    (fb) => fb.submittedAt !== submission.feedback?.submittedAt,
  );
  const timeline = submissionTimeline(submission);
  const sampleEmail = reviewUrl
    ? buildParentSampleEmail(submission, reviewUrl)
    : null;
  const readyToEmail = samplesReadyForParent(submission);
  // Admin auth rides on the fr_admin_session HttpOnly cookie. The
  // reviewer key is never read from the URL or stored in component
  // state. credentials: 'same-origin' is the default but we set it
  // explicitly on every admin fetch so a future refactor can't quietly
  // strip the cookie.

  const onCopy = async () => {
    if (!reviewUrl) return;
    try {
      await navigator.clipboard.writeText(reviewUrl);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      /* clipboard may be denied — fall back: select-on-focus via the
         <code> element below */
    }
  };

  const onCopyEmail = async () => {
    if (!sampleEmail) return;
    try {
      await navigator.clipboard.writeText(
        `Subject: ${sampleEmail.subject}\n\n${sampleEmail.body}`,
      );
      setCopyEmailState('copied');
      setTimeout(() => setCopyEmailState('idle'), 1500);
    } catch {
      /* clipboard may be denied */
    }
  };

  const onSetStatus = async (next: SubmissionStatus) => {
    setBusyStatus(true);
    setStatusErr(null);
    try {
      const res = await fetch(
        `/api/family-review/admin/submissions/${submission.id}/status`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            status: next,
            ...(next === 'invited_to_order'
              ? { betaDiscountCode: 'BETAHERO20' }
              : {}),
          }),
        },
      );
      const data = (await res.json()) as { ok?: boolean; submission?: FamilyReviewSubmission; error?: string };
      if (!res.ok || !data.ok || !data.submission) {
        setStatusErr(data.error ?? `HTTP ${res.status}`);
      } else {
        onUpdated(data.submission);
      }
    } catch (err) {
      setStatusErr(err instanceof Error ? err.message : 'network_error');
    } finally {
      setBusyStatus(false);
    }
  };

  return (
    <div className="stack-16">
      <div className="card card-warm" style={{ padding: 16 }}>
        <div className="eyebrow forest" style={{ marginBottom: 8 }}>
          Parent review link
        </div>
        {reviewUrl ? (
          <>
            <p className="help" style={{ marginBottom: 8 }}>
              The parent&apos;s ONLY way to see their samples. Share by email
              only. Anyone with this link sees the submission.
            </p>
            <code
              className="mono"
              onClick={(e) => {
                const el = e.currentTarget;
                const range = document.createRange();
                range.selectNodeContents(el);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              }}
              style={{
                display: 'block',
                padding: 10,
                background: 'var(--paper)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                fontSize: 11.5,
                wordBreak: 'break-all',
                cursor: 'text',
                color: 'var(--ink-2)',
              }}
            >
              {reviewUrl}
            </code>
            <div className="fr-row" style={{ gap: 8, marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onCopy}
              >
                {copyState === 'copied' ? 'Copied' : 'Copy link'}
              </button>
              <a
                href={reviewUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost btn-sm"
                style={{ textDecoration: 'none', borderBottom: 'none' }}
              >
                Open as parent
              </a>
            </div>
          </>
        ) : (
          <p className="help" style={{ marginBottom: 8, color: 'var(--ochre)' }}>
            Review link was issued once at submission and is not recoverable from stored data.
            Do not send a parent link from this board.
          </p>
        )}
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 6,
            border: readyToEmail
              ? '1px solid rgba(74,112,90,0.28)'
              : '1px solid var(--line)',
            background: readyToEmail
              ? 'rgba(74,112,90,0.09)'
              : 'var(--paper-2)',
          }}
        >
          <div className="fr-row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
            <div className="stack-2">
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: readyToEmail ? 'var(--forest)' : 'var(--ink-2)',
                }}
              >
                {!sampleEmail
                  ? 'Parent review link unavailable'
                  : readyToEmail
                    ? 'Ready to send sample email'
                    : 'Sample email draft waiting on uploads'}
              </span>
              <span className="help">
                {submission.samples.length}/3 samples uploaded · subject avoids
                possessive apostrophes for email-client safety.
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onCopyEmail}
              disabled={!readyToEmail || !sampleEmail}
              title={
                !sampleEmail
                  ? 'The parent link was issued once and is not stored'
                  : readyToEmail
                  ? 'Copy subject and body for a manual parent email'
                  : 'Upload all three samples and mark samples ready first'
              }
            >
              {copyEmailState === 'copied' ? 'Copied draft' : 'Copy email draft'}
            </button>
          </div>
          {readyToEmail && sampleEmail && (
            <div
              className="mono"
              style={{
                marginTop: 8,
                padding: 8,
                background: 'var(--paper)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                fontSize: 11.5,
                color: 'var(--ink-2)',
                whiteSpace: 'pre-wrap',
              }}
            >
              Subject: {sampleEmail.subject}
              {'\n\n'}
              {sampleEmail.body}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="eyebrow forest" style={{ marginBottom: 8 }}>
          Status workflow
        </div>
        <div className="pillrow">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.v}
              type="button"
              className={
                'pill tone-forest' + (submission.status === s.v ? ' on' : '')
              }
              onClick={() => onSetStatus(s.v)}
              disabled={busyStatus || submission.status === s.v}
              aria-pressed={submission.status === s.v}
            >
              {s.label}
            </button>
          ))}
        </div>
        {statusErr && (
          <p className="help" style={{ color: 'var(--err)', marginTop: 8 }}>
            {statusErr}
          </p>
        )}
        {submission.status === 'invited_to_order' && submission.betaDiscountCode && (
          <p className="help" style={{ marginTop: 8 }}>
            Beta code on file:{' '}
            <code className="mono">{submission.betaDiscountCode}</code> (parent
            sees this on their review page). Checkout backend redemption is not
            wired yet — mention the code to your reviewer at order time.
          </p>
        )}
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="eyebrow forest" style={{ marginBottom: 8 }}>
          Review timeline
        </div>
        <div className="stack-8">
          {timeline.map((item, i) => {
            const dot =
              item.tone === 'ok'
                ? 'var(--forest)'
                : item.tone === 'warn'
                  ? 'var(--ochre)'
                  : item.tone === 'bad'
                    ? 'var(--terracotta)'
                    : 'var(--ink-3)';
            return (
              <div
                key={`${item.label}-${item.at}-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '14px 1fr',
                  gap: 8,
                  alignItems: 'start',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: dot,
                    marginTop: 5,
                  }}
                />
                <div className="stack-2">
                  <div className="fr-row-between" style={{ gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>
                      {item.label}
                    </span>
                    <span className="mono" style={{ color: 'var(--ink-3)' }}>
                      {new Date(item.at).toLocaleString()}
                    </span>
                  </div>
                  <p className="help">{item.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="eyebrow forest" style={{ marginBottom: 8 }}>
          Sample briefs (manual prep)
        </div>
        <p className="help" style={{ marginBottom: 10 }}>
          Use these prompts outside this app (ChatGPT image creation, hand
          painting, whatever). Review the output, then upload the approved
          file under the matching brief below. <strong>This app never
          calls any image-generation API.</strong>
        </p>
        <div className="stack-12">
          {briefs.map((b) => (
            <SampleSlot
              key={b.briefId}
              submissionId={submission.id}
              briefLabel={b.label}
              briefIntent={b.intent}
              briefPrompt={b.prompt}
              briefConstraints={b.constraints}
              briefReviewChecklist={b.reviewChecklist}
              briefId={b.briefId}
              existing={submission.samples.find((s) => s.briefId === b.briefId)}
              onUploaded={(next) => onUpdated(next)}
            />
          ))}
        </div>
      </div>

      {submission.feedback && (
        <div className="card card-warm" style={{ padding: 14 }}>
          <div className="eyebrow forest" style={{ marginBottom: 8 }}>
            Parent feedback
          </div>
          <div className="stack-6">
            <div className="fr-row-between">
              <span className="meta">Rating</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {submission.feedback.rating} / 5
              </span>
            </div>
            <div className="fr-row-between">
              <span className="meta">Likeness</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {submission.feedback.looksLikeChild}
              </span>
            </div>
            {submission.feedback.notes && (
              <div className="stack-4" style={{ marginTop: 4 }}>
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
                  {submission.feedback.notes}
                </p>
              </div>
            )}
            <div className="fr-row-between">
              <span className="meta">Received</span>
              <span className="mono" style={{ color: 'var(--ink-3)' }}>
                {new Date(submission.feedback.submittedAt).toLocaleString()}
              </span>
            </div>
            {submission.feedback.sampleRunId && (
              <div className="fr-row-between">
                <span className="meta">Sample run</span>
                <span className="mono" style={{ color: 'var(--ink-3)' }}>
                  {feedbackRunLabel(submission.feedback.sampleRunId)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      {priorFeedback.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="eyebrow forest" style={{ marginBottom: 8 }}>
            Prior feedback history
          </div>
          <div className="stack-10">
            {[...priorFeedback].reverse().map((fb) => (
              <div
                key={`${fb.submittedAt}-${fb.sampleRunId ?? 'legacy'}`}
                className="stack-4"
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  padding: 10,
                }}
              >
                <div className="fr-row-between">
                  <span className="meta">
                    {new Date(fb.submittedAt).toLocaleString()}
                  </span>
                  <span className="mono" style={{ color: 'var(--ink-3)' }}>
                    {feedbackRunLabel(fb.sampleRunId)}
                  </span>
                </div>
                <div className="help">
                  Rating {fb.rating} / 5 · likeness {fb.looksLikeChild}
                </div>
                {fb.notes && (
                  <p className="help" style={{ whiteSpace: 'pre-wrap' }}>
                    {fb.notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SampleSlot({
  submissionId,
  briefId,
  briefLabel,
  briefIntent,
  briefPrompt,
  briefConstraints,
  briefReviewChecklist,
  existing,
  onUploaded,
}: {
  submissionId: string;
  briefId: 'cover-hero' | 'dinosaur-adventure' | 'bedtime-keepsake';
  briefLabel: string;
  briefIntent: string;
  briefPrompt: string;
  briefConstraints: string[];
  briefReviewChecklist: string[];
  existing?: { assetId: string; blobUrl: string; mime: string; uploadedAt: string; note?: string };
  onUploaded: (next: FamilyReviewSubmission) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState(existing?.note ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set('briefId', briefId);
      fd.set('sample', file);
      if (note) fd.set('note', note);
      const res = await fetch(
        `/api/family-review/admin/submissions/${submissionId}/sample`,
        { method: 'POST', body: fd, credentials: 'same-origin' },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        asset?: unknown;
        status?: SubmissionStatus;
        samples?: unknown;
      };
      if (!res.ok || !data.ok) {
        setErr(data.error ?? `HTTP ${res.status}`);
        setBusy(false);
        return;
      }
      // Refresh the parent's submission view by re-fetching the list.
      const listRes = await fetch(
        `/api/family-review/submissions?limit=10`,
        { cache: 'no-store', credentials: 'same-origin' },
      );
      const listData = (await listRes.json()) as {
        ok?: boolean;
        submissions?: FamilyReviewSubmission[];
      };
      if (listData.ok && listData.submissions) {
        const found = listData.submissions.find((s) => s.id === submissionId);
        if (found) onUploaded(found);
      }
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'network_error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 6,
        padding: 12,
        background: 'var(--paper-2)',
      }}
    >
      <div className="stack-8">
        <div className="fr-row-between" style={{ gap: 8, flexWrap: 'wrap', rowGap: 4 }}>
          <strong style={{ fontSize: 13 }}>{briefLabel}</strong>
          {existing ? (
            <span className="chip s-pass" style={{ height: 22 }}>
              Uploaded
            </span>
          ) : (
            <span className="chip s-new" style={{ height: 22 }}>
              Not uploaded
            </span>
          )}
        </div>
        <p className="help">{briefIntent}</p>
        <div
          className="stack-4"
          style={{
            background: 'rgba(74, 112, 90, 0.08)',
            border: '1px solid rgba(74, 112, 90, 0.22)',
            borderRadius: 6,
            padding: 10,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--forest)' }}>
            Reviewer quality gate
          </span>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {briefReviewChecklist.map((item) => (
              <li key={item} className="help" style={{ marginBottom: 3 }}>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <details>
          <summary className="help" style={{ cursor: 'pointer' }}>
            Prompt + constraints (click to expand)
          </summary>
          <pre
            className="mono"
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 11.5,
              padding: 10,
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              marginTop: 6,
              color: 'var(--ink-2)',
            }}
          >
            {briefPrompt}
          </pre>
          <ul className="help" style={{ paddingLeft: 18, marginTop: 6 }}>
            {briefConstraints.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>

        {existing && (
          <div
            style={{
              borderRadius: 6,
              overflow: 'hidden',
              border: '1px solid var(--line-2)',
              aspectRatio: '4 / 5',
              maxWidth: 200,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={adminAssetUrl(submissionId, existing.assetId)}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        )}

        <div className="field">
          <label className="field-label" htmlFor={`note-${briefId}`}>
            Reviewer note <span className="opt">optional, shown to parent</span>
          </label>
          <input
            id={`note-${briefId}`}
            type="text"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            placeholder="e.g. We softened the eyes; let us know if this reads as Mira."
          />
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={SAMPLE_MIME}
          style={{ display: 'none' }}
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="btn btn-forest btn-sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {busy
            ? 'Uploading…'
            : existing
              ? 'Replace sample file'
              : 'Upload sample file'}
        </button>
        {err && (
          <p className="help" style={{ color: 'var(--err)' }}>
            {err}
          </p>
        )}
      </div>
    </div>
  );
}
