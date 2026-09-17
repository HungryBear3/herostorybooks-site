import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
  CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
  CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
  clearCheckoutAttemptStorage,
  recoverConflictingCheckoutAttemptStorage,
  clearCheckoutAfterConfirmedPayment,
  checkoutAttemptMayHaveReachedServer,
  checkoutSubmitAttemptRisk,
  checkoutAttemptStorageUnavailable,
  checkoutAttemptWasSent,
  confirmedCheckoutCleanupAttemptId,
  reconcileCheckoutAttemptIdentity,
  readCheckoutAttemptStorageSnapshot,
  repairCheckoutAttemptStorageToRiskIdentity,
  recordCheckoutAttemptReserved,
  recordCheckoutAttemptSent,
  savedFamilyCharactersForStorage,
  sanitizeSavedCheckoutDraft,
} from '../src/lib/checkout-saved-draft.ts';

const root = process.cwd();
const formSource = fs.readFileSync(
  path.join(root, 'src/app/checkout/checkout-form.tsx'),
  'utf8',
);
const confirmationRouteSource = fs.readFileSync(
  path.join(root, 'src/app/api/order/[orderId]/confirmation/route.ts'),
  'utf8',
);
const thankYouPageSource = fs.readFileSync(
  path.join(root, 'src/app/thank-you/page.tsx'),
  'utf8',
);
const pendingConfirmationSource = fs.readFileSync(
  path.join(root, 'src/app/thank-you/pending-confirmation.tsx'),
  'utf8',
);
const confirmedCleanupPath = path.join(root, 'src/app/thank-you/confirmed-checkout-cleanup.tsx');
const confirmedCleanupSource = fs.existsSync(confirmedCleanupPath)
  ? fs.readFileSync(confirmedCleanupPath, 'utf8')
  : '';

test('storage denial is distinguished from readable conflicting risk evidence', () => {
  const deniedReads = {
    getItem() { throw new DOMException('denied', 'SecurityError'); },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() { throw new DOMException('denied', 'SecurityError'); },
  };
  const deniedSnapshot = readCheckoutAttemptStorageSnapshot(deniedReads);
  assert.equal(checkoutAttemptStorageUnavailable(deniedReads, deniedSnapshot), true);

  const setDenied = {
    getItem() { return null; },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() {},
  };
  const emptyReadableSnapshot = readCheckoutAttemptStorageSnapshot(setDenied);
  assert.equal(checkoutAttemptStorageUnavailable(setDenied, emptyReadableSnapshot), true);

  const sent = 'a'.repeat(32);
  const conflictingReadable = {
    getItem(key: string) {
      if (key === CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) return sent;
      if (key === CHECKOUT_ATTEMPT_ID_STORAGE_KEY) return 'b'.repeat(32);
      return null;
    },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() {},
  };
  const conflictSnapshot = readCheckoutAttemptStorageSnapshot(conflictingReadable);
  assert.equal(checkoutAttemptStorageUnavailable(conflictingReadable, conflictSnapshot), false);
  assert.equal(conflictSnapshot.reliable, false);
});

test('email is adjacent to payment and the long explainer follows the payment action', () => {
  const emailAt = formSource.indexOf('Where should we send everything?');
  const paymentAt = formSource.indexOf('Continue to secure payment${selectedFormat');
  const explainerAt = formSource.indexOf('What happens next');
  assert.ok(emailAt >= 0 && paymentAt >= 0 && explainerAt >= 0);
  assert.ok(emailAt < paymentAt, 'email must be entered before payment');
  assert.ok(paymentAt < explainerAt, 'the long explainer must not separate email from payment');
});

