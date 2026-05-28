import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { getSiteOrigin, shouldIndexSite } from '../src/lib/site-url.ts';

test('site origin uses the concrete Vercel preview URL on preview deployments', () => {
  assert.equal(
    getSiteOrigin({
      VERCEL_ENV: 'preview',
      VERCEL_URL: 'herostorybooks-site-preview.vercel.app',
      NEXT_PUBLIC_URL: 'https://herostorybooks.com',
    } as NodeJS.ProcessEnv),
    'https://herostorybooks-site-preview.vercel.app',
  );
});

test('site origin falls back to production for production deployments', () => {
  assert.equal(
    getSiteOrigin({
      VERCEL_ENV: 'production',
      NEXT_PUBLIC_URL: 'https://herostorybooks.com/',
    } as NodeJS.ProcessEnv),
    'https://herostorybooks.com',
  );
});

test('robots policy indexes production only', () => {
  assert.equal(shouldIndexSite({ VERCEL_ENV: 'preview' } as NodeJS.ProcessEnv), false);
  assert.equal(shouldIndexSite({ VERCEL_ENV: 'development' } as NodeJS.ProcessEnv), false);
  assert.equal(shouldIndexSite({ VERCEL_ENV: 'production' } as NodeJS.ProcessEnv), true);
});

test('homepage and fathers-day pages force dynamic countdown rendering', () => {
  assert.match(readFileSync('src/app/page.tsx', 'utf8'), /dynamic\s*=\s*['"]force-dynamic['"]/);
  assert.match(readFileSync('src/app/fathers-day/page.tsx', 'utf8'), /dynamic\s*=\s*['"]force-dynamic['"]/);
});

test('Father’s Day route exists and uses proof-first copy', () => {
  const src = readFileSync('src/app/fathers-day/page.tsx', 'utf8');
  assert.match(src, /EditorialFathersDayPage/);
  assert.match(src, /proof-first|proof book|Digital PDF/i);
});
