'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProofCardOverride, ProofTextColor } from '@/lib/fulfillment-types';
import {
  LEGACY_DEFAULT_TEXT_COLOR,
  PROOF_CARD_BOUNDS,
  PROOF_CARD_BASE_FONT_PT,
  PROOF_TEXT_COLORS,
  evaluateProofTextContrast,
  proofCardPreviewModel,
  type ProofCardGeometry,
} from '@/lib/proof-layout-override';
import {
  applyKeyboardGeometry,
  applyPointerMove,
  applyPointerResize,
  buildFitBody,
  buildLayoutApplyBody,
  buildLayoutResetBody,
  colorChoiceFromOverride,
  createLatestRequestTracker,
  customerProofFitUrl,
  customerProofLayoutUrl,
  customerRequestHelpUrl,
  describeCardGeometry,
  geometryFromOverride,
  interpretLayoutMutationResponse,
  isEditorArrowKey,
  layoutMutationNotice,
  type LayoutColorChoice,
} from '@/lib/proof-layout-editor-core';

type ColorOption = { value: LayoutColorChoice; swatch: string; label: string };
const COLOR_OPTIONS: ColorOption[] = [
  { value: 'legacy_default', swatch: LEGACY_DEFAULT_TEXT_COLOR.text, label: 'Standard' },
  { value: 'dark_brown', swatch: PROOF_TEXT_COLORS.dark_brown.text, label: 'Dark brown' },
  { value: 'cream', swatch: PROOF_TEXT_COLORS.cream.text, label: 'Cream (for dark art)' },
  { value: 'charcoal', swatch: PROOF_TEXT_COLORS.charcoal.text, label: 'Charcoal (for light art)' },
];

function colorForModel(choice: LayoutColorChoice): ProofTextColor | undefined {
  return choice === 'legacy_default' ? undefined : (choice as ProofTextColor);
}
function contrastFor(choice: LayoutColorChoice, opacity: number) {
  return evaluateProofTextContrast(colorForModel(choice), opacity);
}

export interface CustomerProofLayoutEditorProps {
  orderId: string;
  reviewToken: string | null;
  pageIndex: number;
  imageUrl: string | null;
  storyText: string;
  /** Current authoritative binding — the editor is only mounted when present. */
  proofVersion: string;
  sourceFingerprint: string;
  initialOverride: ProofCardOverride | null;
  /** The op currently holding the shared lock (drives disabled state). */
  busyOp: string | null;
  /** Run `fn` under the shared lock as `op`; `fn` receives its ordering token. */
  runMutation: (op: string, fn: (token: number) => Promise<void>) => Promise<void>;
  /** Adopt `snapshot` in the parent ONLY if `token` is still the current op. */
  applyIfCurrent: (token: number, snapshot: unknown) => void;
  /** A real Save/Reset committed: close the editor and show the durable notice
   *  in the PARENT (survives this child's unmount). Snapshot already adopted. */
  onCommitted: (notice: string) => void;
  /** Request-help recorded: adopt happened via applyIfCurrent; editor STAYS open. */
  onClose: () => void;
}

type DragMode =
  | { kind: 'move'; startX: number; startY: number; origin: ProofCardGeometry }
  | { kind: 'resize'; startX: number; startY: number; origin: ProofCardGeometry };

