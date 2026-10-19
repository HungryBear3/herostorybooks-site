import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function runScenario(): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--import', './tests/helpers/group-book-route-register.mjs', './tests/helpers/group-book-readiness-scenario.ts'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', status: failed.status ?? 1 };
  }
}

test('group-book readiness: release switch, policy, authority, image caps, ambiguity, OMIT, export HOLD (synthetic storage only)', () => {
  const { stdout, stderr, status } = runScenario();
  const line = stdout.split('\n').reverse().find((row) => row.startsWith('RESULT '));
  assert.ok(line, `scenario printed no RESULT line (exit ${status})\n${stderr.slice(-2000)}`);
  const { results } = JSON.parse(line.slice('RESULT '.length)) as { results: { name: string; ok: boolean; error?: string }[] };
  assert.equal(results.length, 23, 'every scenario step must report');
  assert.deepEqual(results.filter((result) => !result.ok), []);
  assert.equal(status, 0);
});
