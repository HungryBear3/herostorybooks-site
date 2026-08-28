/**
 * Module-resolve hook: every `import … from '@vercel/blob'` anywhere in
 * the process resolves to tests/helpers/blob-store-fake.mjs instead.
 *
 * Installed by blob-fake-register.mjs via `--import`. This is how the
 * two-store isolation harness exercises the REAL src/ modules — no
 * injected client, no seam added to production code for the benefit of
 * a test.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') {
    return {
      url: new URL('./blob-store-fake.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
