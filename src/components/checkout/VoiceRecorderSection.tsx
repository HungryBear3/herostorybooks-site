'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isVoiceUploadTooLarge, voiceTooLargeMessage } from '@/lib/upload-limits';

const RECORDED_FILE_NAME = 'child-voice-note.webm';
const VOICE_AUDIO_UPLOAD_ACCEPT_ATTR = [
  'audio/*',
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
const VOICE_PROMPTS = [
  'What adventure should you go on?',
  'What do you love most right now?',
  'What should your hero be brave about?',
];

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
 * Optional beta UI for attaching a short child-voice note. Mounts only when
 * `NEXT_PUBLIC_HSB_VOICE_BETA === 'true'`. The microphone is requested only
 * after the user taps Record; tracks are released as soon as recording stops.
 *
 * The recording is positioned as inspiration/source material for personalizing
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
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const documentFileInputRef = useRef<HTMLInputElement | null>(null);

  // Always release the mic + revoke the preview URL on unmount.
  useEffect(() => {
    return () => {
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
    setRecorderError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecorderError('Voice recording is not supported on this browser. You can upload a file instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickSupportedMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) recordedChunksRef.current.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        // Guard the rare long recording the same way as uploads.
        if (isVoiceUploadTooLarge(blob.size)) {
          setRecorderError(voiceTooLargeMessage(blob.size));
          stopStream();
          setIsRecording(false);
          return;
        }
        const file = new File([blob], RECORDED_FILE_NAME, { type: blob.type });
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
      // Block oversized audio/doc uploads before attaching, so a too-large
      // inspiration file never rides along into the single /api/order request.
      if (isVoiceUploadTooLarge(file.size)) {
        setRecorderError(voiceTooLargeMessage(file.size));
        event.target.value = '';
        return;
      }
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
      aria-label="Optional child voice note"
      data-testid="voice-recorder-section"
    >
      <div>
        <div className="flex items-center gap-2">
          <h2 className="font-serif text-xl text-forest">🎙️ Let your child help tell the story</h2>
          <span className="text-xs font-semibold uppercase tracking-widest text-deep-gold bg-deep-gold/10 px-2 py-0.5 rounded-full">
            Beta · Optional
          </span>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Optional: record a 30-second story idea — your child describing the adventure
          they&apos;d love — or upload a note, PDF, Word doc, or audio file. It&apos;s a sweet way to make a
          Father&apos;s Day book feel like it came from them. We use it only to help
          personalize the writing.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          We do <strong>not</strong> clone your child&apos;s voice, and the recording is{' '}
          <strong>never published</strong> or shared — it just inspires the words on the page.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Used only to help our writer match the story&apos;s voice — we never share it.
          Want it removed? Email support@herostorybooks.com and we&apos;ll delete it.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Notes and uploads are in beta. To avoid losing something special if checkout hits an
          unexpected error, save it first on your device, then upload the saved file here.
        </p>
      </div>

      <div className="rounded-xl border border-deep-gold/20 bg-deep-gold/5 px-4 py-3 text-sm text-forest">
        <p className="font-semibold mb-1">Try one of these prompts:</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {VOICE_PROMPTS.map((prompt) => (
            <li key={prompt}>{prompt}</li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        {!isRecording && !voiceFile && (
          <button
            type="button"
            onClick={handleRecord}
            className="px-4 py-2 rounded-full border-2 border-deep-gold bg-deep-gold text-white font-semibold text-sm hover:bg-deep-gold/90 transition"
          >
            Record audio
          </button>
        )}
        {isRecording && (
          <button
            type="button"
            onClick={handleStop}
            className="px-4 py-2 rounded-full border-2 border-red-500 bg-red-500 text-white font-semibold text-sm hover:bg-red-600 transition"
          >
            ◼ Stop
          </button>
        )}
        {!isRecording && (
          <>
            <button
              type="button"
              onClick={() => audioFileInputRef.current?.click()}
              className="px-4 py-2 rounded-full border-2 border-gray-200 text-forest font-semibold text-sm hover:border-deep-gold transition"
            >
              Upload audio file
            </button>
            <input
              ref={audioFileInputRef}
              type="file"
              accept={VOICE_AUDIO_UPLOAD_ACCEPT_ATTR}
              className="hidden"
              onChange={handleUpload}
            />
            <button
              type="button"
              onClick={() => documentFileInputRef.current?.click()}
              className="px-4 py-2 rounded-full border-2 border-gray-200 text-forest font-semibold text-sm hover:border-deep-gold transition"
            >
              Upload text/document
            </button>
            <input
              ref={documentFileInputRef}
              type="file"
              accept={VOICE_DOCUMENT_UPLOAD_ACCEPT_ATTR}
              className="hidden"
              onChange={handleUpload}
            />
          </>
        )}
        {voiceFile && !isRecording && (
          <button
            type="button"
            onClick={handleRemove}
            className="px-4 py-2 rounded-full border-2 border-gray-200 text-gray-700 font-semibold text-sm hover:border-red-300 hover:text-red-600 transition"
          >
            Remove file
          </button>
        )}
      </div>

      {!voiceFile && !isRecording && (
        <p className="text-xs text-gray-500">
          Use <strong>Record audio</strong> for a new voice note, <strong>Upload audio file</strong>{' '}
          for a saved recording, or <strong>Upload text/document</strong> for text, PDF, or Word
          notes.
        </p>
      )}

      {recorderError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {recorderError}
        </p>
      )}

      {voicePreviewUrl && (
        <div className="space-y-2">
          {attachedFileIsAudio ? (
            <audio controls src={voicePreviewUrl} className="w-full" data-testid="voice-preview" />
          ) : voiceFile ? (
            <div className="rounded-xl border border-deep-gold/20 bg-deep-gold/5 px-4 py-3 text-sm text-forest">
              Attached inspiration file: <strong>{voiceFile.name}</strong>
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
            I&apos;m the parent/guardian and consent to HeroStoryBooks using this recording or document
            only to personalize this order. I understand it will <strong>not</strong> be used
            for voice cloning and will <strong>not</strong> be published or shared.
          </span>
        </label>
      )}
    </section>
  );
}

export default VoiceRecorderSection;
