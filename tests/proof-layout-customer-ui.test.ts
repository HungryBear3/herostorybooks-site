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

test('customer editor parses the full response contract and never fakes success', () => {
  // Response handling routes through the behavioral interpreter (which requires
  // ok===true + an adoptable snapshot, and fails a malformed 200) — not ad-hoc.
  assert.match(editor, /interpretLayoutMutationResponse\(/);
  // Snapshot adoption is stale-ordering-guarded through the shared coordinator.
  assert.match(editor, /applyIfCurrent\(token,/);
  // aria-live status + assertive error regions for accessibility.
  assert.match(editor, /aria-live="polite"/);
  assert.match(editor, /aria-live="assertive"/);
});

test('request-help keeps the editor open (no onCommitted/onClose) and adopts via applyIfCurrent', () => {
  // Isolate the requestHelp() body so the guard is bounded to that handler.
  const m = editor.match(/async function requestHelp\(\)[\s\S]*?\n {2}\}/);
  assert.ok(m, 'requestHelp() function block not found');
  const body = m![0];
  // Request-help does NOT invalidate the proof: adopt the snapshot in the parent
  // WITHOUT closing, and show an inline confirmation. Never close via commit/close.
  assert.match(body, /applyIfCurrent\(token,/);
  assert.match(body, /setStatus\(/);
  assert.doesNotMatch(body, /onCommitted\(/);
  assert.doesNotMatch(body, /onClose\(/);
});

test('customer editor controls are touch-safe (44px) and gestures use pointer capture + touch-none', () => {
  assert.match(editor, /h-11 w-11/);       // resize handle
  assert.match(editor, /min-h-11/);        // action buttons
  assert.match(editor, /touch-none/);      // gesture surfaces do not hijack scroll except mid-gesture
  assert.match(editor, /setPointerCapture/);
  assert.match(editor, /releasePointerCapture/);
});

test('B4: the resize handle is POINTER-ONLY and not keyboard-focusable (arrows cannot move the card via it)', () => {
  // Isolate the resize-handle element block.
  const m = editor.match(/data-testid="layout-resize-handle"[\s\S]{0,400}?data-testid="layout-resize-handle"|<span[\s\S]{0,600}?data-testid="layout-resize-handle"/);
  assert.ok(m, 'resize handle element not found');
  const block = m![0];
  // It must be a non-focusable, aria-hidden span — NOT a focusable button.
  assert.doesNotMatch(block, /<button[^>]*data-testid="layout-resize-handle"|type="button"[\s\S]{0,200}data-testid="layout-resize-handle"/);
  assert.match(block, /aria-hidden/);
  assert.doesNotMatch(block, /tabIndex/);
  assert.doesNotMatch(block, /onKeyDown/);
  // The card group remains the SOLE keyboard interface and documents Alt+Arrow resize.
  assert.match(editor, /role="group"[\s\S]{0,200}Alt with arrows to resize/);
  assert.match(editor, /tabIndex=\{0\}/);
  // The only keyboard resize path is the shared Alt handler on the card.
  assert.match(editor, /applyKeyboardGeometry\(geo, event\.key, \{ shift: event\.shiftKey, alt: event\.altKey \}\)/);
});

test('review-client mounts the editor gated on capability, keyed for remount, on the shared lock', () => {
  assert.match(client, /import CustomerProofLayoutEditor from '\.\/customer-proof-layout-editor'/);
  assert.match(client, /canOfferCustomerLayoutEditing\(snapshot\)/);
  assert.match(client, /key=\{editorIdentityKey\(/);
  // Editor + all parent mutations share ONE coordinator (B6).
  assert.match(client, /createReviewMutationCoordinator\(\)/);
  assert.match(client, /runMutation=\{runMutation\}/);
  assert.match(client, /applyIfCurrent=\{applyIfCurrent\}/);
  // Never the admin route from the customer surface.
  assert.doesNotMatch(client, /admin/);
});
