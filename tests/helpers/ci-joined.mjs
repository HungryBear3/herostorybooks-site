/**
 * Joined mounted journey (`npm run test:joined`).
 *
 * 1. Hermetic `next build`: empty starting env, dotenv disabled, synthetic
 *    token-shaped markers only, direct-upload and expedited flags on, primary
 *    hero left at its production default.
 * 2. `next start` on 127.0.0.1:3199 behind the loopback-only preload.
 * 3. tests/initial-shipping-journey.test.ts with module mocks, the offline
 *    preload and repo-relative aliases; every provider is faked in-process.
 *
 * Passes only on exactly 9 passing tests with nothing failed, skipped, todo or
 * cancelled, a cleanly stopped server and a free port. Waits are bounded and
 * every child is reaped on success, failure and interruption. The preloads are
 * a narrower containment than the OS-level loopback sandbox used locally.
 * Importing this module never spawns anything.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const JOINED_FILE = 'tests/initial-shipping-journey.test.ts';
export const JOINED_EXPECTED = 9;
export const HOST = '127.0.0.1';
export const PORT = 3199;
export const BUILD_TIMEOUT_MS = 600_000;
export const READY_TIMEOUT_MS = 60_000;
export const GATE_TIMEOUT_MS = 600_000;
const STOP_TIMEOUT_MS = 10_000;

const syntheticToken = (store) => ['vercel', 'blob', 'rw', store, 'syntheticSecret'].join('_');

export function serverEnv({ home, tmp, path: searchPath }) {
  return {
    PATH: searchPath,
    HOME: home,
    TMPDIR: tmp,
    NEXT_TELEMETRY_DISABLED: '1',
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true',
    HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'true',
    HSB_CHECKOUT_GUARD_MODE: 'durable',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: syntheticToken('syntheticintake'),
    HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: syntheticToken('syntheticguard'),
    BLOB_READ_WRITE_TOKEN: syntheticToken('syntheticorders'),
  };
}

/** Browser cache: an explicit PLAYWRIGHT_BROWSERS_PATH, else Playwright's default under the REAL home. */
export function gateEnv({ home, tmp, path: searchPath, browsersPath, realHome, platform }) {
  let browsers = browsersPath;
  if (!browsers) {
    if (platform === 'darwin') browsers = path.join(realHome, 'Library', 'Caches', 'ms-playwright');
    else if (platform === 'linux') browsers = path.join(realHome, '.cache', 'ms-playwright');
    else throw new Error(`no default Playwright browser cache for platform ${platform}`);
  }
  return { PATH: searchPath, HOME: home, TMPDIR: tmp, NEXT_TELEMETRY_DISABLED: '1', PLAYWRIGHT_BROWSERS_PATH: browsers };
}

export function plan({ root = ROOT, home, tmp, path: searchPath, tapFile, browsersPath, realHome, platform }) {
  const dotenv = path.join(root, 'tests', 'e2e', 'disable-next-dotenv.cjs');
  const helper = (name) => pathToFileURL(path.join(root, 'tests', 'helpers', name)).href;
  const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  const env = serverEnv({ home, tmp, path: searchPath });
  return [
    { kind: 'build', command: process.execPath, argv: ['--require', dotenv, nextBin, 'build'], env },
    {
      kind: 'server',
      command: process.execPath,
      argv: ['--require', dotenv, '--import', helper('ci-loopback-preload.mjs'), nextBin, 'start', '-H', HOST, '-p', String(PORT)],
      env,
    },
    {
      kind: 'gate',
      command: process.execPath,
      argv: [
        '--experimental-strip-types', '--experimental-test-module-mocks',
        '--require', dotenv,
        '--import', helper('ci-offline-preload.mjs'),
        '--import', helper('ci-native-aliases.mjs'),
        '--test', '--test-concurrency=1',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
        JOINED_FILE,
      ],
      env: gateEnv({ home, tmp, path: searchPath, browsersPath, realHome, platform }),
    },
  ];
}

const SUMMARY = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

