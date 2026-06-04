'use client';
/**
 * Guided Photo Capture (MVP) — behind NEXT_PUBLIC_HSB_GUIDED_PHOTO_CAPTURE.
 * Spec: agent-shared/handoffs/2026-06-03-hsb-guided-photo-capture-spec.md
 *
 * Parent-driven camera capture of a few ordinary still reference photos at
 * different angles. NOT Face ID, NOT a face scan, NOT biometric, NOT depth/3D.
 * Parent/guardian consent is taken BEFORE the camera opens. It only grabs the
 * stills the parent selects, never records or uploads video, and persists
 * nothing until checkout submit. The plain file-upload dropzone remains as the
 * always-available fallback. Decision logic lives in lib/guided-photo-capture.ts.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  GUIDED_CAPTURE_PROMPTS,
  GUIDED_CAPTURE_CONSENT_COPY,
  GUIDED_CAPTURE_CONCISE_COPY,
  GUIDED_CAPTURE_CONSENT_CHECKBOX_LABEL,
  GUIDED_MAX_FRAMES,
  cameraSupport,
  stopStreamTracks,
  describeGetUserMediaError,
  guidedFrameFileName,
  addFrame,
  removeFrame,
  retakeFrame,
  setFrameSelected,
  selectedStills,
  selectedLabels,
  framesToUploadFiles,
  type CapturedFrame,
} from '@/lib/guided-photo-capture';
import { canvasFrameToUploadFile } from '@/lib/photo-upload';

export interface GuidedCaptureResult {
  files: File[];
  labels: string[];
}

interface GuidedPhotoCaptureProps {
  /** Receives the parent's approved still images + labels (never video). */
  onComplete: (result: GuidedCaptureResult) => void;
}

