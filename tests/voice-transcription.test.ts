/**
 * Tests for the optional, consented voice-note transcription path
 * (HSB_VOICE_TRANSCRIPTION_ENABLED + OPENAI_API_KEY).
 *
 * Locked-in behaviors:
 *  - transcribeVoiceNote() is feature-flagged OFF by default → no OpenAI call,
 *    returns null.
 *  - No OpenAI call when there's no flag, no key, or no voice file.
 *  - On success it returns transcript + bounded inspiration + model + timestamp,
 *    with error=null.
 *  - On transcriber failure it returns a record with error set (never throws),
 *    so order creation/payment is not blocked.
 *  - buildVoiceInspiration() is bounded and flags Father's Day/dad cues.
 *  - Story prompt builders include the bounded inspiration when present, and
 *    are byte-identical to the no-voice case when inspiration is absent/failed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  transcribeVoiceNote,
  buildVoiceInspiration,
  truncateTranscript,
  getVoiceTranscriptionModel,
  isVoiceTranscriptionEnabled,
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  MAX_TRANSCRIPT_CHARS,
  MAX_INSPIRATION_CHARS,
  type AudioTranscriber,
} from '../src/lib/voice-transcription.ts';
import { buildUserPrompt, buildPageProseUserPrompt } from '../src/lib/story-generator.ts';
import { planStorybook } from '../src/lib/story-planner.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { VoiceTranscriptMeta } from '../src/lib/fulfillment-types.ts';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function makeAudioFile(size = 32): File {
  return {
    name: 'voice.webm',
    type: 'audio/webm',
    size,
    arrayBuffer: async () => new Uint8Array(size).buffer,
  } as unknown as File;
}

/** A transcriber spy that records call count + the model it was asked to use. */
function spyTranscriber(text: string): { fn: AudioTranscriber; calls: () => number; lastModel: () => string | null } {
  let calls = 0;
  let lastModel: string | null = null;
  const fn: AudioTranscriber = async (_file, model) => {
    calls += 1;
    lastModel = model;
    return text;
  };
  return { fn, calls: () => calls, lastModel: () => lastModel };
}

function baseOrder(extra: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord_voice_prompt',
    childName: 'Mia',
    childAge: '6',
    childPronouns: 'she/her',
    theme: 'space-voyager',
    lesson: '',
    occasion: '',
    giftMessage: '',
    characterNotes: '',
    appearanceOptions: '',
    bookFormat: 'digital',
    formatLabel: 'Digital PDF',
    priceCents: 1499,
    email: 'a@b.com',
    status: 'order_received',
    paymentStatus: 'pending',
    deliveryExpectation: 'soon',
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    ...extra,
  } as OrderRecord;
}

// ── Feature flag gating ───────────────────────────────────────────────────────

test('transcribeVoiceNote is OFF by default → null, no OpenAI call', async () => {
  await withEnv({ HSB_VOICE_TRANSCRIPTION_ENABLED: undefined, OPENAI_API_KEY: 'sk-test' }, async () => {
    assert.equal(isVoiceTranscriptionEnabled(), false);
    const spy = spyTranscriber('should not run');
    const result = await transcribeVoiceNote(makeAudioFile(), { transcribe: spy.fn });
    assert.equal(result, null);
    assert.equal(spy.calls(), 0, 'transcriber must not be called when flag is off');
  });
});

test('voice transcription feature flag tolerates Vercel newline drift', async () => {
  await withEnv({ HSB_VOICE_TRANSCRIPTION_ENABLED: 'true\n' }, async () => {
    assert.equal(isVoiceTranscriptionEnabled(), true);
  });
});

test('voice transcription feature flag tolerates escaped Vercel newline drift', async () => {
  await withEnv({ HSB_VOICE_TRANSCRIPTION_ENABLED: 'true\\n' }, async () => {
    assert.equal(isVoiceTranscriptionEnabled(), true);
  });
});

test('transcribeVoiceNote: no OpenAI call when key missing (even with flag on + file)', async () => {
  await withEnv({ HSB_VOICE_TRANSCRIPTION_ENABLED: 'true', OPENAI_API_KEY: undefined }, async () => {
    const spy = spyTranscriber('should not run');
    const result = await transcribeVoiceNote(makeAudioFile(), { transcribe: spy.fn });
    assert.equal(result, null);
    assert.equal(spy.calls(), 0);
  });
});

test('transcribeVoiceNote: no OpenAI call when no voice file (flag on + key)', async () => {
  await withEnv({ HSB_VOICE_TRANSCRIPTION_ENABLED: 'true', OPENAI_API_KEY: 'sk-test' }, async () => {
    const spy = spyTranscriber('should not run');
    const result = await transcribeVoiceNote(null, { transcribe: spy.fn });
    assert.equal(result, null);
    assert.equal(spy.calls(), 0);
  });
});

// ── Success path ──────────────────────────────────────────────────────────────

