import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyUnauthedAdminOrdersResponse } from '../src/lib/admin-privacy-readiness.ts';

test('admin privacy readiness: 200 login shell is safe', () => {
  const result = classifyUnauthedAdminOrdersResponse({
    status: 200,
    body: '<form action="/api/admin/login"><h1>Ops sign-in</h1><input name="key" type="password" /></form>',
  });

  assert.equal(result.safe, true);
  assert.equal(result.verdict, 'safe_login_shell');
});

test('admin privacy readiness: 200 with order/customer data is unsafe', () => {
  const result = classifyUnauthedAdminOrdersResponse({
    status: 200,
    body: '<h1>Orders · Ops</h1><div>ord_live_123</div><div>customer_email: parent@example.com</div><div>paymentStatus: paid</div>',
  });

  assert.equal(result.safe, false);
  assert.equal(result.verdict, 'unsafe_exposed_data');
});

test('admin privacy readiness: redirects/denials are safe unauthenticated outcomes', () => {
  for (const status of [302, 307, 401, 403]) {
    const result = classifyUnauthedAdminOrdersResponse({ status, body: '' });
    assert.equal(result.safe, true, `status ${status}`);
  }
});


test('/admin/orders page keeps order loading behind the auth gate', () => {
  const src = readFileSync('src/app/admin/orders/page.tsx', 'utf8');
  const authIndex = src.indexOf('if (!authed) return <LoginCard');
  const listIndex = src.indexOf('listOrders()');
  assert.ok(authIndex >= 0, 'page should render login shell for unauthenticated users');
  assert.ok(listIndex >= 0, 'page should load orders for authenticated users');
  assert.ok(authIndex < listIndex, 'order/customer data load must happen after auth gate');
});
