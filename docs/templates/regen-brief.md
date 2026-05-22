# Targeted regeneration brief — _<child name>'s book_

This file is the **shape reference** for the briefs produced by
`scripts/build-regen-brief.ts`. The CLI emits the same skeleton with
real fields filled in from a local order JSON. Treat this template as
documentation, not as a runtime artifact.

## How a brief is produced

```bash
node --experimental-strip-types scripts/build-regen-brief.ts \
  --order ord_<id-or-path>
# optional flags:
#   --out-dir <dir>          default /tmp
#   --include-unflagged      dump every page, not just flagged ones
```

Pages are included by default when EITHER:

- `targetedRegenNeeded === true`, OR
- `reviewerNotes` is non-empty (whitespace-only counts as empty).

The brief is read-only output. The exporter never calls image
generation, Lulu, Stripe, fulfillment, or any external service.

## Brief skeleton

Every brief opens with an order header and then lists one section per
included page:

```markdown
# Targeted regeneration brief — <child>'s book

- Order: `ord_<id>`
- Child: <name>
- Format: <Digital instant | Classic softcover | Premium hardcover>
- Print title: <stored print title, if any>
- Filter: `flagged_only` | `all_pages`
- Pages included: <n> of <total>
- Generated: <ISO timestamp>

## Pages

### Page <n> — <scene title or empty>

- Flag: **YES — targeted regen needed** | no
- Reviewer notes: "<note>" | _(none)_
- Last reviewed: <ISO timestamp>
- Regenerate count: <n>
- Last provider: <openai | fal | fal_edit | gemini> / <model>

**Story text**

> <quoted story copy>

**Current asset**

- current: <url>
- accepted: <url, only if different>

**Recent feedback (last N)**

- <createdAt> · <providerTried> · ok|failed: <rawText> [tags]

**Regeneration instructions (fill in before handoff)**

- Preserve: <character anchor, composition, lighting, palette — what must NOT change>
- Change: <what the new render must do differently>
- Notes for prompt writer: <free-form>

---
```

## Empty-brief behavior

If no pages are flagged (and `--include-unflagged` was not passed) the
brief contains a single explanatory section telling the operator where
to flag pages in the admin grid. This is deliberate — silent empty
files are easy to lose.

## Field provenance

| Brief field            | Source on `PageArtifact`         |
| ---------------------- | -------------------------------- |
| `pageNumber`           | `pageIndex + 1`                  |
| `sceneTitle`           | `sceneTitle` (when present)      |
| `storyText`            | `storyText`                      |
| `currentImageUrl`      | `currentImageUrl`                |
| `acceptedImageUrl`     | `acceptedImageUrl`               |
| `targetedRegenNeeded`  | `targetedRegenNeeded` (Commit 3) |
| `reviewerNotes`        | `reviewerNotes` (Commit 3)       |
| `reviewedAt`           | `reviewedAt` (Commit 3)          |
| `regenerateCount`      | `regenerateCount`                |
| `feedbackSummary`      | last 3 of `feedbackHistory`      |
| `lastProvider/model`   | `generationProvider/Model`       |

The "Regeneration instructions" block is the only section the
exporter does NOT auto-fill — the human/agent reviewing the brief is
expected to write it before any actual regeneration is attempted.
