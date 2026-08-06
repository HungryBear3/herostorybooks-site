'use client';

import { useCallback, useRef, useState } from 'react';

import type { ProofCardOverride, ProofTextColor } from '@/lib/fulfillment-types';
import type { ReviewSnapshot } from '@/lib/page-review';
import {
  LEGACY_DEFAULT_TEXT_COLOR,
  PROOF_TEXT_COLORS,
  evaluateProofTextContrast,
  resolveProofTextColor,
  type ProofCardGeometry,
} from '@/lib/proof-layout-override';
import {
  applyKeyboardGeometry,
  applyPointerMove,
  applyPointerResize,
  buildLayoutApplyBody,
  buildLayoutResetBody,
  colorChoiceFromOverride,
  customerLayoutErrorMessage,
  customerProofLayoutUrl,
  customerRequestHelpUrl,
  geometryFromOverride,
  isEditorArrowKey,
  layoutBinding,
  type LayoutColorChoice,
} from '@/lib/proof-layout-editor-core';

type ColorOption = { value: LayoutColorChoice; swatch: string; label: string };
const COLOR_OPTIONS: ColorOption[] = [
  { value: 'legacy_default', swatch: LEGACY_DEFAULT_TEXT_COLOR.text, label: 'Standard' },
  { value: 'dark_brown', swatch: PROOF_TEXT_COLORS.dark_brown.text, label: 'Dark brown' },
  { value: 'cream', swatch: PROOF_TEXT_COLORS.cream.text, label: 'Cream (for dark art)' },
  { value: 'charcoal', swatch: PROOF_TEXT_COLORS.charcoal.text, label: 'Charcoal (for light art)' },
];

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
  /** Adopt the authoritative server snapshot; the sole source of committed state. */
  onCommitted: (snapshot: ReviewSnapshot) => void;
  onClose: () => void;
}

type DragMode =
  | { kind: 'move'; startX: number; startY: number; origin: ProofCardGeometry }
  | { kind: 'resize'; startX: number; startY: number; origin: ProofCardGeometry };

function resolvedFor(choice: LayoutColorChoice) {
  return resolveProofTextColor(choice === 'legacy_default' ? undefined : (choice as ProofTextColor));
}
function contrastFor(choice: LayoutColorChoice, opacity: number) {
  return evaluateProofTextContrast(choice === 'legacy_default' ? undefined : (choice as ProofTextColor), opacity);
}

