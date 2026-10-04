# HSB split-intake submit-boundary remediation

## Status

**CONTROLLER_GATES_GREEN — uncommitted ten-path candidate; independent exact-byte review remains pending.**

The controller authorized the four additional test paths below. All five obsolete source-location assertions are repaired across the real form → submitCheckoutIntakeOrder chain. Focused, related, full-suite, production-build, and exact WAV Chromium gates are green. This supersedes the former six-path-ceiling block and 1048/1053 result; it is not commit, merge, deployment, or live-order approval.

This document supersedes the inherited test-only handoff. Its historical full-suite/build/browser results are not results for these bytes.

## Identity

- Worktree: `/Users/abigailclaw/cc-worktrees/hsb-split-intake-boundary-fix-20261003`
- Branch: `cc/hsb-split-intake-boundary-fix-20261003`
- HEAD/base: `4c7b9ad2cd7a57624cf8593b401fdd71e4faeb63`
- `origin/main` local tracking ref: `4c7b9ad2cd7a57624cf8593b401fdd71e4faeb63`
- Remote main, read with `git ls-remote origin refs/heads/main`: `4c7b9ad2cd7a57624cf8593b401fdd71e4faeb63`
- Local `main` is a different ref: `597a7501844f49de63a8805e34295b47a914276f`. No ref was changed or fetched.
- No commit created; review the uncommitted file bytes, not HEAD alone.

## Exact ten-path candidate

1. `src/lib/checkout-intake-client-flow.ts`: adds `submitCheckoutIntakeOrder`. It owns preparation, post-await authority/result checks, primary/supporting payload application, completed-cache commit, legacy callback gating, final authority check and injected order dispatch. Reads live refs rather than snapshots after awaiting.
2. `src/app/checkout/checkout-form.tsx`: real `handleSubmit` calls that production helper. Attempt resolution and the pre-intake ownership guard remain before it. Legacy attachment assembly/preflight and existing sent markers, diagnostic phase and fetch remain page-owned callbacks with the same ordering. Response handling is unchanged.
3. `tests/checkout-intake-partial-resume.test.ts`: inherited reset-during-create, reset-during-upload and retry regressions now call the production submit helper, not a test-local orchestration clone. Reset tests prove zero dispatcher calls and no restored session/cache/saved state. Fresh retry dispatch and full-batch A/B/B are preserved. Local source guards updated to the extracted boundary.
4. `tests/checkout-direct-order-wiring.test.ts`: honestly checks the real page/helper dispatch wiring and the moved payload/authority operations.
5. `tests/e2e/admin-intake-asset-playback.spec.ts`: inherited real-handler WAV candidate preserved byte-for-byte; no edit in this remediation.
6. `tests/checkout-attempt-lease.test.ts`: retains lease-before-upload ordering through the actual submit-helper call and preparer invocation.
7. `tests/checkout-attempt-restart.test.ts`: pins the actual awaited restart call (not its import), before the helper/upload boundary; retains verified rotation, cleanup and replacement-identity assertions.
8. `tests/checkout-draft-recovery-and-payment-ux.test.ts`: retains identity/conflict/lease/reservation ownership ordering before the helper and its real preparer.
9. `tests/checkout-legacy-payload-preflight.test.ts`: pins helper payload application before legacy callback and dispatch; null-preparation-only fallback, preflight inside the callback, and sent markers inside the subsequent shared dispatcher.
10. This handoff.

This completion pass changed only the four newly authorized test files and this handoff. All five inherited code/test candidate files, including both production files and the WAV spec, retain their entry SHA-256 values. Generated ignored graph output is local tooling only.

## Strict RED → GREEN

Tests were modified before either production file. The first test attempt could not load `@vercel/blob`; that dependency failure is NOT counted as RED. Installed locked local dependencies with `npm ci --ignore-scripts --no-audit --no-fund` (261 packages; no lockfile/config change).

Narrow command:

