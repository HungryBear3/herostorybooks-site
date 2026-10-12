// Client error-recovery regression for the group-book parent portal and
// withdrawal control. Executes the ACTUAL callback bodies (AST-extracted from
// the client components, transpiled, run in a VM with a synthetic fetch that
// rejects). Not React rendering, not a browser, not live transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORTAL = path.join(ROOT, 'src/app/group-book/parent-intake.tsx');
const WITHDRAW = path.join(ROOT, 'src/app/group-book/family/withdraw-button.tsx');

function callback(file: string, name: string, context: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `${name} not found in ${file}`);
  const code = ts.transpileModule(found.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${code};${name}`, context) as (...args: unknown[]) => Promise<unknown>;
}

function portalContext() {
  const state = { phase: 'form', checking: false, error: null as string | null, files: [1] as unknown[] };
  const ctx = {
    invite: 'SyntheticFamilyAlphaToken000000001', checking: false,
    parentName: 'Synthetic', parentEmail: 'synthetic@example.invalid', childFirstName: 'Synthetic',
    ageRange: '5-6', characterNotes: '', guardian: true, sharedBook: true, schoolDisclaimer: true,
    files: [new Blob(['synthetic'])],
    preparePhoto: async (f: unknown) => f,
    FormData,
    window: { location: { assign: () => { throw new Error('must not navigate'); } } },
    setPhase: (v: string) => { state.phase = v; },
    setChecking: (v: boolean) => { state.checking = v; },
    setError: (v: string | null) => { state.error = v; },
    setFiles: (v: unknown[]) => { state.files = v; },
    fetch: async () => { throw new TypeError('SYNTHETIC_NETWORK_REJECTION'); },
  };
  return { state, ctx };
}

function withdrawContext() {
  const state = { busy: false, withdrawn: false, error: null as string | null };
  const ctx = {
    withdrawn: false, busy: false,
    window: { confirm: () => true },
    setBusy: (v: boolean) => { state.busy = v; },
    setWithdrawn: (v: boolean) => { state.withdrawn = v; },
    setError: (v: string | null) => { state.error = v; },
    fetch: async () => { throw new TypeError('SYNTHETIC_NETWORK_REJECTION'); },
  };
  return { state, ctx };
}

const event = { preventDefault() {} };

for (const kind of ['rejected-json', 'null-json'] as const) {
  for (const target of ['submit', 'withdraw', 'continueFromGate'] as const) {
    test(`${target} releases transient state and reports uncertainty after ${kind}`, async () => {
      const { state, ctx } = target === 'withdraw' ? withdrawContext() : portalContext();
      let calls = 0;
      Object.assign(ctx, { fetch: async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => {
          if (kind === 'rejected-json') throw new SyntaxError('interrupted response');
          return null;
        } };
      } });
      await callback(target === 'withdraw' ? WITHDRAW : PORTAL, target, ctx)(event);
      assert.equal(calls, 1);
      if ('phase' in state && target === 'submit') assert.equal(state.phase, 'form');
      if ('busy' in state) assert.equal(state.busy, false);
      if ('checking' in state) assert.equal(state.checking, false);
      assert.ok(state.error);
      assert.doesNotMatch(state.error, /not saved|not recognized/i);
      assert.match(state.error, /could not|whether|unconfirmed/i);
    });
  }
}

test('interrupted submit returns to the form with a truthful uncertain-write message', async () => {
  const { state, ctx } = portalContext();
  await callback(PORTAL, 'submit', ctx)(event);
  assert.equal(state.phase, 'form', 'transient submitting phase must clear');
  assert.ok(state.error, 'parent must see guidance');
  assert.doesNotMatch(state.error!, /was not saved|not saved|failed/i, 'a lost response must not claim the write failed');
  assert.match(state.error!, /could not confirm|not sure|unsure|whether/i, 'message must state the outcome is unknown');
  assert.match(state.error!, /invite/i, 'message must point to the server reconciliation path (re-enter invite)');
  assert.deepEqual(state.files, [1], 'selected photos are retained for a manual retry');
});

test('interrupted withdrawal clears busy with a truthful uncertain-write message and no auto-retry', async () => {
  const { state, ctx } = withdrawContext();
  let calls = 0;
  ctx.fetch = async () => { calls += 1; throw new TypeError('SYNTHETIC_NETWORK_REJECTION'); };
  await callback(WITHDRAW, 'withdraw', ctx)();
  assert.equal(state.busy, false, 'busy must clear');
  assert.equal(state.withdrawn, false, 'an unconfirmed withdrawal is never shown as recorded');
  assert.ok(state.error);
  assert.doesNotMatch(state.error!, /was not saved|not saved|failed/i);
  assert.match(state.error!, /could not confirm|whether/i);
  assert.match(state.error!, /reload|check/i, 'guidance must send the parent to the server-rendered status');
  assert.equal(calls, 1, 'the append-only withdrawal write is never retried automatically');
});

test('interrupted invite access reports an error and releases the in-flight lock', async () => {
  const { state, ctx } = portalContext();
  state.phase = 'gate';
  await callback(PORTAL, 'continueFromGate', ctx)(event);
  assert.equal(state.phase, 'gate');
  assert.equal(state.checking, false, 'in-flight lock must release');
  assert.ok(state.error);
  assert.match(state.error!, /could not be checked|try again/i);
  assert.doesNotMatch(state.error!, /not recognized/i, 'a transport failure is not an invalid invite');
});

test('invite access holds an in-flight lock while the request is pending', async () => {
  const { state, ctx } = portalContext();
  let seenChecking = false;
  ctx.fetch = async () => { seenChecking = state.checking; throw new TypeError('SYNTHETIC_NETWORK_REJECTION'); };
  await callback(PORTAL, 'continueFromGate', ctx)(event);
  assert.equal(seenChecking, true, 'checking must be true during the request');
});

test('rendered error paragraphs are live-region alerts', () => {
  const portal = readFileSync(PORTAL, 'utf8');
  const button = readFileSync(WITHDRAW, 'utf8');
  const alerts = (s: string) => (s.match(/role="alert"/g) ?? []).length;
  assert.equal(alerts(portal), 2, 'gate and form error paragraphs announce');
  assert.equal(alerts(button), 1, 'withdrawal error paragraph announces');
  assert.match(portal, /disabled=\{!invite\.trim\(\) \|\| checking\}/, 'gate Continue is disabled while checking');
});
