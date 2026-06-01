# CC Prompt — Implement HSB Owner Print Go Console from CD v2 Design

Repo/worktree:

```text
/Users/abigailclaw/.openclaw/workspace/cc-worktrees/hsb-red-yellow-candidate-20260601
```

Current candidate commit to start from:

```text
3011b52
```

Design reference archived in repo:

```text
docs/design/hsb-owner-print-go-console-cd-v2-2026-06-01.html
docs/design/hsb-owner-print-go-console-cd-v2-rex-notes-2026-06-01.md
```

## Mission

Implement the safest parts of the Owner Print Go Console design as a real admin-only production UI. Do **not** paste the standalone HTML wholesale. Extract the interaction model, copy hierarchy, and confirmation pattern; wire it to existing real admin order state and existing server owner-print-go actions.

## Non-negotiable constraints

Do not deploy. Do not mutate production orders. Do not call Stripe, Lulu, RPI, Resend, customer email, or print APIs during implementation/testing. Use local/unit tests and mocks only.

Do not change launch status. This is UI hardening only and does not close G5 or ops readiness.

## Source-of-truth gates to preserve

Read these before coding:

- `docs/reviews/rex-hsb-successor-gate-audit-2026-06-01-3011b52.md`
- `docs/ops/hsb-print-path-sla-decision-2026-06-01.md`
- `docs/runbooks/hsb-g5-paid-owner-test-2026-06-01.md`
- `docs/ops/hsb-yellow-ops-readiness-2026-06-01.md`

Current accepted backend gate patterns:

- Customer proof approval must not submit print.
- Owner print-go must be admin-only.
- Owner print-go requires nonblank `ownerBy` operator id.
- Owner print-go must require paid order, QA pass, customer approval, `proof_approved`, no prior print job, no prior owner-go.
- Durable create-only owner print-go intent lock must happen before any Lulu/RPI side effect.
- Race losers must render safe refusal (`RACE_LOST`) and must not submit print.

## Implementation scope

Implement a real admin UI surface for owner print go / no-go. Use one of these shapes, whichever matches current app structure best:

1. enhance `src/app/admin/orders/[orderId]/...` detail UI with an Owner Print Go decision panel; or
2. add an admin-only route like `/admin/orders/[orderId]/print-go` if that is cleaner.

The UI must show:

- order id and book format;
- payment status;
- QA pass status/time/reviewer;
- customer proof approval status/time;
- current fulfillment status;
- print job id/status if already submitted;
- ownerPrintGoAt / ownerPrintGoBy if already recorded;
- explicit warning: customer approval is not enough to submit print;
- no-auto-print assertion before owner-go;
- best-chance / no guaranteed date copy from print SLA decision;
- disabled / hold states with reasons;
- confirmation modal with required checkbox and exact explicit action text (`PRINT GO` or equivalent strong phrase);
- refusal/error rendering for `OWNER_BY_REQUIRED`, `CUSTOMER_APPROVAL_REQUIRED`, `QA_NOT_PASSED`, `WRONG_FULFILLMENT_STATUS`, `ALREADY_OWNER_GO`, `ALREADY_SUBMITTED`, `ALREADY_SHIPPED`, `RACE_LOST`, `PERSIST_FAILED`.

## Explicitly out of scope

- No new print provider integration.
- No RPI implementation.
- No SLA/date promise changes.
- No kill-switch console.
- No Resend bounce monitoring.
- No production deploy.
- No real paid G5 execution.
- No public/customer-facing design changes.

## Tests required

Add or update tests to prove:

1. Admin auth gates the owner print-go UI/API before any action.
2. Customer-facing source files do not import/call owner print-go or print submit.
3. Button is disabled unless backend eligibility is present.
4. Confirmation checkbox + explicit confirm text are required before POST.
5. Blank operator id refuses and does not call owner print-go.
6. `RACE_LOST`, already-submitted, and already-owner-go refusals render as safe no-op states.
7. Customer approval alone still does not set `ownerPrintGoAt`, `printJobId`, or call `submitPrint`.
8. The UI copy contains no guaranteed Father’s Day / exact date print promise.

## Verification commands

Run at minimum:

```bash
npm test
npm run build
git diff --check
python - <<'PY'
from pathlib import Path
bad=[]
for p in Path('tests').glob('*.test.ts'):
    s=p.read_text(errors='ignore')
    if '.only(' in s or '.skip(' in s:
        bad.append(str(p))
print('skip_only', bad or 'clean')
PY
```

If code files are modified, run:

```bash
graphify update .
```

## Final report format

```text
Owner Print Go Console implementation: PASS / HOLD
Commit:
Files changed:
Backend gate preservation:
Admin auth evidence:
Confirmation gating evidence:
Refusal-state rendering evidence:
No-auto-print evidence:
Tests/build:
Side effects performed: must be none
Residual blockers:
```
