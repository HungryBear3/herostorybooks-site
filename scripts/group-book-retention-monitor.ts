/**
 * Deterministic group-book retention monitor (DRY RUN ONLY).
 *
 *   node --experimental-strip-types scripts/group-book-retention-monitor.ts \
 *     --state <path.json> [--http-status <code>] [--input <snapshot.json>]
 *
 * Without --input it reads ONLY the exact durable slot/heartbeat keys for the
 * expected UTC day (needs GROUP_BOOK_BLOB_READ_WRITE_TOKEN; no listing). With
 * --input it evaluates a recorded {now,slots,heartbeats,readFailed} snapshot.
 * Alerts are printed as dry-run notifications; nothing is sent anywhere. The
 * fingerprint state file is rewritten so an unchanged fault alerts once.
 * Healthy runs print nothing (exit 0); persisting faults exit 1.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { evaluateRetentionMonitor, loadRetentionMonitorInputs } from '../src/lib/group-book/retention-monitor.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const statePath = arg('--state');
if (!statePath) {
  console.error('usage: --state <path.json> [--http-status <code>] [--input <snapshot.json>]');
  process.exit(2);
}
const prior: string[] = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).fingerprints ?? [] : [];
const inputPath = arg('--input');
const snapshot = inputPath
  ? JSON.parse(readFileSync(inputPath, 'utf8'))
  : { now: Date.now(), ...(await loadRetentionMonitorInputs(Date.now())) };
const httpStatus = arg('--http-status') ? Number(arg('--http-status')) : null;
const result = evaluateRetentionMonitor({ ...snapshot, httpStatus, priorFingerprints: prior });
writeFileSync(statePath, JSON.stringify({ fingerprints: result.fingerprints }) + '\n');
for (const alert of result.alerts) console.log(`DRY-RUN NOTIFY ${JSON.stringify(alert)}`);
if (result.alerts.length > 0) console.log(`MONITOR ${JSON.stringify({ expectedDay: result.expectedDay, alerts: result.alerts.length, faults: result.fingerprints.length })}`);
process.exit(result.fingerprints.length > 0 ? 1 : 0);
