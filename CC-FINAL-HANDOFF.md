# CC-HSB-LANE-B-FAMILY-PRIVACY-20260824 — final handoff

## Exact identity

| | |
|---|---|
| Repository | `/Users/abigailclaw/herostorybooks-site` |
| Required base | `ba3533bfaefc6c13cec4b55861b178db12605d1d` |
| `origin/main` at start | `ba3533bfaefc6c13cec4b55861b178db12605d1d` — **matched, no BASE_DRIFT** |
| Worktree | `/Users/abigailclaw/cc-worktrees/hsb-family-review-privacy-20260824` |
| Branch | `cc/hsb-family-review-privacy-20260824` |
| Code commit (the one narrow commit) | `96a010f6adbf1abed3f010a276ae90a9bc33ac09` |
| Code commit tree | `3ead614bfe07478b44aeb6070dde26665d0ff05a` |
| HEAD | this file's own docs-only commit, sitting directly on top of `96a010f` |
| Commits on top of base | 2 — one code commit, one docs-only commit adding this file. `git diff ba3533b..HEAD` outside `CC-FINAL-HANDOFF.md` is exactly the code commit. |
| Pushed / PR'd / merged / deployed | **No.** Local commits only. |

Review target is `96a010f6adbf1abed3f010a276ae90a9bc33ac09` (tree
`3ead614bfe07478b44aeb6070dde26665d0ff05a`). The commit on top of it adds this
file and nothing else.

## Changed paths

All within the allowlist. `git diff --stat ba3533b..HEAD`:

```
 src/app/api/family-review/admin/submissions/[submissionId]/route.ts |   9 +-
 src/app/api/family-review/upload/route.ts                           |  15 +-
 src/lib/family-review/store.ts                                      | 290 +++++++++++--
 src/lib/family-review/tokens.ts                                     |  74 ++--
 tests/family-review-token-privacy.test.ts                           | 641 +++++++++++++++++++++++++++
```

Two route files were touched, and both **demonstrably required** it:

- `upload/route.ts` — the persisted record literal can no longer carry
  `reviewToken`; it now carries `reviewTokenHash`.
- `admin/submissions/[submissionId]/route.ts` — it built the index path from
  `submission.reviewToken`, which no longer exists on a normalized record. It
  now calls `deleteReviewTokenIndexes()`.

Nothing else was modified. `src/lib/orders.ts`, order/proof review capability
code, Blob access mode, private-store token selection, checkout, Stripe,
fulfillment, Lulu, print, email, analytics, social, book generation, public
marketing code and `vercel.json` are all untouched.

One incidental change inside an allowlisted file: `store.ts` now imports
`'../orders.ts'` instead of `'../orders'`. That is the established convention
everywhere else in `src/lib` and is what makes the module importable by the
`node --experimental-strip-types --test` runner.

## What changed, and why

Objects in the family-review store are **public**, so the pathname *is* the
capability. Two things made that capability weak:

1. Submission ids were `fr-{base36-ms}-{8 hex}` — a timestamp plus only
   **32 random bits**. That leaks submission time and ordering, and is a
   guessable authority over a public path.
2. The parent's raw review token was persisted verbatim in the public
   submission JSON *and* used verbatim as the token-index pathname.

### 1. Opaque 128-bit submission ids

`newSubmissionId()` → `fr-{22 base64url chars}` = 16 crypto-random bytes.
No timestamp, no counter, no ordering signal. `isWellFormedSubmissionId()`
accepts both the new shape and the legacy shape, so legacy records stay
routable for admin and parent access.

Consequence handled: `listRecentSubmissions()` used to rely on the timestamp
prefix for "most recent" ordering. It now pages the prefix and ranks by the
Blob object's own `uploadedAt`, bounded to `MAX_LIST_PAGES × LIST_PAGE_SIZE`
(4 × 250) so an admin page load can never become an unbounded scan.

### 2. Hashed token indexes

- `reviewTokenIndexPath(sha256(token))` — the only address ever written.
- `legacyRawReviewTokenPath(token)` — read/delete only, bounded compat.
- `reviewTokenLookupPaths(token)` — digest first, legacy second.

The token carries ~192 bits, so the digest is not brute-forceable back to it.

### 3. Raw token never persisted

The record carries `reviewTokenHash` only. The raw token leaves the process
exactly once: in the `/api/family-review/upload` success response, which is
how the parent receives their link.

### 4. One normalizer in, one serializer out

