/**
 * Optional, consented child-voice-note transcription (NEXT_PUBLIC_HSB_VOICE_BETA
 * front-end + HSB_VOICE_TRANSCRIPTION_ENABLED server gate).
 *
 * Scope + boundaries (do not widen without product sign-off):
 *   - The audio is used ONLY for speech-to-text transcription and to derive a
 *     short, bounded "voice inspiration" summary that can safely steer story
 *     PROSE. It is NEVER used for voice cloning, generated speech, imitation,
 *     or published audio.
 *   - Everything here is a hard no-op unless ALL of the following are true:
 *       1. HSB_VOICE_TRANSCRIPTION_ENABLED === 'true'
 *       2. OPENAI_API_KEY is present
 *       3. a voice File/Blob actually exists
 *     With the flag off (the default), this module makes no OpenAI call and
 *     returns null, so existing checkout + fulfillment behave exactly as before.
 *   - Transcription failure NEVER throws to the caller. It returns a result
 *     with `error` set so checkout can persist a failure marker and continue;
 *     payment must not be blocked by a transcription problem.
 *
 * The OpenAI client is lazy-imported inside the default transcriber so this
 * module can be imported (and unit-tested) without the SDK being constructed,
 * and so tests can inject a fake transcriber.
 */

import type { VoiceTranscriptMeta } from './fulfillment-types.ts';

/** OpenAI's documented speech-to-text default for this feature. */
export const DEFAULT_VOICE_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

/** Upper bound on the stored raw transcript (defense against giant blobs). */
export const MAX_TRANSCRIPT_CHARS = 2_000;

/** Upper bound on the bounded inspiration summary fed into story generation. */
export const MAX_INSPIRATION_CHARS = 600;

/** Control-character class: strip ASCII + C1 control chars before storage. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Cues that suggest a Father's Day / dad framing. Surfaced as a small tag at
 * the front of the inspiration so the story prompt can lean into the occasion
 * when the child actually mentioned it — without us inventing a dad angle that
 * wasn't there.
 */
const FATHERS_DAY_CUE_RE =
  /\b(dad|dada|daddy|papa|pappa|pop|pops|poppa|father|fathers?\s*day|grandpa|grandad|grampa|grandfather)\b/i;

export function isVoiceTranscriptionEnabled(): boolean {
  return process.env.HSB_VOICE_TRANSCRIPTION_ENABLED === 'true';
}

export function getVoiceTranscriptionModel(): string {
  const model = (process.env.HSB_VOICE_TRANSCRIPTION_MODEL ?? '').trim();
  return model || DEFAULT_VOICE_TRANSCRIPTION_MODEL;
}

/** Strip control chars + collapse whitespace; safe for prompts + persistence. */
function sanitizeText(value: string): string {
  return value
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate the raw transcript to a bounded, sanitized form for storage. */
export function truncateTranscript(raw: string): string {
  const clean = sanitizeText(raw);
  if (clean.length <= MAX_TRANSCRIPT_CHARS) return clean;
  return `${clean.slice(0, MAX_TRANSCRIPT_CHARS).trimEnd()}…`;
}

/**
 * Convert a raw transcript into a short, bounded "voice inspiration" string
 * that is safe to inject into story generation.
 *
 * Design choice: we do NOT make a second LLM call here. We sanitize + bound the
 * transcript and detect Father's Day/dad cues locally, then hand the bounded
 * text to the story-prose model with explicit instructions to extract
 * preferences, favorite phrases, emotional tone, adventure ideas, and people/
 * objects mentioned (see story-generator's voiceInspirationBlock). This keeps
 * the path cheap, deterministic, and free of extra checkout latency while still
 * letting the generated prose reflect what the child said.
 */
export function buildVoiceInspiration(rawTranscript: string): string {
  const clean = sanitizeText(rawTranscript);
  if (!clean) return '';
  const snippet =
    clean.length <= MAX_INSPIRATION_CHARS
      ? clean
      : `${clean.slice(0, MAX_INSPIRATION_CHARS).trimEnd()}…`;
  const cuePrefix = FATHERS_DAY_CUE_RE.test(clean)
    ? 'Father/Father’s Day cue present. '
    : '';
  return `${cuePrefix}In the child’s own words: "${snippet}"`;
}

/**
 * Injectable transcriber so tests can fake/observe the OpenAI call. Receives
 * the audio File and the resolved model name; returns the raw transcript text.
 */
export interface AudioTranscriber {
  (file: File, model: string): Promise<string>;
}

/**
 * Default transcriber: lazy-imports the OpenAI SDK and calls the audio
 * transcription endpoint. `response_format: 'text'` yields a plain string from
 * the gpt-4o(-mini)-transcribe models. We never request word/segment
 * timestamps — we only want the text.
 */
const defaultTranscribe: AudioTranscriber = async (file, model) => {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = await client.audio.transcriptions.create({
    file,
    model,
    response_format: 'text',
  });
  // With response_format:'text' the SDK returns a string; with the default
  // json shape it returns { text }. Handle both defensively.
  if (typeof result === 'string') return result;
  return (result as { text?: string }).text ?? '';
};

export interface TranscribeVoiceNoteDeps {
  /** Override the OpenAI call (tests inject a fake/spy here). */
  transcribe?: AudioTranscriber;
  /** Deterministic clock for tests. */
  now?: () => Date;
}

/**
 * Transcribe an attached, consented voice note and derive a bounded inspiration
 * summary. Returns:
 *   - null  → feature disabled / no key / no file (true no-op; no API call)
 *   - VoiceTranscriptMeta with error=null  → success
 *   - VoiceTranscriptMeta with error set   → transcription failed (caller
 *       persists the marker and continues; payment is NOT blocked)
 *
 * Consent is enforced upstream in /api/order — this helper only ever receives a
 * file once the parent/guardian consent check has passed.
 */
export async function transcribeVoiceNote(
  file: File | null | undefined,
  deps: TranscribeVoiceNoteDeps = {},
): Promise<VoiceTranscriptMeta | null> {
  if (!isVoiceTranscriptionEnabled()) return null;
  if (!process.env.OPENAI_API_KEY) return null;
  if (!file || typeof file.arrayBuffer !== 'function') return null;

  const model = getVoiceTranscriptionModel();
  const transcribedAt = (deps.now ?? (() => new Date()))().toISOString();
  const transcribe = deps.transcribe ?? defaultTranscribe;

  try {
    const raw = await transcribe(file, model);
    const transcript = truncateTranscript(raw ?? '');
    const inspiration = buildVoiceInspiration(raw ?? '');
    return {
      transcript: transcript || null,
      inspiration: inspiration || null,
      model,
      transcribedAt,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[voice-transcription] transcription failed:', message);
    return {
      transcript: null,
      inspiration: null,
      model,
      transcribedAt,
      error: message.slice(0, 300),
    };
  }
}
