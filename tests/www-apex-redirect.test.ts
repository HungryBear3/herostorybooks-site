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

test('Vercel permanently redirects only the www host to the apex host while preserving the path', () => {
  const redirect = config.redirects?.find((candidate) =>
    candidate.has?.some(
      (condition) =>
        condition.type === 'host' && condition.value === 'www.herostorybooks.com',
    ),
  );

  assert.ok(redirect, 'expected a www.herostorybooks.com host redirect');
  assert.equal(redirect.source, '/:path*');
  assert.equal(redirect.destination, 'https://herostorybooks.com/:path*');
  assert.equal(redirect.permanent, true);
  assert.deepEqual(redirect.has, [
    { type: 'host', value: 'www.herostorybooks.com' },
  ]);
});
