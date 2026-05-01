/**
 * Repo-wide Tailwind v4 token regression coverage.
 *
 * The repo runs Tailwind v4 (`@import 'tailwindcss'` + `@theme inline`).
 * The legacy `tailwind.config.js` is NOT loaded via `@config`, so any
 * custom color token referenced by a JSX class but missing from
 * globals.css `@theme inline` silently renders with no style.
 *
 * This test scans every src/app + src/components file for utility
 * classes of the form `{prefix}-{token}` (with optional `/N` opacity)
 * and asserts each base token is defined in globals.css. Adding a new
 * custom-token class without adding the matching `--color-*` definition
 * fails this test before the regression hits prod.
 *
 * Tailwind built-in palettes (gray/red/blue/green/amber/emerald/etc.)
 * are excluded — they ship with Tailwind by default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const globalsCss = readFileSync(join(repoRoot, 'src/app/globals.css'), 'utf8');

// Every HSB-custom token name that has appeared in this repo. New
// tokens added to globals.css should be added here too — the test
// purely asserts that any of these used in code is also defined.
const HSB_CUSTOM_TOKENS = [
  'navy',
  'forest',
  'gold',
  'deep-gold',
  'peach',
  'cream',
  'lavender',
  'coral',
  'coral-dark',
  'purple',
];

const TOKEN_PREFIXES = [
  'bg', 'text', 'border', 'from', 'to', 'via', 'ring', 'outline',
  'fill', 'stroke', 'shadow', 'placeholder', 'caret', 'accent',
  'decoration', 'divide',
];

function escapeRe(s: string): string {
  return s.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}

function tokensUsedIn(source: string): Set<string> {
  const used = new Set<string>();
  for (const token of HSB_CUSTOM_TOKENS) {
    for (const prefix of TOKEN_PREFIXES) {
      const re = new RegExp(`\\b${prefix}-${escapeRe(token)}(?:\\/\\d+)?(?=\\b|[^a-zA-Z0-9-])`);
      if (re.test(source)) {
        used.add(token);
        break;
      }
    }
  }
  return used;
}

function tokenIsDefinedInTheme(token: string, css: string): boolean {
  const re = new RegExp(`--color-${escapeRe(token)}\\s*:`);
  return re.test(css);
}

const ROOTS = ['src/app', 'src/components'];

test('every HSB custom token used anywhere under src/app or src/components is defined in globals.css', () => {
  const allUsed = new Set<string>();
  const usageByToken: Record<string, string[]> = {};
  for (const rel of ROOTS) {
    const root = join(repoRoot, rel);
    let files: string[] = [];
    try { files = walk(root); } catch { /* root may not exist */ }
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const token of tokensUsedIn(src)) {
        allUsed.add(token);
        (usageByToken[token] ??= []).push(file.replace(repoRoot + '/', ''));
      }
    }
  }

  const missing: { token: string; files: string[] }[] = [];
  for (const token of allUsed) {
    if (!tokenIsDefinedInTheme(token, globalsCss)) {
      missing.push({ token, files: usageByToken[token].slice(0, 5) });
    }
  }

  if (missing.length > 0) {
    const detail = missing
      .map((m) => `  --color-${m.token} (used in: ${m.files.join(', ')}${m.files.length >= 5 ? ', …' : ''})`)
      .join('\n');
    assert.fail(`Custom tokens used in code but missing from globals.css @theme:\n${detail}`);
  }
});
