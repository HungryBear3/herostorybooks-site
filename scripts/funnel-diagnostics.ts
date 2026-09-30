/**
 * Offline funnel diagnostics CLI. No network, no credentials, no env reads.
 *
 *   node --experimental-strip-types scripts/funnel-diagnostics.ts plan \
 *     --property ID --start YYYY-MM-DD --end YYYY-MM-DD [--breakdown B]
 *       Prints the exact read-only GA4 Data API request plan. B is one of
 *       none (default), device_category, landing_route, campaign,
 *       selected_format. Run each request with an `analytics.readonly` token
 *       outside this repo and save the responses as one JSON object keyed by
 *       request id: {"traffic": {...}, "events": {...}, ...}.
 *   node --experimental-strip-types scripts/funnel-diagnostics.ts report \
 *     --plan FILE --responses FILE [--format json|text]
 *       Prints the closed `hsb.funnel_diagnostics` v1 report (json, default)
 *       or a fixed-width owner view (text), or refuses.
 *
 * A refusal is value-free: `REJECTED <artifact> CODE@$.path` lines.
 * Exit 0 on success, 3 on a refusal, 2 on usage errors or an unreadable file.
 */
import { readFileSync } from 'node:fs';

import {
  buildFunnelReport,
  buildFunnelRequestPlan,
  renderFunnelReportText,
} from '../src/lib/ga4-funnel-diagnostics.ts';

class UsageError extends Error {}

const USAGE = 'usage: funnel-diagnostics.ts plan --property ID --start D --end D [--breakdown B]'
  + ' | report --plan F --responses F [--format json|text]';

function usage(): never {
  throw new UsageError(USAGE);
}

function parseFlags(args: string[], allowed: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.includes(name) || Object.hasOwn(options, name)) usage();
    if (value === undefined || value.startsWith('--')) usage();
    options[name] = value;
  }
  return options;
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false } {
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

function plan(args: string[]): number {
  const options = parseFlags(args, ['property', 'start', 'end', 'breakdown']);
  if (!options.property || !options.start || !options.end) usage();
  const built = buildFunnelRequestPlan({
    propertyId: options.property,
    startDate: options.start,
    endDate: options.end,
    breakdown: options.breakdown,
  });
  if (built.ok === false) {
    process.stdout.write(`REJECTED funnel_plan ${built.reason}@$\n`);
    return 3;
  }
  process.stdout.write(`${JSON.stringify(built.plan, null, 2)}\n`);
  return 0;
}

function report(args: string[]): number {
  const options = parseFlags(args, ['plan', 'responses', 'format']);
  if (!options.plan || !options.responses) usage();
  const format = options.format ?? 'json';
  if (format !== 'json' && format !== 'text') usage();
  const planDoc = readJson(options.plan);
  const responses = readJson(options.responses);
  if (!planDoc.ok || !responses.ok) {
    process.stdout.write(`REJECTED funnel_report JSON_INVALID@$.${planDoc.ok ? 'responses' : 'plan'}\n`);
    return 3;
  }
  const result = buildFunnelReport(planDoc.value, responses.value);
  if (result.ok === false) {
    process.stdout.write(`${result.issues.map((issue) => `REJECTED funnel_report ${issue}`).join('\n')}\n`);
    return 3;
  }
  process.stdout.write(format === 'text' ? renderFunnelReportText(result.report) : `${JSON.stringify(result.report, null, 2)}\n`);
  return 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'plan') return plan(rest);
  if (command === 'report') return report(rest);
  return usage();
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof UsageError ? error.message : 'internal error'}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
