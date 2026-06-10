/**
 * Manual Fulfillment Factory — proof-release gate.
 *
 * isManifestProofReady() is the single source of truth for "may this order's
 * proof be released?". It must return true ONLY for a complete, QA-passed
 * manifest with no template-source artifacts. Every false path below is a
 * way a customer could otherwise receive an incomplete or template proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isManifestProofReady,
  type ArtifactRecord,
  type OrderArtifactManifest,
  type QAReportRecord,
} from '../src/lib/fulfillment-types.ts';

const BLOB = 'https://abc123.public.blob.vercel-storage.com';

function rec(
  source: ArtifactRecord['source'] = 'api_generated',
  url = `${BLOB}/artifact.bin`,
): ArtifactRecord {
  return { url, source, producedAt: '2026-06-10T00:00:00Z', producedBy: 'gpt-4o' };
}

function passingChecks(): QAReportRecord['checks'] {
  return {
    noTemplateSource: true,
    allPageImagesPresent: true,
    proofPdfPresent: true,
    artDirectionPacketPresent: true,
    proseFinalPresent: true,
  };
}

/** A fully complete, QA-passed, template-free manifest → proof ready. */
function completeManifest(): OrderArtifactManifest {
  return {
    schemaVersion: 1,
    orderId: 'ord_test',
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
    generatedBy: 'operator',
    storyBrief: rec('operator_upload'),
    pagePlan: rec('operator_upload'),
    proseFinal: rec('api_generated'),
    artDirectionPacket: rec('operator_upload'),
    pageImages: { 1: rec('api_generated'), 2: rec('api_generated') },
    proofPdf: rec('operator_upload', `${BLOB}/proof.pdf`),
    qaReport: {
      passed: true,
      reviewedAt: '2026-06-10T01:00:00Z',
      reviewedBy: 'alexy',
      notes: 'looks good',
      checks: passingChecks(),
    },
  };
}

// 1 + 2 — nullish input
test('null input → false', () => {
  assert.equal(isManifestProofReady(null), false);
});

test('undefined input → false', () => {
  assert.equal(isManifestProofReady(undefined), false);
});

// 3 — QA not passed
test('qaReport.passed = false → false', () => {
  const m = completeManifest();
  m.qaReport!.passed = false;
  assert.equal(isManifestProofReady(m), false);
});

// 4–7 — missing required fields
test('missing proofPdf → false', () => {
  const m = completeManifest();
  m.proofPdf = null;
  assert.equal(isManifestProofReady(m), false);
});

test('missing proseFinal → false', () => {
  const m = completeManifest();
  m.proseFinal = null;
  assert.equal(isManifestProofReady(m), false);
});

test('missing artDirectionPacket → false', () => {
  const m = completeManifest();
  m.artDirectionPacket = null;
  assert.equal(isManifestProofReady(m), false);
});

test('empty pageImages ({}) → false', () => {
  const m = completeManifest();
  m.pageImages = {};
  assert.equal(isManifestProofReady(m), false);
});

test('null pageImages → false', () => {
  const m = completeManifest();
  m.pageImages = null;
  assert.equal(isManifestProofReady(m), false);
});

// 8 + 9 — template-source artifacts block release
test("artifact source = 'template' → false", () => {
  const m = completeManifest();
  m.proseFinal = rec('template');
  assert.equal(isManifestProofReady(m), false);
});

test("artifact source = 'template_after_openai_failure' → false", () => {
  const m = completeManifest();
  m.pageImages = { 1: rec('template_after_openai_failure') };
  assert.equal(isManifestProofReady(m), false);
});

test("a template-source page image (mixed with good ones) → false", () => {
  const m = completeManifest();
  m.pageImages = { 1: rec('api_generated'), 2: rec('template') };
  assert.equal(isManifestProofReady(m), false);
});

// 10 — any individual QA check false while passed = true
for (const key of [
  'noTemplateSource',
  'allPageImagesPresent',
  'proofPdfPresent',
  'artDirectionPacketPresent',
  'proseFinalPresent',
] as const) {
  test(`qaReport.checks.${key} = false while passed = true → false`, () => {
    const m = completeManifest();
    m.qaReport!.checks[key] = false;
    assert.equal(isManifestProofReady(m), false);
  });
}

// 11 — the only true path
test('complete manifest, all checks true, no template sources, passed = true → true', () => {
  assert.equal(isManifestProofReady(completeManifest()), true);
});
