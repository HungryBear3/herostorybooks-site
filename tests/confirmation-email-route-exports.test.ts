import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as route from '../src/app/api/cron/confirmation-email-sweep/route.ts';
import {
  __resetConfirmationEmailSweepRouteDepsForTests,
  __setConfirmationEmailSweepRouteDepsForTests,
  getRouteDeps,
} from '../src/lib/confirmation-email-sweep-route-deps.ts';
import type { ConfirmationEmailSweepResult } from '../src/lib/confirmation-email-sweep.ts';

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(method: string, authorization?: string): Request {
  return new Request('https://example.test/api/cron/confirmation-email-sweep', {
    method,
    headers: authorization === undefined ? {} : { authorization },
  });
}

test.afterEach(() => {
  __resetConfirmationEmailSweepRouteDepsForTests();
});

test('the confirmation sweep route namespace contains only its Next public handlers and config', () => {
  assert.deepEqual(Object.keys(route).sort(), ['GET', 'POST', 'dynamic', 'maxDuration', 'runtime']);
  assert.equal(typeof route.GET, 'function');
  assert.equal(typeof route.POST, 'function');
  assert.equal(route.runtime, 'nodejs');
  assert.equal(route.dynamic, 'force-dynamic');
  assert.equal(route.maxDuration, 300);
});

test('both handlers deny before reading sweep dependencies or business configuration', async () => {
  __setConfirmationEmailSweepRouteDepsForTests({ runSweep: async () => { throw new Error('must not run'); } });
  let dependencyReads = 0;
  Object.defineProperty(getRouteDeps(), 'runSweep', {
    get() {
      dependencyReads += 1;
      throw new Error('unauthorized dependency access');
    },
  });

  for (const [secret, authorization, status] of [
    [undefined, undefined, 503],
    ['route-test-secret', undefined, 401],
    ['route-test-secret', 'Bearer wrong-secret', 401],
  ] as const) {
    await withEnv({ CRON_SECRET: secret }, async () => {
      const ambient = process.env;
      const businessReads: string[] = [];
      process.env = new Proxy(ambient, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^(HSB_|BLOB_|RESEND_)/.test(key)) businessReads.push(key);
          return Reflect.get(target, key, receiver);
        },
      });
      try {
        for (const method of ['GET', 'POST'] as const) {
          const response = await route[method](request(method, authorization));
          assert.equal(response.status, status);
          assert.deepEqual(await response.json(), { ok: false });
        }
      } finally {
        process.env = ambient;
      }
      assert.deepEqual(businessReads, []);
    });
  }
  assert.equal(dependencyReads, 0);
});

test('the shared helper injects both handlers and preserves success and failure response semantics', async () => {
  await withEnv({ CRON_SECRET: 'route-test-secret' }, async () => {
    for (const ok of [true, false]) {
      const result: ConfirmationEmailSweepResult = {
        ok, scanned: 7, eligible: 6, sent: 1, skipped: 2, blocked: 1, failed: ok ? 0 : 1,
        snapshotted: 1, held: 1, deferred: 0, reaped: 2, reapDeferred: 0,
      };
      let calls = 0;
      const runSweep = async () => { calls += 1; return result; };
      __setConfirmationEmailSweepRouteDepsForTests({ runSweep });
      assert.equal(getRouteDeps().runSweep, runSweep);
      for (const method of ['GET', 'POST'] as const) {
        const response = await route[method](request(method, 'Bearer route-test-secret'));
        assert.equal(response.status, ok ? 200 : 500);
        assert.equal(response.headers.get('content-type'), 'application/json');
        assert.deepEqual(await response.json(), {
          ok, scanned: 7, eligible: 6, sent: 1, skipped: 2, blocked: 1, failed: ok ? 0 : 1,
        });
      }
      assert.equal(calls, 2);
    }
  });
});

test('reset and an empty override restore the lazy default sweep with no sends on an empty local store', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-route-exports-'));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected network transport'); };
  try {
    await withEnv({
      CRON_SECRET: 'route-test-secret',
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      HSB_ORDER_STORE_DIR: dir,
      BLOB_READ_WRITE_TOKEN: undefined,
      VERCEL: undefined,
      NODE_ENV: 'development',
      HSB_CONFIRMATION_ENVELOPE_WRITER: undefined,
      HSB_CONFIRMATION_FROZEN_DISPATCH: undefined,
    }, async () => {
      const injected = async (): Promise<never> => { throw new Error('reset left an override behind'); };
      __setConfirmationEmailSweepRouteDepsForTests({ runSweep: injected });
      __resetConfirmationEmailSweepRouteDepsForTests();
      assert.notEqual(getRouteDeps().runSweep, injected);

      for (const emptyOverride of [false, true]) {
        if (emptyOverride) __setConfirmationEmailSweepRouteDepsForTests({});
        for (const method of ['GET', 'POST'] as const) {
          const response = await route[method](request(method, 'Bearer route-test-secret'));
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            ok: true, scanned: 0, eligible: 0, sent: 0, skipped: 0, blocked: 0, failed: 0,
          });
        }
      }
      assert.deepEqual(readdirSync(dir), [], 'the empty default sweep writes no order state');
      assert.equal(fetchCalls, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
