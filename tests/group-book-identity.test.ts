import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('stored group-book identity regressions: real store and intake, synthetic transport', () => {
  // A nested test runner needs its own reporter, not the parent's IPC context.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './tests/helpers/group-book-route-register.mjs',
    '--test', '--test-reporter=tap', './tests/helpers/group-book-identity-regression.mjs',
  ], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests 15\b/);
  assert.match(result.stdout, /# pass 15\b/);
  assert.match(result.stdout, /# fail 0\b/);
});
