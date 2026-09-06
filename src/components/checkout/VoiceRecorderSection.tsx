'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { recordedStoryAudioFileName } from '@/lib/story-attachment';
import { checkRecordedStoryAudioSize, checkStoryMediaFileSize } from '@/lib/story-media-size';
const VOICE_AUDIO_UPLOAD_ACCEPT_ATTR = [
  '.m4a',
  '.mp3',
  '.wav',
  '.webm',
  '.ogg',
  '.oga',
  '.aac',
  '.caf',
  '.aif',
  '.aiff',
  '.flac',
  '.mp4',
].join(',');
const VOICE_DOCUMENT_UPLOAD_ACCEPT_ATTR = [
  'text/plain',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt',
  '.pdf',
  '.doc',
  '.docx',
].join(',');
function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // Some browsers throw on isTypeSupported with parameters — fall through.
    }
  }
  return undefined;
}

export interface VoiceRecorderSectionProps {
  voiceFile: File | null;
  voicePreviewUrl: string | null;
  voiceSource: 'recorded' | 'uploaded' | null;
  voiceConsent: boolean;
  onVoiceChange: (
    file: File | null,
    previewUrl: string | null,
    source: 'recorded' | 'uploaded' | null,
  ) => void;
  onConsentChange: (consent: boolean) => void;
}

/**
 * Custom Story UI for attaching a short voice note or family memory note
 * (audio, or a text/PDF/Word document). It mounts beside the Custom Story choice. The microphone
 * is requested only after the user taps Record; tracks are released as soon as
 * recording stops.
 *
 * The upload is positioned as inspiration/source material for personalizing
 * the story (themes, favorite phrases, emotional texture). It is NOT used for
 * voice cloning.
 */