export default function CustomerProofLayoutEditor(props: CustomerProofLayoutEditorProps) {
  const {
    orderId, reviewToken, pageIndex, imageUrl, storyText, proofVersion, sourceFingerprint,
    initialOverride, busyOp, runMutation, applyIfCurrent, onCommitted, onClose,
  } = props;

  const frameRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode | null>(null);
  const [geo, setGeo] = useState<ProofCardGeometry>(() => geometryFromOverride(initialOverride));
  const [color, setColor] = useState<LayoutColorChoice>(() => colorChoiceFromOverride(initialOverride));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [announce, setAnnounce] = useState<string>('');
  // AUTHORITATIVE fit from the real renderer (via the read-only fit route).
  const [fit, setFit] = useState<{ state: 'pending' | 'ready' | 'error'; fontSize: number; overflowed: boolean }>(
    { state: 'pending', fontSize: PROOF_CARD_BASE_FONT_PT, overflowed: false },
  );
  const fitTrackerRef = useRef(createLatestRequestTracker());

  const busy = busyOp != null;
  const hasPersistedOverride = initialOverride != null;
  const contrast = contrastFor(color, geo.opacity);
  const binding = { authoredAgainstProofVersion: proofVersion, authoredAgainstFingerprint: sourceFingerprint };
  // Preview font + overflow come from the AUTHORITATIVE fit once known; before
  // that the font falls back to base (Save stays disabled until fit resolves).
  const authoritativeFit = fit.state === 'pending' ? null : { fontSize: fit.fontSize, overflowed: fit.overflowed };
  const model = proofCardPreviewModel(geo, colorForModel(color), authoritativeFit);
  // Save is blocked until the renderer confirms this exact geometry fits.
  const fitBlocksSave = fit.state !== 'ready' || fit.overflowed;

  // B5: move focus into the editor (the interactive card) on open.
  useEffect(() => {
    cardRef.current?.focus();
    setAnnounce(describeCardGeometry(geo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the AUTHORITATIVE fit whenever the fit-relevant geometry changes (only
  // size + fontScale affect fit; position does not). Debounced, and guarded by a
  // latest-wins tracker so a slow response for an older geometry is dropped.
  const fitKey = `${geo.width}:${geo.height}:${geo.fontScale}:${pageIndex}`;
  useEffect(() => {
    const token = fitTrackerRef.current.next();
    setFit((prev) => ({ state: 'pending', fontSize: prev.fontSize, overflowed: false }));
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const fallback = PROOF_CARD_BASE_FONT_PT * geo.fontScale;
      try {
        const res = await fetch(customerProofFitUrl(orderId, reviewToken), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFitBody(pageIndex, geo, binding)),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (!fitTrackerRef.current.isCurrent(token)) return; // superseded by a newer geometry
        const f = (data as { ok?: boolean; fit?: { overflowed?: unknown; fontSize?: unknown } } | null)?.fit;
        if (res.ok && (data as { ok?: boolean })?.ok && f && typeof f.overflowed === 'boolean' && typeof f.fontSize === 'number') {
          setFit({ state: 'ready', fontSize: f.fontSize, overflowed: f.overflowed });
        } else {
          // Couldn't confirm fit → fail closed (block Save) rather than guess.
          setFit({ state: 'error', fontSize: fallback, overflowed: false });
        }
      } catch {
        if (!fitTrackerRef.current.isCurrent(token)) return;
        setFit({ state: 'error', fontSize: fallback, overflowed: false });
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame) return;
    // Suppress page scroll ONLY while a gesture is active.
    event.preventDefault();
    const rect = frame.getBoundingClientRect();
    const dx = (event.clientX - drag.startX) / rect.width;
    const dy = (event.clientY - drag.startY) / rect.height;
    setGeo(drag.kind === 'move' ? applyPointerMove(drag.origin, dx, dy) : applyPointerResize(drag.origin, dx, dy));
  }, []);

  const endGesture = useCallback((event: React.PointerEvent) => {
    if (dragRef.current) setAnnounce(describeCardGeometry(geoRef.current));
    dragRef.current = null;
    try { (event.currentTarget as Element).releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }, []);

  // Keep a ref to the latest geometry so gesture-end can announce it.
  const geoRef = useRef(geo);
  geoRef.current = geo;

  function startGesture(kind: DragMode['kind'], event: React.PointerEvent) {
    if (busy) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, origin: geo };
    try { (event.currentTarget as Element).setPointerCapture(event.pointerId); } catch { /* unsupported */ }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!isEditorArrowKey(event.key)) return;
    if (busy) { event.preventDefault(); return; }
    const next = applyKeyboardGeometry(geo, event.key, { shift: event.shiftKey, alt: event.altKey });
    if (next) {
      event.preventDefault();
      setGeo(next);
      setAnnounce(describeCardGeometry(next));
    }
  }

  async function submitLayout(op: 'save' | 'reset') {
    const body = op === 'save'
      ? buildLayoutApplyBody(pageIndex, geo, color, binding)
      : buildLayoutResetBody(pageIndex, binding);
    await runMutation(op, async (token) => {
      setError(null);
      setStatus(null);
      let response: Response;
      try {
        response = await fetch(customerProofLayoutUrl(orderId, reviewToken), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        setError('We couldn’t reach the server. Check your connection and try again.');
        return;
      }
      const data = await response.json().catch(() => null);
      const outcome = interpretLayoutMutationResponse(response.ok, response.status, data, orderId);
      if (!outcome.ok) { setError(outcome.message); return; }
      // Adopt the authoritative snapshot (guarded against stale ordering).
      applyIfCurrent(token, outcome.snapshot);
      if (outcome.noop) {
        // No change: never claim a rebuild; stay open and say so honestly.
        setStatus(layoutMutationNotice(op, true));
      } else {
        // Real mutation: close + let the PARENT own the durable notice.
        onCommitted(layoutMutationNotice(op, false));
      }
    });
  }

  async function requestHelp() {
    await runMutation('help', async (token) => {
      setError(null);
      setStatus(null);
      let response: Response;
      try {
        response = await fetch(customerRequestHelpUrl(orderId, reviewToken), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageIndex }),
        });
      } catch {
        setError('We couldn’t reach the server. Check your connection and try again.');
        return;
      }
      const data = await response.json().catch(() => null);
      const outcome = interpretLayoutMutationResponse(response.ok, response.status, data, orderId);
      if (!outcome.ok) { setError(outcome.message); return; }
      // Help does NOT invalidate the proof: adopt in parent WITHOUT closing.
      applyIfCurrent(token, outcome.snapshot);
      setStatus(layoutMutationNotice('help', outcome.noop));
    });
  }

  const busyLabel = busyOp === 'save' ? 'Saving…' : busyOp === 'reset' ? 'Resetting…' : busyOp === 'help' ? 'Requesting help…' : null;

  return (
    <section
      className="mt-4 rounded-2xl border border-forest/20 bg-white p-4"
      aria-label="Page layout editor"
      data-testid="customer-layout-editor"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-serif text-lg text-forest">Adjust this page’s text placement</h3>
        <button type="button" onClick={onClose} disabled={busy} className="min-h-11 min-w-11 px-3 text-sm underline text-gray-600 disabled:opacity-50" data-testid="layout-done">
          Done
        </button>
      </div>
      <p className="mt-1 text-sm text-gray-600">
        Drag the text card, use arrow keys to nudge it (Shift for bigger steps, Alt+arrow to resize),
        adjust the panel and text size, and pick a text colour. This is a placement preview — saving
        prepares a fresh proof for you to review; it doesn’t approve your book.
      </p>

      {/* ── Faithful placement preview (art frame + paper band + panel-only opacity) ── */}
      <div
        ref={frameRef}
        className="preview-frame relative mx-auto mt-3 w-full max-w-sm overflow-hidden rounded-xl border border-gray-200"
        style={{ aspectRatio: String(model.page.aspectRatio), containerType: 'size', background: '#FFF8F0' }}
        data-testid="preview-frame"
      >
        {/* Artwork occupies the top art-frame fraction; paper band shows below it. */}
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            className="absolute left-0 top-0 w-full object-cover"
            style={{ height: `${model.artFrameFraction * 100}%` }}
            draggable={false}
            data-testid="preview-artwork"
          />
        ) : (
          <div
            className="absolute left-0 top-0 flex w-full items-center justify-center bg-gray-100 text-xs text-gray-400"
            style={{ height: `${model.artFrameFraction * 100}%` }}
          >
            Illustration preview
          </div>
        )}

        {/* Draggable legibility panel. The BACKGROUND layer carries the opacity;
            the text is a separate, fully-opaque layer. */}
        <div
          ref={cardRef}
          role="group"
          aria-label="Text card. Focus and use arrow keys to move; Shift for larger steps; Alt with arrows to resize."
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => startGesture('move', e)}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          className="absolute cursor-move touch-none outline-none focus-visible:ring-2 focus-visible:ring-forest"
          style={{
            left: `${model.panel.xPct}%`, top: `${model.panel.yPct}%`,
            width: `${model.panel.widthPct}%`, height: `${model.panel.heightPct}%`,
          }}
          data-testid="layout-card"
        >
          {/* panel background only — opacity applies HERE, not to the text */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: model.panelFill, opacity: model.panelOpacity, borderRadius: `${model.cornerRadiusPct}cqw` }}
            data-testid="layout-card-panel"
          />
          {/* keyboard focus ring outline */}
          <span aria-hidden className="pointer-events-none absolute inset-0 rounded-lg border-2 border-forest/70" style={{ borderRadius: `${model.cornerRadiusPct}cqw` }} />
          {/* 44×44 resize handle — POINTER-ONLY and NOT focusable, so arrow keys
              can never land here and accidentally MOVE the card. The sole
              keyboard resize path is the card's documented Alt+Arrow (see the
              card's accessible name above). */}
          <span
            aria-hidden
            role="presentation"
            onPointerDown={(e) => startGesture('resize', e)}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            className={`absolute -bottom-2 -right-2 h-11 w-11 touch-none rounded-full border border-forest bg-white shadow ${busy ? 'pointer-events-none opacity-50' : 'cursor-se-resize'}`}
            data-testid="layout-resize-handle"
          >
            <span aria-hidden className="pointer-events-none absolute inset-0 m-auto h-3 w-3 rounded-sm border-b-2 border-r-2 border-forest" />
          </span>
        </div>

        {/* Fully-opaque, vertically-centred text at the renderer's normalized insets. */}
        <div
          aria-hidden
          className="pointer-events-none absolute flex items-center overflow-hidden leading-tight"
          style={{
            left: `${model.text.xPct}%`, top: `${model.text.yPct}%`,
            width: `${model.text.widthPct}%`, height: `${model.text.heightPct}%`,
            color: model.text.fill, opacity: model.textOpacity,
            fontSize: `${model.text.fontSizePctOfFrameHeight}cqh`,
          }}
          data-testid="layout-card-text"
        >
          <span className="block w-full">{storyText}</span>
        </div>
      </div>

      {/* B5: accessible geometry result of keyboard/pointer moves. */}
      <p aria-live="polite" className="sr-only" data-testid="layout-geometry-status">{announce}</p>

      {/* ── Panel + text-size controls (B3) ── */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-h-11 flex-col justify-center text-sm text-gray-700">
          <span className="mb-1 flex justify-between">
            <span className="font-semibold text-forest">Panel opacity</span>
            <span aria-hidden>{Math.round(geo.opacity * 100)}%</span>
          </span>
          <input
            type="range"
            min={PROOF_CARD_BOUNDS.opacity.min}
            max={PROOF_CARD_BOUNDS.opacity.max}
            step={0.01}
            value={geo.opacity}
            disabled={busy}
            aria-label={`Panel opacity, ${Math.round(geo.opacity * 100)} percent`}
            onChange={(e) => setGeo((g) => ({ ...g, opacity: Number(e.target.value) }))}
            className="h-11 w-full disabled:opacity-50"
            data-testid="layout-opacity"
          />
        </label>
        <label className="flex min-h-11 flex-col justify-center text-sm text-gray-700">
          <span className="mb-1 flex justify-between">
            <span className="font-semibold text-forest">Text size</span>
            <span aria-hidden>{Math.round(geo.fontScale * 100)}%</span>
          </span>
          <input
            type="range"
            min={PROOF_CARD_BOUNDS.fontScale.min}
            max={PROOF_CARD_BOUNDS.fontScale.max}
            step={0.01}
            value={geo.fontScale}
            disabled={busy}
            aria-label={`Text size, ${Math.round(geo.fontScale * 100)} percent`}
            onChange={(e) => setGeo((g) => ({ ...g, fontScale: Number(e.target.value) }))}
            className="h-11 w-full disabled:opacity-50"
            data-testid="layout-fontscale"
          />
        </label>
      </div>

      <fieldset className="mt-3" disabled={busy}>
        <legend className="text-xs font-semibold uppercase tracking-wide text-forest">Text colour</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setColor(opt.value)}
              aria-pressed={color === opt.value}
              className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm disabled:opacity-50 ${color === opt.value ? 'border-forest ring-1 ring-forest' : 'border-gray-200'}`}
            >
              <span aria-hidden className="h-4 w-4 rounded-full border border-gray-300" style={{ background: opt.swatch }} />
              {opt.label}
            </button>
          ))}
        </div>
        <p className={`mt-1 text-xs ${contrast.ok ? 'text-gray-500' : 'text-red-600'}`} data-testid="layout-contrast-note">
          {contrast.ok
            ? 'This colour is easy to read here.'
            : 'This colour is hard to read at the current panel opacity — raise the panel opacity above, or pick another colour.'}
        </p>
      </fieldset>

      {/* AUTHORITATIVE overflow surfaced accessibly (real renderer decision). */}
      <p aria-live="assertive" role="alert" className="mt-2 min-h-[1.25rem] text-xs text-red-600" data-testid="layout-overflow-note">
        {fit.state === 'ready' && fit.overflowed
          ? 'The text doesn’t fit this card at the current size — make the card larger or reduce the text size before saving.'
          : fit.state === 'error'
            ? 'We couldn’t check whether the text fits this card. Adjust the card or try again before saving.'
            : ''}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => submitLayout('save')}
          disabled={busy || !contrast.ok || fitBlocksSave}
          className="min-h-11 rounded-full bg-forest px-5 text-sm font-semibold text-white disabled:opacity-50"
          data-testid="layout-save"
        >
          {busyOp === 'save' ? 'Saving…' : fit.state === 'pending' ? 'Checking fit…' : 'Save layout'}
        </button>
        <button
          type="button"
          onClick={() => submitLayout('reset')}
          disabled={busy || !hasPersistedOverride}
          className="min-h-11 rounded-full border border-forest px-5 text-sm font-semibold text-forest disabled:opacity-50"
          data-testid="layout-reset"
          title={hasPersistedOverride ? undefined : 'This page already uses the standard placement.'}
        >
          {busyOp === 'reset' ? 'Resetting…' : 'Reset to standard'}
        </button>
        <button
          type="button"
          onClick={requestHelp}
          disabled={busy}
          className="min-h-11 rounded-full border border-gray-300 px-5 text-sm text-gray-700 disabled:opacity-50"
          data-testid="layout-request-help"
        >
          {busyOp === 'help' ? 'Requesting help…' : 'Request help with this layout'}
        </button>
      </div>
      {!contrast.ok && (
        <p className="mt-2 text-xs text-red-600" data-testid="layout-save-blocked">
          Saving is paused until the text is readable — raise the panel opacity or choose another colour.
        </p>
      )}

      <p aria-live="polite" role="status" className="mt-2 min-h-[1.25rem] text-sm text-forest" data-testid="layout-status">{busyLabel ?? status}</p>
      <p aria-live="assertive" role="alert" className="min-h-[1.25rem] text-sm text-red-600" data-testid="layout-error">{error}</p>
    </section>
  );
}
