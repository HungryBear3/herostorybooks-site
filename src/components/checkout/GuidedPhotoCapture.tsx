"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  GUIDED_CAPTURE_MEDIA_CONSTRAINTS,
  GUIDED_CAMERA_TRUST_BADGES,
  GUIDED_FACE_GUIDE_CLASS_NAME,
  GUIDED_PHOTO_CONSENT_COPY,
  GUIDED_PHOTO_PROMPTS,
  GUIDED_PHOTO_STILL_ONLY_COPY,
  buildGuidedPhotoFileName,
  canStartGuidedCamera,
  getNextGuidedPromptIndex,
  stopMediaTracks,
  type GuidedPhotoFile,
} from "@/lib/guided-photo-capture";

interface GuidedPhotoCaptureProps {
  frames: GuidedPhotoFile[];
  consent: boolean;
  onConsentChange: (consent: boolean) => void;
  onFramesChange: (frames: GuidedPhotoFile[]) => void;
}

const MAX_CAPTURE_WIDTH = 1280;
const JPEG_QUALITY = 0.82;

function dataUrlToFile(dataUrl: string, fileName: string): File {
  const [header, payload] = dataUrl.split(",");
  const mime = header.match(/data:([^;]+)/)?.[1] ?? "image/jpeg";
  const binary = atob(payload ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mime, lastModified: Date.now() });
}

function scaleVideoDimensions(video: HTMLVideoElement) {
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  if (sourceWidth <= MAX_CAPTURE_WIDTH) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const ratio = MAX_CAPTURE_WIDTH / sourceWidth;
  return { width: MAX_CAPTURE_WIDTH, height: Math.max(1, Math.round(sourceHeight * ratio)) };
}

export function GuidedPhotoCapture({
  frames,
  consent,
  onConsentChange,
  onFramesChange,
}: GuidedPhotoCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const currentPromptIndex = getNextGuidedPromptIndex(frames);

  const stopCamera = useCallback(() => {
    stopMediaTracks(streamRef.current);
    streamRef.current = null;
    setCameraActive(false);
  }, []);

  // Stop all media tracks on unmount/navigation so the camera light goes off.
  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    if (!canStartGuidedCamera(consent)) {
      setCameraError("Parent/guardian consent is required before opening the camera.");
      return;
    }
    if (!navigator?.mediaDevices?.getUserMedia) {
      setCameraError("Camera capture is not available in this browser. Use photo upload instead.");
      return;
    }
    try {
      setCameraError(null);
      const stream = await navigator.mediaDevices.getUserMedia(GUIDED_CAPTURE_MEDIA_CONSTRAINTS);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
    } catch {
      setCameraError("Camera permission was blocked or unavailable. Use photo upload instead.");
      stopCamera();
    }
  }, [consent, stopCamera]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const prompt = GUIDED_PHOTO_PROMPTS[currentPromptIndex];
    if (!video || !prompt) return;
    const canvas = document.createElement("canvas");
    const { width, height } = scaleVideoDimensions(video);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("Photo capture failed. Use photo upload instead.");
      return;
    }
    // Still frame only — we draw a single video frame to canvas; the MediaStream
    // is never recorded or uploaded.
    context.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const file = dataUrlToFile(
      dataUrl,
      buildGuidedPhotoFileName(prompt.label, currentPromptIndex, "jpg"),
    );
    const nextFrames = [
      ...frames.filter((frame) => frame.label !== prompt.label),
      { label: prompt.label, file, dataUrl },
    ];
    onFramesChange(nextFrames);
  }, [currentPromptIndex, frames, onFramesChange]);

  const currentPrompt = GUIDED_PHOTO_PROMPTS[currentPromptIndex];
  const completed = frames.length;

  return (
    <div className="rounded-2xl border border-[#cfe0d8] bg-[#eef4f1] p-4 space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#35564d]">
          Optional guided photo capture
        </p>
        <h3 className="font-serif text-xl text-[#1f1a16]">
          Capture {GUIDED_PHOTO_PROMPTS.length} approved reference photos for better likeness
        </h3>
        <p className="text-sm leading-6 text-[#35564d]">{GUIDED_PHOTO_CONSENT_COPY}</p>
        <p className="text-xs leading-5 text-[#5f766f]">{GUIDED_PHOTO_STILL_ONLY_COPY}</p>
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-[#cfe0d8] bg-white/55 p-3 text-sm text-[#35564d]">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => onConsentChange(event.target.checked)}
          className="mt-1 h-4 w-4 accent-[#a64c4c]"
        />
        <span>I am the parent/guardian or have permission to submit these reference photos.</span>
      </label>

      <div className="grid gap-4 md:grid-cols-[1fr_0.85fr]">
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-2xl border border-[#d8c6a2] bg-[#1f1a16]">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="aspect-[3/4] w-full object-cover md:aspect-video"
            />
            {!cameraActive && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#1f1a16]/80 px-6 text-center text-sm text-white">
                Camera stays local until you capture and approve still photos.
              </div>
            )}
            <div className={GUIDED_FACE_GUIDE_CLASS_NAME} />
          </div>
          {cameraError && (
            <p className="rounded-xl border border-[#a64c4c]/25 bg-[#a64c4c]/10 px-3 py-2 text-sm text-[#7a3030]">
              {cameraError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={cameraActive ? stopCamera : startCamera}
              className="rounded-full bg-[#1f1a16] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#3b3029] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={!consent}
            >
              {cameraActive ? "Close camera" : "Open camera"}
            </button>
            <button
              type="button"
              onClick={captureFrame}
              disabled={!cameraActive}
              className="rounded-full bg-[#a64c4c] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#8f3d3d] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Capture {currentPrompt?.title ?? "photo"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-white">
            {GUIDED_CAMERA_TRUST_BADGES.map((badge) => (
              <span key={badge} className="rounded-full bg-[#1f1a16] px-2.5 py-1">
                {badge}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-[#cfe0d8] bg-white/55 p-3">
            <p className="text-sm font-bold text-[#1f1a16]">
              Step {Math.min(currentPromptIndex + 1, GUIDED_PHOTO_PROMPTS.length)} of {GUIDED_PHOTO_PROMPTS.length}: {currentPrompt?.title}
            </p>
            <p className="mt-1 text-xs leading-5 text-[#5f766f]">{currentPrompt?.instruction}</p>
            <p className="mt-2 text-xs font-semibold text-[#35564d]">
              {completed}/{GUIDED_PHOTO_PROMPTS.length} approved stills captured
            </p>
          </div>

          {frames.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {frames.map((frame) => (
                <div key={frame.label} className="overflow-hidden rounded-xl border border-[#d8c6a2] bg-[#fffaf1]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={frame.dataUrl} alt={`${frame.label} guided reference`} className="h-24 w-full object-cover" />
                  <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
                    <span className="truncate font-semibold capitalize text-[#35564d]">{frame.label}</span>
                    <button
                      type="button"
                      className="text-[#a64c4c] underline"
                      onClick={() => onFramesChange(frames.filter((item) => item.label !== frame.label))}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
