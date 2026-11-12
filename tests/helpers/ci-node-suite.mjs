/**
 * Canonical Node suite launcher (`npm test`).
 *
 * Runs every tests/*.test.ts file serially with native TypeScript stripping and
 * module mocks. The joined mounted journey is the ONLY exclusion: it needs a
 * built loopback server and a browser, and runs separately via `npm run
 * test:joined`. Its file must exist, so deleting it cannot silently shrink the
 * suite. Importing this module never spawns anything.
 */
import { spawn } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const JOINED_ONLY = 'initial-shipping-journey.test.ts';
const CORE_FLAGS = ['--experimental-strip-types', '--experimental-test-module-mocks', '--test', '--test-concurrency=1'];
// Ambient database settings and a parent runner's test context never reach the suite.
const STRIPPED_ENV = /^(?:PG[A-Z0-9_]*|DATABASE_URL|POSTGRES_[A-Z0-9_]*|NODE_TEST_CONTEXT)$/;

export function selectFiles(root = ROOT) {
  const names = readdirSync(path.join(root, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name)
    .sort();
  if (!names.includes(JOINED_ONLY)) {
    throw new Error(`tests/${JOINED_ONLY} is missing; refusing to run a suite whose joined counterpart is gone`);
  }
  return names.filter((name) => name !== JOINED_ONLY).map((name) => `tests/${name}`);
}

export function buildArgs(files) {
  return [...CORE_FLAGS, ...files];
}

export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !STRIPPED_ENV.test(name)));
}

export function runNodeSuite({ root = ROOT, env = process.env, stdio = 'inherit', forwardSignals = false } = {}) {
  const child = spawn(process.execPath, buildArgs(selectFiles(root)), { cwd: root, env: childEnv(env), stdio });
  const forward = (signal) => child.kill(signal);
  if (forwardSignals) for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, forward);
  const release = () => { for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, forward); };
  return new Promise((resolve, reject) => {
    child.once('error', (error) => { release(); reject(error); });
    child.once('exit', (code, signal) => { release(); resolve({ code, signal }); });
  });
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  const { code, signal } = await runNodeSuite({ forwardSignals: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
}