```sh
node --experimental-strip-types --test --test-reporter=tap --test-concurrency=1 tests/checkout-intake-partial-resume.test.ts tests/checkout-direct-order-wiring.test.ts
```

- Expected RED, exit 1: 19 reported tests, 17 pass, 2 fail. The partial-resume module could not import the absent `submitCheckoutIntakeOrder` export. The wiring assertion failed at `boundary > -1 && dispatch > boundary && fetchOrder > dispatch` because the page did not yet call that helper. The 19 count includes the module-load failure, not execution of its individual tests.
- Implemented the helper and production wiring only after that RED.
- First GREEN attempt exposed one additional same-file controller-ref source assertion (56/57); updated it honestly from a snapshot argument to live refs.
- Narrow GREEN: 57/57, zero failures.
- A subsequent local preservation of `const response = await fetch(...)` inside the dispatcher restored unchanged Stripe handoff source guards without altering their tests; the final related run includes both narrow files and they pass.

Logs in `/Users/abigailclaw/.hermes/cache/scratch/`:

- `hsb-boundary-red.log`
- `hsb-boundary-green.log`
- `hsb-boundary-focused.log`
- `hsb-boundary-related-final.log`
- `hsb-boundary-candidate.diff`

## Authorized test-only completion: RED → GREEN

Before editing the four files, ran:

```sh
node --experimental-strip-types --test --test-reporter=tap --test-concurrency=1 tests/checkout-attempt-lease.test.ts tests/checkout-attempt-restart.test.ts tests/checkout-draft-recovery-and-payment-ux.test.ts tests/checkout-legacy-payload-preflight.test.ts
```

- RED: 67 tests, 62 pass, 5 fail, exit 1; exactly the five obsolete source-location assertions listed below.
- GREEN after test-only repair: 67/67 pass, 0 fail/skip, exit 0.
- Related rerun: 1053/1053 pass, 0 fail/skip, exit 0.
- Test commands used a credential-scrubbed `env -i` child with PATH, HOME and TMPDIR only. No environment/config files changed. The initial RED log briefly landed under the shell's unexpected system TMPDIR; moved to the explicit Hermes scratch path and used that path for subsequent test scratch/output.
- Evidence in `/Users/abigailclaw/.hermes/cache/scratch/`: `hsb-boundary-wiring-red.log`, `hsb-boundary-wiring-green.log`, `hsb-boundary-wiring-related.log`, `hsb-boundary-wiring-types.log`, `hsb-boundary-wiring-graph.log`.

## Verification of final candidate bytes

| Check | Result |
|---|---|
| `node --experimental-strip-types --test --test-reporter=tap --test-concurrency=1 tests/checkout-intake-*.test.ts tests/admin-intake-*.test.ts` | 360/360 pass, exit 0 (prior pass; covered again by the related rerun) |
| `node --experimental-strip-types --test --test-reporter=tap --test-concurrency=1 tests/checkout*.test.ts tests/voice-upload.test.ts tests/story-media-size-preflight.test.ts tests/admin-intake-*.test.ts` | 1053/1053 pass, 0 failures/skips, exit 0 (completion rerun) |
| `npx --no-install tsc --noEmit --incremental false -p .` | exit 0, no diagnostics (rerun after test edits) |
| `git diff --check` | exit 0 |
| `graphify update .` | exit 0 after test edits; 4263 nodes, 9320 edges, 180 communities; ignored graph output |
| Prior-pass workspace `pre_agent_secret_scan.py` over five inherited code/test files and tracked diff | exit 0; 6 files scanned, no configured patterns |
| Prior-pass added-line secret-prefix / skipped-test / dangerous-execution scans | 0 hits in each category |
| Credential-scrubbed `npm test`, before build | 4201 pass, 0 fail, 1 expected bundle-dependent skip, exit 0 |
| Credential-scrubbed `npm run build` | optimized production build, TypeScript, page collection, and 26/26 static-page generation pass; exit 0 |
| Credential-scrubbed `npx --no-install playwright test tests/e2e/admin-intake-asset-playback.spec.ts --project=desktop-chromium` | 4/4 Chromium pass, including the real-handler WAV and negative control; exit 0 |
| Credential-scrubbed `npm test`, after build | 4202/4202 pass, 0 failures/skips, exit 0 |