- `normalizeSubmissionRecord()` runs on **every** read (`fetchSubmissionAt`,
  `fetchSubmissionByPath` → `findById`, `findByReviewToken`,
  `listRecentSubmissions`). Legacy plaintext is converted to its digest and
  then dropped, so no generic application record ever carries a stored token.
- `sanitizeSubmissionForPersistence()` runs on **every** write, and strips
  `reviewToken` / `rawReviewToken` / `review_token` defensively — including
  when handed a raw legacy-shaped object straight out of Blob. This is what
  stops the status / sample / feedback / deletion-request read-modify-write
  paths from resurrecting plaintext.
- `buildPersistPlan()` exposes exactly what `persistSubmission` is about to
  write, so the privacy guarantees are assertable in-process with no network.

### 5. The capability echo (read this before reviewing)

`findByReviewToken(token)` re-attaches **the caller's own token** to the
in-memory result:

```ts
return { ...submission, reviewToken: token };
```

This is deliberate and load-bearing. The parent's page
(`src/app/family-review/review/[reviewToken]/page.tsx` → `review-portal.tsx`)
reads `submission.reviewToken` to build its feedback, deletion-request and
sample-proxy URLs. Those files are **outside the allowlist**, so without the
echo the entire parent review flow would break.

Nothing stored is revealed: the record holds only the digest, the echoed value
is the credential the caller already presented in their own URL, and
`sanitizeSubmissionForPersistence` strips it again before any write. The
generic path (`findById`, `listRecentSubmissions`) does **not** echo — it
returns records with no plaintext at all.

## Compatibility contract

| Case | Behavior |
|---|---|
| New submission, parent link | Resolves via digest index. |
| Legacy submission, parent link issued before this change | Still resolves, via the legacy raw-token index. **Not broken.** |
| Legacy record read by admin or any generic path | Returned with plaintext stripped and digest derived. |
| Legacy record written by any generic update | Persisted without plaintext; also gains a digest index. The pre-existing raw-token index object is left exactly as it is — not deleted, not rewritten. Both addresses then resolve. |
| Admin delete | Deletes the digest index and, for a legacy record, the raw-token index too (address recovered from the stored bytes inside `store.ts`; the plaintext never leaves the module). |
| Record with neither digest nor legacy plaintext | `persistSubmission` refuses with `reason: 'no_token_hash'` rather than writing a record unreachable by its own link. |

## RED → GREEN evidence

**RED, before implementation** — probe against base `tokens.ts`
(`scratchpad/red/red-probe.txt`):

```
sample ids: fr-mt7wb2uj-b231e025  fr-mt7wb2uk-fde4558a  fr-mt7wb2uk-6898a554
random part: mt7wb2uj-b231e025   entropy bits: 32
current ms base36 prefix: mt7wb2
ids leaking ms prefix: 8/8
hashReviewToken exported: undefined
isWellFormedReviewTokenHash exported: undefined
```

**RED, the new suite** — written and run before any production change:

```
SyntaxError: The requested module '../src/lib/family-review/store.ts'
does not provide an export named 'buildPersistPlan'
✖ tests 1  pass 0  fail 1
```

Two assertions in my own first draft were sloppy — one compared *import*
positions rather than call sites, one forbade the `reviewToken` shorthand
anywhere in the upload route rather than inside the persisted record literal
(the one-time creation response legitimately uses it). Both were tightened to
test the actual property, not a proxy for it.

**GREEN**, at HEAD `96a010f`:

| Gate | Result |
|---|---|
| `tests/family-review-token-privacy.test.ts` | 24 / 24 pass |
| all `tests/family-review-*.test.ts` | 64 / 64 pass |
| `npm test` | **1523 / 1523 pass, 0 fail** |
| `npm run build` | exit 0 |
| `npm run test:e2e` | **99 / 99 passed** (hermetic config: credentials blanked, loopback, throwaway store) |
| `npx tsc --noEmit` | 54 errors, **byte-identical to the same command at base `ba3533b`** — all pre-existing, all in `tests/`. Diff of sorted outputs is empty. |
| `git diff --check` | clean |

**Leak scan** (`scratchpad/leakscan.mjs`, `scratchpad/leakscan-output.txt`) —
1500 serialized fixtures, 500 tokens × 3 record shapes (new-shaped,
legacy-shaped, echo-contaminated):

