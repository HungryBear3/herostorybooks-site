'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  PageTextLayout,
  PageTextPosition,
  TextColorMode,
  TextSizePreset,
} from '@/lib/fulfillment-types';
import { clamp, TEXT_POSITION_BOUNDS } from '@/lib/proof-text-layout';

/**
 * Constrained proof text placement tool. This is NOT a freeform canvas: the
 * customer can only nudge the story text block within safe printable bounds,
 * pick one of three sizes, and pick a color mode. No arbitrary fonts, colors,
 * rotation, opacity, or panels are exposed. Drag is clamped; nudge buttons are
 * the mobile-friendly fallback.
 */

const DEFAULT_POSITION: Required<PageTextPosition> = { xPct: 10, yPct: 78, widthPct: 80 };
const NUDGE_STEP_PCT = 2;

const SIZE_OPTIONS: { value: TextSizePreset; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];
const COLOR_OPTIONS: { value: TextColorMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const SIZE_FONT_PX: Record<TextSizePreset, number> = { small: 12, medium: 15, large: 18 };

export interface ProofTextLayoutPatch {
  position: PageTextPosition | null;
  sizePreset: TextSizePreset;
  colorMode: TextColorMode;
}

interface ProofTextEditorProps {
  pageIndex: number;
  imageUrl: string | null;
  storyText: string;
  layout?: PageTextLayout | null;
  saving: boolean;
  onSave: (patch: ProofTextLayoutPatch) => void;
}

function clampPosition(pos: PageTextPosition): Required<PageTextPosition> {
  const widthPct = clamp(
    pos.widthPct ?? DEFAULT_POSITION.widthPct,
    TEXT_POSITION_BOUNDS.widthPct.min,
    TEXT_POSITION_BOUNDS.widthPct.max,
  );
  return {
    xPct: clamp(pos.xPct, TEXT_POSITION_BOUNDS.xPct.min, TEXT_POSITION_BOUNDS.xPct.max),
    yPct: clamp(pos.yPct, TEXT_POSITION_BOUNDS.yPct.min, TEXT_POSITION_BOUNDS.yPct.max),
    widthPct,
  };
}

export function ProofTextEditor({
  pageIndex,
  imageUrl,
  storyText,
  layout,
  saving,
  onSave,
}: ProofTextEditorProps) {
  const [position, setPosition] = useState<Required<PageTextPosition>>(
    layout?.position ? clampPosition(layout.position) : DEFAULT_POSITION,
  );
  const [sizePreset, setSizePreset] = useState<TextSizePreset>(layout?.sizePreset ?? 'medium');
  const [colorMode, setColorMode] = useState<TextColorMode>(layout?.colorMode ?? 'auto');
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Reset the draft whenever the selected page changes so edits never leak
  // across pages.
  useEffect(() => {
    setPosition(layout?.position ? clampPosition(layout.position) : DEFAULT_POSITION);
    setSizePreset(layout?.sizePreset ?? 'medium');
    setColorMode(layout?.colorMode ?? 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex]);

  const moveToClientPoint = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const xPct = ((clientX - rect.left) / rect.width) * 100;
    const yPct = ((clientY - rect.top) / rect.height) * 100;
    setPosition((prev) => clampPosition({ ...prev, xPct, yPct }));
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      draggingRef.current = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      moveToClientPoint(e.clientX, e.clientY);
    },
    [moveToClientPoint],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      moveToClientPoint(e.clientX, e.clientY);
    },
    [moveToClientPoint],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const nudge = useCallback((dx: number, dy: number) => {
    setPosition((prev) =>
      clampPosition({ ...prev, xPct: prev.xPct + dx, yPct: prev.yPct + dy }),
    );
  }, []);

  const handleReset = useCallback(() => {
    setPosition(DEFAULT_POSITION);
    setSizePreset('medium');
    setColorMode('auto');
    onSave({ position: null, sizePreset: 'medium', colorMode: 'auto' });
  }, [onSave]);

  const handleSave = useCallback(() => {
    onSave({ position, sizePreset, colorMode });
  }, [onSave, position, sizePreset, colorMode]);

  // Preview-only text color. The PDF resolves 'auto' to dark on the cream band;
  // mirror that here so the preview reads truthfully.
  const previewColor = colorMode === 'light' ? '#FFFFFF' : '#10263d';

  return (
    <section
      className="mb-4 rounded-xl border border-gray-200 bg-white p-3"
      data-testid="proof-text-editor"
      aria-label="Fine-tune text placement"
    >
      <p className="mb-1 text-sm font-semibold text-[#10263d]">Fine-tune text placement</p>
      <p className="mb-3 text-xs text-gray-500">
        We laid out a professional design for you. If you’d like, nudge where the story
        text sits, or pick a size. This never changes the words — only where they sit.
      </p>

      <div
        ref={containerRef}
        className="relative mx-auto w-full max-w-[420px] touch-none select-none overflow-hidden rounded-lg border border-gray-200 bg-gray-50"
        style={{ aspectRatio: '595 / 842' }}
        data-testid="proof-text-editor-canvas"
      >
        {imageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={imageUrl}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
            Image still rendering
          </div>
        )}

        <div
          role="button"
          tabIndex={0}
          aria-label="Drag to move the story text. Use the nudge buttons below as an alternative."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="absolute cursor-move rounded-md border border-dashed border-[#c9a227] bg-[#FFF8F0]/85 px-2 py-1 shadow-sm"
          style={{
            left: `${position.xPct}%`,
            top: `${position.yPct}%`,
            width: `${position.widthPct}%`,
            color: previewColor,
            fontSize: `${SIZE_FONT_PX[sizePreset]}px`,
            lineHeight: 1.25,
          }}
          data-testid="proof-text-block"
        >
          <span className="line-clamp-3 block">{storyText || 'Your story text'}</span>
        </div>
      </div>

      {/* Nudge fallback (mobile-friendly; works without precise dragging). */}
      <div className="mt-3 flex items-center justify-center gap-2" aria-label="Nudge text position">
        <button type="button" onClick={() => nudge(-NUDGE_STEP_PCT, 0)} className="nudge-btn rounded-md border border-gray-200 px-3 py-1.5 text-sm" aria-label="Nudge left">←</button>
        <button type="button" onClick={() => nudge(0, -NUDGE_STEP_PCT)} className="nudge-btn rounded-md border border-gray-200 px-3 py-1.5 text-sm" aria-label="Nudge up">↑</button>
        <button type="button" onClick={() => nudge(0, NUDGE_STEP_PCT)} className="nudge-btn rounded-md border border-gray-200 px-3 py-1.5 text-sm" aria-label="Nudge down">↓</button>
        <button type="button" onClick={() => nudge(NUDGE_STEP_PCT, 0)} className="nudge-btn rounded-md border border-gray-200 px-3 py-1.5 text-sm" aria-label="Nudge right">→</button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <fieldset>
          <legend className="mb-1 text-xs font-semibold text-gray-600">Text size</legend>
          <div className="flex gap-1" role="group" aria-label="Text size">
            {SIZE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSizePreset(opt.value)}
                aria-pressed={sizePreset === opt.value}
                className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${
                  sizePreset === opt.value
                    ? 'border-[#c9a227] bg-amber-50 font-semibold text-[#10263d]'
                    : 'border-gray-200 text-gray-600'
                }`}
                data-testid={`size-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-xs font-semibold text-gray-600">Text color</legend>
          <div className="flex gap-1" role="group" aria-label="Text color">
            {COLOR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setColorMode(opt.value)}
                aria-pressed={colorMode === opt.value}
                className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${
                  colorMode === opt.value
                    ? 'border-[#c9a227] bg-amber-50 font-semibold text-[#10263d]'
                    : 'border-gray-200 text-gray-600'
                }`}
                data-testid={`color-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-xl bg-[#10263d] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          data-testid="save-text-layout"
        >
          {saving ? 'Saving…' : 'Save text placement'}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={saving}
          className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-[#10263d] disabled:opacity-50"
          data-testid="reset-text-layout"
        >
          Reset to recommended
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Saving updates your proof only. It does not approve the page or send anything to print.
      </p>
    </section>
  );
}
