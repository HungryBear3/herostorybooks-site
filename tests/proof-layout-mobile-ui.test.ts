import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gridSource = readFileSync('src/app/admin/orders/[orderId]/page-review-grid.tsx', 'utf8');
const editorSource = readFileSync('src/app/admin/orders/[orderId]/proof-layout-editor.tsx', 'utf8');
const routeSource = readFileSync('src/app/api/admin/orders/[orderId]/proof-layout/route.ts', 'utf8');

test('open page editor spans the review grid instead of staying in a half-width mobile tile', () => {
  assert.match(gridSource, /layoutOpen[\s\S]{0,180}col-span-2[\s\S]{0,80}sm:col-span-3[\s\S]{0,80}lg:col-span-4/);
  assert.match(gridSource, /layoutOpen[\s\S]{0,240}sm:grid-cols-2/);
});

test('editor color controls wrap and drag targets are touch-safe', () => {
  assert.match(editorSource, /flex flex-wrap gap-1/);
  assert.match(editorSource, /onPointerDown=\{startMove\}[\s\S]{0,180}touch-none/);
  assert.match(editorSource, /onPointerDown=\{startResize\}[\s\S]{0,180}h-8 w-8[\s\S]{0,180}touch-none/);
});

test('story-only editor uses current binding names and consumes authoritative snapshot', () => {
  assert.match(editorSource, /authoredAgainstProofVersion:\s*proofVersion/);
  assert.match(editorSource, /authoredAgainstFingerprint:\s*sourceFingerprint/);
  assert.match(editorSource, /onCommitted\(data\.snapshot\)[\s\S]{0,120}onClose\(\)/);
  assert.doesNotMatch(editorSource, /dedication|washOpacity|proof-dedication-layout/i);
});

test('admin route authenticates before parsing and rejects incomplete geometry before mutation', () => {
  assert.ok(routeSource.indexOf('isAdminAuthedFromRequest(request)') < routeSource.indexOf('request.json()'));
  assert.ok(routeSource.indexOf('isCompleteProofCardGeometry(values.geometry)') < routeSource.indexOf('setProofLayoutOverride({'));
  assert.match(routeSource, /const textColor = values\.textColor;[\s\S]{0,80}textColor != null && !isProofTextColor\(textColor\)/);
  assert.ok(routeSource.indexOf('!isProofTextColor(textColor)') < routeSource.indexOf('setProofLayoutOverride({'));
  assert.match(routeSource, /actor:\s*INTERNAL_REVIEW_ACTOR/);
  assert.match(routeSource, /authoredAgainstProofVersion:\s*values\.authoredAgainstProofVersion/);
  assert.match(routeSource, /authoredAgainstFingerprint:\s*values\.authoredAgainstFingerprint/);
  assert.match(routeSource, /snapshot:\s*result\.snapshot/);
  assert.doesNotMatch(routeSource, /numberOrUndefined|proof-dedication-layout/);
});

test('editor remounts local draft state only when authoritative layout or proof identity changes', () => {
  assert.match(editorSource, /function proofLayoutEditorIdentity\([\s\S]*initialOverride[\s\S]*proofVersion[\s\S]*sourceFingerprint[\s\S]*proofFresh/);
  assert.match(editorSource, /<ProofLayoutEditorState[\s\S]{0,160}key=\{proofLayoutEditorIdentity\(props\)\}/);
  assert.doesNotMatch(editorSource, /key=\{JSON\.stringify\(props\)\}/);
});

test('grid clears local proof identity from the authoritative mutation snapshot', () => {
  assert.match(gridSource, /proofVersion:\s*snapshot\.proofVersion/);
  assert.match(gridSource, /sourceFingerprint:\s*snapshot\.proofSourceFingerprint/);
  assert.match(gridSource, /proofFresh:\s*snapshot\.proofFresh/);
});
