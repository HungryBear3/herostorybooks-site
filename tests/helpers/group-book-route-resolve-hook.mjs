// Resolution-only hook for running real group-book route handlers under Node
// type stripping. The real @vercel/blob SDK is never loaded.
const faults = new URL('./group-book-blob-faults.mjs', import.meta.url).href;
const headers = new URL('./group-book-next-headers.mjs', import.meta.url).href;
const src = new URL('../../src/', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') return { url: faults, shortCircuit: true };
  if (specifier === 'next/headers') return { url: headers, shortCircuit: true };
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier.startsWith('@/')) {
    return { url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
