/**
 * Offline analytics governance CLI. No network, no credentials, no env reads.
 *
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/analytics-governance.ts check \
 *     [--registry FILE] [--previous FILE] [--checklist FILE] [--mapping FILE]
 *       Validates the experiment registry (and, with --previous, the change
 *       from the prior version), the GA4 Admin checklist, the decision-packet
 *       mapping contract, and the Meta DEFERRED invariants. Defaults are the
 *       checked-in files under config/analytics/.
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/analytics-governance.ts fixture
 *       Prints the deterministic synthetic GA4-behavior export fixture.
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/analytics-governance.ts schema
 *       Prints the generated JSON Schema for that export.
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/analytics-governance.ts packet-export FILE
 *       Converts one HSB GA4-behavior export into the offline decision
 *       packet's own `decision_packet.ga4_behavior` document through the
 *       checked-in mapping, or refuses: any value the pinned packet cannot
 *       represent rejects the whole export (nothing is collapsed into `other`).
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/analytics-governance.ts packet-fixture
 *       Prints the synthetic packet document (the export of the
 *       packet-representable synthetic fixture).
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/analytics-governance.ts link EXPERIMENT_ID [--registry FILE]
 *       Prints the one canonical governed link for exactly one validated
 *       registry entry whose status is `planned` or `running`, or refuses:
 *       unknown, inactive, ambiguous or invalid entries print no link.
 *
 * The warning flag suppresses only Node's typeless-module path diagnostic;
 * it does not change module semantics or suppress other warnings/errors.
 *
 * Output is value-free: `OK <artifact>` or `REJECTED <artifact> CODE@$.path`;
 * a packet document is printed only on success.
 * Exit 0 when everything is accepted, 3 on any rejection, 2 on usage errors
 * or an unreadable file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  exportDecisionPacketGa4Behavior,
  generateSyntheticGa4BehaviorExport,
  hsbGa4BehaviorExportJsonSchema,
  serializeDecisionPacketDocument,
  validateDecisionPacketMapping,
} from '../src/lib/analytics-decision-export.ts';
import {
  resolveRegistryCampaignLink,
  validateExperimentRegistry,
  validateExperimentRegistryTransition,
} from '../src/lib/campaign-governance.ts';
import { validateGa4AdminChecklist } from '../src/lib/ga4-admin-checklist.ts';
import { META_SERVER_PURCHASE_STATUS, metaDeferredContractViolations } from '../src/lib/meta-capi-status.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
  registry: path.join(ROOT, 'config/analytics/experiment-registry.v1.json'),
  checklist: path.join(ROOT, 'config/analytics/ga4-admin-checklist.v1.json'),
  mapping: path.join(ROOT, 'config/analytics/decision-packet-mapping.v1.json'),
};
/** The checked-in fixtures are exactly these generator calls. */
const FIXTURE_INPUT = { startDate: '2026-09-01', days: 7 };
const PACKET_FIXTURE_INPUT = { ...FIXTURE_INPUT, profile: 'packet_representable' } as const;

class UsageError extends Error {}

function usage(): never {
  throw new UsageError(
    'usage: analytics-governance.ts check [--registry F] [--previous F] [--checklist F] [--mapping F] | fixture | schema | packet-fixture | packet-export F'
      + ' | link EXPERIMENT_ID [--registry F]',
  );
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

function packetExport(file: string): number {
  const doc = readJson(file);
  const mapping = readJson(DEFAULTS.mapping);
  const result = doc.ok && mapping.ok ? exportDecisionPacketGa4Behavior(doc.value, mapping.value) : null;
  if (result?.ok) {
    process.stdout.write(serializeDecisionPacketDocument(result.document));
    return 0;
  }
  const lines: string[] = [];
  if (!doc.ok) report('decision_packet_export', ['JSON_INVALID@$'], '', lines);
  else if (!mapping.ok) report('decision_packet_mapping', ['JSON_INVALID@$'], '', lines);
  else if (result?.ok === false) report('decision_packet_export', result.issues, '', lines);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 3;
}

function packetFixture(): number {
  const mapping = readJson(DEFAULTS.mapping);
  const result = mapping.ok ? exportDecisionPacketGa4Behavior(generateSyntheticGa4BehaviorExport(PACKET_FIXTURE_INPUT), mapping.value) : null;
  if (!result?.ok) throw new Error('the synthetic packet fixture no longer exports');
  process.stdout.write(serializeDecisionPacketDocument(result.document));
  return 0;
}

function link(args: string[]): number {
  const [experimentId, ...flags] = args;
  if (experimentId === undefined || experimentId.startsWith('--')) usage();
  if (flags.length !== 0 && (flags.length !== 2 || flags[0] !== '--registry' || flags[1].startsWith('--'))) usage();
  const registry = readJson(flags[1] ?? DEFAULTS.registry);
  const result = registry.ok ? resolveRegistryCampaignLink(registry.value, experimentId) : { ok: false as const, issues: ['JSON_INVALID@$'] };
  if (result.ok === false) {
    const lines: string[] = [];
    report('campaign_link', result.issues, '', lines);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 3;
  }
  process.stdout.write(`${result.url}\n`);
  return 0;
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
  if (command === 'packet-fixture' && rest.length === 0) return packetFixture();
  if (command === 'packet-export' && rest.length === 1 && !rest[0].startsWith('--')) return packetExport(rest[0]);
  if (command === 'link') return link(rest);
  return usage();
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof UsageError ? error.message : 'internal error'}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