test('restored checkout drafts discard browser-only media objects but preserve entered details', () => {
  const restored = sanitizeSavedCheckoutDraft({
    childName: 'Mina',
    email: 'buyer@example.com',
    photoFile: { name: 'hero.jpg', size: 12 },
    photoDataUrl: 'data:image/jpeg;base64,hero',
    voiceFile: { name: 'memory.m4a', size: 12 },
    voicePreviewUrl: 'blob:voice',
    voiceSource: 'uploaded',
    voiceConsent: true,
    familyCharacters: [{
      id: 'dad-1',
      role: 'dad',
      name: 'Dad',
      notes: 'Brown hair and glasses',
      photoFile: { name: 'dad.jpg', size: 12 },
      photoDataUrl: 'data:image/jpeg;base64,dad',
    }],
  });

  assert.equal(restored.childName, 'Mina');
  assert.equal(restored.email, 'buyer@example.com');
  assert.equal(restored.photoFile, null);
  assert.equal(restored.photoDataUrl, null);
  assert.equal(restored.voiceFile, null);
  assert.equal(restored.voicePreviewUrl, null);
  assert.equal(restored.voiceSource, null);
  assert.equal(restored.voiceConsent, false);
  assert.equal(restored.familyCharacters?.[0]?.name, 'Dad');
  assert.equal(restored.familyCharacters?.[0]?.notes, 'Brown hair and glasses');
  assert.equal(restored.familyCharacters?.[0]?.photoFile, null);
  assert.equal(restored.familyCharacters?.[0]?.photoDataUrl, null);
});

test('malformed restored family characters are discarded or normalized to safe runtime fields', () => {
  const malformedList = sanitizeSavedCheckoutDraft({ familyCharacters: { nope: true } });
  assert.deepEqual(malformedList.familyCharacters, []);

  const restored = sanitizeSavedCheckoutDraft({
    familyCharacters: [
      null,
      { id: 4, role: 'dad', name: 'bad identity' },
      { id: 'mom-1', role: 9, name: 'bad role' },
      {
        id: 'pet-1',
        role: 'pet',
        name: 'Scout',
        notes: 42,
        relationshipLabel: null,
        isGiftRecipient: 'yes',
        appearsInStory: null,
        mustInclude: ['collar', 7, null],
        mustIncludeOther: {},
        focusPersonLabel: false,
        cropHint: 3,
      },
    ],
  });

  assert.deepEqual(restored.familyCharacters, [{
    id: 'pet-1',
    role: 'pet',
    name: 'Scout',
    relationshipLabel: '',
    pronouns: '',
    notes: '',
    isGiftRecipient: false,
    appearsInStory: true,
    photoFile: null,
    photoDataUrl: null,
    mustInclude: ['collar'],
    mustIncludeOther: '',
    focusPersonLabel: '',
    cropHint: '',
  }]);
});

test('attempt identity reconciliation rejects memory and durable-storage disagreement', () => {
  const durableId = '8'.repeat(32);
  const memoryId = '9'.repeat(32);
  assert.deepEqual(
    reconcileCheckoutAttemptIdentity({ attemptId: durableId, reliable: true }, memoryId),
    { attemptId: durableId, reliable: false },
  );
  assert.deepEqual(
    reconcileCheckoutAttemptIdentity({ attemptId: durableId, reliable: true }, durableId),
    { attemptId: durableId, reliable: true },
  );
  assert.deepEqual(
    reconcileCheckoutAttemptIdentity({ attemptId: null, reliable: true }, null),
    { attemptId: null, reliable: true },
  );
  assert.deepEqual(
    reconcileCheckoutAttemptIdentity({ attemptId: null, reliable: true }, memoryId),
    { attemptId: memoryId, reliable: false },
  );
});

test('saved family character JSON excludes File objects and data URLs', () => {
  const saved = savedFamilyCharactersForStorage([{
    id: 'dad-1',
    name: 'Dad',
    notes: 'Brown hair',
    photoFile: { name: 'dad.jpg' },
    photoDataUrl: 'data:image/jpeg;base64,dad',
  }]);

  assert.deepEqual(saved, [{ id: 'dad-1', name: 'Dad', notes: 'Brown hair' }]);
  assert.equal(JSON.stringify(saved).includes('data:image'), false);
  assert.equal(JSON.stringify(saved).includes('dad.jpg'), false);
});

test('a reserved attempt id does not imply the order request reached the server', () => {
  assert.equal(checkoutAttemptMayHaveReachedServer({ requestSent: false, previouslySent: false }), false);
  assert.equal(checkoutAttemptMayHaveReachedServer({ requestSent: true, previouslySent: false }), true);
  assert.equal(checkoutAttemptMayHaveReachedServer({ requestSent: false, previouslySent: true }), true);
});

