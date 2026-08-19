import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const sitemapSource = read('src/app/sitemap.ts');
const middlewareSource = read('middleware.ts');

const canonicalPages: Array<[string, RegExp]> = [
  ['src/app/page.tsx', /alternates:\s*{\s*canonical:\s*['"]\/['"]/s],
  ['src/app/samples/page.tsx', /alternates:\s*{\s*canonical:\s*['"]\/samples['"]/s],
  ['src/app/about/page.tsx', /alternates:\s*{\s*canonical:\s*['"]\/about['"]/s],
  ['src/app/privacy/page.tsx', /alternates:\s*{\s*canonical:\s*['"]\/privacy['"]/s],
  ['src/app/terms/page.tsx', /alternates:\s*{\s*canonical:\s*['"]\/terms['"]/s],
  ['src/app/gifts/page.tsx', /alternates:\s*{\s*canonical:\s*['"]\/gifts['"]/s],
];

test('about route uses the existing editorial About page and has unique index metadata', () => {
  const path = new URL('../src/app/about/page.tsx', import.meta.url);
  assert.equal(existsSync(path), true, '/about route must exist');
  const source = readFileSync(path, 'utf8');
  assert.match(source, /EditorialAboutPage/);
  assert.match(source, /About HeroStoryBooks \| Personalized Books Made With Care/);
  assert.match(source, /alternates:\s*{\s*canonical:\s*['"]\/about['"]/s);
});

test('sitemap lists every intentional public index route and excludes operational routes', () => {
  for (const path of ['/samples', '/about', '/privacy', '/terms', '/gifts']) {
    assert.match(sitemapSource, new RegExp(`\\$\\{origin\\}${path.replace('/', '\\/')}`), `missing ${path}`);
  }
  assert.match(sitemapSource, /GIFT_OCCASIONS/);
  assert.match(sitemapSource, /GIFT_OCCASIONS\.map/);
  for (const path of ['/checkout', '/order', '/thank-you', '/review', '/status', '/admin', '/api']) {
    assert.doesNotMatch(sitemapSource, new RegExp(path.replace('/', '\\/')));
  }
});

test('every public index page declares a self-canonical and unique legal titles', () => {
  for (const [path, canonical] of canonicalPages) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `${path} must exist`);
    assert.match(read(path), canonical, `${path} must declare its self-canonical`);
  }

  const giftDetailSource = read('src/app/gifts/[occasion]/page.tsx');
  assert.match(giftDetailSource, /alternates:\s*{\s*canonical:\s*`\/gifts\/\$\{occasion\.id\}`/s);
  assert.match(read('src/app/privacy/page.tsx'), /Privacy Policy \| HeroStoryBooks/);
  assert.match(read('src/app/terms/page.tsx'), /Terms of Service \| HeroStoryBooks/);
});

test('homepage social metadata does not leak into child routes', () => {
  const rootLayoutSource = read('src/app/layout.tsx');
  const homeSource = read('src/app/page.tsx');

  assert.doesNotMatch(rootLayoutSource, /\bopenGraph\s*:/);
  assert.doesNotMatch(rootLayoutSource, /\btwitter\s*:/);
  assert.match(homeSource, /\bopenGraph\s*:/);
  assert.match(homeSource, /url:\s*['"]https:\/\/herostorybooks\.com['"]/);
  assert.match(homeSource, /\btwitter\s*:/);
});

test('gift index carries route-owned OG/Twitter metadata matching its canonical', () => {
  const giftIndex = read('src/app/gifts/page.tsx');
  assert.match(giftIndex, /import\s*\{[^}]*\bPRODUCTION_ORIGIN\b[^}]*\}\s*from\s*['"]@\/lib\/site-url['"]/);
  assert.match(giftIndex, /openGraph:\s*\{/);
  assert.match(giftIndex, /url:\s*`\$\{PRODUCTION_ORIGIN\}\/gifts`/);
  assert.match(giftIndex, /siteName:\s*['"]HeroStoryBooks['"]/);
  assert.match(giftIndex, /locale:\s*['"]en_US['"]/);
  assert.match(giftIndex, /type:\s*['"]website['"]/);
  assert.match(giftIndex, /images:\s*\[\s*\{[^}]*url:\s*['"]\/assets\/og-social-share\.png['"][^}]*width:\s*1200[^}]*height:\s*630[^}]*\}/s);
  assert.match(giftIndex, /twitter:\s*\{/);
  assert.match(giftIndex, /card:\s*['"]summary_large_image['"]/);
});

test('gift occasion detail carries route-owned OG/Twitter metadata sourced from the occasion and preserves the {} fallback', () => {
  const giftDetail = read('src/app/gifts/[occasion]/page.tsx');
  assert.match(giftDetail, /import\s*\{[^}]*\bPRODUCTION_ORIGIN\b[^}]*\}\s*from\s*['"]@\/lib\/site-url['"]/);
  assert.match(giftDetail, /if \(!occasion\) return \{\};/, 'unknown occasion must still short-circuit to an empty metadata object');
  assert.match(giftDetail, /openGraph:\s*\{/);
  assert.match(giftDetail, /url:\s*`\$\{PRODUCTION_ORIGIN\}\/gifts\/\$\{occasion\.id\}`/);
  assert.match(giftDetail, /siteName:\s*['"]HeroStoryBooks['"]/);
  assert.match(giftDetail, /locale:\s*['"]en_US['"]/);
  assert.match(giftDetail, /type:\s*['"]website['"]/);
  assert.match(giftDetail, /images:\s*\[\s*\{[^}]*url:\s*['"]\/assets\/og-social-share\.png['"][^}]*width:\s*1200[^}]*height:\s*630[^}]*\}/s);
  assert.match(giftDetail, /twitter:\s*\{/);
  assert.match(giftDetail, /card:\s*['"]summary_large_image['"]/);
});

test('gift index is internally linked from the current editorial surface', () => {
  const editorialSource = read('src/components/editorial-site.tsx');
  assert.match(editorialSource, /['"]Gift ideas['"]\s*,\s*['"]\/gifts['"]/);
});

test('public editorial identity says Chicago and contains no stale California claim', () => {
  const editorialSource = read('src/components/editorial-site.tsx');
  assert.match(editorialSource, /small (?:independent )?team in Chicago/i);
  assert.doesNotMatch(editorialSource, /California/i);
});

test('operational and customer-specific pages receive response-level noindex headers', () => {
  assert.match(middlewareSource, /OPERATIONAL_NOINDEX_PATH/);
  for (const path of ['admin', 'api', 'checkout', 'order', 'partner', 'review', 'status', 'thank-you']) {
    assert.match(middlewareSource, new RegExp(path));
  }
  assert.match(middlewareSource, /X-Robots-Tag['"],\s*['"]noindex, nofollow, noarchive, nosnippet/);
  assert.doesNotMatch(
    middlewareSource,
    /if \(existing\) return NextResponse\.next\(\);/,
    'cookie fast-path must not bypass operational noindex headers',
  );
});
