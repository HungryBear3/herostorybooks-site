// Next only looks for this convention file beside the app directory, so with
// src/app the root middleware.ts is never mounted on its own. This entry mounts
// that policy unchanged. The matcher stays a literal here because Next reads it
// statically from this file and will not follow a re-exported `config`.
export { middleware } from '../middleware.ts';

export const config = {
  matcher: ['/(.*)'],
};
