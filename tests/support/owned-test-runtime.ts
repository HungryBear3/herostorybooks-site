/**
 * Runtime contract for suites that write private proof artifacts.
 *
 * HSB_OWNED_TEST_RUNTIME, when set at all, is strict: it must be an existing
 * absolute directory confining HOME and TMPDIR. When absent, the suite creates
 * its own isolated home and tmp beneath a valid TMPDIR or the platform temp
 * directory, and removes them at exit. Bad configuration fails with a named
 * assertion; nothing falls back past it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function existingDirectory(name: string, value: string): string {
  const raw = value.replace(/\/+$/, '');
  assert.ok(raw && path.isAbsolute(raw), `${name} must be absolute`);
  assert.ok(existsSync(raw) && statSync(raw).isDirectory(), `${name} must be an existing directory`);
  return realpathSync(raw);
}

/** The canonical owned root; in the fallback, also points HOME and TMPDIR inside it. */
export function resolveOwnedTestRuntime(prefix: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HSB_OWNED_TEST_RUNTIME;
  if (explicit !== undefined) {
    const owned = existingDirectory('HSB_OWNED_TEST_RUNTIME', explicit);
    for (const name of ['HOME', 'TMPDIR'] as const) {
      const value = existingDirectory(name, env[name] ?? '');
      assert.ok(value === owned || value.startsWith(`${owned}${path.sep}`), `${name} must be confined to the owned runtime`);
    }
    return owned;
  }
  const base = existingDirectory('TMPDIR', env.TMPDIR || os.tmpdir());
  const owned = mkdtempSync(path.join(base, `${prefix}-`));
  process.once('exit', () => rmSync(owned, { recursive: true, force: true }));
  for (const [name, directory] of [['HOME', 'home'], ['TMPDIR', 'tmp']] as const) {
    env[name] = path.join(owned, directory);
    mkdirSync(env[name] as string, { mode: 0o700 });
  }
  return owned;
}

function isExecutableFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0;
}

/** The genuine pdftotext: an explicit absolute HSB_PDFTOTEXT, or PATH. */
export function resolvePdftotext(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HSB_PDFTOTEXT;
  if (explicit !== undefined) {
    assert.ok(path.isAbsolute(explicit), 'HSB_PDFTOTEXT must be absolute');
    assert.ok(isExecutableFile(explicit), 'HSB_PDFTOTEXT must be an executable file');
    return explicit;
  }
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, 'pdftotext');
    if (isExecutableFile(candidate)) return candidate;
  }
  assert.fail('pdftotext must be on PATH (poppler-utils), or HSB_PDFTOTEXT must name it');
}
