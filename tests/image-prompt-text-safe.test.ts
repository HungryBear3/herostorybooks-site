/**
 * Static invariants for HSB page-image prompt construction.
 *
 * Origin: 2026-05-15 Gemini preview proof test.
 *   - p16 failed text-safe (too busy / no protected text zone).
 *   - p19 failed natural-negative-space and risked pseudo-text glyphs.
 *   - p01 bottom text-safe band felt abrupt.
 *
 * Patch under test adds an always-on composition-discipline section to
 * buildPagePrompt + buildRegeneratePrompt that mandates:
 *   - protected text-safe area
 *   - natural negative space (not hard blank bars)
 *   - zero readable text, signage, labels, glyphs, or pseudo-text marks
 *   - no over-centered busy splash-page composition when text is needed
 *   - watercolor storybook style preserved
 *
 * These tests assert the prompt string contains the new discipline
 * language for BOTH initial generation and regenerate paths, regardless
 * of whether a textLayout zone hint is provided. The pre-patch behavior
 * would emit no text-safe guidance at all when textLayout was undefined.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPagePrompt,
  buildRegeneratePrompt,
} from '../src/lib/image-prompt-builder.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const ORDER: Pick<
  OrderRecord,
  | 'childName'
  | 'childAge'
  | 'characterNotes'
  | 'appearanceOptions'
  | 'photoBlobPath'
  | 'theme'
  | 'childPronouns'
> = {
  childName: 'Lukas',
  childAge: '6',
  characterNotes: '',
  appearanceOptions: JSON.stringify({
    skinTone: 'medium',
    hairStyle: 'straight-dark',
  }),
  photoBlobPath: 'orders/x/photo-x.jpg',
  theme: 'brave-explorer',
  childPronouns: 'he/him',
};

const BASE_PROMPT = 'Lukas peers into a glowing cave.';
const STORY_TEXT = 'Lukas tiptoed toward the glowing cave, heart racing.';

// ── Always-on composition discipline (no textLayout provided) ──────────────

test('buildPagePrompt: emits text-safe / negative-space discipline even when no textLayout is set', () => {
  const prompt = buildPagePrompt({
    basePrompt: BASE_PROMPT,
    storyText: STORY_TEXT,
    order: ORDER,
    characterAnchor: 'A six-year-old boy with short dark hair.',
  });

  // protected text-safe area
  assert.match(prompt, /text-safe/i, 'prompt must mention a text-safe area');
  // natural negative space, not a blank bar
  assert.match(prompt, /natural negative space/i, 'prompt must mention natural negative space');
  // anti-blank-bar
  assert.match(
    prompt,
    /not.*(?:blank bar|hard rectangle|vignette mask|color block)/i,
    'prompt must rule out abrupt blank bars / hard rectangles / color blocks',
  );
  // anti-splash-page / anti-over-centered
  assert.match(
    prompt,
    /(over-centered|edge-to-edge splash|naturally off-center)/i,
    'prompt must rule out over-centered busy splash compositions',
  );
  // watercolor storybook style preserved
  assert.match(prompt, /watercolor/i, 'prompt must mention watercolor style');
  assert.match(prompt, /storybook/i, 'prompt must mention storybook style');
});

test('buildPagePrompt: bans pseudo-text, signage, labels, glyphs, readable lettering', () => {
  const prompt = buildPagePrompt({
    basePrompt: BASE_PROMPT,
    storyText: STORY_TEXT,
    order: ORDER,
    characterAnchor: 'A six-year-old boy with short dark hair.',
  });

  // Each of these must appear in the no-text rule.
  assert.match(prompt, /no signage/i, 'prompt must forbid signage');
  assert.match(prompt, /no labels?/i, 'prompt must forbid labels');
  assert.match(prompt, /no maps with readable text/i, 'prompt must forbid readable maps');
  assert.match(prompt, /no pseudo-text glyphs?/i, 'prompt must forbid pseudo-text glyphs');
  assert.match(
    prompt,
    /no symbols arranged to look like writing/i,
    'prompt must forbid symbols that look like writing',
  );
  assert.match(
    prompt,
    /no decorative scribbles that read as letters/i,
    'prompt must forbid decorative scribbles that read as letters',
  );
});

test('buildPagePrompt: carries hero likeness intent and every must-include detail into art direction', () => {
  const prompt = buildPagePrompt({
    basePrompt: BASE_PROMPT,
    storyText: STORY_TEXT,
    order: {
      ...ORDER,
      photoBlobPath: null,
      appearanceOptions: JSON.stringify({
        description: 'warm brown skin and short curly dark hair',
        likenessIntent: 'storybook',
        mustInclude: ['glasses', 'hearing-aid', 'wheelchair'],
        mustIncludeOther: 'purple birthmark on left cheek',
      }),
    },
  });

  assert.match(prompt, /storybook character/i);
  assert.match(prompt, /warm brown skin and short curly dark hair/i);
  assert.match(prompt, /glasses/i);
  assert.match(prompt, /hearing aid/i);
  assert.match(prompt, /wheelchair/i);
  assert.match(prompt, /purple birthmark on left cheek/i);
});

test('buildPagePrompt: no-photo appearance details are not contradicted by legacy identity locks', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'Ava explores a moonlit garden.',
    storyText: 'Ava follows a trail of fireflies.',
    order: {
      ...ORDER,
      childName: 'Ava',
      childPronouns: '',
      photoBlobPath: null,
      appearanceOptions: JSON.stringify({
        description: 'a girl with long red hair and a yellow dress',
        likenessIntent: 'storybook',
      }),
    },
    characterAnchor: 'Ava is a girl with long red hair and a yellow dress.',
  });

  assert.match(prompt, /girl with long red hair and a yellow dress/i);
  assert.doesNotMatch(prompt, /same short dark haircut/i);
  assert.doesNotMatch(prompt, /never change the child into a girl/i);
  assert.doesNotMatch(prompt, /never add long hair/i);
  assert.doesNotMatch(prompt, /boyish presentation/i);
});

test('buildPagePrompt: he/him plus long hair remains customer-driven and non-contradictory', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'Kai explores a moonlit garden.',
    storyText: 'Kai follows a trail of fireflies.',
    order: {
      ...ORDER,
      childName: 'Kai',
      childPronouns: 'he/him',
      characterNotes: 'a boy with waist-length blond hair',
      photoBlobPath: null,
      appearanceOptions: JSON.stringify({
        description: 'a boy with waist-length blond hair',
        hairStyle: 'straight-dark',
        likenessIntent: 'storybook',
      }),
    },
    characterAnchor: 'Kai is a boy with waist-length blond hair.',
  });

  assert.match(prompt, /Kai is a boy with waist-length blond hair/i);
  assert.match(prompt, /do not infer hairstyle, hair length, clothing/i);
  assert.doesNotMatch(prompt, /straight dark hair/i);
  assert.doesNotMatch(prompt, /Lukas is a young boy|short straight dark boy|do not give him long hair|never shoulder-length/i);
});

// ── Layout-hint section still works when provided ──────────────────────────

test('buildPagePrompt: layout hint adds zone-specific text-safe guidance on top of the always-on rules', () => {
  const prompt = buildPagePrompt({
    basePrompt: BASE_PROMPT,
    storyText: STORY_TEXT,
    order: ORDER,
    characterAnchor: 'A six-year-old boy with short dark hair.',
    textLayout: { zone: 'bottom_band', alignment: 'center' },
  });

  // Always-on still present:
  assert.match(prompt, /natural negative space/i);
  // Layout-specific now appended:
  assert.match(prompt, /bottom ~22%/i, 'zone-specific copy should describe bottom_band');
  assert.match(
    prompt,
    /Reminder: no readable text/i,
    'layout-hint section restates the no-text rule for emphasis',
  );
});

// ── buildRegeneratePrompt picks up the same discipline ─────────────────────

test('buildRegeneratePrompt: also emits text-safe / natural-negative-space discipline', () => {
  const { prompt } = buildRegeneratePrompt({
    basePrompt: BASE_PROMPT,
    storyText: STORY_TEXT,
    order: ORDER,
    characterAnchor: 'A six-year-old boy with short dark hair.',
    feedback: 'Please brighten the lighting and keep his face visible.',
  });

  assert.match(prompt, /text-safe/i);
  assert.match(prompt, /natural negative space/i);
  assert.match(prompt, /no pseudo-text glyphs?/i);
  assert.match(prompt, /watercolor/i);
});

// ── Provider routing is NOT changed by this patch ──────────────────────────
//
// The prompt-builder lives upstream of provider selection. Gemini routing
// is owned by image-generator.ts via env gate HSB_ENABLE_GEMINI_IMAGE and
// is tested elsewhere (tests/image-provider-gemini-routing.test.ts). This
// test only asserts that the prompt builder's output continues to be a
// single string the orchestrator can hand to whichever provider is
// selected — no provider-specific branching crept in.

test('buildPagePrompt: returns a single non-empty string suitable for any provider', () => {
  const prompt = buildPagePrompt({
    basePrompt: BASE_PROMPT,
    storyText: STORY_TEXT,
    order: ORDER,
    characterAnchor: 'A six-year-old boy with short dark hair.',
  });
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 200, 'prompt should be substantive');
  // Sanity: no leaked secrets / provider names / api-key fragments.
  assert.doesNotMatch(prompt, /GOOGLE_GEMINI_API_KEY/i);
  assert.doesNotMatch(prompt, /sk[_-][A-Za-z0-9]{4,}/);
});
