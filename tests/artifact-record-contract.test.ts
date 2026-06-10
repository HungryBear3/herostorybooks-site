/**
 * Manual Fulfillment Factory — ArtifactRecord contract.
 *
 * Every artifact in the manifest is a Blob URL reference + metadata; the
 * 'source' field is the trust signal. These tests pin the contract:
 *   - a Blob-backed operator upload is a valid record
 *   - a template source anywhere blocks proof-ready (regression guard)
 *   - an all-api_generated manifest is allowed through
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isManifestProofReady,
  type ArtifactRecord,
  type OrderArtifactManifest,
} from '../src/lib/fulfillment-types.ts';

const BLOB = 'https://abc123.public.blob.vercel-storage.com';

function rec(
  source: ArtifactRecord['source'],
  url = `${BLOB}/artifact.bin`,
): ArtifactRecord {
  return { url, source, producedAt: '2026-06-10T00:00:00Z', producedBy: 'operator' };
}

function manifestWith(opts: {
  proseSource?: ArtifactRecord['source'];
  pageSource?: ArtifactRecord['source'];
}): OrderArtifactManifest {
  const proseSource = opts.proseSource ?? 'api_generated';
  const pageSource = opts.pageSource ?? 'api_generated';
  return {
    schemaVersion: 1,
    orderId: 'ord_contract',
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
    generatedBy: 'mixed',
    storyBrief: rec('operator_upload'),
    pagePlan: rec('operator_upload'),
    proseFinal: rec(proseSource),
    artDirectionPacket: rec('operator_upload'),
    pageImages: { 1: rec(pageSource), 2: rec('api_generated') },
    proofPdf: rec('operator_upload', `${BLOB}/proof.pdf`),
    qaReport: {
      passed: true,
      reviewedAt: '2026-06-10T01:00:00Z',
      reviewedBy: 'alexy',
      notes: '',
      checks: {
        noTemplateSource: true,
        allPageImagesPresent: true,
        proofPdfPresent: true,
        artDirectionPacketPresent: true,
        proseFinalPresent: true,
      },
    },
  };
}

// 1 — a valid Blob URL + operator_upload source is a well-formed record
test('a record with a blob.vercel-storage.com URL and source=operator_upload is valid', () => {
  const r = rec('operator_upload', `${BLOB}/cover.png`);
  assert.match(r.url, /\.blob\.vercel-storage\.com\//);
  assert.equal(r.source, 'operator_upload');
  assert.equal(typeof r.producedAt, 'string');
  assert.equal(typeof r.producedBy, 'string');
});

// 2 — template source anywhere blocks proof ready (regression guard)
test('source=template on the prose artifact blocks proof ready', () => {
  assert.equal(isManifestProofReady(manifestWith({ proseSource: 'template' })), false);
});

test('source=template on a single page image blocks proof ready', () => {
  assert.equal(isManifestProofReady(manifestWith({ pageSource: 'template' })), false);
});

// 3 — an all-api_generated manifest is NOT blocked (positive case)
test('source=api_generated on all artifacts does not block proof ready', () => {
  assert.equal(
    isManifestProofReady(manifestWith({ proseSource: 'api_generated', pageSource: 'api_generated' })),
    true,
  );
});