test('transcribeVoiceNote: success persists transcript + inspiration + model + timestamp', async () => {
  await withEnv({ HSB_VOICE_TRANSCRIPTION_ENABLED: 'true', OPENAI_API_KEY: 'sk-test' }, async () => {
    const spy = spyTranscriber('My daddy and I love building rocket ships.');
    const result = await transcribeVoiceNote(makeAudioFile(), {
      transcribe: spy.fn,
      now: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    assert.ok(result);
    assert.equal(spy.calls(), 1);
    assert.equal(spy.lastModel(), DEFAULT_VOICE_TRANSCRIPTION_MODEL);
    assert.equal(result!.transcript, 'My daddy and I love building rocket ships.');
    assert.match(result!.inspiration ?? '', /Father.Father.s Day cue present/);
    assert.match(result!.inspiration ?? '', /rocket ships/);
    assert.equal(result!.model, DEFAULT_VOICE_TRANSCRIPTION_MODEL);
    assert.equal(result!.transcribedAt, '2026-05-25T12:00:00.000Z');
    assert.equal(result!.error, null);
  });
});

test('transcribeVoiceNote: honors HSB_VOICE_TRANSCRIPTION_MODEL override', async () => {
  await withEnv(
    {
      HSB_VOICE_TRANSCRIPTION_ENABLED: 'true',
      OPENAI_API_KEY: 'sk-test',
      HSB_VOICE_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
    },
    async () => {
      assert.equal(getVoiceTranscriptionModel(), 'gpt-4o-transcribe');
      const spy = spyTranscriber('hello');
      const result = await transcribeVoiceNote(makeAudioFile(), { transcribe: spy.fn });
      assert.equal(spy.lastModel(), 'gpt-4o-transcribe');
      assert.equal(result!.model, 'gpt-4o-transcribe');
    },
  );
});

// ── Failure path ────────────────────────────────────────────────────────────

test('transcribeVoiceNote: transcriber throwing → error marker, never throws', async () => {
  await withEnv({ HSB_VOICE_TRANSCRIPTION_ENABLED: 'true', OPENAI_API_KEY: 'sk-test' }, async () => {
    const failing: AudioTranscriber = async () => {
      throw new Error('openai 500 upstream');
    };
    const result = await transcribeVoiceNote(makeAudioFile(), {
      transcribe: failing,
      now: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    assert.ok(result, 'failure still returns a metadata record (so the route can persist a marker)');
    assert.equal(result!.transcript, null);
    assert.equal(result!.inspiration, null);
    assert.match(result!.error ?? '', /openai 500 upstream/);
    assert.equal(result!.transcribedAt, '2026-05-25T12:00:00.000Z');
  });
});

// ── buildVoiceInspiration bounding + cue detection ───────────────────────────

test('buildVoiceInspiration: empty / whitespace → empty string', () => {
  assert.equal(buildVoiceInspiration(''), '');
  assert.equal(buildVoiceInspiration('   \n\t '), '');
});

test('buildVoiceInspiration: flags dad/Father cue when present, omits otherwise', () => {
  assert.match(buildVoiceInspiration('I want to go fishing with my dad.'), /cue present/i);
  assert.doesNotMatch(buildVoiceInspiration('I love painting rainbows.'), /cue present/i);
});

test('buildVoiceInspiration: bounded to ~MAX_INSPIRATION_CHARS + prefix/wrapper', () => {
  const long = 'space '.repeat(400); // ~2400 chars
  const out = buildVoiceInspiration(long);
  // The snippet itself is capped at MAX_INSPIRATION_CHARS; wrapper adds a small
  // fixed prefix/suffix. Assert it stays comfortably bounded.
  assert.ok(out.length <= MAX_INSPIRATION_CHARS + 80, `inspiration too long: ${out.length}`);
  assert.match(out, /…"$/);
});

test('truncateTranscript: caps overly long transcripts', () => {
  const long = 'a'.repeat(MAX_TRANSCRIPT_CHARS + 500);
  const out = truncateTranscript(long);
  assert.ok(out.length <= MAX_TRANSCRIPT_CHARS + 1, `transcript too long: ${out.length}`);
});

// ── Story prompt integration ─────────────────────────────────────────────────

const VOICE_META: VoiceTranscriptMeta = {
  transcript: 'I want to find a glowing crystal cave with my dad.',
  inspiration: 'Father/Father’s Day cue present. In the child’s own words: "I want to find a glowing crystal cave with my dad."',
  model: 'gpt-4o-mini-transcribe',
  transcribedAt: '2026-05-25T12:00:00.000Z',
  error: null,
};

const FAILED_META: VoiceTranscriptMeta = {
  transcript: null,
  inspiration: null,
  model: 'gpt-4o-mini-transcribe',
  transcribedAt: '2026-05-25T12:00:00.000Z',
  error: 'openai timeout',
};

test('buildUserPrompt includes the bounded voice inspiration when present', () => {
  const prompt = buildUserPrompt(baseOrder({ voiceTranscript: VOICE_META }));
  assert.match(prompt, /VOICE NOTE INSPIRATION/);
  assert.match(prompt, /glowing crystal cave/);
});

test('buildUserPrompt is byte-identical with no voice vs failed transcription', () => {
  const noVoice = buildUserPrompt(baseOrder());
  const failed = buildUserPrompt(baseOrder({ voiceTranscript: FAILED_META }));
  assert.equal(failed, noVoice, 'failed transcription must not alter the prompt');
  assert.doesNotMatch(noVoice, /VOICE NOTE INSPIRATION/);
});

test('buildPageProseUserPrompt includes the bounded voice inspiration when present', () => {
  const order = baseOrder({ voiceTranscript: VOICE_META });
  const plan = planStorybook(order, 24);
  const prompt = buildPageProseUserPrompt(order, plan.pages[0]!, 24, null);
  assert.match(prompt, /VOICE NOTE INSPIRATION/);
  assert.match(prompt, /glowing crystal cave/);
});

test('buildPageProseUserPrompt is byte-identical with no voice vs failed transcription', () => {
  const orderNo = baseOrder();
  const orderFailed = baseOrder({ voiceTranscript: FAILED_META });
  const plan = planStorybook(orderNo, 24);
  const a = buildPageProseUserPrompt(orderNo, plan.pages[0]!, 24, null);
  const b = buildPageProseUserPrompt(orderFailed, plan.pages[0]!, 24, null);
  assert.equal(b, a);
  assert.doesNotMatch(a, /VOICE NOTE INSPIRATION/);
});
