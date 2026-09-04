import {
  AUDIO_MIME_BY_EXTENSION,
  AUDIO_MIME_TYPES,
  DOCUMENT_MIME_BY_EXTENSION,
  MEDIA_MIME_ALIASES,
} from './checkout-media-mime.ts';

export type StoryAttachmentKind = 'audio' | 'document';

export type StoryAttachmentClassification =
  | { kind: StoryAttachmentKind; mimeType: string; extension: string }
  | { kind: 'invalid' };

interface FileIdentity {
  type?: string;
  name?: string;
}

/**
 * Canonical audio MIME → the extension a coherent filename carries. Browser
 * aliases (`audio/x-m4a`, `audio/mp3`, `audio/x-aiff`) are resolved through
 * the shared `MEDIA_MIME_ALIASES` BEFORE this table is consulted, so the
 * string this module emits is always the one the server intake policy accepts.
 */
const AUDIO_BY_MIME: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-caf': 'caf',
  'audio/aiff': 'aiff',
};

const AUDIO_EXTENSIONS = new Set([
  'webm', 'ogg', 'oga', 'mp4', 'm4a', 'aac', 'mp3', 'wav', 'flac', 'caf', 'aif', 'aiff',
]);

export function recordedStoryAudioFileName(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  const canonical = MEDIA_MIME_ALIASES[normalized] ?? normalized;
  const extension = AUDIO_BY_MIME[canonical] ?? 'webm';
  return `child-voice-note.${extension}`;
}

const DOCUMENT_BY_MIME: Readonly<Record<string, string>> = {
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

function normalizedMime(file: FileIdentity): string {
  return (file.type ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function normalizedExtension(file: FileIdentity): string | null {
  const name = file.name?.trim() ?? '';
  if (!name) return null;
  return /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? null;
}

function extensionMatchesMime(kind: StoryAttachmentKind, mimeExtension: string, extension: string): boolean {
  if (kind === 'document') return mimeExtension === extension;
  if (mimeExtension === 'm4a') return extension === 'm4a' || extension === 'mp4';
  if (mimeExtension === 'ogg') return extension === 'ogg' || extension === 'oga';
  if (mimeExtension === 'aiff') return extension === 'aif' || extension === 'aiff';
  return mimeExtension === extension;
}

export function classifyStoryAttachment(file: FileIdentity): StoryAttachmentClassification {
  const mime = normalizedMime(file);
  const extension = normalizedExtension(file);
  const mimeIsUnspecified = mime === '' || mime === 'application/octet-stream';

  if (mimeIsUnspecified) {
    if (!extension) return { kind: 'invalid' };
    const documentMime = DOCUMENT_MIME_BY_EXTENSION[extension];
    if (documentMime) return { kind: 'document', mimeType: documentMime, extension };
    const audioMime = AUDIO_MIME_BY_EXTENSION[extension];
    if (audioMime && AUDIO_EXTENSIONS.has(extension)) {
      return { kind: 'audio', mimeType: audioMime, extension };
    }
    return { kind: 'invalid' };
  }

  // Resolve a browser alias to the canonical string FIRST: what this function
  // returns is what gets reserved, uploaded, and stored, so it must be the
  // exact value the server policy accepts.
  const canonical = MEDIA_MIME_ALIASES[mime] ?? mime;

  const documentExtension = DOCUMENT_BY_MIME[canonical];
  if (documentExtension) {
    if (extension && !extensionMatchesMime('document', documentExtension, extension)) return { kind: 'invalid' };
    return { kind: 'document', mimeType: canonical, extension: documentExtension };
  }

  const audioExtension = AUDIO_BY_MIME[canonical];
  if (audioExtension && (AUDIO_MIME_TYPES as readonly string[]).includes(canonical)) {
    if (extension && !extensionMatchesMime('audio', audioExtension, extension)) return { kind: 'invalid' };
    return { kind: 'audio', mimeType: canonical, extension: audioExtension };
  }

  return { kind: 'invalid' };
}

export function documentMimeForFile(file: FileIdentity): string | null {
  const classification = classifyStoryAttachment(file);
  return classification.kind === 'document' ? classification.mimeType : null;
}
