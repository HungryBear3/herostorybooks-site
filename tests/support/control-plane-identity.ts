/**
 * Shared, offline helpers for the HSB Phase B control-plane foundation tests.
 *
 * This module is test-only support. It never imports application source and is
 * never imported by application source. It reads the vendored contract bytes
 * under docs/architecture/hsb-control-plane-v5/ and the checked-in SQL under
 * db/control-plane/ as plain data.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CONTRACT_DIR = path.join(REPO_ROOT, 'docs/architecture/hsb-control-plane-v5');
export const SQL_DIR = path.join(REPO_ROOT, 'db/control-plane');

/** Accepted identities restated from the task brief and SOURCE-IDENTITY.md. */
export const ACCEPTED = {
  applicationBaseCommit: '957a720a0635e2d875d6ecfb989b6bc5c1092c88',
  applicationBaseTree: '087d10b03ebf5918dc9d767232dc998722ce4fcd',
  sourceManifestSha256: 'de6e3f9d654309a648d1932eacae98c058d9f905121ac9aaf1d576514ddc1015',
  sourceManifestEntries: 27,
  canonicalRegistrySha256: '964695a89f250b07ef0bcb0a6b15deee9e33af6036c1a0bc0650d2d5bd014fa0',
  verdict: 'PASS_FINAL_OFFLINE',
  contractId: 'hsb-checkout-control-v4',
  contractVersion: 4,
} as const;

/** Exact byte identities of every vendored contract file. */
export const VENDORED_SHA256: ReadonlyArray<readonly [string, string]> = [
  ['hsb-checkout-control-v4.json', 'f97a15c0c9fef6319f4322a6539bbce206b8e59df09d3f62f3ae08b784c9fb99'],
  ['schema/hsb-checkout-control.schema.json', 'fa8cb423b6a766e52f989b47de67111c087d42a4da56ee242c19076792f7075b'],
  ['generated/HSB-ARCHITECTURE-DECISION-V4.md', '5ed6ee555711bb687e9b4e50dd3bd0077fabd4010e7e84862f4fc06f065c2b32'],
  ['generated/HSB-PHASE-B-CONTRACT-V4.md', 'd7ba09f81850ce67a506b24c92d3334128f6020eb3bb7b7e79935b39b7343d7c'],
  ['evidence/SOURCE-CANDIDATE-FILES.sha256', 'de6e3f9d654309a648d1932eacae98c058d9f905121ac9aaf1d576514ddc1015'],
  ['evidence/FINAL-OFFLINE-VERDICT.md', '775c652de61042d4e0abf706fe7c2ad0e2ee6ff2244498ac5b44a8124fd5eafc'],
];

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readContractFileBytes(relative: string): Buffer {
  return readFileSync(path.join(CONTRACT_DIR, relative));
}

export function loadContract(): any {
  return JSON.parse(readContractFileBytes('hsb-checkout-control-v4.json').toString('utf8'));
}

/**
 * RFC 8785-style canonical JSON: object keys sorted by code unit, no insignificant
 * whitespace. SHA-256 over this serialization of the whole contract document is the
 * accepted canonical registry digest.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort();
  return `{${entries
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export function canonicalRegistryDigest(): string {
  return sha256Hex(canonicalJson(loadContract()));
}

/** Every checked-in control-plane SQL file, in deterministic lexical apply order. */
export function sqlFileNames(): string[] {
  return readdirSync(SQL_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function readSqlFile(name: string): string {
  return readFileSync(path.join(SQL_DIR, name), 'utf8');
}

export function readAllSql(): string {
  return sqlFileNames()
    .map((name) => readSqlFile(name))
    .join('\n');
}
