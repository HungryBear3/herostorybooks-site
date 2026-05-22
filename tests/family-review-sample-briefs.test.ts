/**
 * @jest-environment node
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderBriefsForSubmission,
  sampleBriefLabelForDirection,
} from '../src/lib/family-review/sample-briefs.ts';

const BASE = {
  childFirstName: 'Lukas',
  ageRange: '3-4' as const,
  pronoun: 'he/him' as const,
};

test('space submissions get a space sample brief, not the dinosaur page', () => {
  const briefs = renderBriefsForSubmission({
    ...BASE,
    direction: 'space',
  });
  const primary = briefs.find((brief) => brief.briefId === 'dinosaur-adventure');

  assert.equal(primary?.label, 'Space explorer page');
  assert.match(primary?.prompt ?? '', /space explorer/i);
  assert.match(primary?.prompt ?? '', /No dinosaurs/i);
  assert.doesNotMatch(primary?.prompt ?? '', /T-rex|lush prehistoric valley/i);
});

test('bedtime submissions get a bedtime primary sample brief', () => {
  const briefs = renderBriefsForSubmission({
    ...BASE,
    direction: 'bedtime',
  });
  const primary = briefs.find((brief) => brief.briefId === 'dinosaur-adventure');

  assert.equal(primary?.label, 'Bedtime wonder page');
  assert.match(primary?.prompt ?? '', /cozy bedroom/i);
  assert.match(primary?.prompt ?? '', /No dinosaurs/i);
});

test('direction-aware labels keep the persisted legacy slot id but show parent-safe text', () => {
  assert.equal(
    sampleBriefLabelForDirection('dinosaur-adventure', 'space'),
    'Space explorer page',
  );
  assert.equal(
    sampleBriefLabelForDirection('dinosaur-adventure', 'dinosaur'),
    'Dinosaur adventure page',
  );
});
