/*
 * The intake cleanup route only reclaims unpaid buyer media if something
 * actually calls it. `vercel.json` is the only thing that does, so the
 * schedule is part of the retention guarantee, not deployment trivia:
 * an unscheduled sweep means private pre-payment media is retained forever.
 *
 * This also pins the fulfillment sweep, because adding a cron entry is
 * exactly the edit most likely to drop a neighbouring one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type VercelCron = { path?: string; schedule?: string };
type VercelConfig = { crons?: VercelCron[] };

const config = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
) as VercelConfig;

const CLEANUP_PATH = '/api/cron/checkout-intake-cleanup';

function cronFor(path: string): VercelCron | undefined {
  return (config.crons ?? []).find((candidate) => candidate.path === path);
}

test('the checkout intake cleanup route is scheduled', () => {
  const cleanup = cronFor(CLEANUP_PATH);
  assert.ok(cleanup, `expected a cron entry for ${CLEANUP_PATH}`);
  assert.equal(typeof cleanup.schedule, 'string');
});

test('the cleanup sweep runs at most once a day', () => {
  const schedule = cronFor(CLEANUP_PATH)?.schedule ?? '';
  const fields = schedule.trim().split(/\s+/);
  assert.equal(fields.length, 5, `expected a 5-field cron expression, got ${schedule}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];

  // A daily cadence is the conservative option that every Vercel plan
  // supports. Anything sub-daily has to be an explicit, separate decision.
  assert.match(minute, /^\d{1,2}$/, 'the minute must be a single fixed value');
  assert.match(hour, /^\d{1,2}$/, 'the hour must be a single fixed value');
  assert.equal(dayOfMonth, '*');
  assert.equal(month, '*');
  assert.equal(dayOfWeek, '*');
});

test('the cleanup sweep does not collide with the fulfillment sweep tick', () => {
  const fulfillment = cronFor('/api/cron/fulfillment-sweep');
  assert.ok(fulfillment, 'the fulfillment sweep must not be removed or renamed');
  assert.equal(fulfillment.schedule, '*/10 * * * *');

  const cleanupMinute = Number((cronFor(CLEANUP_PATH)?.schedule ?? '').trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(cleanupMinute), 'the cleanup minute must be a fixed integer');
  assert.notEqual(cleanupMinute % 10, 0, 'do not stack the cleanup sweep on a fulfillment-sweep tick');
});

test('every scheduled path resolves to a route in this repo', () => {
  for (const cron of config.crons ?? []) {
    assert.ok(cron.path, 'every cron entry needs a path');
    const routeUrl = new URL(`../src/app${cron.path}/route.ts`, import.meta.url);
    assert.doesNotThrow(
      () => readFileSync(routeUrl, 'utf8'),
      `no route handler backs the scheduled path ${cron.path}`,
    );
  }
});

test('the scheduled cleanup route is auth-gated and fails closed', () => {
  const src = readFileSync(
    new URL(`../src/app${CLEANUP_PATH}/route.ts`, import.meta.url),
    'utf8',
  );
  // The route must refuse before it reads any intake state.
  assert.match(src, /evaluateCronAuth\(/, 'the route must evaluate cron auth');
  assert.match(
    src,
    /if \(denied !== null\) return Response\.json\([^)]*\{ status: denied \}\)/,
    'a denied auth evaluation must short-circuit the handler',
  );
  // Deleting buyer media is gated on the direct-upload server flag, which is
  // default-OFF; the route reports the skip rather than sweeping.
  assert.match(src, /isDirectUploadServerEnabled\(/, 'the route must respect the direct-upload flag');
  assert.ok(
    src.indexOf('evaluateCronAuth(') < src.indexOf('runCheckoutIntakeCleanup('),
    'auth must be evaluated before any cleanup run',
  );
});