```
PASS  store.ts: the only raw-token pathname is the single documented legacy read/delete helper
PASS  store.ts: the old raw-token write path helper is gone
PASS  1500 serialized fixtures scanned (500 tokens x 3 record shapes)
PASS  normalized legacy record: reviewToken absent
PASS  normalized legacy record: raw token absent from every field
PASS  normalized legacy record: digest derived, record stays addressable

LEAK SCAN: CLEAN
```

Each fixture is checked for: raw token in the submission pathname, the index
pathname, the index bytes, or the serialized record bytes; parent name, parent
email or child name in any pathname; a `reviewToken` key surviving into the
persisted body; the index landing anywhere but the digest path; and the index
resolving to the wrong submission.

## Open items requiring a ruling

### 1. BLOCKING — the admin board can no longer reproduce a parent's link

This is the direct, spec-mandated consequence of requirement 4 ("preserve the
raw token only in the immediate successful creation response"). Because the
token is not stored, **nothing server-side can reproduce a parent's review URL
after creation.**

`src/app/family-review/admin/admin-board.tsx:1349-1350` does:

```ts
const reviewUrl = `${window.location.origin}/family-review/review/${submission.reviewToken}`;
```

For a NEW submission that now renders **`/family-review/review/undefined`**,
and that broken URL is also interpolated into `buildParentSampleEmail(...)` —
the email body a reviewer copies and sends to a parent.

I did not fix it: `admin-board.tsx` is a component, not an API route, and is
outside the stated allowlist. There is also no in-allowlist fix available — no
stored value can produce the token. Options, in order of my preference:

1. Extend the allowlist by one file and have the board hide the copy-link and
   sample-email affordances when `reviewToken` is absent, showing "link was
   issued once at submission" instead. Small, honest, no capability restored.
2. Lane C: a sealed token escrow (admin-decryptable) to restore the affordance.
   Needs a key/env decision, which is a hard stop here.

Until one of those lands, **the admin board should not be used to send links
for submissions created after this change.**

### 2. PII still lives in the public submission record

Requirement 5 of the reconciliation doc asks for data minimization. The record
still contains `parent.name`, `parent.email` and `child.firstName`, because
admin reviewers need all three to do the work. The mitigation in this lane is
high-entropy path authority (128-bit ids), not removal. **This exposure is
real and is closed only by the Lane C private flip.**

### 3. Legacy raw-token index objects still exist and still contain the token in their pathname

Untouched by design. They are only removed when their submission is deleted
through the admin route, or by Lane C's separately-approved migration.

### 4. Admin routes leak id-shape validity before auth

`status/route.ts` and `sample/route.ts` shape-check `submissionId` and return
`400 invalid_submission_id` **before** `isAdminRequestAuthed`, so an
unauthenticated caller can distinguish a malformed id from a well-formed one.
It discloses shape validity, not record existence. The parent-facing capability
paths — the actual enumeration surface — are already uniformly 404 for
malformed, unknown and miss, and a test now locks that in. I left the admin
ordering alone: reordering it is not a compatibility change and so is outside
the allowlist. Worth a follow-up.

### 5. `newSubmissionId()` lost its `now` parameter

It took `now: Date = new Date()` for the timestamp prefix. With no timestamp
there is nothing to inject. No caller passed it.

## Zero-side-effect attestation

For the duration of this task I did **not**:

- read, list, migrate, rewrite, delete or re-permission any existing Production
  Blob object, or inspect any Production Blob record;
- change Blob access mode, the private store, its env, or token selection;
- touch any book-generation run, art, manuscript, proof, print PDF, page image,
  customer order artifact or provider submission — nothing in Abby's HSB
  regeneration work was accessed;
- contact any customer or issue any review link;
- call any upload or provider API (Stripe, Lulu, OpenAI/Gemini/fal, Resend);
- push, open a PR, merge, deploy, alias, or take any external action.

Everything ran in the isolated worktree. `npm ci` installed dependencies there
from the base lockfile; the main repo's working tree and `node_modules` were
not modified — `git status` in `/Users/abigailclaw/herostorybooks-site` is
clean and it remains on `fix/copy-chicago-not-california`.

The e2e run boots a local `next start` on loopback with
`BLOB_READ_WRITE_TOKEN`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `OPENAI_API_KEY`,
`FAL_KEY`, `GEMINI_API_KEY`, `LULU_CLIENT_*` and `HSB_STRIPE_SECRET_KEY` all
blanked by `playwright.config.ts`, against a throwaway `.e2e-store`. The new
test suite stubs `globalThis.fetch` to throw and asserts it was never called.

**Stopped after the local commit, as instructed.**
