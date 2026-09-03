/**
 * Client-side slot state for the direct-upload checkout, with the same
 * generation fencing the server uses.
 *
 * The server can refuse a stale write. It cannot stop a stale READ from being
 * painted into the page — and on a slow connection that is its own way to lose
 * a buyer's selection: the page reloads, asks for the saved assets, the buyer
 * picks a replacement while that request is still in flight, and the late
 * response restores the old photo as "saved".
 *
 * So every slot carries a CLIENT generation, bumped by every local intent
 * (select, change, remove). An in-flight read captures the generations it was
 * issued against, and on arrival each slot is applied only if its generation
 * has not moved. Same rule as the server, applied to reads instead of writes.
 *
 * Deliberately pure: plain data in, plain data out, no fetch, no storage, no
 * React. The rule is then testable exactly rather than through a rendered
 * component, and the checkout form can hold this in a single `useState`.
 */

export type SlotClientState = 'empty' | 'uploading' | 'saved';

export interface SlotClientEntry {
  slotKey: string;
  state: SlotClientState;
  /** The server asset id, once an upload for the CURRENT generation landed. */
  assetId: string | null;
  clientGeneration: number;
}

export interface IntakeClientState {
  slots: Record<string, SlotClientEntry>;
}

/** Issued for one local intent; only valid while that slot has not moved on. */
export interface SlotTicket {
  slotKey: string;
  clientGeneration: number;
}

/** Issued for one asset-list read; captures every slot's generation. */
export interface SlotListTicket {
  generations: Record<string, number>;
}

export interface ServerSlotView {
  slotKey: string;
  assetId: string | null;
  generation: number;
  pendingGeneration?: number | null;
}

export function createIntakeClientState(): IntakeClientState {
  return { slots: {} };
}

function generationOf(state: IntakeClientState, slotKey: string): number {
  return state.slots[slotKey]?.clientGeneration ?? 0;
}

function withSlot(state: IntakeClientState, entry: SlotClientEntry): IntakeClientState {
  return { ...state, slots: { ...state.slots, [entry.slotKey]: entry } };
}

/**
 * Records the intent to put a new file in a slot.
 *
 * Bumping here is what invalidates everything already in flight for the slot:
 * an earlier upload's result, and any asset-list read issued before now.
 */
export function beginSlotUpload(
  state: IntakeClientState,
  slotKey: string,
): { state: IntakeClientState; ticket: SlotTicket } {
  const clientGeneration = generationOf(state, slotKey) + 1;
  return {
    state: withSlot(state, { slotKey, state: 'uploading', assetId: null, clientGeneration }),
    ticket: { slotKey, clientGeneration },
  };
}

/** Records the intent to empty a slot (Remove, or the cancel half of Change). */
export function clearSlot(
  state: IntakeClientState,
  slotKey: string,
): { state: IntakeClientState; ticket: SlotTicket } {
  const clientGeneration = generationOf(state, slotKey) + 1;
  return {
    state: withSlot(state, { slotKey, state: 'empty', assetId: null, clientGeneration }),
    ticket: { slotKey, clientGeneration },
  };
}

export function slotTicketIsCurrent(state: IntakeClientState, ticket: SlotTicket): boolean {
  return generationOf(state, ticket.slotKey) === ticket.clientGeneration;
}

/**
 * Commits a finished upload — but only for the selection that is still
 * current. A result for a superseded ticket is dropped, never merged.
 */
export function commitSlotUpload(
  state: IntakeClientState,
  ticket: SlotTicket,
  result: { assetId: string },
): { state: IntakeClientState; committed: boolean } {
  if (!slotTicketIsCurrent(state, ticket)) return { state, committed: false };
  return {
    state: withSlot(state, {
      slotKey: ticket.slotKey,
      state: 'saved',
      assetId: result.assetId,
      clientGeneration: ticket.clientGeneration,
    }),
    committed: true,
  };
}

/** Marks a slot's upload as failed so the buyer can retry it. */
export function failSlotUpload(
  state: IntakeClientState,
  ticket: SlotTicket,
): { state: IntakeClientState; committed: boolean } {
  if (!slotTicketIsCurrent(state, ticket)) return { state, committed: false };
  return {
    state: withSlot(state, {
      slotKey: ticket.slotKey,
      state: 'empty',
      assetId: null,
      clientGeneration: ticket.clientGeneration,
    }),
    committed: true,
  };
}

/** Snapshots every slot's generation for an asset-list read about to be sent. */
export function beginSlotListRefresh(state: IntakeClientState): SlotListTicket {
  const generations: Record<string, number> = {};
  for (const [slotKey, entry] of Object.entries(state.slots)) {
    generations[slotKey] = entry.clientGeneration;
  }
  return { generations };
}

/**
 * Merges an asset-list response, slot by slot, dropping any slot the buyer
 * touched after the request was issued.
 *
 * A slot missing from the response is emptied — the server is authoritative
 * about what it holds — but only when that slot is also unfenced, so a local
 * selection still uploading is never wiped by a response that predates it.
 */
export function applySlotListRefresh(
  state: IntakeClientState,
  ticket: SlotListTicket,
  incoming: readonly ServerSlotView[],
): { state: IntakeClientState; applied: string[]; dropped: string[] } {
  const applied: string[] = [];
  const dropped: string[] = [];
  const slots = { ...state.slots };
  const seen = new Set<string>();

  const fenced = (slotKey: string): boolean => (
    generationOf(state, slotKey) !== (ticket.generations[slotKey] ?? 0)
  );

  for (const view of incoming) {
    seen.add(view.slotKey);
    if (fenced(view.slotKey)) {
      dropped.push(view.slotKey);
      continue;
    }
    applied.push(view.slotKey);
    slots[view.slotKey] = {
      slotKey: view.slotKey,
      state: view.pendingGeneration != null ? 'uploading' : view.assetId ? 'saved' : 'empty',
      assetId: view.pendingGeneration != null ? null : view.assetId ?? null,
      clientGeneration: generationOf(state, view.slotKey),
    };
  }

  for (const slotKey of Object.keys(slots)) {
    if (seen.has(slotKey)) continue;
    if (fenced(slotKey)) {
      if (!dropped.includes(slotKey)) dropped.push(slotKey);
      continue;
    }
    if (slots[slotKey]!.state === 'empty' && slots[slotKey]!.assetId === null) continue;
    applied.push(slotKey);
    slots[slotKey] = { ...slots[slotKey]!, state: 'empty', assetId: null };
  }

  return { state: { ...state, slots }, applied, dropped };
}

/**
 * True when no slot is mid-upload.
 *
 * Readiness must be gated on this: a slot that is still uploading is not a
 * saved photo, and treating it as one is how a half-finished replacement gets
 * carried into an order.
 */
export function slotsAreSettled(state: IntakeClientState): boolean {
  return Object.values(state.slots).every((entry) => entry.state !== 'uploading');
}

/** The asset ids currently bound, for building a finalize selection. */
export function savedSlotAssets(state: IntakeClientState): Array<{ slotKey: string; assetId: string }> {
  return Object.values(state.slots)
    .filter((entry): entry is SlotClientEntry & { assetId: string } => (
      entry.state === 'saved' && typeof entry.assetId === 'string' && entry.assetId.length > 0
    ))
    .map((entry) => ({ slotKey: entry.slotKey, assetId: entry.assetId }))
    .sort((a, b) => a.slotKey.localeCompare(b.slotKey));
}
