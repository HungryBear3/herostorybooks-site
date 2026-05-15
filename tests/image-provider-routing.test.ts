/**
 * PR1 routing-gate contract.
 *
 * The orchestrator MUST:
 *   - Try Seedream first when a reference photo is supplied; only fall
 *     through to FAL edit if Seedream returns a structured failure.
 *   - Never call any provider when no reference photo is supplied (the
 *     photo-edit chain is empty in that branch by design).
 *   - Filter OpenAI-named providers from a caller-supplied chain unless
 *     `HSB_ENABLE_OPENAI_IMAGE === 'true'`. The default chains never
 *     contain OpenAI, so this matters only when a future caller passes
 *     `deps.providers` itself.
 *   - Emit a single structured log line per generation attempt. The log
 *     MUST NOT contain URLs, Bearer tokens, sk_/sk- secret-shaped values,
 *     or prompt-length strings (>200 chars). If a value is unsafe or too
 *     long, the helper redacts it — it never refuses to log and never
 *     fails generation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePageImage } from '../src/lib/image-generator.ts';
import type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderInput,
  ImageProviderName,
} from '../src/lib/image-provider-types.ts';

// ── Stub providers ────────────────────────────────────────────────────────────
//
// Behaviour-by-callback so each test can decide success/failure independently.
// Each stub records the order in which `generate()` was invoked across all
// stubs via a shared counter so we can assert strict ordering without relying
// on private Playwright/Jest mock fields.

type Behaviour = (input: ImageProviderInput) => GeneratedImageResult;
type StubProvider = ImageProvider & {
  calls: ImageProviderInput[];
  callOrder: number[];
};

let invocationCounter = 0;
function resetInvocationCounter() {
  invocationCounter = 0;
}
function makeStub(name: ImageProviderName, behaviour: Behaviour): StubProvider {
  const calls: ImageProviderInput[] = [];
  const callOrder: number[] = [];
  return {
    name,
    calls,
    callOrder,
    async generate(input) {
      calls.push(input);
      callOrder.push(++invocationCounter);
      return behaviour(input);
    },
  };
}

const SUCCESS_SEEDREAM: Behaviour = (input) => ({
  imageUrl: 'https://stub/seedream.png',
  provider: 'fal_edit',
  model: 'fal-ai/bytedance/seedream/v4/edit',
  promptUsed: input.prompt,
  conditioning: 'photo_edit',
  referencePhotoUrl: input.referenceImageUrl ?? null,
  latencyMs: 42,
  error: null,
});

const SUCCESS_FAL_EDIT: Behaviour = (input) => ({
  imageUrl: 'https://stub/nano.png',
  provider: 'fal_edit',
  model: 'fal-ai/nano-banana/edit',
  promptUsed: input.prompt,
  conditioning: 'photo_edit',
  referencePhotoUrl: input.referenceImageUrl ?? null,
  latencyMs: 51,
  error: null,
});

const FAIL_SEEDREAM: Behaviour = (input) => ({
  imageUrl: null,
  provider: 'fal_edit',
  model: 'fal-ai/bytedance/seedream/v4/edit',
  promptUsed: input.prompt,
  conditioning: 'photo_edit',
  referencePhotoUrl: input.referenceImageUrl ?? null,
  latencyMs: 12,
  error: 'simulated seedream failure',
});

// Always-throw-if-called stub for "must not be invoked" assertions.
function makeForbiddenStub(name: ImageProviderName): StubProvider {
  return makeStub(name, (input) => {
    throw new Error(
      `forbidden provider ${name} was called with prompt=${input.prompt}`,
    );
  });
}

// ── Console capture ──────────────────────────────────────────────────────────
//
// The orchestrator logs via console.info + console.warn. Tests stub both,
// restore them after, and inspect the captured lines. We never inspect
// stdout/stderr directly to avoid coupling to the runner.

interface ConsoleCapture {
  info: string[];
  warn: string[];
  restore: () => void;
}

function captureConsole(): ConsoleCapture {
  const info: string[] = [];
  const warn: string[] = [];
  const origInfo = console.info;
  const origWarn = console.warn;
  console.info = (...args: unknown[]) => {
    info.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warn.push(args.map(String).join(' '));
  };
  return {
    info,
    warn,
    restore: () => {
      console.info = origInfo;
      console.warn = origWarn;
    },
  };
}

// ── (a) photo present, Seedream succeeds: Seedream once, FAL edit zero ───────

test('routing: photo present + Seedream succeeds → Seedream once, FAL edit not called', async () => {
  resetInvocationCounter();
  const seedream = makeStub('fal_edit', SUCCESS_SEEDREAM);
  const falEdit = makeForbiddenStub('fal_edit');
  const cap = captureConsole();
  try {
    const result = await generatePageImage(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { providers: [seedream, falEdit] },
    );
    assert.equal(result.imageUrl, 'https://stub/seedream.png');
    assert.equal(result.conditioning, 'photo_edit');
    assert.equal(seedream.calls.length, 1);
    assert.equal(falEdit.calls.length, 0);
  } finally {
    cap.restore();
  }
});

// ── (b) photo present, Seedream fails: Seedream then FAL edit, in that order ─

test('routing: photo present + Seedream fails → FAL edit called second, ordered', async () => {
  resetInvocationCounter();
  const seedream = makeStub('fal_edit', FAIL_SEEDREAM);
  const falEdit = makeStub('fal_edit', SUCCESS_FAL_EDIT);
  const cap = captureConsole();
  try {
    const result = await generatePageImage(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { providers: [seedream, falEdit] },
    );
    assert.equal(result.imageUrl, 'https://stub/nano.png');
    assert.equal(result.model, 'fal-ai/nano-banana/edit');
    assert.equal(seedream.calls.length, 1);
    assert.equal(falEdit.calls.length, 1);
    // Strict ordering: Seedream invoked before FAL edit.
    assert.ok(
      seedream.callOrder[0]! < falEdit.callOrder[0]!,
      `expected seedream call (${seedream.callOrder[0]}) to precede fal_edit (${falEdit.callOrder[0]})`,
    );
  } finally {
    cap.restore();
  }
});

// ── (c) photo absent: no provider called, structured failure returned ────────

test('routing: photo absent → no provider invoked, structured photo_edit failure', async () => {
  resetInvocationCounter();
  // Pass an empty chain to match the default no-photo branch behaviour.
  const result = await generatePageImage(
    { prompt: 'p' },
    { providers: [] },
  );
  assert.equal(result.imageUrl, null);
  assert.equal(result.conditioning, 'photo_edit');
  assert.match(result.error ?? '', /no photo-conditioned providers configured/i);
});

// ── (d) OpenAI filter — gate unset → openai dropped, others kept, warn logged

test('routing: caller passes openai provider with gate unset → openai filtered, warn logged', async () => {
  resetInvocationCounter();
  const originalGate = process.env.HSB_ENABLE_OPENAI_IMAGE;
  delete process.env.HSB_ENABLE_OPENAI_IMAGE;
  const openai = makeForbiddenStub('openai');
  const seedream = makeStub('fal_edit', SUCCESS_SEEDREAM);
  const cap = captureConsole();
  try {
    const result = await generatePageImage(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      {
        providers: [openai, seedream],
        orderIdShort: 'ord_abc123',
      },
    );
    assert.equal(openai.calls.length, 0, 'openai must not be called when gate is unset');
    assert.equal(seedream.calls.length, 1, 'seedream must still run after openai is filtered out');
    assert.equal(result.imageUrl, 'https://stub/seedream.png');
    // Warn line names the order short id and the openai_filtered event.
    const warns = cap.warn.join('\n');
    assert.match(warns, /openai_filtered/);
    assert.match(warns, /orderIdShort=ord_abc123/);
    assert.match(warns, /HSB_ENABLE_OPENAI_IMAGE_not_true/);
  } finally {
    cap.restore();
    if (originalGate === undefined) delete process.env.HSB_ENABLE_OPENAI_IMAGE;
    else process.env.HSB_ENABLE_OPENAI_IMAGE = originalGate;
  }
});

// ── (e) OpenAI filter — gate set → openai allowed, takes first slot ──────────

test('routing: caller passes openai provider with gate set → openai called first', async () => {
  resetInvocationCounter();
  const originalGate = process.env.HSB_ENABLE_OPENAI_IMAGE;
  process.env.HSB_ENABLE_OPENAI_IMAGE = 'true';
  const openai = makeStub('openai', (input) => ({
    imageUrl: 'https://stub/openai.png',
    provider: 'openai',
    model: 'gpt-image-1',
    promptUsed: input.prompt,
    conditioning: 'text_only',
    latencyMs: 33,
    error: null,
  }));
  const seedream = makeForbiddenStub('fal_edit');
  const cap = captureConsole();
  try {
    const result = await generatePageImage(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { providers: [openai, seedream] },
    );
    assert.equal(openai.calls.length, 1, 'openai must be called first when gate is set');
    assert.equal(seedream.calls.length, 0, 'seedream must not be called if openai already succeeded');
    assert.equal(result.provider, 'openai');
  } finally {
    cap.restore();
    if (originalGate === undefined) delete process.env.HSB_ENABLE_OPENAI_IMAGE;
    else process.env.HSB_ENABLE_OPENAI_IMAGE = originalGate;
  }
});

// ── (f) structured log content — required fields present, unsafe values absent

test('logging: structured log line contains required fields and no unsafe values', async () => {
  resetInvocationCounter();
  const seedream = makeStub('fal_edit', SUCCESS_SEEDREAM);
  const cap = captureConsole();
  try {
    await generatePageImage(
      {
        prompt: 'p',
        referenceImageUrl: 'https://photos/kid.jpg',
      },
      {
        providers: [seedream],
        orderIdShort: 'ord_abc123',
        pageIndex: 4,
      },
    );
    // Find the one [image-gen] line emitted for the generation.
    const lines = cap.info.filter((l) => l.startsWith('[image-gen]'));
    assert.equal(lines.length, 1, `expected exactly one image-gen log line, got ${lines.length}`);
    const line = lines[0]!;

    // Required fields present.
    for (const required of [
      'orderIdShort=ord_abc123',
      'pageIndex=4',
      'provider=fal_edit',
      'model=fal-ai/bytedance/seedream/v4/edit',
      'conditioning=photo_edit',
      'latencyMs=42',
      'refPhoto=yes',
      'result=ok',
    ]) {
      assert.ok(line.includes(required), `expected log line to include "${required}", got: ${line}`);
    }

    // Unsafe values must NOT appear.
    assert.ok(!/https?:\/\//i.test(line), `log line must not contain a URL: ${line}`);
    assert.ok(!/Bearer\s+/i.test(line), `log line must not contain a bearer token: ${line}`);
    assert.ok(!/\bsk[_-]/i.test(line), `log line must not contain an sk_/sk- value: ${line}`);

    // Length proxy for "no prompt or body leaked".
    assert.ok(line.length < 400, `log line should be short, got ${line.length} chars`);
  } finally {
    cap.restore();
  }
});

// ── (g) structured log content — long/unsafe orderIdShort is redacted, not thrown

test('logging: oversize orderIdShort is redacted, generation still succeeds', async () => {
  resetInvocationCounter();
  const seedream = makeStub('fal_edit', SUCCESS_SEEDREAM);
  const cap = captureConsole();
  try {
    // 250-char orderIdShort would never happen in practice; we test that the
    // helper silently redacts it rather than throwing or leaking it.
    const huge = 'A'.repeat(250);
    const result = await generatePageImage(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { providers: [seedream], orderIdShort: huge },
    );
    assert.equal(result.imageUrl, 'https://stub/seedream.png', 'generation must still succeed');
    const line = cap.info.find((l) => l.startsWith('[image-gen]'))!;
    assert.ok(line.includes('orderIdShort=[redacted-too-long]'), `expected redaction, got: ${line}`);
    // Underlying value must not appear.
    assert.ok(!line.includes(huge), 'oversize value must not appear in log');
  } finally {
    cap.restore();
  }
});

// ── (h) structured log content — URL-shaped value is redacted

test('logging: URL-shaped orderIdShort is redacted as a defence-in-depth measure', async () => {
  resetInvocationCounter();
  const seedream = makeStub('fal_edit', SUCCESS_SEEDREAM);
  const cap = captureConsole();
  try {
    const result = await generatePageImage(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { providers: [seedream], orderIdShort: 'https://leaky.example/secret' },
    );
    assert.equal(result.imageUrl, 'https://stub/seedream.png');
    const line = cap.info.find((l) => l.startsWith('[image-gen]'))!;
    assert.ok(line.includes('orderIdShort=[redacted-url]'), `expected redaction, got: ${line}`);
    assert.ok(!line.includes('leaky.example'), 'URL substring must not appear in log');
  } finally {
    cap.restore();
  }
});
