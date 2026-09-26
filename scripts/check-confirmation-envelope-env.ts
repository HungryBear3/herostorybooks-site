/**
 * Deploy-time contract for the private confirmation-envelope lane.
 *
 * Runs as a step of `npm run build`, which is the command Vercel invokes for
 * this project. On a Vercel PRODUCTION build with the envelope writer armed it
 * fails the build — before deploy, loudly — when the dedicated credential is
 * missing, malformed, or names a store another HSB lane already uses, or when
 * the Blob namespace does not resolve.
 *
 * Why a build gate and not a runtime check: the regression this prevents is
 * silent. `scripts/check-story-media-env.ts` records the precedent verbatim —
 * the code required an environment variable Production did not have, a feature
 * quietly vanished, and nothing failed. A runtime gate is what produced that
 * outcome; it cannot also detect it. Here the silent failure would be worse
 * than a vanished control: an envelope writer pointed at a store that is not
 * its own.
 *
 * Everywhere else this is a no-op. A local `next build`, a CI build (the
 * workflow blanks `VERCEL`/`VERCEL_ENV`), a Vercel Preview build, and any
 * build with the writer flag off all exit 0 without needing a single secret.
 * The writer flag is off by default, so this gate is silent until an operator
 * deliberately arms the lane.
 *
 * This script reaches no network and touches no store. It reads an
 * environment, and it prints a problem string that names the variable and the
 * fault. No token value is ever read into the output.
 */
import {
  CONFIRMATION_ENVELOPE_TOKEN_ENV,
  CONFIRMATION_ENVELOPE_WRITER_ENV,
  confirmationEnvelopeBuildContractProblem,
  isConfirmationEnvelopeWriterEnabled,
  isVercelProductionBuild,
} from '../src/lib/confirmation-envelope-config.ts';

const problem = confirmationEnvelopeBuildContractProblem(process.env);

if (!problem) {
  if (isVercelProductionBuild(process.env) && isConfirmationEnvelopeWriterEnabled(process.env)) {
    console.log(
      '[confirmation-envelope] Production build contract satisfied: dedicated private envelope store configured.',
    );
  }
  process.exit(0);
}

console.error(
  [
    '',
    '  ✖ Vercel Production build refused: the confirmation-envelope lane is misconfigured.',
    '',
    `    ${problem}`,
    '',
    '    A frozen confirmation envelope holds the exact message body, subject and',
    '    recipient the provider will receive. Those bytes must be written to a',
    '    SEPARATE, private Vercel Blob store. The public order store named by',
    '    BLOB_READ_WRITE_TOKEN rejects private writes and must not be reused, and',
    '    neither may the intake, guard, story-media or Family Review stores.',
    '',
    '    Dedication is checked by Blob STORE ID, not by comparing token strings:',
    '    two different credentials issued for one store are two strings addressing',
    '    one keyspace.',
    '',
    `    To ship Production WITHOUT the envelope writer, leave ${CONFIRMATION_ENVELOPE_WRITER_ENV}`,
    `    unset (the default). Only the exact value "true" arms it.`,
    '',
    `    A configured ${CONFIRMATION_ENVELOPE_TOKEN_ENV} is not by itself evidence that`,
    '    the store is private. Run the operator preflight probe once against the',
    '    provisioned store before the writer is armed:',
    '',
    '      npm run envelope:probe',
    '',
  ].join('\n'),
);
process.exit(1);