export default function GuidedPhotoCapture({ onComplete }: GuidedPhotoCaptureProps) {
  const [consent, setConsent] = useState(false);
  const [open, setOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [promptIndex, setPromptIndex] = useState(0);
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameSeq = useRef(0);

  const support = cameraSupport();

  const stopCamera = useCallback(() => {
    stopStreamTracks(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
  }, []);

  // Release the camera + preview URLs on unmount / route change.
  useEffect(() => {
    return () => {
      stopStreamTracks(streamRef.current);
      streamRef.current = null;
      frames.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!consent) {
      setError('Please confirm the consent checkbox first.');
      return;
    }
    if (!support.supported) {
      setError('This device or browser can’t use the guided camera. Use file upload below instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStreaming(true);
      setOpen(true);
    } catch (err) {
      setError(describeGetUserMediaError(err));
      stopCamera();
    }
  }, [consent, support.supported, stopCamera]);

  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    if (frames.length >= GUIDED_MAX_FRAMES) {
      setError(`You can keep up to ${GUIDED_MAX_FRAMES} photos. Delete one to take another.`);
      return;
    }
    const prompt = GUIDED_CAPTURE_PROMPTS[promptIndex];
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('Couldn’t read the camera frame. Use file upload below instead.');
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const file = await canvasFrameToUploadFile(canvas, { baseName: guidedFrameFileName(prompt.label) });
      frameSeq.current += 1;
      const frame: CapturedFrame = {
        id: `frame-${frameSeq.current}`,
        label: prompt.label,
        file,
        previewUrl: URL.createObjectURL(file),
        selected: true,
      };
      setFrames((prev) => addFrame(prev, frame));
      setPromptIndex((i) => Math.min(i + 1, GUIDED_CAPTURE_PROMPTS.length - 1));
    } catch {
      setError('Couldn’t save that photo. Try again or use file upload below.');
    }
  }, [frames.length, promptIndex]);

  const onDelete = useCallback((id: string) => {
    setFrames((prev) => {
      const { frames: next, removed } = removeFrame(prev, id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }, []);

  const onRetake = useCallback((label: string) => {
    setFrames((prev) => {
      const { frames: next, removed } = retakeFrame(prev, label);
      removed.forEach((f) => URL.revokeObjectURL(f.previewUrl));
      return next;
    });
    const idx = GUIDED_CAPTURE_PROMPTS.findIndex((p) => p.label === label);
    if (idx >= 0) setPromptIndex(idx);
  }, []);

  const onToggleSelected = useCallback((id: string, sel: boolean) => {
    setFrames((prev) => setFrameSelected(prev, id, sel));
  }, []);

  const finish = useCallback(() => {
    const files = framesToUploadFiles(frames); // throws if a non-image slipped in
    const labels = selectedLabels(frames);
    stopCamera();
    onComplete({ files, labels });
    setOpen(false);
  }, [frames, onComplete, stopCamera]);

  const cancel = useCallback(() => {
    stopCamera();
    setOpen(false);
  }, [stopCamera]);

  const prompt = GUIDED_CAPTURE_PROMPTS[promptIndex];
  const selectedCount = selectedStills(frames).length;

  return (
    <section
      data-testid="guided-photo-capture"
      className="rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] p-5 space-y-3"
    >
      <div>
        <h3 className="font-serif text-lg text-[#1f1a16]">Guided photo capture (optional)</h3>
        <p className="mt-1 text-sm text-[#695f54]">
          Take a few quick reference angles with your camera — or skip it and use the upload box below.
        </p>
      </div>

      <p data-testid="guided-photo-consent-copy" className="text-xs leading-5 text-[#8a7b6a]">
        {GUIDED_CAPTURE_CONSENT_COPY}
      </p>
      <p className="text-xs leading-5 text-[#8a7b6a]">{GUIDED_CAPTURE_CONCISE_COPY}</p>

      {!open && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-xs text-[#695f54]">
            <input
              type="checkbox"
              data-testid="guided-photo-consent"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>{GUIDED_CAPTURE_CONSENT_CHECKBOX_LABEL}</span>
          </label>
          <button
            type="button"
            data-testid="guided-photo-start"
            onClick={startCamera}
            disabled={!consent}
            className="rounded-full bg-[#a64c4c] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#8f3f3f] disabled:opacity-40"
          >
            Start guided capture
          </button>
        </div>
      )}

      {error && (
        <p data-testid="guided-photo-error" className="text-sm text-[#a64c4c]">
          {error}
        </p>
      )}

      {open && (
        <div className="space-y-3">
          <div className="relative mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-2xl bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} playsInline muted autoPlay className="h-full w-full object-cover" />
            <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-[70%] w-[55%] rounded-[50%] border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
          </div>

          {streaming && (
            <div className="text-center">
              <p className="font-semibold text-[#1f1a16]">{prompt.title}</p>
              <p className="text-xs text-[#8a7b6a]">{prompt.hint}</p>
              <button
                type="button"
                data-testid="guided-photo-capture-btn"
                onClick={captureFrame}
                className="mt-2 rounded-full bg-[#1f1a16] px-5 py-2 text-sm font-semibold text-white"
              >
                Capture “{prompt.title}”
              </button>
            </div>
          )}

          {frames.length > 0 && (
            <div className="grid grid-cols-3 gap-2" data-testid="guided-photo-review">
              {frames.map((f) => (
                <div key={f.id} className="rounded-xl border border-[#dfd2b8] p-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.previewUrl} alt={`Reference: ${f.label}`} className="h-20 w-full rounded-lg object-cover" />
                  <label className="mt-1 flex items-center gap-1 text-[11px] text-[#695f54]">
                    <input type="checkbox" checked={f.selected} onChange={(e) => onToggleSelected(f.id, e.target.checked)} />
                    Use
                  </label>
                  <div className="mt-1 flex gap-1">
                    <button type="button" onClick={() => onRetake(String(f.label))} className="text-[11px] text-[#a64c4c] underline">
                      Retake
                    </button>
                    <button type="button" onClick={() => onDelete(f.id)} className="text-[11px] text-[#8a7b6a] underline">
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="guided-photo-finish"
              onClick={finish}
              disabled={selectedCount === 0}
              className="rounded-full bg-[#a64c4c] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              Use these photos ({selectedCount})
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-full border border-[#dfd2b8] px-4 py-2 text-sm font-semibold text-[#695f54]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
