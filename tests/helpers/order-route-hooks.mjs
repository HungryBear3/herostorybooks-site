/**
 * Module-resolve hook for the `/api/order` route boundary.
 *
 * The route is the only file in the repo that imports through the `@/…`
 * tsconfig alias, which the node test runner does not resolve — that is why it
 * has never been importable under `node:test`. This hook resolves the alias to
 * the real `src/…​.ts` modules and swaps exactly three edges for journalling
 * fakes: `next/server`, `stripe`, and `@vercel/blob`. Plus `@/lib/orders`,
 * which re-exports the real module behind a journal.
 *
 * Installed by order-route-register.mjs via `--import`, following the same
 * pattern as blob-fake-hooks.mjs. No seam is added to production code.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SWAPS = {
  'next/server': './order-route-fakes/next-server.mjs',
  stripe: './order-route-fakes/stripe.mjs',
  '@vercel/blob': './order-route-fakes/blob.mjs',
  '@/lib/orders': './order-route-fakes/orders.mjs',
};

export async function resolve(specifier, context, nextResolve) {
  const swap = SWAPS[specifier];
  if (swap) return { url: new URL(swap, import.meta.url).href, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    // The alias resolves to a `.ts` file, or to a directory's `index.ts`
    // (`@/lib/custom-story`), exactly as the tsconfig paths mapping does.
    const base = new URL(`../../src/${specifier.slice(2)}`, import.meta.url);
    for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
      if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
    }
    throw new Error(`unresolved alias ${specifier}`);
  }
  return nextResolve(specifier, context);
}