export default function CustomerProofLayoutEditor(props: CustomerProofLayoutEditorProps) {
  const { orderId, reviewToken, pageIndex, imageUrl, storyText, proofVersion, sourceFingerprint, initialOverride, onCommitted, onClose } = props;

  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode | null>(null);
  const [geo, setGeo] = useState<ProofCardGeometry>(() => geometryFromOverride(initialOverride));
  const [color, setColor] = useState<LayoutColorChoice>(() => colorChoiceFromOverride(initialOverride));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const resolved = resolvedFor(color);
  const contrast = contrastFor(color, geo.opacity);
  const binding = { authoredAgainstProofVersion: proofVersion, authoredAgainstFingerprint: sourceFingerprint };

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
    dragRef.current = null;
    try { (event.currentTarget as Element).releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }, []);

  function startGesture(kind: DragMode['kind'], event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, origin: geo };
    // Pointer capture → off-frame / cancelled gestures still deliver up/cancel here.
    try { (event.currentTarget as Element).setPointerCapture(event.pointerId); } catch { /* unsupported */ }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!isEditorArrowKey(event.key)) return;
    const next = applyKeyboardGeometry(geo, event.key, { shift: event.shiftKey, alt: event.altKey });
    if (next) {
      event.preventDefault();
      setGeo(next);
    }
  }

  async function submit(body: Record<string, unknown>, successMsg: string) {
    setBusy(true);
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
      setError(customerLayoutErrorMessage(undefined, 0));
      setBusy(false);
      return;
    }
    const data = (await response.json().catch(() => null)) as { snapshot?: ReviewSnapshot; error?: string } | null;
    if (!response.ok || !data) {
      setError(customerLayoutErrorMessage(data?.error, response.status));
      setBusy(false);
      return;
    }
    if (!data.snapshot) {
      // Never synthesize success without the authoritative snapshot.
      setError('We saved nothing — the server didn’t return the updated proof state. Please reload and try again.');
      setBusy(false);
      return;
    }
    // The returned snapshot is the sole committed state.
    onCommitted(data.snapshot);
    setStatus(successMsg);
    setBusy(false);
    onClose();
  }

  const save = () => submit(
    buildLayoutApplyBody(pageIndex, geo, color, binding),
    'Layout request saved. We’ll prepare an updated full proof for you to review before final approval.',
  );
  const reset = () => submit(
    buildLayoutResetBody(pageIndex, binding),
    'Layout reset to the standard placement. We’ll prepare an updated proof for you to review.',
  );

  async function requestHelp() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(customerRequestHelpUrl(orderId, reviewToken), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageIndex }),
      });
      const data = (await res.json().catch(() => null)) as { snapshot?: ReviewSnapshot } | null;
      if (!res.ok || !data?.snapshot) {
        setError('We couldn’t record your help request. Please try again.');
      } else {
        onCommitted(data.snapshot);
        setStatus('Thanks — we’ve noted that you’d like help with this page’s layout. Our team will take a look; no email has been sent yet.');
      }
    } catch {
      setError(customerLayoutErrorMessage(undefined, 0));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-forest/20 bg-white p-4" aria-label="Page layout editor" data-testid="customer-layout-editor">
      <div className="flex items-center justify-between">
        <h3 className="font-serif text-lg text-forest">Adjust this page’s text placement</h3>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 px-3 text-sm underline text-gray-600">Done</button>
      </div>
      <p className="mt-1 text-sm text-gray-600">
        Drag the text card, use arrow keys to nudge it (Shift for bigger steps, Alt+arrow to resize), and pick a text colour.
        Saving prepares a fresh proof for you to review — it doesn’t approve your book.
      </p>

      <div
        ref={frameRef}
        className="relative mx-auto mt-3 w-full max-w-sm overflow-hidden rounded-xl border border-gray-200 bg-cream"
        style={{ aspectRatio: '595 / 842' }}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">Illustration preview</div>
        )}
        <div
          role="group"
          aria-label="Text card. Focus and use arrow keys to move; Shift for larger steps; Alt with arrows to resize."
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => startGesture('move', e)}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          className="absolute cursor-move touch-none rounded-lg border-2 border-forest/70 outline-none focus-visible:ring-2 focus-visible:ring-forest"
          style={{
            left: `${geo.x * 100}%`, top: `${geo.y * 100}%`,
            width: `${geo.width * 100}%`, height: `${geo.height * 100}%`,
            background: resolved.fill, opacity: geo.opacity,
          }}
          data-testid="layout-card"
        >
          <span className="block h-full w-full overflow-hidden p-1 text-[8px] leading-tight" style={{ color: resolved.text }}>{storyText}</span>
          {/* 44×44 resize handle */}
          <button
            type="button"
            aria-label="Resize the text card"
            onPointerDown={(e) => startGesture('resize', e)}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            className="absolute -bottom-2 -right-2 h-11 w-11 touch-none rounded-full border border-forest bg-white shadow"
          >
            <span aria-hidden className="pointer-events-none absolute inset-0 m-auto h-3 w-3 rounded-sm border-b-2 border-r-2 border-forest" />
          </button>
        </div>
      </div>

      <fieldset className="mt-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-forest">Text colour</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setColor(opt.value)}
              aria-pressed={color === opt.value}
              className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm ${color === opt.value ? 'border-forest ring-1 ring-forest' : 'border-gray-200'}`}
            >
              <span aria-hidden className="h-4 w-4 rounded-full border border-gray-300" style={{ background: opt.swatch }} />
              {opt.label}
            </button>
          ))}
        </div>
        <p className={`mt-1 text-xs ${contrast.ok ? 'text-gray-500' : 'text-red-600'}`}>
          {contrast.ok ? 'This colour is easy to read here.' : 'This colour may be hard to read at the current panel — pick another or make the panel more solid.'}
        </p>
      </fieldset>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={busy} className="min-h-11 rounded-full bg-forest px-5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save layout'}
        </button>
        <button type="button" onClick={reset} disabled={busy} className="min-h-11 rounded-full border border-forest px-5 text-sm font-semibold text-forest disabled:opacity-50">
          Reset to standard
        </button>
        <button type="button" onClick={requestHelp} disabled={busy} className="min-h-11 rounded-full border border-gray-300 px-5 text-sm text-gray-700 disabled:opacity-50">
          Request help with this layout
        </button>
      </div>

      <p aria-live="polite" role="status" className="mt-2 min-h-[1.25rem] text-sm text-forest">{status}</p>
      <p aria-live="assertive" role="alert" className="min-h-[1.25rem] text-sm text-red-600">{error}</p>
    </section>
  );
}
