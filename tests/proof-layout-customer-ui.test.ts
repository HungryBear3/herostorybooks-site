/**
 * Bounded, mutation-proven source guards for the customer layout editor wiring
 * (there is no React DOM harness in this repo; the interaction/contract logic is
 * covered behaviourally by proof-layout-editor-core.test.ts and the real route
 * by proof-layout-route.test.ts — these guards lock the surface-specific wiring
 * that those cannot see). Each assertion is narrow and falsifiable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync('src/app/review/[orderId]/customer-proof-layout-editor.tsx', 'utf8');
const client = readFileSync('src/app/review/[orderId]/review-client.tsx', 'utf8');

test('customer editor calls ONLY the tokenized customer endpoint, never the admin route', () => {
  assert.match(editor, /customerProofLayoutUrl\(orderId, reviewToken\)/);
  assert.match(editor, /customerRequestHelpUrl\(orderId, reviewToken\)/);
  assert.doesNotMatch(editor, /\/api\/admin\//);
  assert.doesNotMatch(client, /\/api\/admin\//);
});

test('customer editor never sends appliedBy and never puts the token in the body', () => {
  assert.doesNotMatch(editor, /appliedBy/);
  // The token only reaches the URL via customerProofLayoutUrl/customerRequestHelpUrl;
  // it is never assembled into a JSON body here.
  assert.doesNotMatch(editor, /body:[\s\S]{0,120}token/);
});

test('customer editor adopts the authoritative snapshot and never fakes success', () => {
  assert.match(editor, /onCommitted\(data\.snapshot\)/);
  assert.match(editor, /did.?n.t return the updated proof state|didn’t return/);
  // aria-live status + assertive error regions for accessibility.
  assert.match(editor, /aria-live="polite"/);
  assert.match(editor, /aria-live="assertive"/);
});

test('customer editor controls are touch-safe (44px) and gestures use pointer capture + touch-none', () => {
  assert.match(editor, /h-11 w-11/);       // resize handle
  assert.match(editor, /min-h-11/);        // action buttons
  assert.match(editor, /touch-none/);      // gesture surfaces do not hijack scroll except mid-gesture
  assert.match(editor, /setPointerCapture/);
  assert.match(editor, /releasePointerCapture/);
});

test('review-client mounts the customer editor gated on eligibility, keyed for remount, adopting the snapshot', () => {
  assert.match(client, /import CustomerProofLayoutEditor from '\.\/customer-proof-layout-editor'/);
  assert.match(client, /canOfferCustomerLayoutEditing\(snapshot\)/);
  assert.match(client, /key=\{editorIdentityKey\(/);
  assert.match(client, /onCommitted=\{\(next: ReviewSnapshot\) =>\s*\{[\s\S]{0,80}setSnapshot\(next\)/);
  // Never the admin route from the customer surface.
  assert.doesNotMatch(client, /admin/);
});
