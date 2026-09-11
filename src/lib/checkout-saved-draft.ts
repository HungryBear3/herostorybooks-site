type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Browser File objects and blob/data preview URLs cannot survive JSON storage.
 * Keep only the character details a buyer can safely resume after a reload.
 */
export function savedFamilyCharactersForStorage(
  characters: readonly unknown[],
): UnknownRecord[] {
  return characters.filter(isRecord).map((character) => {
    const {
      photoFile: _photoFile,
      photoDataUrl: _photoDataUrl,
      ...saved
    } = character;
    return saved;
  });
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeSavedFamilyCharacter(value: unknown): UnknownRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  if (typeof value.role !== 'string' || !value.role.trim()) return null;
  return {
    id: value.id,
    role: value.role,
    name: stringValue(value.name),
    relationshipLabel: stringValue(value.relationshipLabel),
    pronouns: stringValue(value.pronouns),
    notes: stringValue(value.notes),
    isGiftRecipient: typeof value.isGiftRecipient === 'boolean' ? value.isGiftRecipient : false,
    appearsInStory: typeof value.appearsInStory === 'boolean' ? value.appearsInStory : true,
    photoFile: null,
    photoDataUrl: null,
    mustInclude: stringArray(value.mustInclude),
    mustIncludeOther: stringValue(value.mustIncludeOther),
    focusPersonLabel: stringValue(value.focusPersonLabel),
    cropHint: stringValue(value.cropHint),
  };
}

/**
 * Treat every restored checkout draft as text-only and normalize every field
 * that FormState later reads as a string, array, or boolean. Browser storage is
 * untrusted: legacy/manual values must not reach `.trim()`, `.filter()`, etc.
 */
export function sanitizeSavedCheckoutDraft(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};

  const familyCharacters = Array.isArray(value.familyCharacters)
    ? value.familyCharacters
        .map(normalizeSavedFamilyCharacter)
        .filter((character): character is UnknownRecord => character !== null)
    : [];
  const savedAt = typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
    ? value.savedAt
    : 0;

  return {
    theme: stringValue(value.theme),
    childName: stringValue(value.childName),
    heroType: stringValue(value.heroType),
    childAge: stringValue(value.childAge),
    recipientName: stringValue(value.recipientName),
    recipientRelationship: stringValue(value.recipientRelationship),
    lesson: stringValue(value.lesson),
    occasion: stringValue(value.occasion),
    giftMessage: stringValue(value.giftMessage),
    characterNotes: stringValue(value.characterNotes),
    customStoryMemory: stringValue(value.customStoryMemory),
    customStorySourceMode: stringValue(value.customStorySourceMode),
    familyCharacters,
    mustInclude: stringArray(value.mustInclude),
    mustIncludeOther: stringValue(value.mustIncludeOther),
    bookFormat: stringValue(value.bookFormat),
    email: stringValue(value.email),
    savedAt,
    photoFile: null,
    photoDataUrl: null,
    voiceFile: null,
    voicePreviewUrl: null,
    voiceSource: null,
    voiceConsent: false,
  };
}

export function checkoutAttemptMayHaveReachedServer(input: {
  requestSent: boolean;
  previouslySent: boolean;
}): boolean {
  return input.requestSent || input.previouslySent;
}

/**
 * A serialized `File` parses back as `{}` — truthy, but with no name, size, or
 * type. Direct intake reads `file.type`/`file.name` to pick a canonical MIME,
 * so a stale placeholder is refused synchronously, before `/api/checkout/intake`
 * is ever called. Require the two properties every real `File` carries so a
 * restored draft can never enter the direct-upload lane.
 */
function isUsableMediaFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && typeof value.size === 'number';
}

export function checkoutDraftHasDirectMediaFiles(input: {
  photoFile?: unknown;
  voiceFile?: unknown;
  guidedFrameCount?: number;
  familyCharacters?: readonly unknown[];
}): boolean {
  if (isUsableMediaFile(input.photoFile)) return true;
  if (isUsableMediaFile(input.voiceFile)) return true;
  if ((input.guidedFrameCount ?? 0) > 0) return true;
  return (input.familyCharacters ?? []).some(
    (character) => isRecord(character) && isUsableMediaFile(character.photoFile),
  );
}