test('submit risk distinguishes this click from a retained unresolved attempt', () => {
  assert.equal(checkoutSubmitAttemptRisk({
    requestSent: false,
    previouslySent: false,
    previousAttemptResolved: false,
  }), 'none');
  assert.equal(checkoutSubmitAttemptRisk({
    requestSent: false,
    previouslySent: true,
    previousAttemptResolved: false,
  }), 'previous_attempt_unresolved');
  assert.equal(checkoutSubmitAttemptRisk({
    requestSent: false,
    previouslySent: true,
    previousAttemptResolved: true,
  }), 'previous_attempt_resolved');
  assert.equal(checkoutSubmitAttemptRisk({
    requestSent: true,
    previouslySent: true,
    previousAttemptResolved: true,
  }), 'current_order_request_sent');
});

test('unreadable storage remains conservatively ambiguous across in-memory marker mismatches', () => {
  const deniedStorage = {
    getItem(): string | null { throw new Error('storage denied'); },
    setItem(): void { throw new Error('storage denied'); },
    removeItem(): void { throw new Error('storage denied'); },
  };
  const attemptId = 'a'.repeat(32);

  assert.doesNotThrow(() => recordCheckoutAttemptSent(deniedStorage, attemptId));
  assert.equal(checkoutAttemptWasSent(deniedStorage, attemptId, attemptId), true);
  assert.equal(checkoutAttemptWasSent(deniedStorage, attemptId, 'b'.repeat(32)), true);
});

test('a remounted legacy attempt with no durable state is conservatively unknown', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
  const attemptId = 'c'.repeat(32);

  assert.equal(checkoutAttemptWasSent(storage, attemptId), true);
  assert.equal(recordCheckoutAttemptReserved(storage, attemptId), true);
  assert.equal(values.get(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY), attemptId);
  assert.equal(checkoutAttemptWasSent(storage, attemptId), false);
});

test('a partial sent-marker write failure is reported so order dispatch can abort', () => {
  const values = new Map<string, string>();
  const attemptId = 'd'.repeat(32);
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) {
      if (key === CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) throw new Error('sent marker denied');
      values.set(key, value);
    },
    removeItem(key: string) { values.delete(key); },
  };

  assert.equal(recordCheckoutAttemptReserved(storage, attemptId), true);
  assert.equal(recordCheckoutAttemptSent(storage, attemptId), false);
  assert.equal(checkoutAttemptWasSent(storage, attemptId), false);
});

test('a key-specific read failure cannot hide a sent attempt or authorize a new identity', () => {
  const sentAttemptId = 'e'.repeat(32);
  for (const failingKey of [
    CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
    CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
    CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
  ]) {
    const storage = {
      getItem(key: string) {
        if (key === failingKey) throw new Error(`${key} read failed`);
        if (key === CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) return sentAttemptId;
        return null;
      },
      setItem() {},
      removeItem() {},
    };

    const snapshot = readCheckoutAttemptStorageSnapshot(storage);
    assert.equal(snapshot.reliable, false, `${failingKey} failure must poison the snapshot`);
    if (failingKey !== CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) {
      assert.equal(snapshot.attemptId, sentAttemptId);
    }
  }
});

test('mismatched durable attempt identities are classified as unreliable', () => {
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, 'f'.repeat(32)],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, '1'.repeat(32)],
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, '2'.repeat(32)],
  ]);
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };

  assert.deepEqual(readCheckoutAttemptStorageSnapshot(storage), {
    attemptId: '1'.repeat(32),
    reliable: false,
  });
});

test('a single sent identity safely repairs conflicting lower-risk browser markers', () => {
  const sentId = '1'.repeat(32);
  const staleId = '2'.repeat(32);
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, staleId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, sentId],
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, staleId],
  ]);
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };

  assert.equal(repairCheckoutAttemptStorageToRiskIdentity(storage), true);
  assert.deepEqual(readCheckoutAttemptStorageSnapshot(storage), {
    attemptId: sentId,
    reliable: true,
  });
  assert.equal(values.get(CHECKOUT_ATTEMPT_ID_STORAGE_KEY), sentId);
  assert.equal(values.get(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY), sentId);
  assert.equal(values.get(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY), sentId);
});

test('conflicting sent and cleanup identities remain blocked without mutation', () => {
  const sentId = '3'.repeat(32);
  const cleanupId = '4'.repeat(32);
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, sentId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, sentId],
    [CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY, cleanupId],
  ]);
  const before = [...values.entries()];
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };

  assert.equal(repairCheckoutAttemptStorageToRiskIdentity(storage), false);
  assert.deepEqual([...values.entries()], before);
});

