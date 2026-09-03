export type StoryAttachmentKind = 'audio' | 'document';

export type StoryAttachmentClassification =
  | { kind: StoryAttachmentKind; mimeType: string; extension: string }
  | { kind: 'invalid' };

interface FileIdentity {
  type?: string;
  name?: string;
}

const AUDIO_BY_MIME: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-caf': 'caf',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

const AUDIO_EXTENSIONS = new Set([
  'webm', 'ogg', 'oga', 'mp4', 'm4a', 'aac', 'mp3', 'wav', 'flac', 'caf', 'aif', 'aiff',
]);

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp4: 'audio/mp4',
  m4a: 'audio/x-m4a',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  caf: 'audio/x-caf',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

const DOCUMENT_BY_MIME: Readonly<Record<string, string>> = {
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const DOCUMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

  const documentExtension = DOCUMENT_BY_MIME[mime];
  if (documentExtension) {
    if (extension && !extensionMatchesMime('document', documentExtension, extension)) return { kind: 'invalid' };
    return { kind: 'document', mimeType: mime, extension: documentExtension };
  }

  const audioExtension = AUDIO_BY_MIME[mime];
  if (audioExtension) {
    if (extension && !extensionMatchesMime('audio', audioExtension, extension)) return { kind: 'invalid' };
    return { kind: 'audio', mimeType: mime, extension: audioExtension };
  }

  return { kind: 'invalid' };
}

export function documentMimeForFile(file: FileIdentity): string | null {
  const classification = classifyStoryAttachment(file);
  return classification.kind === 'document' ? classification.mimeType : null;
}
