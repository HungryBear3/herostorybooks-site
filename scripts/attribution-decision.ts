/**
 * Offline attribution decision CLI. No network, no credentials, no env reads,
 * no order-store access: it reads only the files it is given.
 *
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/attribution-decision.ts ledger-export \
 *     --orders-dir DIR --start YYYY-MM-DD --end YYYY-MM-DD --timezone TZ \
 *     [--registry FILE] [--data-origin operator_export|synthetic_fixture] \
 *     [--generated-at YYYY-MM-DDTHH:MM:SSZ]
 *       Reads a read-only snapshot directory of durable order records (one
 *       `*.json` record per file; other names and subdirectories are not
 *       records) and prints the closed `hsb.decision_export.ledger` v1
 *       document. An unparsable file is counted as an integrity rejection,
 *       never skipped. Producing the snapshot is a separate operator step.
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/attribution-decision.ts decision-report \
 *     --ledger FILE --ga4 FILE --experiment EXPERIMENT_ID [--registry FILE]
 *       Joins one ledger export, one HSB-native GA4 behavior export and the
 *       registry into the closed `hsb.decision_report.attribution` v1 report
 *       for one registered experiment, or refuses on any schema, identity,
 *       window, attestation or integrity mismatch.
 *
 * The warning flag suppresses only Node's typeless-module path diagnostic;
 * it does not change module semantics or suppress other warnings/errors.
 *
 * Output is value-free: a document on success, otherwise
 * `REJECTED <artifact> CODE@$.path` lines. Exit 0 on success, 3 on a
 * refusal, 2 on usage errors or an unreadable file or directory.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAttributionDecisionReport } from '../src/lib/attribution-decision-report.ts';
import { buildLedgerAttributionExport } from '../src/lib/attribution-ledger-export.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = path.join(ROOT, 'config/analytics/experiment-registry.v1.json');

class UsageError extends Error {}

const USAGE = 'usage: attribution-decision.ts ledger-export --orders-dir D --start D --end D --timezone TZ'
  + ' [--registry F] [--data-origin O] [--generated-at TS]'
  + ' | decision-report --ledger F --ga4 F --experiment ID [--registry F]';

function usage(): never {
  throw new UsageError(USAGE);
}

function parseFlags(args: string[], allowed: readonly string[], required: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.includes(name) || Object.hasOwn(options, name)) usage();
    if (value === undefined || value.startsWith('--')) usage();
    options[name] = value;
  }
  if (required.some((name) => !Object.hasOwn(options, name))) usage();
  return options;
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new UsageError('unreadable input file');
  }
}

function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** One record per `*.json` file, in name order; an unparsable file is a `null` record. */
function readOrderSnapshot(dir: string): unknown[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new UsageError('unreadable orders directory');
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const parsed = parseJson(readText(path.join(dir, name)));
      return parsed.ok ? parsed.value : null;
    });
}

function refuse(artifact: string, issues: string[]): number {
  process.stdout.write(`${issues.map((issue) => `REJECTED ${artifact} ${issue}`).join('\n')}\n`);
  return 3;
}

function nowTimestamp(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

function ledgerExport(args: string[]): number {
  const options = parseFlags(
    args,
    ['orders-dir', 'start', 'end', 'timezone', 'registry', 'data-origin', 'generated-at'],
    ['orders-dir', 'start', 'end', 'timezone'],
  );
  const orders = readOrderSnapshot(options['orders-dir']);
  const registry = parseJson(readText(options.registry ?? DEFAULT_REGISTRY));
  if (!registry.ok) return refuse('ledger_export', ['REGISTRY_INVALID@$.registry']);
  const result = buildLedgerAttributionExport({
    orders,
    registry: registry.value,
    timezone: options.timezone,
    coverage: { start: options.start, end: options.end },
    generatedAt: options['generated-at'] ?? nowTimestamp(),
    dataOrigin: options['data-origin'] ?? 'operator_export',
  });
  if (result.ok === false) return refuse('ledger_export', result.issues);
  process.stdout.write(`${JSON.stringify(result.document, null, 2)}\n`);
  return 0;
}

function decisionReport(args: string[]): number {
  const options = parseFlags(args, ['ledger', 'ga4', 'experiment', 'registry'], ['ledger', 'ga4', 'experiment']);
  const inputs = {
    ledger: parseJson(readText(options.ledger)),
    ga4: parseJson(readText(options.ga4)),
    registry: parseJson(readText(options.registry ?? DEFAULT_REGISTRY)),
  };
  const unparsable = (Object.keys(inputs) as Array<keyof typeof inputs>).filter((name) => !inputs[name].ok);
  if (unparsable.length > 0) return refuse('decision_report', unparsable.map((name) => `JSON_INVALID@$.${name}`));
  const value = (parsed: Parsed) => (parsed as { ok: true; value: unknown }).value;
  const result = buildAttributionDecisionReport({
    ledger: value(inputs.ledger),
    ga4: value(inputs.ga4),
    registry: value(inputs.registry),
    experimentId: options.experiment,
  });
  if (result.ok === false) return refuse('decision_report', result.issues);
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  return 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'ledger-export') return ledgerExport(rest);
  if (command === 'decision-report') return decisionReport(rest);
  return usage();
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof UsageError ? error.message : 'internal error'}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
