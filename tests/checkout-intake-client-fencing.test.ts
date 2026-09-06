/*
 * Client-side generation fencing.
 *
 * The server can only refuse a stale WRITE. It cannot stop a stale READ from
 * being painted into the page, and on a slow mobile connection that is a real
 * way to lose a selection:
 *
 *   the page reloads and asks for the saved assets → the buyer immediately
 *   picks a replacement → the slow asset-list response arrives → the old photo
 *   is restored as "saved" and can satisfy readiness while the replacement is
 *   still uploading.
 *
 * That was a blocking finding against the rejected candidate, whose refresh
 * handler merged restored refs unconditionally. The fix is symmetrical to the
 * server's: every slot carries a client generation, an in-flight read captures
 * the generations it was issued against, and on arrival each slot is applied
 * only if its generation has not moved.
 *
 * This module is deliberately pure — no DOM, no fetch, no React — so the
 * fencing rule can be tested exactly rather than approximated through a
 * rendered component.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySlotListRefresh,
  beginSlotListRefresh,
  beginSlotUpload,
  clearSlot,
  commitSlotUpload,
  createIntakeClientState,
  slotTicketIsCurrent,
  slotsAreSettled,
} from '../src/lib/checkout-intake-client.ts';

const HERO = 'primary_hero_photo';
const ALICE = 'family_pet_reference:char-alice';

test('a refresh response cannot overwrite a slot the buyer touched afterwards', () => {
  let state = createIntakeClientState();

  // Page reload asks for the saved assets.
  const refresh = beginSlotListRefresh(state);

  // Before it comes back, the buyer picks a replacement hero photo.
  const started = beginSlotUpload(state, HERO);
  state = started.state;

  // The slow response finally arrives, still carrying the OLD photo.
  const applied = applySlotListRefresh(state, refresh, [
    { slotKey: HERO, assetId: 'asset_old', generation: 1 },
  ]);
  state = applied.state;

  assert.deepEqual(applied.dropped, [HERO]);
  assert.deepEqual(applied.applied, []);
  assert.equal(state.slots[HERO]?.state, 'uploading');
  assert.equal(state.slots[HERO]?.assetId, null, 'the old photo was not restored');
});

test('a refresh response still restores the slots nobody touched', () => {
  let state = createIntakeClientState();
  const refresh = beginSlotListRefresh(state);
  state = beginSlotUpload(state, HERO).state;

  const applied = applySlotListRefresh(state, refresh, [
    { slotKey: HERO, assetId: 'asset_old_hero', generation: 1 },
    { slotKey: ALICE, assetId: 'asset_alice', generation: 1 },
  ]);
  state = applied.state;

  assert.deepEqual(applied.dropped, [HERO]);
  assert.deepEqual(applied.applied, [ALICE]);
  assert.equal(state.slots[ALICE]?.state, 'saved');
  assert.equal(state.slots[ALICE]?.assetId, 'asset_alice');
});

test('a reload restores a pending replacement as uploading even when an old asset remains active', () => {
  const state = createIntakeClientState();
  const applied = applySlotListRefresh(state, beginSlotListRefresh(state), [
    { slotKey: HERO, assetId: 'asset_old_hero', generation: 2, pendingGeneration: 2 },
  ]);

  assert.equal(applied.state.slots[HERO]?.state, 'uploading');
  assert.equal(applied.state.slots[HERO]?.assetId, null);
  assert.equal(slotsAreSettled(applied.state), false);
});

test('a removal during an in-flight refresh is not undone by it', () => {
  let state = createIntakeClientState();
  state = applySlotListRefresh(state, beginSlotListRefresh(state), [
    { slotKey: HERO, assetId: 'asset_first', generation: 1 },
  ]).state;
  assert.equal(state.slots[HERO]?.state, 'saved');

  const refresh = beginSlotListRefresh(state);
  state = clearSlot(state, HERO).state;

  const applied = applySlotListRefresh(state, refresh, [
    { slotKey: HERO, assetId: 'asset_first', generation: 1 },
  ]);
  state = applied.state;

  assert.deepEqual(applied.dropped, [HERO]);
  assert.equal(state.slots[HERO]?.state, 'empty');
  assert.equal(state.slots[HERO]?.assetId, null);
});

test('a refresh clears a slot the server no longer holds, unless it was touched', () => {
  let state = createIntakeClientState();
  state = applySlotListRefresh(state, beginSlotListRefresh(state), [
    { slotKey: HERO, assetId: 'asset_first', generation: 1 },
    { slotKey: ALICE, assetId: 'asset_alice', generation: 1 },
  ]).state;

  const refresh = beginSlotListRefresh(state);
  const touched = beginSlotUpload(state, ALICE);
  state = touched.state;

  // The server has neither slot any more.
  state = applySlotListRefresh(state, refresh, []).state;

  assert.equal(state.slots[HERO]?.state, 'empty', 'the untouched slot follows the server');
  assert.equal(state.slots[ALICE]?.state, 'uploading', 'the touched slot keeps the local intent');
});

test('an upload result is committed only for the selection that is still current', () => {
  let state = createIntakeClientState();

  const first = beginSlotUpload(state, HERO);
  state = first.state;
  // The buyer changes their mind while the first upload is in flight.
  const second = beginSlotUpload(state, HERO);
  state = second.state;

  assert.equal(slotTicketIsCurrent(state, first.ticket), false);
  assert.equal(slotTicketIsCurrent(state, second.ticket), true);

  const late = commitSlotUpload(state, first.ticket, { assetId: 'asset_first' });
  state = late.state;
  assert.equal(late.committed, false);
  assert.equal(state.slots[HERO]?.assetId, null);

  const current = commitSlotUpload(state, second.ticket, { assetId: 'asset_second' });
  state = current.state;
  assert.equal(current.committed, true);
  assert.equal(state.slots[HERO]?.state, 'saved');
  assert.equal(state.slots[HERO]?.assetId, 'asset_second');
});

test('a commit after removal does not resurrect the slot', () => {
  let state = createIntakeClientState();
  const upload = beginSlotUpload(state, HERO);
  state = upload.state;
  state = clearSlot(state, HERO).state;

  const late = commitSlotUpload(state, upload.ticket, { assetId: 'asset_x' });
  state = late.state;

  assert.equal(late.committed, false);
  assert.equal(state.slots[HERO]?.state, 'empty');
});

test('readiness is false while any slot is still uploading', () => {
  let state = createIntakeClientState();
  assert.equal(slotsAreSettled(state), true);

  const upload = beginSlotUpload(state, HERO);
  state = upload.state;
  assert.equal(slotsAreSettled(state), false, 'an in-flight upload is not a saved photo');

  state = commitSlotUpload(state, upload.ticket, { assetId: 'asset_ok' }).state;
  assert.equal(slotsAreSettled(state), true);
});

test('every mutation advances the generation, so tickets are never reusable', () => {
  let state = createIntakeClientState();
  const a = beginSlotUpload(state, HERO);
  state = a.state;
  const b = clearSlot(state, HERO);
  state = b.state;
  const c = beginSlotUpload(state, HERO);
  state = c.state;

  assert.equal(a.ticket.clientGeneration, 1);
  assert.equal(b.ticket.clientGeneration, 2);
  assert.equal(c.ticket.clientGeneration, 3);
  assert.equal(slotTicketIsCurrent(state, a.ticket), false);
  assert.equal(slotTicketIsCurrent(state, b.ticket), false);
  assert.equal(slotTicketIsCurrent(state, c.ticket), true);
});

test('the state object is never mutated in place', () => {
  const state = createIntakeClientState();
  const next = beginSlotUpload(state, HERO).state;
  assert.notEqual(state, next);
  assert.deepEqual(state.slots, {}, 'the original snapshot is unchanged');
});
