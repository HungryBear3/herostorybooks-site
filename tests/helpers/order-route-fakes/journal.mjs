/** Shared journal of every external call the route made. */
export const journal = [];

export function record(surface, op, detail) {
  journal.push({ surface, op, detail: detail ?? null });
}