export const CHECKOUT_ATTEMPT_ID_STORAGE_KEY = 'hsb-checkout-attempt-id';
export const CHECKOUT_DRAFT_STORAGE_KEY = 'hsb_order_v1';
export const CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY = 'hsb-checkout-attempt-cleanup';
export const CHECKOUT_ATTEMPT_SENT_STORAGE_KEY = 'hsb-checkout-attempt-sent';
export const CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY = 'hsb-checkout-attempt-reserved';
const CHECKOUT_ATTEMPT_ID_RE = /^[a-f0-9]{32}$/;

export interface MinimalWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CheckoutAttemptStorageSnapshot {
  attemptId: string | null;
  reliable: boolean;
}

/**
 * Prove that attempt storage is wholly unavailable before using the cookie
 * lease fallback. Partial reads or any readable risk identity stay fail-closed.
 */
export function checkoutAttemptStorageUnavailable(
  storage: MinimalWebStorage | null | undefined,
  snapshot: CheckoutAttemptStorageSnapshot,
): boolean {
  if (!storage) return true;

  let successfulReads = 0;
  let failedReads = 0;
  let readableIdentity = false;
  for (const key of CHECKOUT_ATTEMPT_STORAGE_KEYS) {
    try {
      const value = storage.getItem(key);
      successfulReads += 1;
      if (value !== null) readableIdentity = true;
    } catch {
      failedReads += 1;
    }
  }
  if (failedReads === CHECKOUT_ATTEMPT_STORAGE_KEYS.length) return true;
  if (failedReads > 0 || successfulReads !== CHECKOUT_ATTEMPT_STORAGE_KEYS.length) return false;
  if (readableIdentity || snapshot.attemptId || !snapshot.reliable) return false;

  const probeKey = 'hsb-checkout-attempt-storage-probe';
  const probeValue = '1';
  try {
    storage.setItem(probeKey, probeValue);
    if (storage.getItem(probeKey) !== probeValue) return true;
    storage.removeItem(probeKey);
    return storage.getItem(probeKey) !== null;
  } catch {
    try { storage.removeItem(probeKey); } catch { /* storage is unavailable */ }
    return true;
  }
}

const CHECKOUT_ATTEMPT_STORAGE_KEYS = [
  CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
  CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
  CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
] as const;

/**
 * Repair only toward one unambiguous high-risk identity. A `sent` or `cleanup`
 * marker means that exact attempt may already own an order/provider Session, so
 * lower-risk primary/reserved drift may be rewritten to that identity. This
 * never clears evidence, never chooses between conflicting high-risk markers,
 * and never mints a new attempt.
 */
export function repairCheckoutAttemptStorageToRiskIdentity(
  storage: MinimalWebStorage | null | undefined,
): boolean {
  if (!storage) return false;
  const values = new Map<(typeof CHECKOUT_ATTEMPT_STORAGE_KEYS)[number], string | null>();
  try {
    for (const key of CHECKOUT_ATTEMPT_STORAGE_KEYS) {
      const value = storage.getItem(key);
      if (value !== null && !CHECKOUT_ATTEMPT_ID_RE.test(value)) return false;
      values.set(key, value);
    }
  } catch {
    return false;
  }

  const cleanup = values.get(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY) ?? null;
  const sent = values.get(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) ?? null;
  if (cleanup && sent && cleanup !== sent) return false;
  const riskIdentity = cleanup ?? sent;
  if (!riskIdentity) return false;

  try {
    storage.setItem(CHECKOUT_ATTEMPT_ID_STORAGE_KEY, riskIdentity);
    storage.setItem(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, riskIdentity);
  } catch {
    return false;
  }
  const repaired = readCheckoutAttemptStorageSnapshot(storage);
  return repaired.reliable && repaired.attemptId === riskIdentity;
}

/**
 * Recover a readable private-browser store containing more than one attempt.
 * Every identity that may have reached the server is confirmed terminal before
 * any marker is removed. A matching primary+reserved identity is locally
 * proven unsent and may be discarded without a server lookup.
 */
