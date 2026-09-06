import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('Custom Story is the primary story direction and templates are secondary', () => {
  const customIndex = checkoutFormSource.indexOf('Fully custom');
  const templatesIndex = checkoutFormSource.indexOf('Or pick a ready adventure template');
  assert.ok(customIndex > -1, 'custom primary badge should render');
  assert.ok(templatesIndex > -1, 'template group label should render');
  assert.ok(customIndex < templatesIndex, 'Custom Story should appear before templates');
  assert.match(checkoutFormSource, /templateThemes = THEMES\.filter\(\(theme\) => theme\.id !== CUSTOM_STORY_THEME_ID\)/);
});

test('Custom Story selection immediately reveals all source inputs before templates and hero details', () => {
  const panel = checkoutFormSource.indexOf('data-testid="custom-story-intake-panel"');
  const templates = checkoutFormSource.indexOf('Or pick a ready adventure template');
  const heroDetails = checkoutFormSource.indexOf('Who this story celebrates');
  assert.ok(panel > -1 && panel < templates && templates < heroDetails);
  assert.match(checkoutFormSource, /data-testid="custom-story-intake-panel"[\s\S]*?Type the memory or story idea[\s\S]*?<VoiceRecorderSection/);
  assert.match(checkoutFormSource, /Choose a ready-made adventure instead/);
  assert.doesNotMatch(checkoutFormSource, /STORY_UPLOAD_ENABLED|NEXT_PUBLIC_HSB_STORY_UPLOAD/);
});

test('Custom Story editor is not duplicated on the Story step', () => {
  const panelCount = checkoutFormSource.match(/data-testid="custom-story-intake-panel"/g) ?? [];
  const textareaCount = checkoutFormSource.match(/id="customStoryMemory"/g) ?? [];
  const recorderCount = checkoutFormSource.match(/<VoiceRecorderSection/g) ?? [];
  assert.equal(panelCount.length, 1);
  assert.equal(textareaCount.length, 1);
  assert.equal(recorderCount.length, 1);
  assert.match(checkoutFormSource, /Custom Story source[\s\S]*?Return to Hero details anytime to edit it/);
});

test('main photo intake leads with recommended upload and keeps description as the alternative', () => {
  assert.match(checkoutFormSource, /Upload a photo for the best likeness/);
  assert.match(checkoutFormSource, /Recommended/);
  assert.match(checkoutFormSource, /Or describe the hero instead/);
  assert.match(checkoutFormSource, /Upload from your phone/);
  assert.match(checkoutFormSource, /Choose an existing JPG, PNG, or WebP photo\./);
  assert.match(checkoutFormSource, /Open your camera for a still photo\./);
  assert.match(checkoutFormSource, /data-testid="hero-photo-proof-example"/);
  assert.ok(
    checkoutFormSource.indexOf('data-testid="hero-photo-upload-control"') <
      checkoutFormSource.indexOf('data-testid="hero-photo-proof-example"'),
    'upload controls must precede the proof example in semantic DOM order',
  );
  assert.doesNotMatch(checkoutFormSource, /Drag &amp; drop · JPG\/PNG\/WebP\/HEIC/);
});

test('checkout direct-media consent explicitly covers uploaded documents', () => {
  assert.match(
    checkoutFormSource,
    /I have permission to provide these photos, recordings, or documents and authorize/,
  );
  assert.doesNotMatch(
    checkoutFormSource,
    /I have permission to provide these photos or recordings and authorize/,
  );
});

test('CD/Cowork checkout polish avoids contradictory or nervous copy', () => {
  assert.match(checkoutFormSource, /Only a few things are required to start/);
  assert.match(checkoutFormSource, /story direction/);
  assert.match(checkoutFormSource, /5 quick angles, about a minute \(optional\)/);
  assert.match(checkoutFormSource, /PROMO_CODE_HELP/);
  assert.match(checkoutFormSource, /Usually in \{PROOF_TURNAROUND_WINDOW\}, you get a private link/);
  assert.match(checkoutFormSource, /form\.childName \|\| "your child"/);
  assert.doesNotMatch(checkoutFormSource, /required people photos/);
  assert.doesNotMatch(checkoutFormSource, /0 of \$\{requiredHumanPhotoCount\} added/);
  assert.doesNotMatch(checkoutFormSource, /Add later/);
  assert.doesNotMatch(checkoutFormSource, /Optional — open only if you want extra likeness help/);
  assert.doesNotMatch(checkoutFormSource, /Within 2 business days/);
  assert.doesNotMatch(checkoutFormSource, /⚡ \{fmt\.delivery\}/);
});

test('checkout errors stay specific, visible near payment, and include manual support contact', () => {
  assert.match(checkoutFormSource, /data-testid="submit-error"/);
  assert.match(checkoutFormSource, /\{submitError\}/);
  assert.match(checkoutFormSource, /mailto:support@herostorybooks\.com/);
  assert.match(checkoutFormSource, /help you finish the order manually/);
});

test('optional guided photos stay collapsed behind a likeness link', () => {
  const linkIndex = checkoutFormSource.indexOf('Want an even better likeness? Take guided photos');
  const panelIndex = checkoutFormSource.indexOf('showGuidedPhotos && (');
  const componentIndex = checkoutFormSource.indexOf('<GuidedPhotoCapture');
  assert.ok(linkIndex > -1, 'optional guided photo link should render');
  assert.ok(panelIndex > -1, 'guided photo panel should be gated by showGuidedPhotos');
  assert.ok(componentIndex > panelIndex, 'GuidedPhotoCapture should mount only inside the expanded panel');
  assert.match(checkoutFormSource, /aria-expanded=\{showGuidedPhotos\}/);
});