test('private-mode marker conflicts clear only after every server-risk identity is terminal', async () => {
  const cleanupId = '7'.repeat(32);
  const unsentReservedId = '8'.repeat(32);
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, unsentReservedId],
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, unsentReservedId],
    [CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY, cleanupId],
  ]);
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
  const confirmed: string[] = [];

  assert.equal(await recoverConflictingCheckoutAttemptStorage(storage, async (attemptId) => {
    confirmed.push(attemptId);
    return 'restart_allowed';
  }), true);
  assert.deepEqual(confirmed, [cleanupId]);
  assert.deepEqual([...values.entries()], []);
  assert.deepEqual(readCheckoutAttemptStorageSnapshot(storage), { attemptId: null, reliable: true });
});

test('private-mode marker conflict recovery preserves all evidence when any risky identity is unresolved', async () => {
  const cleanupId = '9'.repeat(32);
  const sentId = 'a'.repeat(32);
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, sentId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, sentId],
    [CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY, cleanupId],
  ]);
  const before = [...values.entries()];
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };

  assert.equal(await recoverConflictingCheckoutAttemptStorage(storage, async (attemptId) => (
    attemptId === cleanupId ? 'restart_allowed' : 'unknown'
  )), false);
  assert.deepEqual([...values.entries()], before);
});

test('marker repair fails closed when any write or readback is unavailable', () => {
  const sentId = '5'.repeat(32);
  const staleId = '6'.repeat(32);
  for (const failingKey of [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY]) {
    const values = new Map<string, string>([
      [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, staleId],
      [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, sentId],
      [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, staleId],
    ]);
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) {
        if (key === failingKey) throw new Error('write failed');
        values.set(key, value);
      },
      removeItem(key: string) { values.delete(key); },
    };

    assert.equal(repairCheckoutAttemptStorageToRiskIdentity(storage), false);
    assert.notEqual(readCheckoutAttemptStorageSnapshot(storage).reliable, true);
  }
});

test('partial accepted-handoff cleanup stays known-sent after remount', () => {
  const attemptId = '3'.repeat(32);
  for (const failingKey of [
    CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
    CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
    CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  ]) {
    const attempted: string[] = [];
    const values = new Map<string, string>([
      [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
      [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
      [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId],
    ]);
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) {
        attempted.push(key);
        if (key === failingKey) throw new Error(`${key} removal failed`);
        values.delete(key);
      },
    };

    assert.equal(clearCheckoutAttemptStorage(storage, attemptId), false);
    assert.equal(checkoutAttemptWasSent(storage, attemptId), true);
    if (failingKey !== CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY) {
      assert.deepEqual(attempted.slice(0, 3), [
        CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
        CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
        CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
      ]);
    }
  }
});

test('silent no-op attempt removals stay known-sent after remount', () => {
  const attemptId = '4'.repeat(32);
  for (const noOpKey of [
    CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
    CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
    CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  ]) {
    const values = new Map<string, string>([
      [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
      [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
      [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId],
    ]);
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) {
        if (key !== noOpKey) values.delete(key);
      },
    };

    assert.equal(clearCheckoutAttemptStorage(storage, attemptId), false);
    assert.equal(checkoutAttemptWasSent(storage, attemptId), true);
  }
});

test('draft cleanup runs only after a verified tombstone and before attempt deletion', () => {
  const attemptId = '5'.repeat(32);
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId],
  ]);
  const events: string[] = [];
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) {
      events.push(`set:${key}`);
      values.set(key, value);
    },
    removeItem(key: string) {
      events.push(`remove:${key}`);
      values.delete(key);
    },
  };

  assert.equal(clearCheckoutAttemptStorage(storage, attemptId, () => {
    assert.equal(values.get(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY), attemptId);
    assert.equal(values.get(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY), attemptId);
    events.push('draft');
    return true;
  }), true);
  assert.ok(events.indexOf(`set:${CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY}`) < events.indexOf('draft'));
  assert.ok(events.indexOf('draft') < events.indexOf(`remove:${CHECKOUT_ATTEMPT_ID_STORAGE_KEY}`));
});

