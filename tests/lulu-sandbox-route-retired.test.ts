import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Lulu sandbox web endpoint is retired and cannot mutate provider config or submit', () => {
  const src = readFileSync('src/app/api/lulu-sandbox-check/route.ts', 'utf8');
  assert.match(src, /isAdminAuthedFromRequest\(request\)/);
  assert.match(src, /lulu_sandbox_submission_retired/);
  assert.match(src, /status:\s*410/);
  assert.doesNotMatch(src, /process\.env\.|submitPrintJob|createOrderRecord|LULU_API_URL|POD_PACKAGE_ID/);
});
