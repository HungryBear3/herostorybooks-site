import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const layoutSource = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');

test('root layout loads the Google Analytics gtag script with the production measurement id', () => {
  assert.match(layoutSource, /G-68FKEDZEG3/);
  assert.match(layoutSource, /googletagmanager\.com\/gtag\/js\?id=\$\{googleAnalyticsMeasurementId\}/);
  assert.match(layoutSource, /gtag\('js', new Date\(\)\)/);
  assert.match(layoutSource, /gtag\('config', '\$\{googleAnalyticsMeasurementId\}'\)/);
});

test('shared analytics layer forwards HSB funnel events to gtag when available', () => {
  assert.match(analyticsSource, /typeof window\.gtag === 'function'/);
  assert.match(analyticsSource, /window\.gtag\('event', event, vercelSafeProps\(record\)\)/);
});
