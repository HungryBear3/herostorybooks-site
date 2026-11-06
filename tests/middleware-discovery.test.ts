/**
 * Proves the installed Next discovers a middleware entry at all. With src/app,
 * Next scans src/ for the convention file, so the root middleware.ts alone was
 * never mounted and every policy test passed against an unmounted module.
 *
 * No server and no network: this drives Next's own discovery and static-info
 * helpers over the real files. The `rootPaths` steps mirror the inline scan in
 * next/dist/build/index.js, which Next does not export. Whether the entry truly
 * reaches the build manifest and HTTP is proved by the mounted gates, not here.
 */
import './helpers/middleware-harness.mjs';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireNext = createRequire(import.meta.url);

const { findPagesDir } = requireNext('next/dist/lib/find-pages-dir.js');
const { getFilesInDir } = requireNext('next/dist/lib/get-files-in-dir.js');
const { MIDDLEWARE_FILENAME, PROXY_FILENAME } = requireNext('next/dist/lib/constants.js');
const { PAGE_TYPES } = requireNext('next/dist/lib/page-types.js');
const { createPagesMapping } = requireNext('next/dist/build/route-discovery.js');
const { getPageStaticInfo } = requireNext('next/dist/build/analysis/get-page-static-info.js');
const { isMiddlewareFile } = requireNext('next/dist/build/utils.js');
const { loadBindings } = requireNext('next/dist/build/swc/index.js');
const { defaultConfig } = requireNext('next/dist/server/config-shared.js');

const nextConfig = { ...defaultConfig, ...requireNext('../next.config.js') };

test('installed Next selects src/middleware.ts as the only middleware entry', async () => {
  const { appDir, pagesDir } = findPagesDir(ROOT);
  const rootDir = path.join(pagesDir || appDir, '..');
  assert.equal(rootDir, path.join(ROOT, 'src'), 'src/app moves the convention level to src/');

  const extensions = nextConfig.pageExtensions.join('|');
  const conventions = [MIDDLEWARE_FILENAME, PROXY_FILENAME].map((name) => new RegExp(`^${name}\\.(?:${extensions})$`));
  const rootPaths = Array.from(await getFilesInDir(rootDir) as Set<string>)
    .filter((file) => conventions.some((convention) => convention.test(file)))
    .map((file) => path.join(rootDir, file).replace(ROOT, ''));
  assert.deepEqual(rootPaths, ['/src/middleware.ts'], 'exactly one convention file, and no proxy to conflict with it');

  const mapping = await createPagesMapping({
    isDev: false,
    pageExtensions: nextConfig.pageExtensions,
    pagePaths: rootPaths,
    pagesType: PAGE_TYPES.ROOT,
    pagesDir,
    appDir,
    appDirOnly: true,
  });
  assert.deepEqual(Object.keys(mapping), ['/src/middleware']);
  assert.equal(isMiddlewareFile('/src/middleware'), true);
});

test('installed Next extracts the literal matcher from src/middleware.ts statically', async () => {
  // Offline: the lockfile patcher can fetch and rewrite, and the wasm fallback can download.
  process.env.NEXT_IGNORE_INCORRECT_LOCKFILE = '1';
  process.env.NEXT_DISABLE_SWC_WASM = '1';
  await loadBindings();

  // isDev: false makes Next throw if it cannot see the `middleware` export.
  const info = await getPageStaticInfo({
    pageFilePath: path.join(ROOT, 'src', 'middleware.ts'),
    nextConfig,
    isDev: false,
    page: '/src/middleware',
    pageType: PAGE_TYPES.ROOT,
  });
  assert.equal(info.hadUnsupportedValue, false, 'config is statically analyzable');
  const matchers = info.middleware.matchers;
  assert.deepEqual(matchers.map((matcher: { originalSource: string }) => matcher.originalSource), ['/(.*)']);

  const matcher = new RegExp(matchers[0].regexp);
  for (const pathname of ['/', '/group-book/sign-in', '/status/ord_synthetic', '/api/admin/group-book/checkout.png', '/_next/static/chunks/app.js']) {
    assert.match(pathname, matcher, `${pathname} reaches the middleware`);
  }
});

test('src/middleware.ts delegates to the root policy with nothing in between', async () => {
  const root = await import('../middleware.ts');
  const entry = await import('../src/middleware.ts');
  assert.equal(entry.middleware, root.middleware, 'the very same function, so no bypass can sit in front of it');
  assert.deepEqual(entry.config, root.config, 'mounted matcher equals the policy matcher');
  assert.deepEqual(Object.keys(entry).sort(), ['config', 'middleware']);
});
