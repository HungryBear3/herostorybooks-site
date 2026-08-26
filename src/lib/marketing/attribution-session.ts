/**
 * Governed first-party campaign attribution.
 *
 * THE CONTRACT. `./utm-contract.ts` is the sole authority on what a campaign
 * tuple may contain: four allowlisted fields, a closed `utm_medium` vocabulary,
 * a 40-character token shape, and PII rejection. Nothing here re-implements or
 * relaxes any of it. A tuple that does not validate is DISCARDED, never stored,
 * never forwarded, and never allowed to displace a tuple that did validate.
 *
 * WHAT IS PERSISTED. Only the validated governed fields plus the epoch
 * millisecond the tuple was first seen. Never a raw URL, a referrer, a
 * fragment, an arbitrary query parameter, a path, or anything derived from
 * customer input.
 *
 * PRECEDENCE — FIRST TOUCH WINS, FOR 30 DAYS.
 *
 *   - The first valid tuple a browser sees is stored with its timestamp.
 *   - A later valid tuple does NOT overwrite it while the stored tuple is
 *     inside the window. Credit belongs to the campaign that introduced the
 *     visitor, not to whatever they clicked last on the way to paying.
 *   - Once the stored tuple is older than the window, the next valid tuple
 *     becomes the new first touch.
 *   - An invalid, empty, or partially-invalid-to-nothing tuple never
 *     overwrites, never extends the window, and never clears storage.
 *
 * That rule is a choice, not a law. It is written down here, asserted in
 * tests/marketing-attribution-session.test.ts, and documented in
 * docs/marketing/attribution-event-contract.md so a later change is a visible
 * decision rather than a drift.
 *
 * CONSENT POSTURE, STATED EXPLICITLY. This module is deliberately NOT gated on
 * marketing consent. The stored tuple is four allowlisted campaign labels with
 * PII rejection applied — it identifies a campaign, never a person, carries no
 * cross-site identifier, and is read only by HSB's own server to attribute the
 * customer's own order. Transmission to GA4 or Meta remains consent-gated at
 * those adapters. This is a documented assumption; if the owner decides
 * attribution capture itself requires consent, gate `captureAttribution` on
 * `isMarketingConsentGranted` and nothing else needs to change.
 *
 * Isomorphic: every storage access is guarded, and a browser with storage
 * disabled degrades to "current URL only" rather than throwing.
 */

import {
  GOVERNED_UTM_FIELDS,
  validateUtmTuple,
  type GovernedUtmTuple,
} from './utm-contract.ts';

/** Bounded first-party key. Versioned so a contract change cannot mis-read. */
export const ATTRIBUTION_STORAGE_KEY = 'hsb:attribution:v1';

/** First-touch window. 30 days matches the experiment board's cycle length. */
export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard ceiling on the serialized record; a bounded store cannot be a sink. */
export const ATTRIBUTION_MAX_SERIALIZED_BYTES = 512;

export interface StoredAttribution {
  /** Schema version. A different value is not trusted. */
  v: 1;
  /** The validated governed tuple. Only allowlisted fields survive here. */
  t: GovernedUtmTuple;
  /** Epoch ms of FIRST touch. Not refreshed by later visits. */
  at: number;
}

export type AttributionOutcome =
  | 'stored_first_touch'
  | 'kept_existing_first_touch'
  | 'replaced_expired'
  | 'no_valid_tuple'
  | 'unavailable';

export interface AttributionDecision {
  outcome: AttributionOutcome;
  /** The tuple that is authoritative after this decision, if any. */
  attribution: StoredAttribution | null;
}

/** Minimal storage shape, so tests inject a fake instead of touching globals. */
export interface AttributionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Parse a persisted record, accepting ONLY what the governed contract accepts.
 *
 * A stored record is re-validated rather than trusted: the contract may have
 * tightened since it was written, and a hand-edited localStorage value is
 * attacker-controlled input like any other.
 */
export function parseStoredAttribution(raw: string | null): StoredAttribution | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.length > ATTRIBUTION_MAX_SERIALIZED_BYTES) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at <= 0) {
    return null;
  }
  const result = validateUtmTuple(record.t);
  if (!result.ok || !result.tuple) return null;
  return { v: 1, t: result.tuple, at: record.at };
}

export function serializeAttribution(value: StoredAttribution): string {
  // Field order fixed so the serialized form is deterministic.
  const tuple: Record<string, string> = {};
  for (const field of GOVERNED_UTM_FIELDS) {
    const v = (value.t as unknown as Record<string, string | undefined>)[field];
    if (typeof v === 'string' && v) tuple[field] = v;
  }
  return JSON.stringify({ v: 1, t: tuple, at: value.at });
}

