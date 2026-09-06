/**
 * Module-resolve hook for the `/api/order` route boundary.
 *
 * The route is the only file in the repo that imports through the `@/…`
 * tsconfig alias, which the node test runner does not resolve — that is why it
 * has never been importable under `node:test`. This hook resolves the alias to
 * the real `src/…​.ts` modules and swaps exactly three edges for journalling
 * fakes: `next/server`, `stripe`, and `@vercel/blob`. Plus `src/lib/orders.ts`,
 * which re-exports the real module behind a journal.
 *
 * The orders swap is keyed on the RESOLVED file, not on the `@/lib/orders`
 * specifier, because the route is now a thin adapter over
 * `checkout-order-route-handler.ts` and that handler — like every other module
 * in the checkout graph — reaches the durable order surface through the
 * relative `./orders.ts`. Keyed on the specifier alone the journal would only
 * ever see the handful of calls the adapter itself makes, and "the refusal
 * landed before `createOrderRecord`" would be vacuously true for every request.
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
};

const ORDERS_MODULE = new URL('../../src/lib/orders.ts', import.meta.url).href;
const ORDERS_FAKE = new URL('./order-route-fakes/orders.mjs', import.meta.url).href;

/** The journalled orders module, except for the fake's own import of the real one. */
function withOrdersSwap(resolved, context) {
  if (resolved?.url !== ORDERS_MODULE) return resolved;
  if (context?.parentURL === ORDERS_FAKE) return resolved;
  return { url: ORDERS_FAKE, shortCircuit: true };
}

export async function resolve(specifier, context, nextResolve) {
  const swap = SWAPS[specifier];
  if (swap) return { url: new URL(swap, import.meta.url).href, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    // The alias resolves to a `.ts` file, or to a directory's `index.ts`
    // (`@/lib/custom-story`), exactly as the tsconfig paths mapping does.
    const base = new URL(`../../src/${specifier.slice(2)}`, import.meta.url);
    for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
      if (existsSync(fileURLToPath(candidate))) {
        return withOrdersSwap({ url: candidate, shortCircuit: true }, context);
      }
    }
    throw new Error(`unresolved alias ${specifier}`);
  }
  return withOrdersSwap(await nextResolve(specifier, context), context);
}
