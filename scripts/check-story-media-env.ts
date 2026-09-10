/**
 * Deploy-time contract for the Custom Story media lane.
 *
 * Runs as the first step of `npm run build`, which is the command Vercel
 * invokes for this project. On a Vercel PRODUCTION build it fails the build —
 * before deploy, loudly — when the private story-media Blob credential is
 * missing, blank, or names the same store as the public order credential.
 *
 * Why a build gate and not a runtime check: the regression this prevents was
 * silent. The code required an environment variable Production did not have,
 * the checkout controls quietly vanished, and nothing failed. A runtime gate is
 * what produced that outcome; it cannot also detect it.
 *
 * Everywhere else this is a no-op. A local `next build`, a CI build (the
 * workflow blanks `VERCEL`/`VERCEL_ENV`) and a Vercel Preview build all exit 0
 * without needing a single secret.
 *
 * The escape hatch is `HSB_STORY_MEDIA_INTENT=disabled`, and it is the only
 * one: an operator deliberately shipping Production without the media lane
 * says so explicitly.
 *
 * No token value is ever read into the output. The validator returns a problem
 * string that names the variable and the fault, never the value.
 */
import {
  STORY_MEDIA_INTENT_ENV,
  isVercelProductionBuild,
  storyMediaBuildContractProblem,
} from '../src/lib/story-media-store.ts';

const problem = storyMediaBuildContractProblem(process.env);

if (!problem) {
  if (isVercelProductionBuild(process.env)) {
    console.log('[story-media] Production build contract satisfied: private Blob store configured.');
  }
  process.exit(0);
}

console.error(
  [
    '',
    '  ✖ Vercel Production build refused: the Custom Story media lane is misconfigured.',
    '',
    `    ${problem}`,
    '',
    '    Customer voice notes and story documents must be written to a SEPARATE,',
    '    private Vercel Blob store. The public order store named by',
    '    BLOB_READ_WRITE_TOKEN rejects private writes and must not be reused.',
    '',
    '    Fix: set HSB_PRIVATE_READ_WRITE_TOKEN on the Production environment to a',
    '    read-write token for the private store.',
    '',
    `    To ship Production WITHOUT the Custom Story media lane, set ${STORY_MEDIA_INTENT_ENV}=disabled.`,
    '',
  ].join('\n'),
);
process.exit(1);
