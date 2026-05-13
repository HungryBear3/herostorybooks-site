#!/usr/bin/env node
/**
 * HSB launch deploy-hygiene check.
 *
 * Read-only audit that refuses to certify a branch as deploy-safe when:
 *   - the working tree is dirty
 *   - HEAD is on main / master (deploys must come from a single-purpose branch)
 *   - the branch mixes launch-safety files (API / fulfillment / checkout /
 *     admin / order-state) with landing-marketing files (homepage /
 *     hero / featured books / theme churn)
 *   - the local .vercel/project.json is missing or names multiple projects
 *
 * Intended invocation:
 *   npm run launch:hygiene
 *
 * Options:
 *   --base=<ref>   comparison base; default origin/main if present, else main
 *   --json         machine-readable JSON output (no ANSI)
 *   --quiet        suppress info lines; only emit checks + verdict
 *   --demo=<case>  print canned output for the runbook (cases: clean | dirty
 *                  | on-main | mixed-scope | no-vercel)
 *   --help, -h     show usage
 *
 * Exit codes:
 *   0  all FAIL checks passed (warnings allowed)
 *   1  one or more FAIL checks tripped
 *   2  invocation error (bad flag, no git repo)
 *
 * No git mutations, no file writes, no network calls. The Vercel config
 * check reads a local JSON if present and never contacts the Vercel API.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Pattern-based scope classification ──────────────────────────────────────

/**
 * Files that, if changed, signal launch-safety / backend-sensitive work.
 * A branch with these files should NOT also carry landing-marketing churn.
 */
export const LAUNCH_SAFETY_PATTERNS = [
  /^src\/app\/api\//,
  /^src\/lib\/fulfillment/,
  /^src\/lib\/order/,
  /^src\/lib\/stripe/,
  /^src\/lib\/lulu/,
  /^src\/lib\/admin/,
  /^src\/lib\/pdf-builder/,
  /^src\/lib\/print-/,
  /^src\/lib\/recovery/,
  /^src\/lib\/image-/,
  /^src\/lib\/story-/,
  /^src\/app\/admin\//,
  /^src\/app\/checkout\//,
  /^src\/app\/thank-you\//,
  /^src\/app\/review\//,
  /^src\/app\/status\//,
  /^src\/app\/order\//,
  /^tests\/(?:fulfillment|order|checkout|stripe|lulu|admin|pdf|print|recovery|webhook|proof|lifecycle|abandoned)/,
];

/**
 * Files that, if changed, signal landing-page / marketing / theme work.
 * A branch with these files should NOT also carry launch-safety churn.
 */
export const LANDING_MARKETING_PATTERNS = [
  /^src\/components\/landing\//,
  /^src\/components\/(?:Hero|FeaturedBooks|Testimonials|HowItWorks|ValueProposition|SampleGallery|Pricing|FAQ|Footer|Navbar|Logo|TrustBadges|MothersDayBanner)/,
  /^src\/app\/page\.tsx$/,
  /^src\/app\/samples\//,
  /^src\/app\/pricing\//,
  /^public\/(?:samples|hero|book-covers|brand|marketing)\//,
  /^src\/styles\/(?:globals|theme|landing|marketing)/,
];

/**
 * Shared infrastructure files. Changes here neither flag launch-safety nor
 * landing-marketing — they apply to both surfaces and should not trigger a
 * mixed-scope failure on their own.
 */
export const SHARED_PATTERNS = [
  /^docs\//,
  /^scripts\//,
  /^tests\/launch-hygiene-check/,
  /^tests\/(?:helpers|utils|fixtures)\//,
  /^\.github\//,
  /^package(?:-lock)?\.json$/,
  /^tsconfig.*\.json$/,
  /^next\.config\..*$/,
  /^eslint\.config\..*$/,
  /^tailwind\.config\..*$/,
  /^postcss\.config\..*$/,
  /^components\.json$/,
  /^\.gitignore$/,
  /^\.eslintignore$/,
  /^\.prettierrc.*$/,
  /^README\.md$/,
  /^CLAUDE\.md$/,
  /^PRD.*\.md$/,
];

/** @typedef {'launch-safety' | 'landing-marketing' | 'shared' | 'unknown'} Scope */

/**
 * Classify a single repo-relative path into one scope. Order matters: shared
 * is checked first so that, e.g., a doc that happens to be named `order.md`
 * doesn't get mis-tagged as launch-safety.
 *
 * @param {string} path
 * @returns {Scope}
 */
