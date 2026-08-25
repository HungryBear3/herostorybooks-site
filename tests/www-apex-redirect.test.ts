import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type VercelRedirect = {
  source?: string;
  destination?: string;
  permanent?: boolean;
  has?: Array<{ type?: string; value?: string }>;
};

type VercelConfig = {
  redirects?: VercelRedirect[];
};

const config = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
) as VercelConfig;

const wwwHostCondition = [
  { type: 'host', value: 'www.herostorybooks.com' },
];

test('Vercel permanently redirects the www root and deep paths to the apex host', () => {
  const redirects = config.redirects ?? [];
  const rootRedirect = redirects.find(
    (candidate) =>
      candidate.source === '/' &&
      JSON.stringify(candidate.has) === JSON.stringify(wwwHostCondition),
  );
  const pathRedirect = redirects.find(
    (candidate) =>
      candidate.source === '/:path*' &&
      JSON.stringify(candidate.has) === JSON.stringify(wwwHostCondition),
  );

  assert.ok(rootRedirect, 'expected an explicit www root redirect');
  assert.equal(rootRedirect.destination, 'https://herostorybooks.com/');
  assert.equal(rootRedirect.permanent, true);

  assert.ok(pathRedirect, 'expected a www wildcard path redirect');
  assert.equal(pathRedirect.destination, 'https://herostorybooks.com/:path*');
  assert.equal(pathRedirect.permanent, true);

  assert.ok(
    redirects.indexOf(rootRedirect) < redirects.indexOf(pathRedirect),
    'the exact root redirect must be evaluated before the wildcard redirect',
  );
});
