/**
 * Targeted-regeneration brief exporter.
 *
 * Reads a single local OrderRecord JSON file and emits a human-
 * readable Markdown brief + a machine-readable JSON brief describing
 * which pages an operator flagged for targeted regeneration. This is
 * the export tool that turns Commit 3's `targetedRegenNeeded` /
 * `reviewerNotes` admin flags into a structured handoff document.
 *
 * Strictly read-only. NEVER calls image generation, fulfillment,
 * Lulu, Stripe, or any external service. Only writes to /tmp (or the
 * `--out-dir` you pass).
 *
 * Usage:
 *   node --experimental-strip-types scripts/build-regen-brief.ts \
 *     --order ord_f4df6f1eb2e04b19
 *
 *   node --experimental-strip-types scripts/build-regen-brief.ts \
 *     --order .data/orders/ord_f4df6f1eb2e04b19.json \
 *     --out-dir /tmp \
 *     --include-unflagged
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';

export interface BuildRegenBriefOptions {
  /** When true, every page is included regardless of flag/notes state.
   *  Default false — only flagged or noted pages appear. */
  includeUnflagged?: boolean;
  /** ISO timestamp used for the brief header. Injected for testability. */
  now?: string;
}

export interface RegenBriefPage {
  pageNumber: number;
  pageIndex: number;
  sceneTitle: string | null;
  storyText: string;
  currentImageUrl: string | null;
  acceptedImageUrl: string | null;
  targetedRegenNeeded: boolean;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  regenerateCount: number;
  /** Concise human-readable summary of the latest few feedback entries. */
  feedbackSummary: string[];
  lastProvider: string | null;
  lastModel: string | null;
}

export type RegenBriefFilter = 'flagged_only' | 'all_pages';

export interface RegenBriefJson {
  generatedAt: string;
  orderId: string;
  childName: string | null;
  bookFormat: string | null;
  formatLabel: string | null;
  printTitle: string | null;
  filter: RegenBriefFilter;
  totalPages: number;
  pagesIncluded: number;
  pages: RegenBriefPage[];
}

const FEEDBACK_SUMMARY_LIMIT = 3;

/**
 * A page is "flagged" if the operator either toggled
 * `targetedRegenNeeded` on, or left non-whitespace reviewer notes.
 * Both signals are equally load-bearing — a note alone implies the
 * operator wants to act on this page even if they didn't tick the box.
 */
export function isPageFlagged(page: PageArtifact): boolean {
  if (page.targetedRegenNeeded === true) return true;
  const notes = typeof page.reviewerNotes === 'string' ? page.reviewerNotes.trim() : '';
  return notes.length > 0;
}

function summarizePageForBrief(page: PageArtifact): RegenBriefPage {
  const feedbackSummary = (page.feedbackHistory ?? [])
    .slice(-FEEDBACK_SUMMARY_LIMIT)
    .map((f) => {
      const ts = f.createdAt ?? '?';
      const provider = f.providerTried ?? '?';
      const status = f.success ? 'ok' : 'failed';
      const text = (f.rawText ?? '').trim().replace(/\s+/g, ' ');
      const tags = (f.tags ?? []).length > 0 ? ` [${(f.tags ?? []).join(', ')}]` : '';
      return `${ts} · ${provider} · ${status}: ${text || '(no text)'}${tags}`;
    });

  return {
    pageNumber: page.pageIndex + 1,
    pageIndex: page.pageIndex,
    sceneTitle: typeof (page as { sceneTitle?: unknown }).sceneTitle === 'string'
      ? (page as { sceneTitle?: string }).sceneTitle ?? null
      : null,
    storyText: page.storyText ?? '',
    currentImageUrl: page.currentImageUrl ?? null,
    acceptedImageUrl: page.acceptedImageUrl ?? null,
    targetedRegenNeeded: Boolean(page.targetedRegenNeeded),
    reviewerNotes:
      typeof page.reviewerNotes === 'string' && page.reviewerNotes.trim().length > 0
        ? page.reviewerNotes.trim()
        : null,
    reviewedAt: typeof page.reviewedAt === 'string' ? page.reviewedAt : null,
    regenerateCount: page.regenerateCount ?? 0,
    feedbackSummary,
    lastProvider: page.generationProvider ?? null,
    lastModel: page.generationModel ?? null,
  };
}

export function buildRegenBriefJson(
  order: Pick<
    OrderRecord,
    'id' | 'childName' | 'bookFormat' | 'formatLabel' | 'printTitle' | 'pageArtifacts'
  > & { id: string; childName?: string },
  options: BuildRegenBriefOptions = {},
): RegenBriefJson {
  const includeUnflagged = options.includeUnflagged === true;
  const allPages = [...(order.pageArtifacts ?? [])].sort((a, b) => a.pageIndex - b.pageIndex);
  const filteredPages = includeUnflagged ? allPages : allPages.filter(isPageFlagged);

  return {
    generatedAt: options.now ?? new Date().toISOString(),
    orderId: order.id,
    childName: order.childName ?? null,
    bookFormat: order.bookFormat ?? null,
    formatLabel: order.formatLabel ?? null,
    printTitle: order.printTitle ?? null,
    filter: includeUnflagged ? 'all_pages' : 'flagged_only',
    totalPages: allPages.length,
    pagesIncluded: filteredPages.length,
    pages: filteredPages.map(summarizePageForBrief),
  };
}