Node emits the inherited `MODULE_TYPELESS_PACKAGE_JSON` warning; no package configuration was changed to suppress it.

### Resolved obsolete source-location failures

The pre-edit RED run reproduced lease, restart, ownership, payload-placement and legacy-branch failures in the four newly authorized files. Previously these searched for preparation/payload operations inline in the form. They now assert the actual awaited form call and production helper invocation, preserve every pre-boundary ownership claim, and inspect the helper-owned payload and null-preparation branch. Callback nesting assertions retain preflight-before-send semantics across the two files. No comments, dead aliases, duplicate production calls, deleted tests or skips were introduced to satisfy assertions. Production changes were not needed.

## Deliberately deferred

- Independent exact-byte review: pending controller.
- Commit, push, PR, merge, deploy, and live checkout/provider qualification remain unauthorized and were not performed.
- No DOM-driven checkout claim: behavioral regressions execute the actual exported production submit boundary with the real synthetic intake handler; source regressions tie that boundary to `handleSubmit`.

## SHA-256 manifest

```text
9c488030bde5720b421efdb5a344903853e19752808d1ce17b61f1ccfb2ff867  src/app/checkout/checkout-form.tsx
fbfd6b356886ddf03aa7f8b9186fc6d5495929ebf17a48d7422c707f3ed05b21  src/lib/checkout-intake-client-flow.ts
4033dd18150d46395c829d5862f2e99f60267810480ba17cf8db26c861efd560  tests/checkout-attempt-lease.test.ts
897d7ca71c6cca07bab472e01f05ec907928228e5d529d887d5715e1d6536ebd  tests/checkout-attempt-restart.test.ts
64da8a56990d8178a84e4035a248c719597cca61282c793656d86398d03b4359  tests/checkout-direct-order-wiring.test.ts
7d40fb08df8f1d383f4e20e7e70ec5e23c2203452a060ffb01236d5f00bbdd84  tests/checkout-draft-recovery-and-payment-ux.test.ts
ca98f70f62c0f1fe8990ae3ff3eebf4e572ccae8a845128fd1a3f20319686971  tests/checkout-intake-partial-resume.test.ts
8c4b4c86a27bd5f42d7261693581c8d5d41b9b19c273abbd51821cd2628b1085  tests/checkout-legacy-payload-preflight.test.ts
4858e28f50c82ee84a8abbe8a29a4a73a1e5891e35ef48da8c92044176ffc0a3  tests/e2e/admin-intake-asset-playback.spec.ts
4c3402fc0af52ea84d595dd82faca28dd84194991f5a6bf176b27d9f760a53b9  tracked git diff vs HEAD (git diff)
```

The handoff hash is reported separately to avoid self-reference. Tracked diff: 9 files, 446 insertions, 146 deletions, plus this untracked handoff. All ten candidate paths must be included in review. The previous five-file diff hash is superseded.

## Side-effect attestation

No commit, staging, push, PR, merge, deploy, environment/config/credential change, real customer/media access, order/payment/Stripe/provider action, email, proof or print action. No change in any other worktree or profile. Earlier-pass remote access was dependency installation and read-only main-ref discovery. Controller full-suite/build/browser runs used a credential-scrubbed `env -i`; Playwright additionally blanked inherited variables, disabled dotenv, used a loopback server, and used its disposable local store. Tests use synthetic fixtures and injected transports, not live orders/providers. Local changes beyond the ten candidate files are ignored `node_modules`/graph/build output and scratch evidence logs. No secret values were printed.
