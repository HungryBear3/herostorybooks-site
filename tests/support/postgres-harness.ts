/**
 * Disposable local PostgreSQL harness for the HSB Phase B control-plane tests.
 *
 * Properties this harness guarantees, all of which the control-plane proof depends on:
 *   - a fresh random temp root per cluster, never a shared or ambient data directory;
 *   - Unix-socket only: `listen_addresses` is empty, so no TCP port is ever opened;
 *   - a scrubbed child environment (no ambient PG*, no credentials, no ~/.pgpass,
 *     no ~/.psqlrc) — every child gets PATH plus a throwaway HOME;
 *   - bounded waits on readiness and on every child process, with SIGKILL on timeout;
 *   - synchronous reaping for every serial command and explicit awaited exit for the
 *     concurrent ones;
 *   - teardown on success and on failure, including an exit hook of last resort.
 *
 * It contacts no network, reads no credentials, and touches nothing outside its
 * own temp root.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { SQL_DIR, sqlFileNames } from './control-plane-identity.ts';

const REQUIRED_TOOLS = ['initdb', 'pg_ctl', 'psql'] as const;
type RequiredTool = (typeof REQUIRED_TOOLS)[number];

/** Local-only install locations searched in addition to PATH. Never network. */
const EXTRA_TOOL_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/lib/postgresql/18/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/local/pgsql/bin',
];

const BOOTSTRAP_USER = 'hsb_cp_bootstrap';
const DATABASE_NAME = 'hsb_cp';
const ROLE_PATTERN = /^hsb_[a-z_]+$/;

export class PostgresUnavailableError extends Error {}

function which(tool: RequiredTool): string | null {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...EXTRA_TOOL_DIRS]) {
    const candidate = path.join(dir, tool);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // unreadable directory entry — keep looking
    }
  }
  return null;
}

/**
 * Resolve every required PostgreSQL binary or throw. Never returns a partial set and
 * never lets a caller silently skip: an unavailable toolchain is a hard failure.
 */
export function resolvePostgresTools(): Record<RequiredTool, string> {
  const resolved = {} as Record<RequiredTool, string>;
  const missing: string[] = [];
  for (const tool of REQUIRED_TOOLS) {
    const found = which(tool);
    if (found) resolved[tool] = found;
    else missing.push(tool);
  }
  if (missing.length > 0) {
    throw new PostgresUnavailableError(
      `HSB control-plane PostgreSQL proof cannot run: missing local PostgreSQL tool(s) ${missing.join(', ')}. ` +
        `Searched PATH and ${EXTRA_TOOL_DIRS.join(', ')}. Install a local PostgreSQL server ` +
        `(for example \`brew install postgresql@18\`) and re-run. This proof is never skipped.`,
    );
  }
  return resolved;
}

/** Synchronous bounded sleep with no child process and no busy-wait. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function shortTempRoot(): string {
  // The Unix socket path has a hard ~103 byte limit, so prefer a short root.
  const base = existsSync('/tmp') && statSync('/tmp').isDirectory() ? '/tmp' : (process.env.TMPDIR ?? '/tmp');
  return mkdtempSync(path.join(base, 'hsb-cp-'));
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface PostgresCluster {
  readonly root: string;
  readonly dataDir: string;
  readonly socketDir: string;
  readonly port: number;
  /** Run SQL as the bootstrap superuser. Throws with psql stderr on any error. */
  sql(text: string, options?: { timeoutMs?: number }): string;
  /** Run SQL and require it to fail. Returns combined stderr for assertion. */
  sqlExpectError(text: string, options?: { timeoutMs?: number }): string;
  /** Run SQL after SET ROLE <role>. The role name is validated, never interpolated blindly. */
  sqlAsRole(role: string, text: string, options?: { timeoutMs?: number }): string;
  sqlAsRoleExpectError(role: string, text: string, options?: { timeoutMs?: number }): string;
  /** Start a concurrent psql session. Used only by the advisory-lock barrier proof. */
  startSession(text: string, options?: { timeoutMs?: number }): Promise<CommandResult>;
  stop(): void;
}

