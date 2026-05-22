'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { PageArtifact } from '@/lib/orders';

const HIGH_REGEN_THRESHOLD = 3;
const NOTES_MAX = 500;

type GridPage = Pick<
  PageArtifact,
  | 'pageIndex'
  | 'storyText'
  | 'currentImageUrl'
  | 'acceptedImageUrl'
  | 'regenerateCount'
  | 'accepted'
  | 'targetedRegenNeeded'
  | 'reviewerNotes'
  | 'reviewedAt'
  | 'generationProvider'
  | 'generationModel'
>;

interface Props {
  orderId: string;
  pages: GridPage[];
}

export default function PageReviewGrid({ orderId, pages }: Props) {
  const sorted = useMemo(() => [...pages].sort((a, b) => a.pageIndex - b.pageIndex), [pages]);
  const flaggedCount = useMemo(
    () => sorted.filter((p) => Boolean(p.targetedRegenNeeded)).length,
    [sorted],
  );

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-xs uppercase tracking-wider text-gray-500">Page review grid</h2>
        <span className="text-[10px] text-gray-400">
          {sorted.length} page{sorted.length === 1 ? '' : 's'} ·{' '}
          {sorted.filter((p) => p.regenerateCount >= HIGH_REGEN_THRESHOLD).length} hot ·{' '}
          {flaggedCount} flagged
        </span>
      </div>
      <p className="text-[11px] text-gray-500 mb-4">
        Internal-only. Click a tile to mark for targeted regeneration or add a note.
        Pages with a high regenerate count or an existing flag get a coral border.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {sorted.map((page) => (
          <PageTile key={page.pageIndex} orderId={orderId} page={page} />
        ))}
      </div>
    </section>
  );
}

function PageTile({ orderId, page }: { orderId: string; page: GridPage }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(page.reviewerNotes ?? '');
  const [flag, setFlag] = useState(Boolean(page.targetedRegenNeeded));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(page.reviewedAt ?? null);

  const dirty =
    flag !== Boolean(page.targetedRegenNeeded) ||
    (notes.trim() || null) !== (page.reviewerNotes ?? null);

  const hot = page.regenerateCount >= HIGH_REGEN_THRESHOLD;
  const flagged = Boolean(page.targetedRegenNeeded);
  const borderColor = flagged
    ? 'border-coral'
    : hot
      ? 'border-amber-300'
      : 'border-gray-200';

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/page-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageIndex: page.pageIndex,
          targetedRegenNeeded: flag,
          reviewerNotes: notes.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; page?: { reviewedAt?: string | null } };
      if (!res.ok) {
        setErr(data.error ?? `Failed (${res.status})`);
      } else {
        setSavedAt(data.page?.reviewedAt ?? new Date().toISOString());
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  const imgUrl = page.currentImageUrl ?? page.acceptedImageUrl ?? null;

  return (
    <div className={`rounded-lg border ${borderColor} bg-cream/40 overflow-hidden flex flex-col`}>
      <div className="relative aspect-square bg-gray-100">
        {imgUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgUrl} alt={`Page ${page.pageIndex + 1}`} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">no image</div>
        )}
        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-mono">
          p{page.pageIndex + 1}
        </div>
        {flagged && (
          <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-coral text-white text-[10px] font-semibold">
            regen
          </div>
        )}
        {hot && !flagged && (
          <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-amber-500 text-white text-[10px] font-semibold">
            hot {page.regenerateCount}
          </div>
        )}
      </div>
      <div className="p-2 text-[11px] flex flex-col gap-1.5">
        <p className="text-gray-700 line-clamp-3 leading-snug">{page.storyText || <span className="text-gray-400">(no story text)</span>}</p>
        <div className="flex items-center justify-between text-gray-500 text-[10px]">
          <span>{page.accepted ? 'accepted' : 'pending'} · regens {page.regenerateCount}</span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="underline text-forest"
          >
            {open ? 'close' : 'review'}
          </button>
        </div>
        {open && (
          <div className="space-y-2 border-t border-gray-100 pt-2">
            <label className="flex items-center gap-2 text-[11px] text-gray-700">
              <input
                type="checkbox"
                checked={flag}
                onChange={(e) => setFlag(e.target.checked)}
                disabled={busy}
              />
              Targeted regen needed
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX))}
              rows={3}
              maxLength={NOTES_MAX}
              placeholder="Reviewer notes (e.g. Lukas looks older here; T-rex too small)…"
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-[11px]"
              disabled={busy}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-gray-400">
                {savedAt ? `saved ${new Date(savedAt).toLocaleString()}` : 'not reviewed'}
              </span>
              <button
                type="button"
                onClick={save}
                disabled={busy || !dirty}
                className="px-2 py-1 text-[11px] rounded font-semibold bg-forest text-white disabled:opacity-40"
              >
                {busy ? 'saving…' : 'save'}
              </button>
            </div>
            {err && <p className="text-[10px] text-coral-dark">{err}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
