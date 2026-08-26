/**
 * THE single source of truth for optional browser measurement consent.
 *
 * One store governs GA4 and Meta together. Both adapters subscribe here; there
 * is no second mechanism, and no adapter is allowed to decide for itself.
 *
 * DEFAULT IS NOT CONSENT. With no stored choice the state is 'unknown', and
 * 'unknown' enables nothing. Only an explicit 'granted' turns anything on.
 * There is no pre-checked box, no implied consent from continued browsing, and
 * no "reject" path that is harder to reach than "accept" — accept and decline
 * are the same two buttons, same prominence, same number of clicks.
 *
 * WHAT IS STORED, AND WHEN. Nothing at all until the visitor chooses. On a
 * choice, one bounded first-party localStorage entry:
 *
 *     hsb:consent:v1  ->  {"v":1,"c":"granted"|"denied","at":<epoch ms>}
 *
 * No cookie is set, so a visitor who never chooses leaves no storage behind and
 * nothing needs disclosing for them. No identifier, no fingerprint, no
 * cross-site value: the record says what was chosen and when, and nothing that
 * could distinguish one visitor from another.
 *
 * REACTIVITY. `setConsent` notifies subscribers synchronously in the current
 * tab, so a decline takes effect without a reload and an accept initialises the
 * adapters exactly once. A `storage` event mirrors a choice made in another tab
 * of the same browser.
 *
 * BACK-COMPAT. The chosen state is mirrored onto the documented global that
 * `./consent.ts` reads, so existing consumers keep working unchanged.
 *
 * ESSENTIAL BEHAVIOUR IS NEVER GATED. Nothing in the ordering, payment,
 * fulfilment, or family-review paths consults this module. Declining optional
 * measurement must leave the product fully functional.
 */

import { CONSENT_GLOBAL_KEY, type ConsentState } from './consent.ts';

export type ConsentChoice = 'granted' | 'denied';

/** Bounded, versioned, first-party. */
export const CONSENT_STORAGE_KEY = 'hsb:consent:v1';

/** Same-tab notification channel. */
export const CONSENT_EVENT_NAME = 'hsb:consent-changed';

/** A stored record longer than this is not a consent record. */
export const CONSENT_MAX_SERIALIZED_BYTES = 128;

export interface StoredConsent {
  v: 1;
  c: ConsentChoice;
  at: number;
}

export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Parse a persisted choice. Anything unrecognised is 'unknown', not a grant. */
export function parseStoredConsent(raw: string | null): StoredConsent | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.length > CONSENT_MAX_SERIALIZED_BYTES) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (record.c !== 'granted' && record.c !== 'denied') return null;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at <= 0) {
    return null;
  }
  return { v: 1, c: record.c, at: record.at };
}

export function readStoredConsent(storage: ConsentStorage | null): ConsentState {
  if (!storage) return 'unknown';
  try {
    const parsed = parseStoredConsent(storage.getItem(CONSENT_STORAGE_KEY));
    return parsed ? parsed.c : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The browser's storage, or null. Never throws. */
export function browserConsentStorage(): ConsentStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

type ConsentListener = (state: ConsentState) => void;
const listeners = new Set<ConsentListener>();

/** In-memory mirror so a storage-less browser is still reactive in-tab. */
let currentState: ConsentState | null = null;

function mirrorToGlobal(state: ConsentState): void {
  try {
    if (typeof globalThis === 'undefined') return;
    (globalThis as Record<string, unknown>)[CONSENT_GLOBAL_KEY] =
      state === 'unknown' ? undefined : state;
  } catch {
    /* a frozen global is not a reason to fail a consent change */
  }
}

function notify(state: ConsentState): void {
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch {
      /* one bad subscriber must not block the others */
    }
  }
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(CONSENT_EVENT_NAME, { detail: state }));
    }
  } catch {
    /* event dispatch is a convenience, not the mechanism */
  }
}

/** Current consent. Reads storage once, then serves the in-memory mirror. */
export function getConsent(): ConsentState {
  if (currentState !== null) return currentState;
  const state = readStoredConsent(browserConsentStorage());
  currentState = state;
  mirrorToGlobal(state);
  return state;
}

/** Record an explicit choice and notify every subscriber in this tab. */
export function setConsent(choice: ConsentChoice, now = Date.now()): void {
  const storage = browserConsentStorage();
  if (storage) {
    try {
      storage.setItem(
        CONSENT_STORAGE_KEY,
        JSON.stringify({ v: 1, c: choice, at: now } satisfies StoredConsent),
      );
    } catch {
      /* privacy mode: the choice still governs this tab */
    }
  }
  currentState = choice;
  mirrorToGlobal(choice);
  notify(choice);
}

/**
 * Withdraw the stored choice and return to 'unknown'.
 *
 * This is the "change your mind" path: it disables optional measurement
 * immediately and re-offers the choice, rather than silently switching to a
 * grant.
 */
export function clearConsent(): void {
  const storage = browserConsentStorage();
  if (storage) {
    try {
      storage.removeItem(CONSENT_STORAGE_KEY);
    } catch {
      /* nothing to undo */
    }
  }
  currentState = 'unknown';
  mirrorToGlobal('unknown');
  notify('unknown');
}

/** Subscribe to consent changes. Returns an unsubscribe function. */
export function subscribeConsent(listener: ConsentListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset module state. Test-only; never called by application code. */
export function __resetConsentStoreForTests(): void {
  listeners.clear();
  currentState = null;
  mirrorToGlobal('unknown');
}

/**
 * Mirror a choice made in another tab. Attached once by the consent surface.
 * Returns a detach function.
 */
export function attachCrossTabConsentSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CONSENT_STORAGE_KEY) return;
    const next = parseStoredConsent(event.newValue);
    const state: ConsentState = next ? next.c : 'unknown';
    currentState = state;
    mirrorToGlobal(state);
    notify(state);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