function childEnv(homeDir: string): NodeJS.ProcessEnv {
  // Explicit allowlist. Nothing ambient (PGHOST, PGUSER, PGPASSWORD, PGSERVICE,
  // BLOB/STRIPE/RESEND credentials, …) reaches any child.
  return {
    PATH: process.env.PATH ?? '',
    HOME: homeDir,
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
    NODE_ENV: 'test',
    PGCONNECT_TIMEOUT: '10',
  };
}

export function startDisposableCluster(): PostgresCluster {
  const tools = resolvePostgresTools();
  const root = shortTempRoot();
  const dataDir = path.join(root, 'data');
  const socketDir = path.join(root, 's');
  const homeDir = path.join(root, 'home');
  const logFile = path.join(root, 'postgres.log');
  // Unique socket directory already isolates the cluster; the port only names the
  // socket file. Randomised anyway so two clusters can never collide.
  const port = 20000 + Math.floor(Math.random() * 20000);

  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  let stopped = false;
  const env = childEnv(homeDir);

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      spawnSync(tools.pg_ctl, ['-D', dataDir, '-m', 'immediate', '-w', '-t', '20', 'stop'], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
    } catch {
      // fall through to directory removal regardless
    }
    rmSync(root, { recursive: true, force: true });
  };

  const exitHook = (): void => teardown();
  process.once('exit', exitHook);

  const fail = (stage: string, result: ReturnType<typeof spawnSync>): never => {
    let log = '';
    try {
      if (existsSync(logFile)) log = readFileSync(logFile, 'utf8').slice(-4000);
    } catch {
      /* ignore */
    }
    teardown();
    process.removeListener('exit', exitHook);
    throw new Error(
      `PostgreSQL harness failed at ${stage} (status=${result.status}, signal=${result.signal ?? 'none'})\n` +
        `stdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}\nserver log:\n${log}`,
    );
  };

  try {
    const initdb = spawnSync(
      tools.initdb,
      [
        '-D', dataDir,
        '-U', BOOTSTRAP_USER,
        '--auth-local=trust',
        '--auth-host=reject',
        '-E', 'UTF8',
        '--locale=C',
        '--no-sync',
      ],
      { env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' },
    );
    if (initdb.status !== 0) fail('initdb', initdb);

    const serverOptions = [
      `-c listen_addresses=''`, // no TCP socket is ever created
      `-c unix_socket_directories='${socketDir}'`,
      `-c port=${port}`,
      '-c fsync=off',
      '-c full_page_writes=off',
      '-c max_connections=24',
      '-c log_min_messages=warning',
      '-c log_statement=none',
    ].join(' ');

    const start = spawnSync(
      tools.pg_ctl,
      ['-D', dataDir, '-l', logFile, '-o', serverOptions, '-w', '-t', '45', 'start'],
      { env, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' },
    );
    if (start.status !== 0) fail('pg_ctl start', start);
  } catch (error) {
    teardown();
    process.removeListener('exit', exitHook);
    throw error;
  }

  const runPsql = (database: string, text: string, timeoutMs: number): ReturnType<typeof spawnSync> =>
    spawnSync(
      tools.psql,
      [
        '-X', // never read ~/.psqlrc
        '-q',
        '-A',
        '-t',
        '-P', 'pager=off',
        '-v', 'ON_ERROR_STOP=1',
        '-h', socketDir,
        '-p', String(port),
        '-U', BOOTSTRAP_USER,
        '-d', database,
        '-f', '-', // SQL arrives on stdin; nothing is ever built into an argv string
      ],
      { env, encoding: 'utf8', input: text, timeout: timeoutMs, killSignal: 'SIGKILL' },
    );

  // Bounded readiness wait against the freshly started cluster.
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    const probe = runPsql('postgres', 'SELECT 1;', 10_000);
    if (probe.status === 0) ready = true;
    else sleepSync(250);
  }
  if (!ready) {
    teardown();
    process.removeListener('exit', exitHook);
    throw new Error('PostgreSQL harness failed: cluster did not become ready within the bounded wait');
  }

  const bootstrap = runPsql('postgres', `CREATE DATABASE ${DATABASE_NAME};`, 30_000);
  if (bootstrap.status !== 0) {
    teardown();
    process.removeListener('exit', exitHook);
    throw new Error(`PostgreSQL harness failed to create the test database: ${bootstrap.stderr}`);
  }

  const assertRole = (role: string): string => {
    if (!ROLE_PATTERN.test(role)) throw new Error(`refusing to SET ROLE to a non-control-plane name: ${role}`);
    return role;
  };

  const cluster: PostgresCluster = {
    root,
    dataDir,
    socketDir,
    port,
    sql(text, options) {
      const result = runPsql(DATABASE_NAME, text, options?.timeoutMs ?? 60_000);
      if (result.status !== 0) {
        throw new Error(`SQL failed (status=${result.status}):\n${text}\n--- stderr ---\n${result.stderr}`);
      }
      return String(result.stdout ?? '');
    },
    sqlExpectError(text, options) {
      const result = runPsql(DATABASE_NAME, text, options?.timeoutMs ?? 60_000);
      if (result.status === 0) {
        throw new Error(`SQL unexpectedly succeeded:\n${text}\n--- stdout ---\n${result.stdout}`);
      }
      return `${result.stderr ?? ''}`;
    },
    sqlAsRole(role, text, options) {
      return cluster.sql(`SET ROLE ${assertRole(role)};\n${text}`, options);
    },
    sqlAsRoleExpectError(role, text, options) {
      return cluster.sqlExpectError(`SET ROLE ${assertRole(role)};\n${text}`, options);
    },
    startSession(text, options) {
      const timeoutMs = options?.timeoutMs ?? 30_000;
      const child: ChildProcess = spawn(
        tools.psql,
        [
          '-X', '-q', '-A', '-t', '-P', 'pager=off',
          '-v', 'ON_ERROR_STOP=1',
          '-h', socketDir,
          '-p', String(port),
          '-U', BOOTSTRAP_USER,
          '-d', DATABASE_NAME,
          '-f', '-',
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      );

      return new Promise<CommandResult>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const killer = setTimeout(() => {
          stderr += '\n[harness] concurrent session exceeded its bounded wait; SIGKILLed\n';
          child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout!.setEncoding('utf8');
        child.stderr!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          reject(error);
        });
        // 'close' fires after the child has been reaped and all stdio is drained.
        child.on('close', (status) => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          resolve({ status: status ?? -1, stdout, stderr });
        });

        child.stdin!.end(text);
      });
    },
    stop() {
      teardown();
      process.removeListener('exit', exitHook);
    },
  };

  return cluster;
}

/** Apply every checked-in control-plane SQL file in deterministic ordinal order. */
export function applyControlPlaneSchema(cluster: PostgresCluster): string[] {
  const applied: string[] = [];
  for (const name of sqlFileNames()) {
    try {
      cluster.sql(readFileSync(path.join(SQL_DIR, name), 'utf8'), { timeoutMs: 120_000 });
    } catch (error) {
      throw new Error(`applying db/control-plane/${name} failed: ${(error as Error).message}`);
    }
    applied.push(name);
  }
  return applied;
}

/** Wait, bounded, until `predicate` holds for a fresh query result. */
export function waitForCondition(
  cluster: PostgresCluster,
  query: string,
  predicate: (value: string) => boolean,
  options: { attempts?: number; intervalMs?: number; description: string },
): void {
  const attempts = options.attempts ?? 80;
  const intervalMs = options.intervalMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate(cluster.sql(query).trim())) return;
    sleepSync(intervalMs);
  }
  throw new Error(`bounded wait expired: ${options.description}`);
}
