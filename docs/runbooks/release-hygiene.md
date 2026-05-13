# HSB release hygiene — deploy guardrail

## Why this exists

A prior launch was set back by a deploy that mixed proof/fulfillment fixes
with landing-page redesign churn — the landing-page changes reverted a UI
the team had just shipped, and the rollback also reverted the launch-safety
fixes that were correct. The decision in force:

> HSB launch-safety fixes must be isolated from landing-page churn. Prior
> UI reverts are a launch blocker.

The `npm run launch:hygiene` guardrail is a small, read-only local check
that catches the most common shapes of branch contamination before a deploy
is started. It is not a substitute for code review — it is a fast tripwire.

## What it checks

| ID       | Failure shape                                                          | Outcome |
| -------- | ---------------------------------------------------------------------- | ------- |
| `branch` | HEAD is on `main` / `master`, or detached                              | FAIL    |
| `tree`   | working tree is dirty (any uncommitted edits or untracked files)       | FAIL    |
| `base`   | no comparison base resolvable (`origin/main`, `main`, `master`)        | WARN    |
| `scope`  | branch touches BOTH launch-safety AND landing-marketing files          | FAIL    |
| `scope`  | branch has unclassified files (patterns may need updating)             | WARN    |
| `vercel` | `.vercel/project.json` exists but has no `projectId`                   | FAIL    |
| `vercel` | neither `.vercel/project.json` nor `vercel.json` is present locally    | WARN    |

A "branch is safe to deploy" verdict means every FAIL check passed. Warnings
do not block — they exist so the operator notices and acts before pushing.

## When to run it

Run before any of:

1. Pushing a branch you intend to deploy.
2. Cutting a Vercel preview for stakeholder review.
3. Promoting a preview to production.
4. Submitting work for code review where the launch-safety scope matters.

Do not run it as a CI gate without first auditing the patterns — the patterns
are intentionally conservative and will need updating as the repo grows. The
script's `scope` warning mode (unclassified files) is the trigger for that
update.

## How to run

```sh
# From inside the worktree you intend to deploy from:
npm run launch:hygiene

# Compare against an explicit base:
npm run launch:hygiene -- --base=origin/main

# JSON output (for tooling):
npm run launch:hygiene -- --json

# Hide info lines, only show pass/fail/warn:
npm run launch:hygiene -- --quiet

# Demo runbook output without touching git:
npm run launch:hygiene -- --demo=clean
npm run launch:hygiene -- --demo=mixed-scope
npm run launch:hygiene -- --demo=dirty
npm run launch:hygiene -- --demo=on-main
npm run launch:hygiene -- --demo=no-vercel
```

Exit codes:

- `0` — every FAIL check passed (warnings allowed).
- `1` — one or more FAIL checks tripped.
- `2` — invocation error (bad flag, not a git worktree).

## What "launch-safety" vs "landing-marketing" means

The script classifies each changed file (vs the comparison base) into one
of four buckets. The patterns live in
`scripts/launch-hygiene-check.mjs` next to constants
`LAUNCH_SAFETY_PATTERNS`, `LANDING_MARKETING_PATTERNS`, and
`SHARED_PATTERNS`. Update those when the repo grows new surfaces.

### launch-safety

Backend-sensitive paths whose changes can break checkout, fulfillment, or
order state. Touching these requires the most careful review.

- `src/app/api/**` (every API route)
- `src/lib/fulfillment*`, `src/lib/order*`, `src/lib/stripe*`,
  `src/lib/lulu*`, `src/lib/admin*`, `src/lib/pdf-builder*`,
  `src/lib/print-*`, `src/lib/recovery*`, `src/lib/image-*`,
  `src/lib/story-*`
- `src/app/admin/**`, `src/app/checkout/**`, `src/app/thank-you/**`,
  `src/app/review/**`, `src/app/status/**`, `src/app/order/**`
- `tests/(fulfillment|order|checkout|stripe|lulu|admin|pdf|print|recovery|webhook|proof|lifecycle|abandoned)*`

### landing-marketing

Public marketing surface — homepage, hero, featured books, themed components,
and marketing imagery. Reverting one of these is the failure mode the
guardrail is designed to prevent.

- `src/components/landing/**`
- `src/components/(Hero|FeaturedBooks|Testimonials|HowItWorks|ValueProposition|SampleGallery|Pricing|FAQ|Footer|Navbar|Logo|TrustBadges|MothersDayBanner)*`
- `src/app/page.tsx`, `src/app/samples/**`, `src/app/pricing/**`
- `public/(samples|hero|book-covers|brand|marketing)/**`
- `src/styles/(globals|theme|landing|marketing)*`

### shared

