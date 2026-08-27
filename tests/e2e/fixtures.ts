/**
 * Shared fixtures for the customer text-placement editor e2e suite.
 *
 * Every test gets its OWN freshly-seeded synthetic order id. That is not just
 * hygiene: the server keeps an in-process read-your-own-writes cache
 * (`recentConditionalCommits`), so re-seeding an order the server has already
 * committed to would hand the test a stale read. Unique ids per test keep each
 * case deterministic and let files run fully in parallel.
 */
import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { E2E_STORE_DIR } from '../../playwright.config.ts';
import type { SeedSpec, FixtureState } from './seed-cli.ts';

export const REPO_ROOT = process.cwd();
const SEED_CLI = path.join(REPO_ROOT, 'tests', 'e2e', 'seed-cli.ts');

export interface SeededOrder {
  orderId: string;
  token: string;
  proofVersion: string;
  proofSourceFingerprint: string;
}

function runSeeder(args: string[]): string {
  mkdirSync(E2E_STORE_DIR, { recursive: true });
  return execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', SEED_CLI, ...args],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, HSB_ORDER_STORE_DIR: E2E_STORE_DIR } },
  );
}

/** Bounded geometry well inside every server rule — the "known good" card. */
export const ROOMY = { x: 0.1, y: 0.12, width: 0.6, height: 0.3, opacity: 0.9, fontScale: 1 };

/** Mirrors PROOF_CARD_BOUNDS in src/lib/proof-layout-override.ts. */
export const BOUNDS = {
  width: { min: 0.15, max: 0.9 },
  height: { min: 0.06, max: 0.5 },
  opacity: { min: 0.35, max: 0.92 },
  fontScale: { min: 0.85, max: 1.15 },
} as const;
export const SAFE_MARGIN = 0.05;
export const FOLIO_RESERVE = 0.06;

export interface EditorFixtures {
  /** Seed a synthetic order and return its identity + capability token. */
  seed: (spec?: Partial<SeedSpec> & { state?: FixtureState }) => SeededOrder;
  /** Read an order back out of the local store (assert persistence / no-mutation). */
  readOrder: (orderId: string) => any;
  /** Open the tokenized review surface for a seeded order. */
  gotoReview: (order: SeededOrder, page: Page) => Promise<void>;
  /** Open the review surface AND the layout editor, returning when it is interactive. */
  openEditor: (order: SeededOrder, page: Page) => Promise<void>;
  /** POST directly to a customer route, bypassing the UI entirely. */
  api: (
    request: APIRequestContext,
    route: 'proof-layout' | 'request-help' | 'proof-fit',
    orderId: string,
    body: unknown,
    token: string | null,
  ) => Promise<{ status: number; body: any }>;
}

let seq = 0;

export const test = base.extend<EditorFixtures>({
  seed: async ({}, use, testInfo) => {
    const made: string[] = [];
    await use((spec = {}) => {
      seq += 1;
      // Unique per test AND per worker so parallel runs never collide.
      const id = spec.id
        ?? `ord_e2e_${testInfo.workerIndex}_${process.pid}_${seq}`;
      const out = runSeeder(['seed', JSON.stringify({ ...spec, id })]);
      const parsed = JSON.parse(out) as SeededOrder;
      made.push(parsed.orderId);
      return parsed;
    });
  },

  readOrder: async ({}, use) => {
    await use((orderId: string) => JSON.parse(runSeeder(['read', orderId])));
  },

  gotoReview: async ({}, use) => {
    await use(async (order, page) => {
      // Arrive as a visitor who has already answered the consent banner.
      // Without this the banner is fixed to the foot of the viewport and can
      // sit over the layout editor's resize handle, so a pointer drag lands on
      // the banner instead of the handle. Declining is the conservative choice:
      // it keeps every optional analytics destination off for these tests, and
      // it is the state a privacy-minded customer would be in.
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem(
            'hsb:consent:v1',
            JSON.stringify({ v: 1, c: 'denied', at: 1_700_000_000_000 }),
          );
        } catch {
          /* storage unavailable: the banner shows, which the specs tolerate */
        }
      });
      await page.goto(`/review/${order.orderId}?token=${order.token}`);
      await expect(page.getByTestId('review-scope-banner')).toBeVisible();
    });
  },

  openEditor: async ({ gotoReview }, use) => {
    await use(async (order, page) => {
      await gotoReview(order, page);
      await page.getByTestId('open-layout-editor').click();
      await expect(page.getByTestId('customer-layout-editor')).toBeVisible();
      // The Save button self-labels "Checking fit…" until the AUTHORITATIVE fit
      // route answers. Waiting on that label is state-based, not timing-based.
      await expect(page.getByTestId('layout-save')).not.toHaveText(/Checking fit/);
    });
  },

  api: async ({}, use) => {
    await use(async (request, route, orderId, body, token) => {
      const qs = token == null ? '' : `?token=${encodeURIComponent(token)}`;
      const res = await request.post(`/api/order/${orderId}/${route}${qs}`, {
        data: body as any,
        headers: { 'content-type': 'application/json' },
        failOnStatusCode: false,
      });
      let parsed: any = null;
      try { parsed = await res.json(); } catch { parsed = null; }
      return { status: res.status(), body: parsed };
    });
  },
});

export { expect };

/** Binding envelope the server requires on every apply/reset/fit. */
export const bindingOf = (o: SeededOrder) => ({
  authoredAgainstProofVersion: o.proofVersion,
  authoredAgainstFingerprint: o.proofSourceFingerprint,
});

/** The override actually persisted on page 0, or null. */
export const overrideOf = (order: any, pageIndex = 0) =>
  order?.pageArtifacts?.[pageIndex]?.proofCardOverride ?? null;