test('failed tombstone establishment never deletes the saved draft or attempt evidence', () => {
  const attemptId = '6'.repeat(32);
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId],
  ]);
  let draftCleanupCalls = 0;
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem() { /* silent no-op */ },
    removeItem(key: string) { values.delete(key); },
  };

  assert.equal(clearCheckoutAttemptStorage(storage, attemptId, () => {
    draftCleanupCalls += 1;
    return true;
  }), false);
  assert.equal(draftCleanupCalls, 0);
  assert.equal(values.get(CHECKOUT_ATTEMPT_ID_STORAGE_KEY), attemptId);
  assert.equal(values.get(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY), attemptId);
  assert.equal(values.get(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY), attemptId);
});

test('failed verified draft deletion preserves all attempt evidence behind the tombstone', () => {
  const attemptId = '7'.repeat(32);
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId],
  ]);
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };

  assert.equal(clearCheckoutAttemptStorage(storage, attemptId, () => false), false);
  assert.equal(values.get(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY), attemptId);
  assert.equal(values.get(CHECKOUT_ATTEMPT_ID_STORAGE_KEY), attemptId);
  assert.equal(values.get(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY), attemptId);
  assert.equal(values.get(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY), attemptId);
  assert.equal(checkoutAttemptWasSent(storage, attemptId), true);
});

test('paid cleanup is authorized server-side and attempt rotation cleanup never runs at Stripe handoff', () => {
  const decisionAt = formSource.indexOf('const continueDecision = decideCheckoutAttemptContinue({');
  const paidRecoveryAt = formSource.indexOf(
    'continueDecision.action === "paid_confirmation_required"',
    decisionAt,
  );
  const restartAuthorizationAt = formSource.indexOf(
    'continueDecision.action === "rotate_attempt"',
    decisionAt,
  );
  const restartCleanupAt = formSource.indexOf('clearCheckoutAttemptStorage(', restartAuthorizationAt);
  const handoffAt = formSource.indexOf('performStripeHandoff(');
  assert.ok(decisionAt >= 0, 'the shared Continue decision must own restart authorization');
  assert.ok(
    paidRecoveryAt > decisionAt && paidRecoveryAt < restartAuthorizationAt,
    'completed-paid attempts must route to recovery before the rotation branch',
  );
  assert.ok(
    restartCleanupAt > restartAuthorizationAt,
    'attempt cleanup must occur only after the rotate_attempt decision',
  );
  assert.ok(handoffAt > restartCleanupAt);
  assert.doesNotMatch(formSource.slice(handoffAt), /clearCheckoutAttemptStorage\s*\(/);
  assert.match(confirmationRouteSource, /confirmedCheckoutCleanupAttemptId\s*\(/);
  assert.match(confirmationRouteSource, /cleanupAttemptId/);
  assert.match(thankYouPageSource, /confirmedCheckoutCleanupAttemptId\s*\(/);
  assert.match(thankYouPageSource, /<ConfirmedCheckoutCleanup\b/);
  assert.match(pendingConfirmationSource, /cleanupAttemptId\??:\s*string/);
  assert.match(pendingConfirmationSource, /clearCheckoutAfterConfirmedPayment\s*\(/);
  assert.match(confirmedCleanupSource, /clearCheckoutAfterConfirmedPayment\s*\(/);
  assert.match(confirmedCleanupSource, /sessionStorage/);
  assert.match(confirmedCleanupSource, /localStorage/);
});

test('server authorizes cleanup only for an exact paid order session and attempt', () => {
  const attemptId = 'c'.repeat(32);
  const sessionId = 'cs_exact';
  assert.equal(confirmedCheckoutCleanupAttemptId({
    paymentStatus: 'paid',
    stripeSessionId: sessionId,
    checkoutAttemptId: attemptId,
  }, sessionId), attemptId);
  for (const input of [
    { paymentStatus: 'pending', stripeSessionId: sessionId, checkoutAttemptId: attemptId },
    { paymentStatus: 'paid', stripeSessionId: 'cs_other', checkoutAttemptId: attemptId },
    { paymentStatus: 'paid', stripeSessionId: sessionId, checkoutAttemptId: 'bad' },
    { paymentStatus: 'paid', stripeSessionId: sessionId, checkoutAttemptId: null },
  ]) {
    assert.equal(confirmedCheckoutCleanupAttemptId(input, sessionId), null);
  }
  assert.equal(confirmedCheckoutCleanupAttemptId({
    paymentStatus: 'paid', stripeSessionId: sessionId, checkoutAttemptId: attemptId,
  }, null), null);
});

test('server-confirmed cleanup requires the exact durable attempt and keeps sent evidence on partial failure', () => {
  const attemptId = 'a'.repeat(32);
  for (const failingKey of [
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
    CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
    CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  ]) {
    const values = new Map<string, string>([
      [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
      [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
      [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId],
    ]);
    const attemptStorage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) {
        if (key === failingKey) throw new Error('failed');
        values.delete(key);
      },
    };
    const drafts = new Map([['hsb_order_v1', 'draft']]);
    const draftStorage = {
      getItem(key: string) { return drafts.get(key) ?? null; },
      setItem(key: string, value: string) { drafts.set(key, value); },
      removeItem(key: string) { drafts.delete(key); },
    };

    assert.equal(clearCheckoutAfterConfirmedPayment(attemptStorage, draftStorage, attemptId, 'hsb_order_v1'), false);
    assert.equal(checkoutAttemptWasSent(attemptStorage, attemptId), true);
  }

  const mismatchValues = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
  ]);
  const mismatchStorage = {
    getItem(key: string) { return mismatchValues.get(key) ?? null; },
    setItem(key: string, value: string) { mismatchValues.set(key, value); },
    removeItem(key: string) { mismatchValues.delete(key); },
  };
  assert.equal(
    clearCheckoutAfterConfirmedPayment(mismatchStorage, mismatchStorage, 'b'.repeat(32), 'hsb_order_v1'),
    false,
  );
  assert.equal(mismatchValues.get(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY), attemptId);
});

test('server-confirmed cleanup deletes the draft and sent marker last', () => {
  const attemptId = 'b'.repeat(32);
  const events: string[] = [];
  const values = new Map<string, string>([
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId],
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId],
  ]);
  const attemptStorage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { events.push(key); values.delete(key); },
  };
  const drafts = new Map([['hsb_order_v1', 'draft']]);
  const draftStorage = {
    getItem(key: string) { return drafts.get(key) ?? null; },
    setItem(key: string, value: string) { drafts.set(key, value); },
    removeItem(key: string) { events.push(key); drafts.delete(key); },
  };

  assert.equal(clearCheckoutAfterConfirmedPayment(attemptStorage, draftStorage, attemptId, 'hsb_order_v1'), true);
  assert.equal(events[0], 'hsb_order_v1');
  assert.equal(events.at(-1), CHECKOUT_ATTEMPT_SENT_STORAGE_KEY);
  assert.equal(readCheckoutAttemptStorageSnapshot(attemptStorage).attemptId, null);
});