export function isExpired(value: StoredAttribution, now: number, ttlMs = ATTRIBUTION_TTL_MS): boolean {
  return now - value.at >= ttlMs;
}

/**
 * Decide what the authoritative attribution is, given what is stored and what
 * the current URL offers. Pure: no storage access, no clock.
 */
export function decideAttribution(args: {
  stored: StoredAttribution | null;
  incoming: unknown;
  now: number;
  ttlMs?: number;
}): AttributionDecision {
  const ttlMs = args.ttlMs ?? ATTRIBUTION_TTL_MS;
  const incoming = validateUtmTuple(args.incoming);
  const incomingTuple = incoming.ok && incoming.tuple ? incoming.tuple : null;
  const stored = args.stored;

  if (stored && !isExpired(stored, args.now, ttlMs)) {
    // A live first touch is never displaced, valid challenger or not.
    return { outcome: 'kept_existing_first_touch', attribution: stored };
  }

  if (!incomingTuple) {
    // Nothing valid to store. An expired record is left in place rather than
    // cleared: it is harmless, and clearing would be a write with no benefit.
    return { outcome: 'no_valid_tuple', attribution: stored ?? null };
  }

  const next: StoredAttribution = { v: 1, t: incomingTuple, at: args.now };
  return {
    outcome: stored ? 'replaced_expired' : 'stored_first_touch',
    attribution: next,
  };
}

/**
 * Read the governed tuple out of a query string. Only the four governed keys
 * are even looked at; everything else in the URL is ignored, not stored.
 */
export function attributionFromSearch(search: string): Partial<Record<string, string>> {
  const out: Record<string, string> = {};
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search ?? '');
  } catch {
    return out;
  }
  for (const field of GOVERNED_UTM_FIELDS) {
    const value = params.get(field);
    // Bound before validation so a megabyte query value is never carried.
    if (typeof value === 'string' && value.length <= 200) out[field] = value;
  }
  return out;
}

/**
 * Capture attribution for this browser: read storage, apply precedence, write
 * back only when the decision actually changed the authoritative tuple.
 */
export function captureAttribution(args: {
  search: string;
  storage?: AttributionStorage | null;
  now: number;
  ttlMs?: number;
}): AttributionDecision {
  const storage = args.storage;
  if (!storage) return { outcome: 'unavailable', attribution: null };

  let stored: StoredAttribution | null = null;
  try {
    stored = parseStoredAttribution(storage.getItem(ATTRIBUTION_STORAGE_KEY));
  } catch {
    stored = null;
  }

  const decision = decideAttribution({
    stored,
    incoming: attributionFromSearch(args.search),
    now: args.now,
    ttlMs: args.ttlMs,
  });

  if (
    (decision.outcome === 'stored_first_touch' || decision.outcome === 'replaced_expired') &&
    decision.attribution
  ) {
    try {
      storage.setItem(ATTRIBUTION_STORAGE_KEY, serializeAttribution(decision.attribution));
    } catch {
      // Privacy mode / quota. The in-memory decision still serves this page.
    }
  }

  return decision;
}

/** The browser's storage, or null when it is unavailable. Never throws. */
export function browserAttributionStorage(): AttributionStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    const store = window.localStorage;
    if (!store) return null;
    return store;
  } catch {
    return null;
  }
}

/** The authoritative tuple for this browser right now, or null. */
export function currentAttribution(now = Date.now()): GovernedUtmTuple | null {
  const storage = browserAttributionStorage();
  if (!storage) return null;
  let stored: StoredAttribution | null = null;
  try {
    stored = parseStoredAttribution(storage.getItem(ATTRIBUTION_STORAGE_KEY));
  } catch {
    return null;
  }
  if (!stored) return null;
  if (isExpired(stored, now)) return null;
  return stored.t;
}

/**
 * Flatten a tuple into the exact string map that may cross a server boundary
 * (checkout body, Stripe metadata). Only governed keys, only validated values.
 */
export function attributionMetadata(tuple: GovernedUtmTuple | null): Record<string, string> {
  if (!tuple) return {};
  const out: Record<string, string> = {};
  for (const field of GOVERNED_UTM_FIELDS) {
    const value = (tuple as unknown as Record<string, string | undefined>)[field];
    if (typeof value === 'string' && value) out[field] = value;
  }
  return out;
}