export function renderRegenBriefMarkdown(brief: RegenBriefJson): string {
  const lines: string[] = [];
  const title = brief.childName ? `${brief.childName}'s book` : brief.orderId;
  lines.push(`# Targeted regeneration brief — ${title}`);
  lines.push('');
  lines.push(`- Order: \`${brief.orderId}\``);
  if (brief.childName) lines.push(`- Child: ${brief.childName}`);
  if (brief.formatLabel) lines.push(`- Format: ${brief.formatLabel}`);
  if (brief.printTitle) lines.push(`- Print title: ${brief.printTitle}`);
  lines.push(`- Filter: \`${brief.filter}\``);
  lines.push(`- Pages included: ${brief.pagesIncluded} of ${brief.totalPages}`);
  lines.push(`- Generated: ${brief.generatedAt}`);
  lines.push('');

  if (brief.pages.length === 0) {
    lines.push('## No pages flagged for regeneration');
    lines.push('');
    lines.push(
      'No pages have `targetedRegenNeeded: true` or non-empty `reviewerNotes`. ',
    );
    lines.push(
      'If you expected entries here, re-open the admin page-review grid ',
    );
    lines.push(
      '(`/admin/orders/' + brief.orderId + '`), tick the flag or add a note, ',
    );
    lines.push('and re-run this script. Or pass `--include-unflagged` to dump every page.');
    return lines.join('\n');
  }

  lines.push('## Pages');
  lines.push('');
  for (const page of brief.pages) {
    lines.push(`### Page ${page.pageNumber}${page.sceneTitle ? ` — ${page.sceneTitle}` : ''}`);
    lines.push('');
    lines.push(
      `- Flag: ${page.targetedRegenNeeded ? '**YES — targeted regen needed**' : 'no'}`,
    );
    lines.push(`- Reviewer notes: ${page.reviewerNotes ? `"${page.reviewerNotes}"` : '_(none)_'}`);
    if (page.reviewedAt) lines.push(`- Last reviewed: ${page.reviewedAt}`);
    lines.push(`- Regenerate count: ${page.regenerateCount}`);
    if (page.lastProvider) {
      lines.push(`- Last provider: ${page.lastProvider}${page.lastModel ? ` / ${page.lastModel}` : ''}`);
    }
    lines.push('');
    lines.push('**Story text**');
    lines.push('');
    lines.push('> ' + (page.storyText || '_(empty)_').replace(/\n/g, '\n> '));
    lines.push('');
    if (page.currentImageUrl || page.acceptedImageUrl) {
      lines.push('**Current asset**');
      lines.push('');
      if (page.currentImageUrl) lines.push(`- current: ${page.currentImageUrl}`);
      if (page.acceptedImageUrl && page.acceptedImageUrl !== page.currentImageUrl) {
        lines.push(`- accepted: ${page.acceptedImageUrl}`);
      }
      lines.push('');
    }
    if (page.feedbackSummary.length > 0) {
      lines.push(`**Recent feedback (last ${page.feedbackSummary.length})**`);
      lines.push('');
      for (const f of page.feedbackSummary) lines.push(`- ${f}`);
      lines.push('');
    }
    lines.push('**Regeneration instructions (fill in before handoff)**');
    lines.push('');
    lines.push('- Preserve: <character anchor, composition, lighting, palette — what must NOT change>');
    lines.push('- Change: <what the new render must do differently>');
    lines.push('- Notes for prompt writer: <free-form>');
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  // Trim trailing separator.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines[lines.length - 1] === '---') lines.pop();
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  order: string | null;
  outDir: string;
  includeUnflagged: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { order: null, outDir: '/tmp', includeUnflagged: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--order') {
      args.order = argv[++i] ?? null;
    } else if (a === '--out-dir') {
      args.outDir = argv[++i] ?? '/tmp';
    } else if (a === '--include-unflagged') {
      args.includeUnflagged = true;
    } else if (a === '-h' || a === '--help') {
      args.order = null;
    }
  }
  return args;
}

async function loadOrderFromTarget(target: string): Promise<{ order: OrderRecord; resolvedFrom: string }> {
  let candidate = target;
  // If it ends in .json or contains a separator, treat as a path.
  if (!candidate.endsWith('.json') && !candidate.includes('/')) {
    candidate = path.join('.data', 'orders', `${target}.json`);
  }
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
  const raw = await fs.readFile(absolute, 'utf8');
  return { order: JSON.parse(raw) as OrderRecord, resolvedFrom: absolute };
}

function printUsage(): void {
  console.error(
    'Usage: node --experimental-strip-types scripts/build-regen-brief.ts \\\n' +
      '         --order <orderId-or-path> [--out-dir <dir>] [--include-unflagged]',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.order) {
    printUsage();
    process.exit(2);
  }
  const { order, resolvedFrom } = await loadOrderFromTarget(args.order);
  const brief = buildRegenBriefJson(order, { includeUnflagged: args.includeUnflagged });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `hsb-regen-brief-${order.id}-${ts}`;
  const jsonPath = path.join(args.outDir, `${baseName}.json`);
  const mdPath = path.join(args.outDir, `${baseName}.md`);
  await fs.mkdir(args.outDir, { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(brief, null, 2));
  await fs.writeFile(mdPath, renderRegenBriefMarkdown(brief));
  console.log(`Loaded order from ${resolvedFrom}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(
    `Filter: ${brief.filter} · pages included ${brief.pagesIncluded} of ${brief.totalPages}`,
  );
  if (brief.pagesIncluded === 0) {
    console.log('No pages flagged. Use --include-unflagged for a dry/full brief.');
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