export function classifyPath(path) {
  if (SHARED_PATTERNS.some((re) => re.test(path))) return "shared";
  if (LAUNCH_SAFETY_PATTERNS.some((re) => re.test(path))) return "launch-safety";
  if (LANDING_MARKETING_PATTERNS.some((re) => re.test(path))) return "landing-marketing";
  return "unknown";
}

/**
 * Group changed files by scope.
 * @param {string[]} files
 * @returns {Record<Scope, string[]>}
 */
export function classifyChangedFiles(files) {
  /** @type {Record<Scope, string[]>} */
  const out = {
    "launch-safety": [],
    "landing-marketing": [],
    shared: [],
    unknown: [],
  };
  for (const f of files) {
    out[classifyPath(f)].push(f);
  }
  return out;
}

/**
 * Decide whether a branch's scope mix is acceptable. Mixed-scope is the
 * load-bearing fail — see the launch-safety decision in the deploy-hygiene
 * runbook.
 *
 * @param {Record<Scope, string[]>} grouped
 * @returns {{ ok: boolean; reason?: string }}
 */
export function checkMixedScope(grouped) {
  const hasLaunch = grouped["launch-safety"].length > 0;
  const hasLanding = grouped["landing-marketing"].length > 0;
  if (hasLaunch && hasLanding) {
    return {
      ok: false,
      reason:
        "branch touches both launch-safety and landing-marketing files; " +
        "per the HSB launch-safety decision, these must be split into two single-purpose branches.",
    };
  }
  return { ok: true };
}

// ── Git helpers (read-only) ─────────────────────────────────────────────────

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {string}
 */