export async function recoverConflictingCheckoutAttemptStorage(
  storage: MinimalWebStorage | null | undefined,
  resolveAttempt: (attemptId: string) => Promise<'restart_allowed' | 'resume_required' | 'unknown'>,
): Promise<boolean> {
  if (!storage) return false;
  const values = new Map<(typeof CHECKOUT_ATTEMPT_STORAGE_KEYS)[number], string | null>();
  try {
    for (const key of CHECKOUT_ATTEMPT_STORAGE_KEYS) {
      const value = storage.getItem(key);
      if (value !== null && !CHECKOUT_ATTEMPT_ID_RE.test(value)) return false;
      values.set(key, value);
    }
  } catch {
    return false;
  }

  const identities = new Set(
    [...values.values()].filter((value): value is string => Boolean(value)),
  );
  if (identities.size <= 1) return false;

  const primary = values.get(CHECKOUT_ATTEMPT_ID_STORAGE_KEY) ?? null;
  const cleanup = values.get(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY) ?? null;
  const sent = values.get(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) ?? null;
  const reserved = values.get(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY) ?? null;
  const needsServerConfirmation = new Set<string>();
  if (cleanup) needsServerConfirmation.add(cleanup);
  if (sent) needsServerConfirmation.add(sent);
  // Current builds persist primary+reserved before dispatch. A primary without
  // its matching reserved marker can be legacy/sent and must be reconciled.
  if (primary && primary !== reserved) needsServerConfirmation.add(primary);
  if (needsServerConfirmation.size === 0) return false;

  for (const attemptId of needsServerConfirmation) {
    if (await resolveAttempt(attemptId) !== 'restart_allowed') return false;
  }

  // Remove low-risk primary/reserved markers first. Sent/cleanup evidence stays
  // until last, so an interrupted cleanup remains conservative on remount.
  for (const key of [
    CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
    CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
    CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  ]) {
    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function confirmedCheckoutCleanupAttemptId(
  order: {
    paymentStatus?: unknown;
    stripeSessionId?: unknown;
    checkoutAttemptId?: unknown;
  } | null | undefined,
  requestedSessionId: string | null | undefined,
): string | null {
  if (!order || order.paymentStatus !== 'paid') return null;
  if (typeof requestedSessionId !== 'string' || !requestedSessionId) return null;
  if (order.stripeSessionId !== requestedSessionId) return null;
  if (typeof order.checkoutAttemptId !== 'string' || !CHECKOUT_ATTEMPT_ID_RE.test(order.checkoutAttemptId)) {
    return null;
  }
  return order.checkoutAttemptId;
}

/**
 * Reconcile React's same-mount identity with durable browser evidence before
 * any private intake or upload. A ref is never allowed to override a missing
 * or different durable identity.
 */
export function reconcileCheckoutAttemptIdentity(
  snapshot: CheckoutAttemptStorageSnapshot,
  inMemoryAttemptId: string | null | undefined,
): CheckoutAttemptStorageSnapshot {
  if (!snapshot.reliable) return snapshot;
  if (inMemoryAttemptId && snapshot.attemptId !== inMemoryAttemptId) {
    return { attemptId: snapshot.attemptId ?? inMemoryAttemptId, reliable: false };
  }
  return { attemptId: snapshot.attemptId, reliable: true };
}

/**
 * Read every attempt key independently. One inaccessible key or conflicting
 * identity makes the snapshot unreliable, even when another key is readable:
 * callers must not mint or dispatch a new attempt from an incomplete view.
 */
export function readCheckoutAttemptStorageSnapshot(
  storage: MinimalWebStorage | null | undefined,
): CheckoutAttemptStorageSnapshot {
  if (!storage) return { attemptId: null, reliable: false };

  let reliable = true;
  const read = (key: string): string | null => {
    try {
      const value = storage.getItem(key);
      if (value !== null && !CHECKOUT_ATTEMPT_ID_RE.test(value)) reliable = false;
      return value && CHECKOUT_ATTEMPT_ID_RE.test(value) ? value : null;
    } catch {
      reliable = false;
      return null;
    }
  };

  const primary = read(CHECKOUT_ATTEMPT_ID_STORAGE_KEY);
  const cleanup = read(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY);
  const sent = read(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY);
  const reserved = read(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY);
  const identities = new Set([primary, cleanup, sent, reserved].filter((value): value is string => Boolean(value)));
  if (identities.size > 1) reliable = false;

  // Cleanup and sent identities are highest risk and win recovery priority.
  return { attemptId: cleanup ?? sent ?? primary ?? reserved, reliable };
}

/**
 * Reserving a checkout attempt ID is NOT server exposure: the ID is minted
 * locally so direct uploads and `/api/order` stay idempotent across retries.
 * Only a dispatched `/api/order` request can create an order or a Stripe
 * Session. The marker is bound to the attempt ID it was written for so a new
 * attempt can never inherit an older attempt's dispatch. A missing marker for
 * an existing attempt is conservatively ambiguous: it may have been created by
 * an older build or by a browser that accepted the ID write but rejected the
 * sent-marker write.
 */
export function checkoutAttemptWasSent(
  storage: MinimalWebStorage | null | undefined,
  attemptId: string | null | undefined,
  inMemorySentAttemptId?: string | null,
): boolean {
  if (!attemptId) return false;
  if (inMemorySentAttemptId === attemptId) return true;
  if (!storage) return true;
  try {
    if (storage.getItem(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY) === attemptId) return true;
    if (storage.getItem(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) === attemptId) return true;
    if (storage.getItem(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY) === attemptId) return false;
    return true;
  } catch {
    return true;
  }
}

export function recordCheckoutAttemptReserved(
  storage: MinimalWebStorage | null | undefined,
  attemptId: string,
): boolean {
  if (!storage || !attemptId) return false;
  try {
    storage.setItem(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY, attemptId);
    return storage.getItem(CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY) === attemptId;
  } catch {
    return false;
  }
}

export function recordCheckoutAttemptSent(
  storage: MinimalWebStorage | null | undefined,
  attemptId: string,
): boolean {
  if (!storage || !attemptId) return false;
  try {
    storage.setItem(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY, attemptId);
    return storage.getItem(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) === attemptId;
  } catch {
    return false;
  }
}

export function forgetCheckoutAttemptSent(
  storage: MinimalWebStorage | null | undefined,
): void {
  if (!storage) return;
  for (const key of [
    CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
  ]) {
    try {
      storage.removeItem(key);
    } catch {
      /* continue so every marker gets a cleanup attempt */
    }
  }
}

/**
 * Clear accepted-handoff browser state monotonically.
 *
 * The optional callback deletes the saved draft only after the cleanup
 * tombstone is durable. Every attempt-key removal is read back; browsers that
 * silently ignore removeItem therefore retain the tombstone and sent-risk.
 */
export function clearCheckoutAttemptStorage(
  storage: MinimalWebStorage | null | undefined,
  attemptId: string,
  clearSavedDraft?: () => boolean,
): boolean {
  if (!storage || !CHECKOUT_ATTEMPT_ID_RE.test(attemptId)) return false;

  // Establish monotonic sent-risk evidence before deleting anything. If this
  // cannot be persisted and read back, leave all existing markers untouched.
  try {
    storage.setItem(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY, attemptId);
    if (storage.getItem(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY) !== attemptId) return false;
  } catch {
    return false;
  }

  if (clearSavedDraft) {
    try {
      if (!clearSavedDraft()) return false;
    } catch {
      return false;
    }
  }

  let cleared = true;
  for (const key of [
    CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
    CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
  ]) {
    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) cleared = false;
    } catch {
      cleared = false;
    }
  }
  if (!cleared) return false;

  // Remove and verify the tombstone last. Any failure keeps remounts
  // conservative rather than downgrading a known-sent attempt.
  try {
    storage.removeItem(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY);
    return storage.getItem(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

/**
 * Clear browser checkout state only after the server has confirmed the exact
 * paid order/session/attempt tuple. Draft deletion is verified first; lower-
 * risk markers follow, and the durable sent marker is removed last. Every
 * failure before that last step therefore remains known-sent after remount.
 */
export function clearCheckoutAfterConfirmedPayment(
  attemptStorage: MinimalWebStorage | null | undefined,
  draftStorage: MinimalWebStorage | null | undefined,
  confirmedAttemptId: string,
  draftKey: string,
): boolean {
  if (!attemptStorage || !draftStorage || !CHECKOUT_ATTEMPT_ID_RE.test(confirmedAttemptId)) {
    return false;
  }
  const snapshot = readCheckoutAttemptStorageSnapshot(attemptStorage);
  if (!snapshot.reliable || snapshot.attemptId !== confirmedAttemptId) return false;
  if (!checkoutAttemptWasSent(attemptStorage, confirmedAttemptId)) return false;

  try {
    draftStorage.removeItem(draftKey);
    if (draftStorage.getItem(draftKey) !== null) return false;
  } catch {
    return false;
  }

  for (const key of [
    CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
    CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
    CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  ]) {
    try {
      attemptStorage.removeItem(key);
      if (attemptStorage.getItem(key) !== null) return false;
    } catch {
      return false;
    }
  }

  try {
    attemptStorage.removeItem(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY);
    return attemptStorage.getItem(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY) === null;
  } catch {
    // Payment is server-confirmed. Remove-then-throw may have completed the
    // intended cleanup; throw-before-remove safely retains sent-risk.
    return false;
  }
}
