/**
 * Shared editorial shell accessibility landmarks (inherited review P3).
 * EditorialPageShell must render the global <header> (banner) and <footer>
 * (contentinfo) as SIBLINGS of <main>, under a neutral wrapper — not nested
 * inside <main>, which would demote those landmarks. There must remain exactly
 * one header/main/footer per page, in document order header → main → footer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const editorialSrc = read('src/components/editorial-site.tsx');

// Capture the shell body, then strip line comments so prose that mentions
// element names (e.g. "the main region") can't create false structural matches.
const shellRaw = editorialSrc.match(/export function EditorialPageShell[\s\S]*?\n}/)?.[0] ?? '';
const shell = shellRaw.replace(/\/\/[^\n]*/g, '');

test('EditorialPageShell exists and wraps only children in <main>', () => {
  assert.notEqual(shell, '', 'EditorialPageShell must be defined');
  assert.match(shell, /<main[^>]*>\s*\{children\}\s*<\/main>/, 'main must wrap only {children}');
});

test('header precedes main and footer follows main (correct landmark order)', () => {
  assert.match(shell, /<EditorialHeader[\s\S]*<main[\s\S]*<\/main>[\s\S]*<EditorialFooter/, 'order must be header → main → footer');
});

test('neither header nor footer is nested inside <main>', () => {
  // Header must not appear after an opening <main>.
  assert.doesNotMatch(shell, /<main[^>]*>[\s\S]*<EditorialHeader/, 'header must not be nested inside main');
  // Footer must not appear before the closing </main>.
  assert.doesNotMatch(shell, /<EditorialFooter[\s\S]*<\/main>/, 'footer must not be nested inside main');
});

test('shell preserves page visuals on a neutral outer wrapper (not on main)', () => {
  assert.match(shell, /min-h-screen/, 'shell must preserve min-h-screen');
  assert.match(shell, /bg-\[#f8f0dd\]/, 'shell must preserve the cream background');
  // The visual wrapper is a neutral <div>, not <main>.
  assert.match(shell, /<div className="[^"]*min-h-screen[^"]*"/, 'outer wrapper must be a neutral div carrying the page background');
});

test('shell still renders the single shared header and footer components (no second implementation)', () => {
  assert.match(shell, /<EditorialHeader\b/);
  assert.match(shell, /<EditorialFooter\s*\/>/);
  // EditorialHeader renders a <header> and EditorialFooter a <footer> (the only ones).
  assert.match(editorialSrc, /function EditorialHeader[\s\S]*?<header/);
  assert.match(editorialSrc, /function EditorialFooter[\s\S]*?<footer/);
});
