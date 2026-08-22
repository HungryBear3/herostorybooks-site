# Rex/Codex handoff — HSB remaining truthfulness remediation

**Verdict: PASS — local candidate only; independent exact-SHA review still required.**

## Identity

- Worktree: `/Users/abigailclaw/rex-worktrees/hsb-final-truthfulness-remediation-20260821`
- Branch: `rex/hsb-final-truthfulness-remediation-20260821`
- Base SHA: `58b33acaf84ad3d87c1f3320a3214a38d3244a25`
- Base tree: `36178f6343cc09826227aa462de567c920dd050a`
- New SHA: use `git rev-parse HEAD` after the single local commit containing this handoff
- No push, PR, Preview, merge, deploy, env/provider/customer/order/payment/proof/print/email/public action

## Final scope

The Codex draft originally included unrelated fulfillment-sweep test plumbing and a Playwright webpack override to work around its sandbox. Rex reverted those changes before verification. The committed candidate is limited to:

- `src/app/api/order/[orderId]/route.ts`
- `src/app/terms/page.tsx`
- `tests/customer-copy-honesty.test.ts`
- `tests/digital-pdf-timing-truthfulness.test.ts`
- `tests/legacy-delivery-expectation-normalization.test.ts`
- `tests/legal-copy.test.ts`
- this handoff

## Blocker disposition

### Fixed — unauthenticated raw GET

`GET /api/order/[orderId]` now fails closed before `getOrder`:

- missing admin configuration → 503;
- missing/wrong key → 401;
- correct admin key → raw evidence response.

Raw stored `deliveryExpectation` bytes remain available only after authentication. Historical orders are not mutated.

Behavioral tests invoke GET directly and prove all three branches. They no longer mistake a PATCH-only header string for GET authorization.

### Fixed — approval-first timing paraphrases

The exported predicate now catches the exact missed sentences and broader same-family access/provide/available/release/unlock/send/email/deliver/download/receive constructions, including:

- `Approval grants access to the final PDF.`
- `The digital file is provided after approval.`
- `The PDF becomes accessible after approval.`
- `Approval makes the digital download accessible.`

Accurate approval-as-acceptance, print-gating, and PDF-with-proof-email statements remain allowed. Direct fixtures and disposable mutations cover the exact blocker forms.

### Fixed — human-review paraphrases

The guard now covers staff/team/expert/editorial/artist/human/manual review/check/inspect/quality constructions, including:

- `Staff checks every order before the proof is sent.`
- `Every book gets an expert review before delivery.`
- `Every order includes an editorial review before fulfillment.`
- `Every proof gets a team quality check.`

Threshold-specific regeneration escalation and concierge-beta statements remain allowed only because tests bind them to named enforcing gates.

### Fixed — direct stale-pricing reachability

The guard checks importers/consumers of the actual stale `src/lib/pricing.ts` module, not only its current intermediary.

### Fixed — Terms copy surfaced by stronger guard

The experimental primary-hero Terms section said `manual proof review` without an every-order proof-release gate. It now says `concierge intake confirmation`, matching the enforced concierge intake boundary without claiming proof QA.

## Governing lifecycle preserved

- Digital PDF is persisted and emailed with the proof before customer approval.
- Customer whole-book approval records acceptance/refund boundary and does not submit print.
- Authenticated admin manual approval remains the operator print-release path into `approvePrintProof`.
- No every-order human QA gate was introduced or claimed.
- The two exact historical legacy strings remain read/render normalized only; stored bytes remain unchanged.

## Verification

### Focused

- 84/84 passed
- Includes GET auth/legacy normalization, timing grammar, human-review grammar, all six email builders, order email/status, and legal copy

### Full tests

- `npm test`: 1,480 passed / 0 failed / 0 skipped

### Default production build

- Exact `npm run build` using Next.js 16.2 Turbopack: PASS
- 22/22 static pages generated
- TypeScript build stage passed

### Explicit TypeScript delta

- Base diagnostics: 34
- Candidate diagnostics: 34
- Introduced: 0
- Changed-file diagnostics: 0

### E2E/browser

- Exact `npm run test:e2e`: 99/99 passed
- Desktop and mobile Chromium
- Local production build/start on loopback `127.0.0.1:3178`
- Processing-copy homepage/checkout/thank-you/status surfaces covered
- Customer editor API/UI lifecycle tests covered
- Synthetic local fixtures only; provider/payment/email credentials stripped by existing config

### Other gates

- `git diff --check`: PASS
- `graphify update .`: PASS — 1,959 nodes / 3,581 edges / 174 communities
- Added-line skip/secret/live-action scan required before commit

## Environment notes

Codex’s sandbox could not bind loopback or write shared Git metadata, but both operations succeeded from Rex’s normal tool environment. Exact default Turbopack build also passed; no webpack override is included.

Temporary alias/shim files live only under `/tmp` or ignored `node_modules`; none is committed.

## Post-review linear child

Independent review of `ee214546096130327bd36a4c0d117675ba1e41df` found three blockers, all fixed in the next linear child:

1. The real order GET route now uses explicit relative `.ts` imports and `next/server.js`, so the repository’s exact default `npm test` runs cleanly without `NODE_OPTIONS`, an alias loader, or ignored `node_modules` shims.
2. Timing grammar now catches passive/modal and verb-before-file forms including `can be accessed`, `we provide`, `will be provided when`, `receive only after`, and `can download after approving`.
3. Human-review grammar now catches `each book reviewed by an expert`, team sign-off, team QA, staff vets each order, and editorial sign-off. The accurate final production check before print release is allowed only through a narrow print-release clause and a test binding it to authenticated `manuallyApproveProof → approvePrintProof` enforcement.

Post-fix verification:

- Clean focused gate: 44/44 passed with no loader/shims
- Exact default `npm test`: 1,481/1,481 passed
- Exact default Turbopack build: PASS, 22/22 pages
- TypeScript: 34 baseline / 34 candidate / 0 introduced / 0 changed-file diagnostics
- Exact `npm run test:e2e`: 99/99 passed

## Second post-review linear child

Independent review of `323120b0bc8cfce6c388933034edb9d1d7ad63d3` found the print-release exemption too broad: it could allow generic every-book/page/order QA promises. The next linear child changes only the guard test plus this handoff:

- the allowance is now anchored to the exact supported sentence, `Our team will complete the final production check before print release`;
- four generic review/inspection/check/art probes are explicitly banned;
- generic terminal vocabulary includes printing, print production, and print release.

Post-fix verification:

- human-review hostile/allowed gate: 16/16 passed;
- exact default `npm test`: 1,481/1,481 passed;
- TypeScript: 34 baseline / 34 candidate / 0 introduced / 0 changed-file diagnostics;
- application code is byte-identical to the build 22/22 and E2E 99/99 passed parent.

## Residual risks

- The authenticated raw GET remains an evidence route; callers must supply the configured admin key.
- The regex grammar is materially broader and directly fixture-tested, but customer truthfulness still requires future served-surface scans when new copy families are introduced.
- Candidate is not independently approved until a fresh reviewer audits the exact committed SHA.

## Side effects / preservation

- Protected worktrees were not edited.
- No fetch, push, PR, Preview, merge, deploy, provider call, customer/order/payment/proof/print/email/public action.
- No historical order backfill or stored-record mutation.
