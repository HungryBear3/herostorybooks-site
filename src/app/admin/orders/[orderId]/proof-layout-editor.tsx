'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { ProofCardOverride, ProofTextColor } from '@/lib/fulfillment-types';
import type { ReviewSnapshot } from '@/lib/page-review';
import {
  canonicalizeProofCardGeometry,
  evaluateProofTextContrast,
  LEGACY_DEFAULT_TEXT_COLOR,
  PROOF_CARD_BOUNDS,
  PROOF_TEXT_COLORS,
  resolveProofTextColor,
  type ProofCardGeometry,
} from '@/lib/proof-layout-override';

type ColorChoice = 'legacy_default' | ProofTextColor;
const COLOR_OPTIONS: { value: ColorChoice; swatch: string; label: string }[] = [
  { value: 'legacy_default', swatch: LEGACY_DEFAULT_TEXT_COLOR.text, label: 'Default (legacy)' },
  { value: 'dark_brown', swatch: PROOF_TEXT_COLORS.dark_brown.text, label: 'Dark brown' },
  { value: 'cream', swatch: PROOF_TEXT_COLORS.cream.text, label: 'Cream (dark art)' },
  { value: 'charcoal', swatch: PROOF_TEXT_COLORS.charcoal.text, label: 'Charcoal (light art)' },
];

const PAGE_ASPECT = 595.28 / 841.89;
const STORY_IMAGE_HEIGHT_FRACTION = 650 / 841.89;
const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.05;

function resolveChoice(choice: ColorChoice) {
  return resolveProofTextColor(choice === 'legacy_default' ? undefined : choice);
}

function contrastFor(choice: ColorChoice, opacity: number) {
  return evaluateProofTextContrast(choice === 'legacy_default' ? undefined : choice, opacity);
}

function defaultGeometry(): ProofCardGeometry {
  return canonicalizeProofCardGeometry({
    x: 42 / 595.28,
    y: 650 / 841.89,
    width: (595.28 - 84) / 595.28,
    height: 156 / 841.89,
    opacity: 0.9,
    fontScale: 1,
  });
}

function toGeometry(override: ProofCardOverride | null | undefined): ProofCardGeometry {
  return override ? canonicalizeProofCardGeometry(override) : defaultGeometry();
}

function initialColorChoice(override: ProofCardOverride | null | undefined): ColorChoice {
  return override?.textColor ?? 'legacy_default';
}

type DragMode =
  | { kind: 'move'; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'resize'; startX: number; startY: number; originW: number; originH: number };

interface Props {
  orderId: string;
  pageIndex: number;
  imageUrl: string | null;
  storyText: string;
  proofVersion: string;
  sourceFingerprint: string;
  proofFresh: boolean;
  initialOverride: ProofCardOverride | null;
  onCommitted: (snapshot: ReviewSnapshot) => void;
  onClose: () => void;
}

interface LayoutResponse {
  error?: string;
  snapshot?: ReviewSnapshot;
}

function proofLayoutEditorIdentity({
  initialOverride,
  proofVersion,
  sourceFingerprint,
  proofFresh,
  orderId,
  pageIndex,
}: Pick<Props, 'initialOverride' | 'proofVersion' | 'sourceFingerprint' | 'proofFresh' | 'orderId' | 'pageIndex'>): string {
  return JSON.stringify([
    orderId,
    pageIndex,
    proofVersion,
    sourceFingerprint,
    proofFresh,
    initialOverride
      ? {
          x: initialOverride.x,
          y: initialOverride.y,
          width: initialOverride.width,
          height: initialOverride.height,
          opacity: initialOverride.opacity,
          fontScale: initialOverride.fontScale,
          textColor: initialOverride.textColor ?? null,
          authoredAgainstProofVersion: initialOverride.authoredAgainstProofVersion,
          authoredAgainstFingerprint: initialOverride.authoredAgainstFingerprint,
          appliedAt: initialOverride.appliedAt,
          appliedBy: initialOverride.appliedBy,
        }
      : null,
  ]);
}

export default function ProofLayoutEditor(props: Props) {
  return <ProofLayoutEditorState key={proofLayoutEditorIdentity(props)} {...props} />;
}