Cross-cutting files that don't trigger a scope failure on their own: docs,
build/lint config, package metadata, this script's tests, etc.

### unknown

Anything that didn't match a pattern. The script emits a WARN that points
the operator at the patterns to update. An unknown file does NOT trigger a
mixed-scope failure on its own.

## What to do when each check fails

### `branch` FAIL — on main/master or detached HEAD

Create a single-purpose audit branch first:

```sh
git switch -c hsb/<short-purpose>   # e.g. hsb/preview-fulfillment-observability
```

Deploys must come from a named, single-purpose branch.

### `tree` FAIL — dirty working tree

Commit or stash. If the dirty files belong to a different effort, create a
clean **worktree** for the deploy-targeted work (do not stash someone else's
WIP):

```sh
git worktree add -b hsb/<short-purpose> ../herostorybooks-site-<short-purpose> <base-sha>
```

Then `cd` into that worktree, install dependencies, and re-run
`npm run launch:hygiene` there.

### `scope` FAIL — MIXED SCOPE

This is the load-bearing failure the guardrail exists for. The branch
contains both launch-safety files and landing-marketing files. Split it:

1. Pick which scope belongs on the current branch.
2. Move the other scope's changes onto a separate branch
   (`git cherry-pick`, `git restore --staged <paths>`, or
   `git checkout <base> -- <paths>` depending on intent).
3. Re-run the guardrail on each branch.

### `scope` WARN — unclassified files

The pattern lists in `scripts/launch-hygiene-check.mjs` need an update.
Decide which bucket the unclassified files belong to and add a regex to the
matching constant. Then re-run the guardrail.

### `vercel` FAIL — ambiguous `.vercel/project.json`

Run `vercel link` in this worktree to re-pin the project id, or delete the
broken `.vercel/project.json` and re-link.

### `vercel` WARN — no local Vercel config

You haven't linked this worktree to a Vercel project yet. Decide whether
this worktree should deploy, and if so run `vercel link`. Warning, not
failure — many local audits never deploy.

## Example output

The runbook examples below are produced by `--demo=<case>` and never read
the real working tree.

```sh
$ npm run launch:hygiene -- --demo=clean

HSB launch hygiene check
========================

✓ branch hsb/preview-fulfillment-observability
  single-purpose audit branch.

✓ working tree clean
  no uncommitted edits.

ⓘ base ref origin/main
  comparing origin/main..HEAD (516839b).

✓ scope analysis: single-purpose
  launch-safety=3 landing-marketing=0 shared=0 unknown=0 (3 file(s) total)
  launch-safety (3):
    src/app/api/webhooks/stripe/route.ts
    src/lib/fulfillment-kickoff.ts
    tests/fulfillment-kickoff.test.ts

✓ Vercel config present
  projectId=prj_abcdef0123…

verdict: ✓ branch is safe to deploy
```

```sh
$ npm run launch:hygiene -- --demo=mixed-scope

HSB launch hygiene check
========================

✓ branch hsb/big-mixed
  single-purpose audit branch.

✓ working tree clean
  no uncommitted edits.

ⓘ base ref origin/main
  comparing origin/main..HEAD.

✗ MIXED SCOPE
  branch touches both launch-safety and landing-marketing files; per the
  HSB launch-safety decision, these must be split into two single-purpose
  branches. launch-safety=2 landing-marketing=2 shared=0 unknown=0 (4
  file(s) total)
  launch-safety (2):
    src/app/api/webhooks/stripe/route.ts
    src/lib/fulfillment-kickoff.ts
  landing-marketing (2):
    src/app/page.tsx
    src/components/landing/Hero.tsx

✓ Vercel config present
  projectId=prj_abcdef0123…

verdict: ✗ NOT safe to deploy
```

## Safety properties of the script

- **Read-only.** No git mutations (no `commit`, `push`, `reset`, `checkout`,
  `stash`, `add`, `rm`). No file writes outside stdout/stderr.
- **No network.** The Vercel check reads a local JSON if present. It never
  contacts the Vercel API.
- **No deploy actions.** The script makes no assertion that anything ships;
  it only certifies the branch's local state.
- **Pure-function core.** `classifyPath`, `classifyChangedFiles`,
  `checkMixedScope`, and `demoChecks` are exported and unit-tested in
  `tests/launch-hygiene-check.test.ts`.

## Extending the patterns

When the repo grows a new launch-safety surface (a new API route group, a
new admin tool, a new lib/* file in the payment path), add its regex to
`LAUNCH_SAFETY_PATTERNS` and add a positive-case row to
`tests/launch-hygiene-check.test.ts`. The guardrail's value is proportional
to how well its patterns reflect the current launch-safety topology.
