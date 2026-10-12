import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function runScenario(): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        './tests/helpers/group-book-route-register.mjs',
        './tests/helpers/group-book-remediation-scenario.ts',
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; status?: number };
    return { stdout: failed.stdout ?? '', status: failed.status ?? 1 };
  }
}

test('real group-book routes and store pass the remediation regression scenario (synthetic, fake storage)', () => {
  const { stdout, status } = runScenario();
  const line = stdout.split('\n').reverse().find((row) => row.startsWith('RESULT '));
  assert.ok(line, `scenario printed no RESULT line (exit ${status})`);
  const { results } = JSON.parse(line.slice('RESULT '.length)) as {
    results: { name: string; ok: boolean; error?: string }[];
  };
  assert.ok(results.length >= 25, 'every scenario step must report');
  const failures = results.filter((result) => !result.ok);
  assert.deepEqual(failures, []);
  assert.equal(status, 0);
});

test('withdrawal is posted inside the narrow /group-book cookie path', () => {
  const session = readFileSync(path.join(ROOT, 'src/lib/group-book/session.ts'), 'utf8');
  const button = readFileSync(path.join(ROOT, 'src/app/group-book/family/withdraw-button.tsx'), 'utf8');
  const route = readFileSync(path.join(ROOT, 'src/app/group-book/family/withdraw/route.ts'), 'utf8');
  assert.match(session, /path:\s*'\/group-book'/);
  assert.match(button, /fetch\('\/group-book\/family\/withdraw'/);
  assert.match(route, /export \{ POST \} from '@\/app\/api\/group-book\/withdrawal\/route'/);
});

test('intake persists only server-normalized image bytes', () => {
  const intake = readFileSync(path.join(ROOT, 'src/app/api/group-book/intake/route.ts'), 'utf8');
  assert.match(intake, /normalizeGroupBookImage/);
  assert.doesNotMatch(intake, /file\.arrayBuffer\(\)/);
  assert.doesNotMatch(intake, /deleteGroupBookPhotos\(uploaded\);\s*if \(await findGroupBookSubmission/);
});
