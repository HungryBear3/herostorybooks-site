/**
 * Runs the REAL root middleware.ts and reports the exact headers it puts
 * on a response.
 *
 * Every existing middleware test in this repo is a static-source
 * assertion, because `node --experimental-strip-types --test` cannot
 * resolve the `@/…` path alias middleware.ts imports (see the note in
 * tests/public-catalog-route.test.ts). A source regex cannot prove which
 * header a given pathname actually receives, which is exactly what
 * referrer containment needs to be pinned on.
 *
 * So: install a synchronous resolve hook that teaches this process the
 * two mappings the test runner is missing —
 *
 *   `@/x`         → <repo>/src/x{,.ts,.tsx,/index.ts}
 *   `next/server` → next/server.js (the subpath node resolution wants)
 *
 * — then dynamically import middleware.ts through it. registerHooks is
 * synchronous and in-thread, so it is already installed by the time this
 * module finishes evaluating, which is before any importer's body runs.
 * No production seam is added for the test's benefit; the real module
 * runs unmodified.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') {
      return nextResolve('next/server.js', context);
    }
    if (specifier.startsWith('@/')) {
      const base = resolvePath(ROOT, 'src', specifier.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const middlewareModule = await import(pathToFileURL(resolvePath(ROOT, 'middleware.ts')).href);
const nextServer = await import(
  pathToFileURL(resolvePath(ROOT, 'node_modules', 'next', 'server.js')).href
);

/**
 * Invoke the middleware for `url` and return its response headers as a
 * lower-cased plain object. Cookie-plumbing headers are dropped: they
 * are the cover-variant feature, not the privacy contract under test.
 */
export function headersFor(url, init) {
  const response = middlewareModule.middleware(
    new nextServer.NextRequest(new URL(url, 'https://herostorybooks.com'), init),
  );
  const out = {};
  for (const [key, value] of response.headers.entries()) {
    if (key === 'set-cookie' || key.startsWith('x-middleware-')) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}