test('checkout resolves local conflicts or a server lease before private intake and otherwise fails closed', () => {
  const snapshotRead = formSource.indexOf('let storedAttempt = readStoredCheckoutAttempt(attemptStorage)');
  const identityReconcile = formSource.indexOf('reconcileCheckoutAttemptIdentity(', snapshotRead);
  const riskRepair = formSource.indexOf('repairCheckoutAttemptStorageToRiskIdentity(', identityReconcile);
  const identityConflict = formSource.indexOf('checkoutAttemptIdentityConflict(', identityReconcile);
  const conflictAbort = formSource.indexOf('if (inMemoryIdentityConflict)', identityConflict);
  const conflictRecovery = formSource.indexOf('recoverConflictingCheckoutAttemptStorage(', conflictAbort);
  const leaseTransition = formSource.indexOf('resolveCheckoutAttemptSubmitLease({', riskRepair);
  const leaseAbort = formSource.indexOf('leaseTransition.action === "abort_unresolved"', leaseTransition);
  const conflictGuard = formSource.indexOf('if (!reconciledAttempt.reliable)', leaseAbort);
  const reservation = formSource.indexOf('markCheckoutAttemptReserved(checkoutAttemptId)', conflictGuard);
  const reservedReadback = formSource.indexOf('const reservedAttempt = serverLeaseBacked ? null : readStoredCheckoutAttempt()', reservation);
  const reservedGuard = formSource.indexOf('if (!serverLeaseBacked', reservedReadback);
  const intake = formSource.indexOf('prepareOrReuseDirectIntakeSubmission(', reservedGuard);
  assert.ok(snapshotRead > -1 && identityReconcile > snapshotRead);
  assert.ok(identityConflict > identityReconcile && conflictAbort > identityConflict);
  assert.ok(conflictRecovery > conflictAbort && riskRepair > conflictRecovery,
    'identity conflict must abort before reconciliation or storage repair');
  assert.match(
    formSource.slice(conflictAbort, conflictRecovery),
    /attemptWasPreviouslySent = true;[\s\S]*throw new Error/,
  );
  assert.ok(leaseTransition > riskRepair && leaseAbort > leaseTransition);
  assert.ok(conflictGuard > leaseAbort, 'lease failure must still stop before checkout work');
  assert.ok(reservation > conflictGuard && reservedReadback > reservation && reservedGuard > reservedReadback);
  assert.ok(intake > reservedGuard, 'all identity and reservation guards must precede private intake');
  assert.doesNotMatch(formSource, /\/api\/checkout\/attempt-status|clearAbsentCheckoutAttemptMarkers/);
});

