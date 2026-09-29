/**
 * Offline analytics governance CLI. No network, no credentials, no env reads.
 *
 *   node --experimental-strip-types scripts/analytics-governance.ts check \
 *     [--registry FILE] [--previous FILE] [--checklist FILE] [--mapping FILE]
 *       Validates the experiment registry (and, with --previous, the change
 *       from the prior version), the GA4 Admin checklist, the decision-packet
 *       mapping contract, and the Meta DEFERRED invariants. Defaults are the
 *       checked-in files under config/analytics/.
 *   node --experimental-strip-types scripts/analytics-governance.ts fixture
 *       Prints the deterministic synthetic GA4-behavior export fixture.
 *   node --experimental-strip-types scripts/analytics-governance.ts schema
 *       Prints the generated JSON Schema for that export.
 *
 * Output is value-free: `OK <artifact>` or `REJECTED <artifact> CODE@$.path`.
 * Exit 0 when everything is accepted, 3 on any rejection, 2 on usage errors
 * or an unreadable file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  generateSyntheticGa4BehaviorExport,
  hsbGa4BehaviorExportJsonSchema,
  validateDecisionPacketMapping,
} from '../src/lib/analytics-decision-export.ts';
import { validateExperimentRegistry, validateExperimentRegistryTransition } from '../src/lib/campaign-governance.ts';
import { validateGa4AdminChecklist } from '../src/lib/ga4-admin-checklist.ts';
import { META_SERVER_PURCHASE_STATUS, metaDeferredContractViolations } from '../src/lib/meta-capi-status.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
  registry: path.join(ROOT, 'config/analytics/experiment-registry.v1.json'),
  checklist: path.join(ROOT, 'config/analytics/ga4-admin-checklist.v1.json'),
  mapping: path.join(ROOT, 'config/analytics/decision-packet-mapping.v1.json'),
};
/** The checked-in fixture is exactly this generator call. */
const FIXTURE_INPUT = { startDate: '2026-09-01', days: 7 };

class UsageError extends Error {}

function usage(): never {
  throw new UsageError('usage: analytics-governance.ts check [--registry F] [--previous F] [--checklist F] [--mapping F] | fixture | schema');
}

function parseCheckArgs(args: string[]): Record<'registry' | 'previous' | 'checklist' | 'mapping', string | undefined> {
  const options: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith('--') ? flag.slice(2) : '';
    if (!['registry', 'previous', 'checklist', 'mapping'].includes(name) || options[name] !== undefined) usage();
    if (value === undefined || value.startsWith('--')) usage();
    options[name] = value;
  }
  return {
    registry: options.registry ?? DEFAULTS.registry,
    previous: options.previous,
    checklist: options.checklist ?? DEFAULTS.checklist,
    mapping: options.mapping ?? DEFAULTS.mapping,
  };
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function readJson(file: string): Parsed {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new UsageError('unreadable input file');
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function report(artifact: string, issues: string[], okLine: string, lines: string[]): boolean {
  if (issues.length === 0) {
    lines.push(`OK ${okLine}`);
    return true;
  }
  for (const issue of issues) lines.push(`REJECTED ${artifact} ${issue}`);
  return false;
}

function check(args: string[]): number {
  const options = parseCheckArgs(args);
  const lines: string[] = [];
  let ok = true;

  const registry = readJson(options.registry!);
  if (!registry.ok) {
    ok = report('experiment_registry', ['JSON_INVALID@$'], '', lines) && ok;
  } else {
    let issues = validateExperimentRegistry(registry.value);
    if (issues.length === 0 && options.previous) {
      const previous = readJson(options.previous);
      issues = previous.ok ? validateExperimentRegistryTransition(previous.value, registry.value) : ['PREVIOUS_INVALID@$'];
    }
    const count = (registry.value as { experiments?: unknown[] }).experiments?.length ?? 0;
    ok = report('experiment_registry', issues, `experiment_registry experiments=${count}`, lines) && ok;
  }

  const checklist = readJson(options.checklist!);
  ok = report('ga4_admin_checklist', checklist.ok ? validateGa4AdminChecklist(checklist.value) : ['JSON_INVALID@$'], 'ga4_admin_checklist', lines) && ok;

  const mapping = readJson(options.mapping!);
  ok = report('decision_packet_mapping', mapping.ok ? validateDecisionPacketMapping(mapping.value) : ['JSON_INVALID@$'], 'decision_packet_mapping', lines) && ok;

  ok = report('meta_server_purchase', metaDeferredContractViolations(), `meta_server_purchase ${META_SERVER_PURCHASE_STATUS.status}`, lines) && ok;

  process.stdout.write(`${lines.join('\n')}\n`);
  return ok ? 0 : 3;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'check') return check(rest);
  if (command === 'fixture' && rest.length === 0) {
    process.stdout.write(`${JSON.stringify(generateSyntheticGa4BehaviorExport(FIXTURE_INPUT), null, 2)}\n`);
    return 0;
  }
  if (command === 'schema' && rest.length === 0) {
    process.stdout.write(`${JSON.stringify(hsbGa4BehaviorExportJsonSchema(), null, 2)}\n`);
    return 0;
  }
  return usage();
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof UsageError ? error.message : 'internal error'}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
