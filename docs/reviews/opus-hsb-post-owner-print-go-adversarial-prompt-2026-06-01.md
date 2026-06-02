# Opus Prompt — HSB Post Owner Print-Go Console Adversarial Review

Use this only after loading the candidate branch below.

Repo/worktree:

```text
/Users/abigailclaw/.openclaw/workspace/cc-worktrees/hsb-red-yellow-candidate-20260601
```

Branch:

```text
hsb/red-yellow-candidate-20260601
```

Current HEAD:

```text
cd09c9f
```

Key recent commits:

```text
540ec60 feat(hsb): owner print go console — modal, tiles, refusal-state UI
cd09c9f docs(hsb): archive owner print-go console CD v2 design + impl prompt
```

Known verification after `540ec60`:

- Full `npm test`: 1018/1018 pass
- `git diff --check`: clean
- skip/only scan: clean
- `npm run build`: reported green by CC
- `graphify update .`: reported 1486 nodes / 2713 edges / 162 communities
- Rex source spot-checks passed for:
  - `PRINT GO` modal
  - owner-go path no longer using `window.confirm()`
  - additive `failureCode` route body
  - structured refusal-state UI
  - no-auto-print copy
  - best-chance / no guaranteed-date copy

Hard constraints for your review:

- Do not deploy.
- Do not mutate production orders.
- Do not call Stripe, Lulu, RPI, Resend, customer email, or print APIs.
- Do not make code changes.
- This is adversarial read-only review only.

## Source-of-truth docs to read first

Read these files before forming a verdict:

```text
docs/reviews/rex-hsb-successor-gate-audit-2026-06-01-3011b52.md
docs/ops/hsb-print-path-sla-decision-2026-06-01.md
docs/runbooks/hsb-g5-paid-owner-test-2026-06-01.md
docs/ops/hsb-yellow-ops-readiness-2026-06-01.md
docs/design/hsb-owner-print-go-console-cd-v2-rex-notes-2026-06-01.md
```

Also inspect the implementation touched by `540ec60`:

```text
src/app/admin/orders/[orderId]/detail-client.tsx
src/app/admin/orders/[orderId]/page.tsx
src/app/api/admin/orders/[orderId]/print-go/route.ts
src/lib/admin-actions.ts
tests/admin-shipping-proof.test.ts
```

## Review question

After the Owner Print-Go Console UI slice, can HSB move from YELLOW-CANDIDATE/internal prep to an approved controlled G5 paid owner-test attempt, or are there still hidden blockers that make even a controlled paid owner-test unsafe?

Do **not** answer whether HSB is ready for public paid traffic, creator outreach, gifting, or broad launch. Those remain blocked unless G5 and ops readiness are explicitly cleared.

## Required review areas

1. **G1 route/provenance**
   - Proof/artifact release requires `generationRouteDecision` and matching `route_decision_recorded`.
   - Fallback/API-disabled/template paths fail closed.
   - Stale-read-prone writes preserve route/provenance.
   - No path can send template prose or unreleasable proof to a customer.

2. **G2 stale-read handling**
   - Refusal paths preserve newly written state and audit events.
   - Email-failure paths do not clobber proof or route evidence.
   - Auto-send paths are guarded before customer email.

3. **G3 owner print-go backend safety**
   - Customer proof approval does not submit print.
   - Owner print-go is server-side, admin-only, and requires nonblank operator id.
   - Durable create-only lock happens before any Lulu/RPI side effect.
   - Race losers cannot submit print.
   - Already-submitted/already-shipped/already-owner-go states are safe no-ops.

4. **Owner Print-Go Console UI safety after `540ec60`**
   - Admin page is auth-gated before rendering operator actions.
   - UI does not expose owner-go to customer-facing routes.
   - `PRINT GO` modal/checkbox/operator-id gating is sufficient as UX guard, while server remains source of truth.
   - `failureCode` addition is backwards-compatible and does not weaken route behavior.
   - Refusal copy makes clear when no print submission occurred.
   - Copy does not guarantee Father's Day / exact date delivery.

5. **G5 owner-test readiness**
   - Runbook covers paid order, route evidence, QA, proof email, revision, revised proof, customer approval, no-auto-print proof, owner print-go, and post-action evidence.
   - No step implies unapproved production mutation.
   - Artifact packet requirements are concrete enough for Rex to verify.

6. **Ops readiness for controlled G5 only**
   - Named human owners exist or the missing-owner gap is explicitly blocking.
   - Daily cap/support inbox/QA operator/refund-revision policy/kill-switch/bounce monitoring are enough for a single controlled owner test.
   - If not enough, say exactly which missing item blocks G5 vs which only blocks public traffic.

7. **Public/customer trust posture**
   - No public promise contradicts proof-before-print, shipping uncertainty, or no-hardcover-by-Father's-Day posture.
   - Launch remains fail-closed for public traffic until G5 evidence is captured.

## Output format

```text
Verdict: CONTROLLED_G5_OK / HOLD

If HOLD, top blockers:
1. [severity] [file:line] issue, why it can harm a paid owner-test order, exact fix or decision needed

If CONTROLLED_G5_OK, required pre-flight checklist:
1. exact approval / env / evidence / operator condition required before Rex can run or verify G5

Blockers for public traffic/creator/gifting after G5:
1. ...

Non-blocking risks:
1. ...

Questions for Alexy:
1. ...

Evidence checked:
- commands/files reviewed
- tests/build relied on

Final recommendation:
...
```

Be adversarial. Treat “tests pass” as insufficient if an operator, customer, fulfillment, or audit path can still fail open. Conversely, separate true blockers from things that are acceptable for a single owner-controlled paid test but not for public launch.
