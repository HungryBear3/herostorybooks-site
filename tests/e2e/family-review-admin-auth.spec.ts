import { expect, test } from '@playwright/test';

const ADMIN_KEY = 'e2e-family-review-admin-key';

async function expectAdminListStatus(
  request: import('@playwright/test').APIRequestContext,
  status: number,
  cookie?: string,
) {
  const response = await request.get('/api/family-review/submissions?limit=1', {
    failOnStatusCode: false,
    headers: cookie ? { cookie } : undefined,
  });
  expect(response.status()).toBe(status);
}

test('invalid JSON shapes clear an authenticated Family Review admin session', async ({ request }) => {
  const login = await request.post('/api/family-review/admin/login', {
    data: { key: ADMIN_KEY },
    failOnStatusCode: false,
  });
  expect(login.status()).toBe(200);
  const sessionCookie = login.headers()['set-cookie']?.match(/fr_admin_session=[^;]+/)?.[0];
  expect(sessionCookie).toBeTruthy();
  await expectAdminListStatus(request, 200, sessionCookie);

  const invalid = await request.post('/api/family-review/admin/login', {
    data: 'null',
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie!,
    },
    failOnStatusCode: false,
  });
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()['cache-control']).toContain('no-store');
  expect(invalid.headers()['set-cookie']).toContain('fr_admin_session=;');
  expect(invalid.headers()['set-cookie']).toContain('Max-Age=0');
  await expect(invalid.json()).resolves.toEqual({ ok: false, error: 'invalid_body' });

  await expectAdminListStatus(request, 403);
});

test('missing or malformed key objects clear an authenticated admin session', async ({ request }) => {
  for (const body of [{}, { key: null }, { key: [] }]) {
    const login = await request.post('/api/family-review/admin/login', {
      data: { key: ADMIN_KEY },
      failOnStatusCode: false,
    });
    expect(login.status()).toBe(200);

    const invalid = await request.post('/api/family-review/admin/login', {
      data: body,
      failOnStatusCode: false,
    });
    expect(invalid.status()).toBe(401);
    expect(invalid.headers()['cache-control']).toContain('no-store');
    expect(invalid.headers()['set-cookie']).toContain('Max-Age=0');
    await expectAdminListStatus(request, 403);
  }
});
