// Recover lost paid orders from a JSON config.
//
// Usage:
//   node --experimental-strip-types scripts/recover-orders.ts <config.json>
//
// Example config: scripts/recover-orders.example.json
//
// Each entry in the array is a RecoveryInput:
//   {
//     "id": "ord_<exact-original-id>",
//     "childName": "...",
//     "bookFormat": "classic" | "digital" | "premium",
//     "email": "...",
//     "stripeSessionId": "cs_test_..." (optional but recommended),
//     "shippingAddress": { line1, city, state, zip, country } (required for print),
//     "photoFilePath": "/absolute/path/to/photo.jpg" (optional),
//     "characterNotes": "...",
//     "appearanceOptions": "...",
//     "theme": "...",
//     "lesson": "...",
//     "occasion": "...",
//     "giftMessage": "..."
//   }

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  formatRecoverySummary,
  recoverOrder,
  type RecoveryInput,
  type RecoverySummary,
} from '../src/lib/order-recovery.ts';

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error(
      'Usage: node --experimental-strip-types scripts/recover-orders.ts <config.json>',
    );
    process.exit(2);
  }

  const raw = await readFile(path.resolve(configPath), 'utf8');
  let inputs: RecoveryInput[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('config must be a JSON array');
    inputs = parsed as RecoveryInput[];
  } catch (err) {
    console.error(`Could not parse ${configPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  if (inputs.length === 0) {
    console.error('Config is empty.');
    process.exit(2);
  }

  const summaries: RecoverySummary[] = [];
  let failures = 0;

  for (const input of inputs) {
    if (!input.id || !input.childName || !input.email || !input.bookFormat) {
      console.error(
        `Skipping invalid input (missing id/childName/email/bookFormat): ${JSON.stringify(input)}`,
      );
      failures++;
      continue;
    }
    try {
      const summary = await recoverOrder(input);
      summaries.push(summary);
    } catch (err) {
      console.error(
        `Recovery FAILED for id=${input.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failures++;
    }
  }

  console.log('\n── Recovery summary ──────────────────────────────────────────────');
  for (const s of summaries) {
    console.log('');
    console.log(formatRecoverySummary(s));
  }
  console.log(
    `\n${summaries.length} order(s) recovered, ${failures} skipped/failed.\n`,
  );

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Recovery script crashed:', err);
  process.exit(1);
});
