import { runRecoverySweep } from '../src/lib/recovery-sweep';

const dryRun = process.argv.includes('--dry-run');

const result = await runRecoverySweep({ dryRun });

console.log(
  dryRun
    ? `Dry run: ${result.eligible} eligible lead(s) found, no emails sent.`
    : `Sweep complete: ${result.sent} sent, ${result.failed} failed, ${result.eligible} eligible.`,
);

if (result.failed > 0) process.exit(1);
