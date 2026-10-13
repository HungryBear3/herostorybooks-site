const fake = new URL('./group-book-blob-fake.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') return { url: fake, shortCircuit: true };
  return nextResolve(specifier, context);
}
