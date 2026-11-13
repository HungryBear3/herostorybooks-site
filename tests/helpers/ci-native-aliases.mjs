// Resolution only: native Node strips TS; no compiler or diagnostics.
// Repo-relative: the checkout root is derived from this file, never hardcoded.
import { registerHooks } from 'node:module';
const root = new URL('../../', import.meta.url);
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('@/')) return next(new URL('src/' + specifier.slice(2) + '.ts', root).href, context);
  return next(specifier, context);
} });
