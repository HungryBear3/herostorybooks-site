# Opus Prompt - HSB RED-to-YELLOW Adversarial Review

Use this only after loading the candidate branch below.

Repo/worktree:

```text
/Users/abigailclaw/.openclaw/workspace/cc-worktrees/hsb-red-yellow-candidate-20260601
```

Branch:

```text
hsb/red-yellow-candidate-20260601
```

HEAD:

```text
f56eeee
```

Known verification:

- targeted admin/fulfillment/email: 96/96
- focused gate suite: 169/169
- full `npm test`: 1006/1006
- `npm run build`: green with known Turbopack NFT warning
- `git diff --check`: green
- skip/only scan: green
- refined secret scan: green
- `graphify update .`: green, 1481 nodes / 2691 edges / 159 communities

## Review Question

Can this candidate move HSB from RED/HOLD to YELLOW, or are there hidden launch blockers that still make paid/creator/gifting traffic unsafe?

## Required Review Areas

1. G1 route/provenance:
   - proof/artifact release requires `generationRouteDecision` and matching `route_decision_recorded`
   - fallback/API-disabled/template paths fail closed
   - stale-read-prone writes preserve route/provenance

2. G2 stale-read handling:
   - refusal paths preserve newly written state and audit events
   - email-failure paths do not clobber proof or route evidence

3. G3 owner print-go:
   - customer approval does not submit print
   - owner print-go is server-side, admin-only, and requires nonblank operator id
   - durable create-only lock happens before any Lulu/RPI side effect
   - race losers cannot submit print

4. G5 owner-test readiness:
   - runbook covers paid order, route evidence, QA, proof email, revision, revised proof, approval, no-auto-print, owner print-go
   - no step implies unapproved production mutation

5. Ops readiness:
   - daily cap, support inbox owner, QA operator checklist, refund/revision policy, kill switches, and Father’s Day cutoff rules are explicit enough for YELLOW

6. Public/customer trust:
   - no public promise contradicts proof-before-print, shipping uncertainty, or no-hardcover-by-Father's-Day posture
   - no route can send template prose or unreviewed proof to a customer

## Output Format

```text
Verdict: YELLOW_CANDIDATE_OK / HOLD

Blockers:
1. [severity] [file:line] issue, why it can harm a paid order, exact fix needed

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

Do not deploy, mutate orders, call Stripe/Lulu/RPI, send customer email, or perform any public action.
