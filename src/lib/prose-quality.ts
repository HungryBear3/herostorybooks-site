/**
 * Deterministic prose-quality fixers used by the template fallback (and as a
 * defensive post-pass on generated prose).
 *
 * - fixSingularTheyAgreement: corrects singular-verb agreement after "they"
 *   ("They tells" → "They tell", "they does" → "they do", "they is" → "they are").
 *   English never legitimately writes "they + 3rd-person-singular verb", so the
 *   correction is safe to run unconditionally on any pronoun.
 * - spreadIndex: pick from a fixed line pool with a coprime stride so adjacent
 *   pages never reuse the same templated line (reduces obvious repetition).
 */

// "they <verb>" agreement fixes for the bounded verb set the templates use.
const THEY_VERB_BASE: Record<string, string> = {
  tells: 'tell', understands: 'understand', chooses: 'choose', explains: 'explain',
  studies: 'study', waits: 'wait', moves: 'move', hurries: 'hurry', pauses: 'pause',
  follows: 'follow', crouches: 'crouch', hears: 'hear', sets: 'set', reaches: 'reach',
  catches: 'catch', turns: 'turn', smiles: 'smile', gives: 'give', keeps: 'keep',
  stands: 'stand', takes: 'take', checks: 'check', hovers: 'hover', starts: 'start',
  makes: 'make', grows: 'grow', shifts: 'shift', notices: 'notice', brushes: 'brush',
  holds: 'hold', knows: 'know', feels: 'feel', looks: 'look', steps: 'step',
  wants: 'want', needs: 'need', finds: 'find', runs: 'run', walks: 'walk',
};

function matchCase(sample: string, replacement: string): string {
  // Preserve "They" (capitalized) vs "they".
  return /^[A-Z]/.test(sample) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

export function fixSingularTheyAgreement(input: string): string {
  if (!input) return input;
  let out = input;
  // Irregulars first.
  out = out.replace(/\b(they)\s+is\b/gi, (_m, t) => `${t} are`);
  out = out.replace(/\b(they)\s+was\b/gi, (_m, t) => `${t} were`);
  out = out.replace(/\b(they)\s+does\b/gi, (_m, t) => `${t} do`);
  out = out.replace(/\b(they)\s+has\b/gi, (_m, t) => `${t} have`);
  out = out.replace(/\b(they)\s+'s\b/gi, (_m, t) => `${t} are`);
  // Regular 3rd-person-singular -s verbs in the templated set.
  out = out.replace(/\b(they)\s+([a-z]+)\b/gi, (full, they: string, verb: string) => {
    const base = THEY_VERB_BASE[verb.toLowerCase()];
    return base ? `${they} ${matchCase(verb, base)}` : full;
  });
  return out;
}

/**
 * Coprime-stride index into a fixed-size pool so consecutive `index` values
 * never map to the same slot (avoids adjacent templated-line repeats).
 */
export function spreadIndex(index: number, poolSize: number, stride = 5): number {
  if (poolSize <= 1) return 0;
  const s = gcd(stride, poolSize) === 1 ? stride : 1; // ensure coprime → full coverage
  return ((index * s) % poolSize + poolSize) % poolSize;
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}