function ProofLayoutEditorState({
  orderId,
  pageIndex,
  imageUrl,
  storyText,
  proofVersion,
  sourceFingerprint,
  proofFresh,
  initialOverride,
  onCommitted,
  onClose,
}: Props) {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode | null>(null);
  const [geo, setGeo] = useState<ProofCardGeometry>(() => toGeometry(initialOverride));
  const [color, setColor] = useState<ColorChoice>(() => initialColorChoice(initialOverride));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasOverride, setHasOverride] = useState(Boolean(initialOverride));
  const resolved = resolveChoice(color);
  const contrast = contrastFor(color, geo.opacity);

  const update = useCallback((patch: Partial<ProofCardGeometry>) => {
    setGeo((previous) => canonicalizeProofCardGeometry({ ...previous, ...patch }));
  }, []);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      const frame = frameRef.current;
      if (!drag || !frame) return;
      const rect = frame.getBoundingClientRect();
      const dx = (event.clientX - drag.startX) / rect.width;
      const dy = (event.clientY - drag.startY) / rect.height;
      if (drag.kind === 'move') update({ x: drag.originX + dx, y: drag.originY + dy });
      else update({ width: drag.originW + dx, height: drag.originH + dy });
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [update]);

  function startMove(event: React.PointerEvent) {
    event.preventDefault();
    dragRef.current = {
      kind: 'move',
      startX: event.clientX,
      startY: event.clientY,
      originX: geo.x,
      originY: geo.y,
    };
  }

  function startResize(event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      kind: 'resize',
      startX: event.clientX,
      startY: event.clientY,
      originW: geo.width,
      originH: geo.height,
    };
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const resize = event.altKey;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        resize ? update({ width: geo.width - step }) : update({ x: geo.x - step });
        break;
      case 'ArrowRight':
        event.preventDefault();
        resize ? update({ width: geo.width + step }) : update({ x: geo.x + step });
        break;
      case 'ArrowUp':
        event.preventDefault();
        resize ? update({ height: geo.height - step }) : update({ y: geo.y - step });
        break;
      case 'ArrowDown':
        event.preventDefault();
        resize ? update({ height: geo.height + step }) : update({ y: geo.y + step });
        break;
      default:
        break;
    }
  }

  async function post(body: Record<string, unknown>): Promise<LayoutResponse | null> {
    setBusy(true);
    setErr(null);
    try {
      const response = await fetch(`/api/admin/orders/${orderId}/proof-layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as LayoutResponse;
      if (!response.ok) {
        setErr(errorLabel(data.error, response.status));
        return null;
      }
      if (!data.snapshot) {
        setErr('The server did not return authoritative proof state. Refresh before continuing.');
        return null;
      }
      onCommitted(data.snapshot);
      router.refresh();
      onClose();
      return data;
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Request failed');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const data = await post({
      pageIndex,
      geometry: geo,
      ...(color === 'legacy_default' ? {} : { textColor: color }),
      authoredAgainstProofVersion: proofVersion,
      authoredAgainstFingerprint: sourceFingerprint,
    });
    if (data) setHasOverride(true);
  }

  async function reset() {
    const data = await post({
      pageIndex,
      geometry: null,
      authoredAgainstProofVersion: proofVersion,
      authoredAgainstFingerprint: sourceFingerprint,
    });
    if (data) {
      setHasOverride(false);
      setGeo(defaultGeometry());
      setColor('legacy_default');
    }
  }

  const percent = (value: number) => `${(value * 100).toFixed(3)}%`;

  return (
    <div className="space-y-2 border-t border-gray-100 pt-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-forest uppercase tracking-wide">Proof layout editor</p>
        <button type="button" onClick={onClose} className="text-[10px] underline text-gray-500">done</button>
      </div>

      {!proofFresh ? (
        <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
          Rebuild the proof before editing layout — each change binds to the current proof revision and fingerprint.
        </p>
      ) : (
        <>
          <div
            ref={frameRef}
            className="relative w-full bg-cream overflow-hidden rounded border border-gray-200 select-none"
            style={{ aspectRatio: String(PAGE_ASPECT) }}
          >
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={`Page ${pageIndex + 1} artwork`}
                className="absolute left-0 top-0 w-full object-cover pointer-events-none"
                style={{ height: percent(STORY_IMAGE_HEIGHT_FRACTION) }}
                draggable={false}
              />
            ) : null}
            <div
              role="group"
              aria-label={`Text card for page ${pageIndex + 1}. Arrow keys move; Alt+arrows resize.`}
              tabIndex={0}
              onPointerDown={startMove}
              onKeyDown={onKeyDown}
              className="absolute cursor-move touch-none rounded outline-none ring-1 ring-forest/60 focus:ring-2 focus:ring-forest"
              style={{ left: percent(geo.x), top: percent(geo.y), width: percent(geo.width), height: percent(geo.height) }}
            >
              <div className="absolute inset-0 rounded" style={{ opacity: geo.opacity, backgroundColor: resolved.fill }} />
              <p
                className="relative p-1.5 leading-snug overflow-hidden h-full"
                style={{ fontSize: `${11 * geo.fontScale}px`, color: resolved.text }}
              >
                {storyText}
              </p>
              <span
                onPointerDown={startResize}
                className="absolute -right-3 -bottom-3 h-8 w-8 touch-none cursor-nwse-resize rounded-sm after:absolute after:right-2 after:bottom-2 after:h-3 after:w-3 after:rounded-sm after:bg-forest"
                aria-hidden
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-gray-600">
              Opacity {geo.opacity.toFixed(2)}
              <input
                type="range"
                min={PROOF_CARD_BOUNDS.opacity.min}
                max={PROOF_CARD_BOUNDS.opacity.max}
                step={0.01}
                value={geo.opacity}
                onChange={(event) => update({ opacity: Number(event.target.value) })}
                className="w-full"
                disabled={busy}
              />
            </label>
            <label className="text-[10px] text-gray-600">
              Font scale {geo.fontScale.toFixed(2)}
              <input
                type="range"
                min={PROOF_CARD_BOUNDS.fontScale.min}
                max={PROOF_CARD_BOUNDS.fontScale.max}
                step={0.01}
                value={geo.fontScale}
                onChange={(event) => update({ fontScale: Number(event.target.value) })}
                className="w-full"
                disabled={busy}
              />
            </label>
          </div>

          <div className="space-y-1">
            <p className="text-[10px] text-gray-600">Text color</p>
            <div className="flex flex-wrap gap-1">
              {COLOR_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setColor(option.value)}
                  disabled={busy}
                  aria-pressed={color === option.value}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] border ${color === option.value ? 'border-forest ring-1 ring-forest' : 'border-gray-300'}`}
                >
                  <span className="inline-block h-3 w-3 rounded-sm border border-gray-300" style={{ backgroundColor: option.swatch }} aria-hidden />
                  {option.label}
                </button>
              ))}
            </div>
            <p className={`text-[9px] ${contrast.ok ? 'text-gray-500' : 'text-coral-dark'}`}>
              Deterministic contrast: {contrast.ratio.toFixed(2)}:1 vs {contrast.threshold}:1 required —{' '}
              {contrast.ok ? 'passes' : 'too low; raise opacity or choose another color'}.
            </p>
          </div>

          <p className="text-[9px] text-gray-400">
            Drag the card or use arrow keys (Alt+arrows resize). Saving invalidates the cached proof and closes this editor until a rebuild.
          </p>
          <p className="text-[9px] text-amber-700">
            Collision boxes are visual guides only. Position the card by eye and keep it inside the safe margins.
          </p>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={busy || !hasOverride}
              className="px-2 py-1 text-[11px] rounded font-semibold border border-gray-300 text-gray-700 disabled:opacity-40"
            >
              reset to default
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !contrast.ok}
              className="px-2 py-1 text-[11px] rounded font-semibold bg-forest text-white disabled:opacity-40"
            >
              {busy ? 'saving…' : 'save layout'}
            </button>
          </div>
          {err && <p className="text-[10px] text-coral-dark">{err}</p>}
        </>
      )}
    </div>
  );
}

function errorLabel(code: string | undefined, status: number): string {
  switch (code) {
    case 'text_overflow':
      return 'Text does not fit — enlarge the card or lower the font scale.';
    case 'insufficient_contrast':
      return 'Text color fails the contrast check — raise opacity or choose another color.';
    case 'invalid_text_color':
      return 'Unsupported text color. Choose dark, cream, or charcoal.';
    case 'invalid_geometry':
      return 'Layout geometry is incomplete or malformed. Refresh and try again.';
    case 'stale_revision':
    case 'stale_fingerprint':
    case 'proof_stale':
      return 'Proof changed since you opened the editor — refresh and try again.';
    case 'no_live_proof':
      return 'No live proof to bind to — rebuild the proof first.';
    case 'order_approved':
    case 'order_shipped':
    case 'order_in_production':
    case 'print_submitted':
    case 'order_finalized':
    case 'proof_layout_lifecycle_closed':
      return 'Layout editing is closed because this proof was approved, released, printed, completed, or shipped.';
    case 'order_refunded':
      return 'Layout editing is closed because this order was refunded.';
    case 'order_mutation_busy':
      return 'Another order update won the race. Refresh before trying again.';
    default:
      return code ?? `Failed (${status})`;
  }
}