export function VoiceRecorderSection({
  voiceFile,
  voicePreviewUrl,
  voiceSource,
  voiceConsent,
  onVoiceChange,
  onConsentChange,
}: VoiceRecorderSectionProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const mediaOperationRef = useRef(0);

  // Always release the mic + revoke the preview URL on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mediaOperationRef.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
    };
    // We intentionally do NOT depend on voicePreviewUrl — the cleanup is for unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const handleRecord = useCallback(async () => {
    const operationId = ++mediaOperationRef.current;
    setRecorderError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecorderError('Voice recording is not supported on this browser. You can upload a file instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || operationId !== mediaOperationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickSupportedMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) recordedChunksRef.current.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        if (!mountedRef.current || operationId !== mediaOperationRef.current) {
          recordedChunksRef.current = [];
          stream.getTracks().forEach((track) => track.stop());
          if (streamRef.current === stream) streamRef.current = null;
          return;
        }
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        // Judge the recording before it can replace what is already attached:
        // no object URL for it, and the existing preview stays valid.
        const sizeVerdict = checkRecordedStoryAudioSize(blob);
        if (sizeVerdict.ok === false) {
          recordedChunksRef.current = [];
          setRecorderError(sizeVerdict.message);
          stopStream();
          setIsRecording(false);
          return;
        }
        const file = new File([blob], recordedStoryAudioFileName(blob.type), { type: blob.type });
        const previewUrl = URL.createObjectURL(blob);
        if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
        onVoiceChange(file, previewUrl, 'recorded');
        setRecorderError(null);
        stopStream();
        setIsRecording(false);
      });
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      if (!mountedRef.current || operationId !== mediaOperationRef.current) return;
      setRecorderError('We could not access the microphone. Please allow access, or upload a file instead.');
      stopStream();
      setIsRecording(false);
      console.error('[voice-recorder] getUserMedia failed', err);
    }
  }, [onVoiceChange, voicePreviewUrl, stopStream]);

  const handleStop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      stopStream();
      setIsRecording(false);
    }
  }, [stopStream]);

  const handleUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      // Refuse an oversize file here, where the customer is still looking at
      // the picker — not at the payment button. Nothing about the current
      // attachment, consent, preview URL, or recorder authority changes.
      const sizeVerdict = checkStoryMediaFileSize(file);
      if (sizeVerdict.ok === false) {
        setRecorderError(sizeVerdict.message);
        // Still clear the input so picking a smaller file re-fires onChange.
        event.target.value = '';
        return;
      }
      mediaOperationRef.current += 1;
      const previewUrl = URL.createObjectURL(file);
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
      onVoiceChange(file, previewUrl, 'uploaded');
      setRecorderError(null);
      // Reset the input so re-selecting the same file fires onChange again.
      event.target.value = '';
    },
    [onVoiceChange, voicePreviewUrl],
  );

  const handleRemove = useCallback(() => {
    mediaOperationRef.current += 1;
    if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
    onVoiceChange(null, null, null);
    onConsentChange(false);
  }, [onConsentChange, onVoiceChange, voicePreviewUrl]);

  const attachedFileIsAudio = Boolean(
    voiceFile &&
      (voiceFile.type.startsWith('audio/') ||
        /\.(webm|m4a|mp3|wav|ogg|oga|aac|caf|aif|aiff|flac|mp4)$/i.test(voiceFile.name)),
  );

  return (
    <section
      className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4"
      aria-label="Optional voice note or written file"
      data-testid="voice-recorder-section"
    >
      {!voiceFile && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border-2 border-[#d8c6a2] bg-[#fffaf1] p-4">
            <h2 className="font-serif text-xl text-forest">🎙️ Voice note</h2>
            <p className="mt-1 text-sm text-gray-600">Up to 3 minutes. 30 seconds is plenty.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {!isRecording ? (
                <button
                  type="button"
                  onClick={handleRecord}
                  className="rounded-full border-2 border-deep-gold bg-deep-gold px-4 py-2 text-sm font-semibold text-white transition hover:bg-deep-gold/90"
                >
                  Record audio
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStop}
                  className="rounded-full border-2 border-red-500 bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600"
                >
                  ◼ Stop
                </button>
              )}
              {!isRecording && (
                <label
                  htmlFor="custom-story-audio-upload"
                  className="cursor-pointer rounded-full border-2 border-gray-300 px-4 py-2 text-sm font-semibold text-forest transition hover:border-deep-gold has-[:focus-visible]:border-[#241914] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#241914] has-[:focus-visible]:ring-offset-2"
                  data-testid="custom-story-audio-upload-control"
                >
                  Upload audio file
                  <input
                    id="custom-story-audio-upload"
                    aria-label="Upload audio file"
                    type="file"
                    accept={VOICE_AUDIO_UPLOAD_ACCEPT_ATTR}
                    className="sr-only"
                    onChange={handleUpload}
                  />
                </label>
              )}
            </div>
          </div>

          {!isRecording && (
            <div className="rounded-2xl border-2 border-[#d8c6a2] bg-[#fffaf1] p-4">
              <h2 className="font-serif text-xl text-forest">📄 Written file</h2>
              <p className="mt-1 text-sm text-gray-600">TXT, PDF, or Word, up to 10 MB.</p>
              <p className="mt-2 text-xs leading-5 text-gray-600">
                Our story team reads your file and uses it as inspiration. Nothing is generated from it automatically.
              </p>
              <label
                htmlFor="custom-story-document-upload"
                className="mt-4 inline-flex cursor-pointer rounded-full border-2 border-gray-300 px-4 py-2 text-sm font-semibold text-forest transition hover:border-deep-gold has-[:focus-visible]:border-[#241914] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#241914] has-[:focus-visible]:ring-offset-2"
                data-testid="custom-story-document-upload-control"
              >
                Upload document
                <input
                  id="custom-story-document-upload"
                  aria-label="Upload document"
                  type="file"
                  accept={VOICE_DOCUMENT_UPLOAD_ACCEPT_ATTR}
                  className="sr-only"
                  onChange={handleUpload}
                />
              </label>
            </div>
          )}
        </div>
      )}

      {voiceFile && !isRecording && (
        <button
          type="button"
          onClick={handleRemove}
          className="rounded-full border-2 border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-red-300 hover:text-red-600"
        >
          Remove file
        </button>
      )}

      {recorderError && (
        <p
          role="alert"
          data-testid="voice-recorder-error"
          className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2"
        >
          {recorderError}
        </p>
      )}

      {voicePreviewUrl && (
        <div className="space-y-2">
          {attachedFileIsAudio ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-forest">Attached: voice note</p>
              <audio controls src={voicePreviewUrl} className="w-full" data-testid="voice-preview" />
            </div>
          ) : voiceFile ? (
            <div className="rounded-xl border border-deep-gold/20 bg-deep-gold/5 px-4 py-3 text-sm text-forest">
              Attached: <strong>{voiceFile.name}</strong> · {(voiceFile.size / (1024 * 1024)).toFixed(1)} MB
            </div>
          ) : null}
          {voiceFile && (
            <a
              href={voicePreviewUrl}
              download={voiceFile.name || 'hero-story-voice-note.webm'}
              className="inline-flex text-sm font-semibold text-forest underline decoration-deep-gold/60 underline-offset-4 hover:text-deep-gold"
            >
              Download file
            </a>
          )}
          <p className="text-xs text-gray-500">
            {voiceSource === 'recorded' ? 'Recorded just now.' : 'Uploaded from your device.'}{' '}
            Save it before leaving this page if you want to reuse it. Not happy with it? Tap{' '}
            <strong>Remove file</strong> and try again.
          </p>
        </div>
      )}

      {voiceFile && (
        <label className="flex items-start gap-2 text-sm text-forest bg-cream/40 border border-gray-200 rounded-xl px-3 py-3">
          <input
            type="checkbox"
            checked={voiceConsent}
            onChange={(e) => onConsentChange(e.target.checked)}
            className="mt-0.5"
            data-testid="voice-consent"
          />
          <span>
            {attachedFileIsAudio ? (
              <>
                I&apos;m the parent/guardian or an authorized adult for everyone in this recording. Hero Story Books may use it only to write this book. It won&apos;t be used for voice cloning or AI training, and won&apos;t be shared.
              </>
            ) : (
              <>
                I have the right to share this document. Hero Story Books may use it only to write this book. It won&apos;t be used for AI training and won&apos;t be shared.
              </>
            )}
          </span>
        </label>
      )}
    </section>
  );
}

export default VoiceRecorderSection;