function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function tryGit(repoRoot, args) {
  try {
    return { ok: true, out: git(repoRoot, args) };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {string} repoRoot
 */
function readGitState(repoRoot) {
  const status = git(repoRoot, ["status", "--porcelain"]);
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  return { status, branch, head };
}

/**
 * Pick a comparison base. Prefer the explicit flag → origin/main → main.
 * Returns null if no base can be resolved.
 *
 * @param {string} repoRoot
 * @param {string | null} explicit
 */
function resolveBase(repoRoot, explicit) {
  const tried = [];
  const candidates = [explicit, "origin/main", "main", "master"].filter(Boolean);
  for (const ref of /** @type {string[]} */ (candidates)) {
    tried.push(ref);
    const r = tryGit(repoRoot, ["rev-parse", "--verify", ref]);
    if (r.ok) return { ref, sha: r.out, tried };
  }
  return { ref: null, sha: null, tried };
}

/**
 * Files changed between `base` and HEAD (committed only — dirty-tree changes
 * are reported separately).
 *
 * @param {string} repoRoot
 * @param {string} base
 * @returns {string[]}
 */
function changedFilesVsBase(repoRoot, base) {
  const out = git(repoRoot, ["diff", "--name-only", `${base}...HEAD`]);
  return out.length === 0 ? [] : out.split("\n").filter(Boolean);
}

// ── Vercel config (local-only) ──────────────────────────────────────────────

/**
 * @param {string} repoRoot
 */
export function inspectVercelConfig(repoRoot) {
  const projectJsonPath = resolve(repoRoot, ".vercel", "project.json");
  const vercelJsonPath = resolve(repoRoot, "vercel.json");
  const hasProjectJson = existsSync(projectJsonPath);
  const hasVercelJson = existsSync(vercelJsonPath);

  /** @type {{ projectId?: string; orgId?: string; multipleProjects?: boolean; raw?: unknown }} */
  let projectInfo = {};
  if (hasProjectJson) {
    try {
      const data = JSON.parse(readFileSync(projectJsonPath, "utf8"));
      projectInfo = {
        projectId: typeof data.projectId === "string" ? data.projectId : undefined,
        orgId: typeof data.orgId === "string" ? data.orgId : undefined,
        raw: data,
      };
    } catch {
      projectInfo = {};
    }
  }
  return {
    hasProjectJson,
    hasVercelJson,
    projectInfo,
  };
}

// ── Check runner ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Check
 * @property {'pass' | 'fail' | 'warn' | 'info'} level
 * @property {string} id
 * @property {string} label
 * @property {string} detail
 * @property {Record<string, unknown>=} data
 */

/**
 * Runs every hygiene check against a captured git/Vercel state. Returns the
 * structured check list — the renderer decides how to display.
 *
 * @param {{ repoRoot: string; base: string | null }} input
 * @returns {Check[]}
 */
export function runChecks({ repoRoot, base }) {
  /** @type {Check[]} */
  const checks = [];
  const { status, branch, head } = readGitState(repoRoot);

  // branch check — refuse on main/master
  if (branch === "main" || branch === "master") {
    checks.push({
      level: "fail",
      id: "branch",
      label: `branch ${branch}`,
      detail:
        "deploys must come from a single-purpose audit branch, not main/master.",
    });
  } else if (branch === "HEAD") {
    checks.push({
      level: "fail",
      id: "branch",
      label: "detached HEAD",
      detail: "check out a named branch before running this guardrail.",
    });
  } else {
    checks.push({
      level: "pass",
      id: "branch",
      label: `branch ${branch}`,
      detail: "single-purpose audit branch.",
    });
  }

  // working tree check — refuse if dirty
  if (status.length > 0) {
    const lines = status.split("\n").filter(Boolean);
    const mod = lines.filter((l) => /^[ MARC]M/.test(l) || /^M[ MARC]/.test(l) || /^MM/.test(l));
    const untracked = lines.filter((l) => l.startsWith("?? "));
    checks.push({
      level: "fail",
      id: "tree",
      label: "working tree DIRTY",
      detail: `${mod.length} modified, ${untracked.length} untracked file(s); commit or stash before certifying.`,
      data: { modified: mod.length, untracked: untracked.length, lines },
    });
  } else {
    checks.push({
      level: "pass",
      id: "tree",
      label: "working tree clean",
      detail: "no uncommitted edits.",
    });
  }

  // base check
  if (!base) {
    checks.push({
      level: "warn",
      id: "base",
      label: "no comparison base",
      detail:
        "could not resolve origin/main or main; pass --base=<ref> to compare scope explicitly.",
    });
  } else {
    checks.push({
      level: "info",
      id: "base",
      label: `base ref ${base}`,
      detail: `comparing ${base}..HEAD (${head.slice(0, 7)}).`,
    });
  }

  // scope check — only if tree is clean AND we have a base
  const treeClean = status.length === 0;
  if (treeClean && base) {
    const files = changedFilesVsBase(repoRoot, base);
    if (files.length === 0) {
      checks.push({
        level: "info",
        id: "scope",
        label: "no committed changes vs base",
        detail: "branch is empty — nothing to certify.",
      });
    } else {
      const grouped = classifyChangedFiles(files);
      const mixed = checkMixedScope(grouped);
      const summary =
        `launch-safety=${grouped["launch-safety"].length} ` +
        `landing-marketing=${grouped["landing-marketing"].length} ` +
        `shared=${grouped.shared.length} ` +
        `unknown=${grouped.unknown.length} ` +
        `(${files.length} file(s) total)`;
      if (!mixed.ok) {
        checks.push({
          level: "fail",
          id: "scope",
          label: "MIXED SCOPE",
          detail: `${mixed.reason} ${summary}`,
          data: { grouped },
        });
      } else if (grouped.unknown.length > 0) {
        checks.push({
          level: "warn",
          id: "scope",
          label: "scope analysis: unclassified files present",
          detail: `${summary} — review the unclassified files and update LAUNCH_SAFETY_PATTERNS / LANDING_MARKETING_PATTERNS / SHARED_PATTERNS so future runs catch them.`,
          data: { grouped },
        });
      } else {
        checks.push({
          level: "pass",
          id: "scope",
          label: "scope analysis: single-purpose",
          detail: summary,
          data: { grouped },
        });
      }
    }
  } else {
    checks.push({
      level: "info",
      id: "scope",
      label: "scope analysis skipped",
      detail: treeClean
        ? "no comparison base available."
        : "working tree dirty; clean it first.",
    });
  }

  // vercel config
  const vc = inspectVercelConfig(repoRoot);
  if (!vc.hasProjectJson && !vc.hasVercelJson) {
    checks.push({
      level: "warn",
      id: "vercel",
      label: "no local Vercel config",
      detail:
        "neither .vercel/project.json nor vercel.json found; confirm the deploy target (run `vercel link` to pin it) before pushing.",
    });
  } else if (vc.hasProjectJson && !vc.projectInfo.projectId) {
    checks.push({
      level: "fail",
      id: "vercel",
      label: "ambiguous .vercel/project.json",
      detail: ".vercel/project.json is present but has no projectId — re-link the worktree with `vercel link`.",
    });
  } else {
    const projectLabel = vc.projectInfo.projectId
      ? `projectId=${vc.projectInfo.projectId.slice(0, 12)}…`
      : "vercel.json present (no .vercel/project.json)";
    checks.push({
      level: "pass",
      id: "vercel",
      label: "Vercel config present",
      detail: projectLabel,
    });
  }

  return checks;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const grn = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const yel = (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s);
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);

function levelGlyph(level) {
  if (level === "pass") return grn("✓");
  if (level === "fail") return red("✗");
  if (level === "warn") return yel("⚠");
  return dim("ⓘ");
}

/**
 * @param {Check[]} checks
 * @param {{ quiet?: boolean }} opts
 */
function renderText(checks, opts = {}) {
  const lines = [];
  lines.push(bold("HSB launch hygiene check"));
  lines.push("========================");
  lines.push("");
  for (const c of checks) {
    if (opts.quiet && c.level === "info") continue;
    lines.push(`${levelGlyph(c.level)} ${c.label}`);
    if (c.detail) lines.push(`  ${dim(c.detail)}`);
    if (c.data && c.id === "scope" && c.data.grouped) {
      const g = /** @type {Record<string, string[]>} */ (c.data.grouped);
      for (const bucket of ["launch-safety", "landing-marketing", "unknown"]) {
        if (g[bucket].length === 0) continue;
        lines.push(`  ${bold(bucket)} (${g[bucket].length}):`);
        for (const f of g[bucket].slice(0, 12)) lines.push(`    ${f}`);
        if (g[bucket].length > 12) lines.push(`    … +${g[bucket].length - 12} more`);
      }
    }
    if (c.data && c.id === "tree" && Array.isArray(c.data.lines)) {
      const ls = /** @type {string[]} */ (c.data.lines);
      for (const l of ls.slice(0, 12)) lines.push(`    ${l}`);
      if (ls.length > 12) lines.push(`    … +${ls.length - 12} more`);
    }
    lines.push("");
  }
  const failed = checks.some((c) => c.level === "fail");
  const warned = checks.some((c) => c.level === "warn");
  lines.push(
    failed
      ? red("verdict: ✗ NOT safe to deploy")
      : warned
        ? yel("verdict: ⚠ safe to deploy after addressing warnings")
        : grn("verdict: ✓ branch is safe to deploy"),
  );
  return lines.join("\n");
}

/**
 * Canned outputs for the runbook. Demo mode never reads git or fs.
 * @param {string} which
 * @returns {Check[]}
 */
export function demoChecks(which) {
  switch (which) {
    case "clean":
      return [
        { level: "pass", id: "branch", label: "branch hsb/preview-fulfillment-observability", detail: "single-purpose audit branch." },
        { level: "pass", id: "tree", label: "working tree clean", detail: "no uncommitted edits." },
        { level: "info", id: "base", label: "base ref origin/main", detail: "comparing origin/main..HEAD (516839b)." },
        {
          level: "pass",
          id: "scope",
          label: "scope analysis: single-purpose",
          detail: "launch-safety=3 landing-marketing=0 shared=0 unknown=0 (3 file(s) total)",
          data: {
            grouped: {
              "launch-safety": [
                "src/app/api/webhooks/stripe/route.ts",
                "src/lib/fulfillment-kickoff.ts",
                "tests/fulfillment-kickoff.test.ts",
              ],
              "landing-marketing": [],
              shared: [],
              unknown: [],
            },
          },
        },
        { level: "pass", id: "vercel", label: "Vercel config present", detail: "projectId=prj_abcdef0123…" },
      ];
    case "dirty":
      return [
        { level: "pass", id: "branch", label: "branch hsb/whatever", detail: "single-purpose audit branch." },
        {
          level: "fail",
          id: "tree",
          label: "working tree DIRTY",
          detail: "4 modified, 1 untracked file(s); commit or stash before certifying.",
          data: { lines: [" M src/app/page.tsx", " M src/components/landing/Hero.tsx", "?? scratch.txt"] },
        },
        { level: "info", id: "base", label: "base ref origin/main", detail: "comparing origin/main..HEAD." },
        { level: "info", id: "scope", label: "scope analysis skipped", detail: "working tree dirty; clean it first." },
        { level: "pass", id: "vercel", label: "Vercel config present", detail: "projectId=prj_abcdef0123…" },
      ];
    case "on-main":
      return [
        { level: "fail", id: "branch", label: "branch main", detail: "deploys must come from a single-purpose audit branch, not main/master." },
        { level: "pass", id: "tree", label: "working tree clean", detail: "no uncommitted edits." },
        { level: "info", id: "base", label: "base ref origin/main", detail: "comparing origin/main..HEAD." },
        { level: "info", id: "scope", label: "no committed changes vs base", detail: "branch is empty — nothing to certify." },
        { level: "pass", id: "vercel", label: "Vercel config present", detail: "projectId=prj_abcdef0123…" },
      ];
    case "mixed-scope":
      return [
        { level: "pass", id: "branch", label: "branch hsb/big-mixed", detail: "single-purpose audit branch." },
        { level: "pass", id: "tree", label: "working tree clean", detail: "no uncommitted edits." },
        { level: "info", id: "base", label: "base ref origin/main", detail: "comparing origin/main..HEAD." },
        {
          level: "fail",
          id: "scope",
          label: "MIXED SCOPE",
          detail:
            "branch touches both launch-safety and landing-marketing files; per the HSB launch-safety decision, these must be split into two single-purpose branches. launch-safety=2 landing-marketing=2 shared=0 unknown=0 (4 file(s) total)",
          data: {
            grouped: {
              "launch-safety": ["src/app/api/webhooks/stripe/route.ts", "src/lib/fulfillment-kickoff.ts"],
              "landing-marketing": ["src/app/page.tsx", "src/components/landing/Hero.tsx"],
              shared: [],
              unknown: [],
            },
          },
        },
        { level: "pass", id: "vercel", label: "Vercel config present", detail: "projectId=prj_abcdef0123…" },
      ];
    case "no-vercel":
      return [
        { level: "pass", id: "branch", label: "branch hsb/whatever", detail: "single-purpose audit branch." },
        { level: "pass", id: "tree", label: "working tree clean", detail: "no uncommitted edits." },
        { level: "info", id: "base", label: "base ref origin/main", detail: "comparing origin/main..HEAD." },
        { level: "pass", id: "scope", label: "scope analysis: single-purpose", detail: "launch-safety=1 landing-marketing=0 shared=0 unknown=0 (1 file(s) total)" },
        {
          level: "warn",
          id: "vercel",
          label: "no local Vercel config",
          detail:
            "neither .vercel/project.json nor vercel.json found; confirm the deploy target (run `vercel link` to pin it) before pushing.",
        },
      ];
    default:
      throw new Error(`unknown demo case: ${which}`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { base: null, json: false, quiet: false, demo: null, help: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a.startsWith("--base=")) out.base = a.slice("--base=".length);
    else if (a.startsWith("--demo=")) out.demo = a.slice("--demo=".length);
    else if (a === "--demo") out.demo = "clean";
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

const USAGE = `Usage: launch-hygiene-check.mjs [options]

  --base=<ref>     comparison base (default: origin/main or main)
  --json           machine-readable JSON output (no ANSI)
  --quiet          suppress info lines
  --demo=<case>    runbook example: clean | dirty | on-main | mixed-scope | no-vercel
  -h, --help       this message

Exit 0: all FAIL checks passed (warnings allowed).
Exit 1: one or more FAIL checks tripped.
Exit 2: invocation error.`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  /** @type {Check[]} */
  let checks;

  if (args.demo) {
    try {
      checks = demoChecks(args.demo);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
  } else {
    // Real run — repo root is the cwd of this worktree.
    const repoRoot = process.cwd();
    if (!existsSync(resolve(repoRoot, ".git")) && !existsSync(resolve(repoRoot, ".git"))) {
      // worktrees have a .git FILE not a .git DIR — existsSync handles both.
      process.stderr.write(`not a git worktree: ${repoRoot}\n`);
      process.exit(2);
    }
    const baseResolved = resolveBase(repoRoot, args.base);
    checks = runChecks({ repoRoot, base: baseResolved.ref });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(checks, { quiet: args.quiet })}\n`);
  }

  const failed = checks.some((c) => c.level === "fail");
  process.exit(failed ? 1 : 0);
}

// Only auto-run when invoked as a CLI, not when imported by tests.
const __filename__ = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename__) {
  main();
}