test('checkout wiring marks an attempt sent only immediately before the order request', () => {
  const marker = formSource.indexOf('markCheckoutAttemptSent(checkoutAttemptId)');
  const requestFlag = formSource.indexOf('requestSent = true;', marker);
  const orderFetch = formSource.indexOf('fetch("/api/order"', requestFlag);
  assert.ok(marker > -1, 'missing sent-attempt marker');
  assert.ok(requestFlag > marker, 'requestSent must follow the durable marker');
  assert.ok(orderFetch > requestFlag, 'the marker and request flag must precede /api/order');
  assert.match(formSource, /if \(!serverLeaseBacked && !markCheckoutAttemptSent\(checkoutAttemptId\)\)[\s\S]{0,300}throw new Error[\s\S]{0,300}if \(!serverLeaseBacked\) checkoutAttemptSentRef\.current = checkoutAttemptId/);
  assert.match(formSource, /readStoredCheckoutAttemptSent\(\s*checkoutAttemptId,\s*checkoutAttemptSentRef\.current,?\s*\)/);
  assert.match(formSource, /if \(!serverLeaseBacked && !markCheckoutAttemptSent\(checkoutAttemptId\)\)[\s\S]{0,300}throw new Error/);
  assert.ok(
    formSource.indexOf('if (!serverLeaseBacked && !markCheckoutAttemptSent(checkoutAttemptId))')
      < formSource.indexOf('fetch("/api/order"'),
    'an unpersisted sent marker must abort before /api/order',
  );
  const reliabilityGuard = formSource.indexOf('if (!reconciledAttempt.reliable)');
  const mintAttempt = formSource.indexOf('checkoutAttemptId = newCheckoutAttemptId()', reliabilityGuard);
  assert.ok(reliabilityGuard > -1 && mintAttempt > reliabilityGuard,
    'an incomplete storage snapshot must abort before a new identity is minted');
  const acceptedCleanup = formSource.slice(
    formSource.indexOf('const handoff = performStripeHandoff(result.redirectTo'),
    formSource.indexOf('if (handoff.reason === "invalid_url")'),
  );
  assert.doesNotMatch(acceptedCleanup, /clearCheckoutAttemptStorage|clearAttemptId|clearSavedDraft|removeItem/);
  assert.doesNotMatch(formSource, /attemptMayHaveReachedServer:\s*requestSent\s*\|\|\s*attemptWasReused/);
});

test('review step visibly labels the required email field', () => {
  assert.match(
    formSource,
    /<label[^>]*htmlFor="email"[\s\S]{0,240}Email address[\s\S]{0,240}<\/label>[\s\S]{0,240}<input[\s\S]{0,160}id="email"/,
  );
  assert.match(formSource, /autoComplete="email"/);
  assert.match(formSource, /Required for your receipt and private proof link/);
});

test('people editor uses an unmistakable full-width save action and add-another confirmation', () => {
  assert.match(formSource, /Save \$\{supportingCharacterDraft\.name\.trim\(\) \|\| "person"\}/);
  assert.match(formSource, /data-testid="save-supporting-character"/);
  assert.match(formSource, /data-testid="save-supporting-character"[\s\S]{0,500}w-full/);
  assert.match(formSource, /saved\. Add another person or pet, or continue/);
});