export function parseTapSummary(text) {
  const counts = {};
  let ok = true;
  for (const name of SUMMARY) {
    const found = [...String(text).matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    if (found.length !== 1) { ok = false; continue; }
    counts[name] = Number(found[0][1]);
  }
  ok = ok && counts.tests === JOINED_EXPECTED && counts.pass === JOINED_EXPECTED
    && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
  return { ok, counts };
}

export function portIsFree(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (free) => { socket.destroy(); resolve(free); };
    socket.setTimeout(2_000, () => done(false));
    socket.once('connect', () => done(false));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED'));
  });
}

// ── Orchestration (only when executed directly) ─────────────────────────────

const active = new Set();

function launch(step, stdio) {
  const child = spawn(step.command, step.argv, { cwd: ROOT, env: step.env, stdio });
  active.add(child);
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { active.delete(child); resolve({ code: null, signal: null, error }); });
    child.once('exit', (code, signal) => { active.delete(child); resolve({ code, signal }); });
  });
  return { child, exited };
}

async function bounded({ child, exited }, timeoutMs) {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const result = await exited;
  clearTimeout(timer);
  return { ...result, timedOut };
}

async function waitForReady(server) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let exited = false;
  server.exited.then(() => { exited = true; });
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://${HOST}:${PORT}/checkout`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function stop(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return true;
  server.child.kill('SIGTERM');
  const timer = setTimeout(() => server.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await server.exited;
  clearTimeout(timer);
  return true;
}

function tail(file, bytes = 20_000) {
  try { return readFileSync(file, 'utf8').slice(-bytes); } catch { return '(unavailable)'; }
}

async function main() {
  const base = process.env.TMPDIR;
  if (!base || !path.isAbsolute(base) || realpathSync(base) !== base) {
    throw new Error('ci-joined: TMPDIR must name an existing canonical directory');
  }
  const realHome = os.homedir();
  const scratch = mkdtempSync(path.join(base, 'hsb-joined-'));
  const home = path.join(scratch, 'home');
  const tmp = path.join(scratch, 'tmp');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(tmp, { mode: 0o700 });
  const tapFile = path.join(scratch, 'joined.tap');
  const serverLog = path.join(scratch, 'server.log');
  const [build, serve, gate] = plan({
    root: ROOT, home, tmp, path: process.env.PATH ?? '', tapFile,
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH, realHome, platform: process.platform,
  });

  let interrupted = null;
  const interrupt = (signal) => { interrupted = signal; for (const child of active) child.kill('SIGKILL'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  const verdict = { build: null, ready: false, gate: null, summary: null, serverStopped: false, portFreeAfter: false };
  let server = null;
  try {
    if (!(await portIsFree())) throw new Error(`ci-joined: ${HOST}:${PORT} is already in use`);
    verdict.build = await bounded(launch(build, 'inherit'), BUILD_TIMEOUT_MS);
    if (verdict.build.code !== 0 || interrupted) throw new Error('ci-joined: next build failed');

    const log = openSync(serverLog, 'w');
    try { server = launch(serve, ['ignore', log, log]); } finally { closeSync(log); }
    verdict.ready = await waitForReady(server);
    if (!verdict.ready || interrupted) throw new Error('ci-joined: server did not become ready');

    verdict.gate = await bounded(launch(gate, 'inherit'), GATE_TIMEOUT_MS);
    verdict.summary = parseTapSummary(tail(tapFile, 1_000_000));
  } catch (error) {
    console.error(String(error?.message ?? error));
  } finally {
    if (server) verdict.serverStopped = await stop(server);
    else verdict.serverStopped = true;
    verdict.portFreeAfter = await portIsFree();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }

  const ok = !interrupted && verdict.build?.code === 0 && verdict.ready && verdict.gate?.code === 0
    && !verdict.gate?.timedOut && verdict.summary?.ok === true && verdict.serverStopped && verdict.portFreeAfter;
  console.log('JOINED_VERDICT ' + JSON.stringify({ ok, interrupted, ...verdict }));
  if (!ok) {
    // Raw evidence is printed before the scratch directory is removed.
    console.error('--- joined TAP ---\n' + tail(tapFile));
    console.error('--- server log (tail) ---\n' + tail(serverLog));
  }
  rmSync(scratch, { recursive: true, force: true });
  if (interrupted) process.kill(process.pid, interrupted);
  process.exit(ok ? 0 : 1);
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main();
