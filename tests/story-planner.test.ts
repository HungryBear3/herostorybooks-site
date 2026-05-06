import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord } from '../src/lib/orders.ts';
import { defaultTextLayoutForPage, planStorybook, validateStoryPlan } from '../src/lib/story-planner.ts';

function makeOrder(theme: string) {
  return createOrderRecord(
    {
      childName: 'Rex Print Smoke',
      childAge: '5',
      email: 'a@b.com',
      theme,
      lesson: 'kindness',
      occasion: 'birthday',
      characterNotes: 'loves frogs, carries a lucky whistle',
      appearanceOptions: JSON.stringify({ skinTone: 'medium', hairStyle: 'straight-dark', eyewear: '' }),
      bookFormat: 'classic',
    },
    { id: `ord_plan_${theme}`, now: '2026-05-03T12:00:00Z' },
  );
}

function actionLead(beat: string) {
  return beat.split(',')[0]!.trim().toLowerCase();
}

test('planStorybook: creates a 24-page plan that passes structural validation', () => {
  const plan = planStorybook(makeOrder('brave-explorer'));
  assert.equal(plan.pages.length, 24);
  assert.deepEqual(validateStoryPlan(plan), []);
});

test('planStorybook: 24-page plan uses 24 unique settings and 24 unique beat summaries', () => {
  const plan = planStorybook(makeOrder('brave-explorer'));
  assert.equal(new Set(plan.pages.map((p) => p.setting)).size, 24);
  assert.equal(new Set(plan.pages.map((p) => p.beat_summary)).size, 24);
});

test('planStorybook: final three pages are true resolution beats, not mid-journey loops', () => {
  const plan = planStorybook(makeOrder('brave-explorer'));
  const lastThree = plan.pages.slice(-3);
  assert.deepEqual(lastThree.map((p) => p.arc_position), ['resolution', 'resolution', 'resolution']);
  assert.match(lastThree[0]!.beat_summary.toLowerCase(), /return|bring|carry|head home|reach home|share|turns toward home/);
  assert.match(lastThree[1]!.beat_summary.toLowerCase(), /share|show|tell|celebrate|set down|open/);
  assert.match(lastThree[2]!.beat_summary.toLowerCase(), /goodnight|sleep|rest|home|bed|quiet/);
});

test('planStorybook: brave-explorer locks explorer outfit and varied beats', () => {
  const plan = planStorybook(makeOrder('brave-explorer'));
  assert.match(plan.protagonist_outfit, /explorer hat/i);
  assert.match(plan.protagonist_outfit, /backpack/i);
  assert.equal(new Set(plan.pages.map((p) => p.setting)).size, 24);
  assert.ok(new Set(plan.pages.map((p) => p.emotional_tone)).size >= 4);
  assert.ok(plan.pages.filter((p) => p.who_else_in_frame !== 'none').length >= 3);
  assert.ok(plan.pages.some((p) => p.arc_position === 'middle' && /doubt|frustration|hesitation|strain/.test(p.emotional_tone)));
  assert.equal(new Set(plan.pages.map((p) => p.beat_summary)).size, 24);
  assert.match(plan.title, /^Rex and the /);
  assert.equal(new Set(plan.pages.map((p) => actionLead(p.beat_summary))).size, 24);
  assert.ok(plan.pages.filter((p) => /listening stone/i.test(`${p.beat_summary} ${p.key_object_or_detail}`)).length >= 6);
  assert.match(plan.pages[21]!.setting.toLowerCase(), /home|path at dusk|porch|bedroom/);
  assert.match(plan.pages[22]!.setting.toLowerCase(), /porch|home/);
  assert.match(plan.pages[23]!.setting.toLowerCase(), /bedroom|home/);
});

test('planStorybook: brave-explorer climax/payoff beats avoid the old looped weak spots', () => {
  const plan = planStorybook(makeOrder('brave-explorer'));
  const page9 = plan.pages[8]!;
  const page13 = plan.pages[12]!;
  const page21 = plan.pages[20]!;
  const page22 = plan.pages[21]!;

  assert.ok((page9.beat_summary.match(/monkey/gi) || []).length <= 1, 'page 9 should not mention multiple monkeys in a confusing way');
  assert.doesNotMatch(page13.beat_summary.toLowerCase(), /backs up once|study the problem again/);
  assert.match(page21.beat_summary.toLowerCase(), /understands|answer|reveal|finds|at last/);
  assert.match(page22.beat_summary.toLowerCase(), /turns toward home|heads home|wrapped safely in both hands/);
});

test('planStorybook: no shot type is used more than four times', () => {
  const plan = planStorybook(makeOrder('space-voyager'));
  const counts = new Map<string, number>();
  for (const page of plan.pages) counts.set(page.shot_type, (counts.get(page.shot_type) ?? 0) + 1);
  for (const count of counts.values()) {
    assert.ok(count <= 4, `shot type repeated too often: ${count}`);
  }
});

test('planStorybook: supports premium 32-page plans too', () => {
  const order = makeOrder('dragon-quest');
  const plan = planStorybook(order, 32);
  assert.equal(plan.pages.length, 32);
  assert.deepEqual(validateStoryPlan(plan), []);
});

test('planStorybook: every plan page carries a deterministic text_layout for the renderer + image generator', () => {
  const plan = planStorybook(makeOrder('brave-explorer'));
  for (const page of plan.pages) {
    assert.ok(page.text_layout, `page ${page.page} missing text_layout`);
    assert.ok(['top_left', 'top_right', 'bottom_left', 'bottom_right', 'bottom_band', 'top_band', 'natural'].includes(page.text_layout.zone));
    assert.ok(['none', 'translucent_cream', 'translucent_dark', 'soft_scrim'].includes(page.text_layout.panelStyle));
  }
  // Final page is always the cozy bottom_band cadence.
  assert.equal(plan.pages.at(-1)!.text_layout.zone, 'bottom_band');
  // Plan output is stable across runs.
  const second = planStorybook(makeOrder('brave-explorer'));
  assert.deepEqual(plan.pages.map((p) => p.text_layout), second.pages.map((p) => p.text_layout));
});

test('defaultTextLayoutForPage: uses bottom_band for the final spread regardless of shot type', () => {
  for (const shot of ['extreme_wide', 'close_up', 'birds_eye', 'worms_eye'] as const) {
    const layout = defaultTextLayoutForPage(23, 24, shot);
    assert.equal(layout.zone, 'bottom_band', `final-page override should win for shot=${shot}`);
  }
});
