/**
 * Standing, machine-checkable house rules for custom-memory stories.
 *
 * Gatekeeper review P8: the §4 house rules ship as a standing list merged with
 * each order's `mustAvoid[]`, so no order has to re-discover the same hazards.
 * These are matched as whole-word / phrase substrings against sanitized briefs,
 * plans, and final prose — a hit is an automatic fail (§4 "any hit = fail").
 *
 * This is a lexicon, not a policy engine: it catches the obvious adult-conflict
 * and sensitive-topic vocabulary. Two-reviewer creative QA remains the backstop
 * for tone/subtext the word list can't see.
 */

/** Adult-conflict + sensitive-topic terms that must never reach a children's book. */
export const GLOBAL_BAN_TERMS: readonly string[] = [
  // Relationship conflict
  'divorce',
  'separation',
  'separated',
  'breakup',
  'break up',
  'affair',
  'cheating',
  'custody',
  'apology fight',
  'blame',
  'blaming',
  'argument',
  'fighting',
  'shouting match',
  // Health / body
  'illness',
  'cancer',
  'diagnosis',
  'hospital',
  'surgery',
  'medication',
  'overdose',
  'weight',
  'diet',
  'fat',
  'skinny',
  // Substances
  'alcohol',
  'drunk',
  'beer',
  'wine',
  'cocktail',
  'hangover',
  'drugs',
  'smoking',
  // Money / legal
  'bankrupt',
  'bankruptcy',
  'debt',
  'mortgage',
  'lawsuit',
  'lawyer',
  'court',
  'eviction',
  // Discipline / peril (adult-framed)
  'grounded',
  'punishment',
  'spanking',
  // Profanity (mild set; extend as needed)
  'damn',
  'hell',
];

/**
 * Preset-theme lexicon. A custom story that contains any of these has been
 * contaminated by a canned template (Taco Gate's jungle-template takeover).
 * Gatekeeper review §4: any preset template phrase appearing = automatic fail +
 * bug, not a rewrite.
 */
export const PRESET_TEMPLATE_LEXICON: readonly string[] = [
  'listening stones',
  'listening stone',
  'brave explorer',
  'space voyager',
  'ocean dreams',
  'dinosaur discovery',
  'dragon quest',
  'jungle',
  'temple',
  'ancient ruins',
  'enchanted forest',
];

/**
 * Merge the standing global ban list with an order's per-brief `mustAvoid[]`,
 * de-duplicated and lower-cased for matching (P8).
 */
export function mergedAvoidTerms(perOrderMustAvoid: readonly string[]): string[] {
  const set = new Set<string>();
  for (const term of GLOBAL_BAN_TERMS) set.add(term.toLowerCase());
  for (const term of perOrderMustAvoid) {
    const t = term.trim().toLowerCase();
    if (t) set.add(t);
  }
  return [...set];
}
