# CC Prompt — Implement HSB KS-1 through KS-6 Operator Console

Repo/worktree:

```text
/Users/abigailclaw/.openclaw/workspace/cc-worktrees/hsb-red-yellow-candidate-20260601
```

Start from current candidate HEAD:

```text
4891fdb
```

## Mission

Implement an admin-only HSB kill-switch console that turns the current docs-only split controls into a real operator surface for **internal readiness**. This should close the “KS-1 through KS-6 are documented split controls, not a single operator console” blocker for the RED-to-YELLOW candidate.

This is not a production launch. This must not run G5, submit print, send customer email, deploy, or mutate production.

## Required Reading Before Coding

- `docs/reviews/rex-hsb-successor-gate-audit-2026-06-01-3011b52.md`
- `docs/ops/hsb-yellow-ops-readiness-2026-06-01.md`
- `docs/ops/hsb-print-path-sla-decision-2026-06-01.md`
- `docs/runbooks/hsb-g5-paid-owner-test-2026-06-01.md`
- Existing admin surfaces:
  - `src/app/admin/capacity/page.tsx`
  - `src/app/admin/orders/page.tsx`
  - `src/app/admin/qa-room/page.tsx`
  - `src/lib/admin-auth.ts`
  - `src/lib/admin-auth-server.ts`
  - `src/app/api/admin/login/route.ts`

## Non-Negotiable Red Lines

- Do not deploy.
- Do not push.
- Do not call Stripe.
- Do not call Lulu or RPI.
- Do not call Resend or send customer/admin email.
- Do not mutate production orders, Vercel Blob production data, payment state, fulfillment state, or print state.
- Do not change public/customer-facing copy except if needed to read an already-active checkout pause flag.
- Do not mark HSB GREEN or approved for paid/creator/gifting traffic.
- Do not touch the paid owner-test order `ord_d8ba45c3169b456f`.

## Console Scope

Add an admin-only operator page, preferably:

```text
/admin/kill-switches
```

Use the existing admin cookie/session pattern from `/admin/capacity` and `/admin/orders`.

The console must show six switch rows:

1. **KS-1 Checkout pause**
   - Existing env-backed runtime truth: `HSB_CHECKOUT_PAUSED=true`.
   - Console must show current effective env state.
   - If a local persisted override is implemented, `/api/order` and checkout pause helpers must consume it before Stripe/session creation.

2. **KS-2 Proof release hold**
   - Intended effect: operators do not run QA pass / customer proof release while active.
   - If implemented as a persisted flag, QA-pass admin route must refuse before release/send paths.

3. **KS-3 Owner print-go hold**
   - Intended effect: owner print-go is refused while active.
   - If implemented as a persisted flag, `/api/admin/orders/[orderId]/print-go` must refuse before `recordOwnerPrintGo`.

4. **KS-4 Marketing/traffic hold**
   - Internal status flag only unless an existing traffic integration exists.
   - Must be visible in console and daily ops docs.
   - No external ad/social API calls.

5. **KS-5 Provider/generation hold**
   - Intended effect: no new provider generation route without explicit route/provenance approval.
   - If wired into code, it must fail closed before new generation work starts. Do not break admin diagnostics/read-only views.

6. **KS-6 Print-provider hold**
   - Intended effect: no Lulu/RPI submission while active.
   - If wired into code, print submission must refuse before any Lulu/RPI side effect.

Conservative implementation is acceptable:

- At minimum, create a real admin console that displays all six switches, owner/operator, reason, updatedAt, and action buttons.
- Persist switch state locally/testably through the existing storage conventions or a new small ops-state helper.
- Wire the high-risk switches into the relevant admin/server paths where the code already has a clear local boundary:
  - checkout pause before Stripe/order form parsing;
  - QA pass/proof release before send/release;
  - owner print-go before durable lock / print submit;
  - print-provider hold before Lulu/RPI side effect.
- For any switch not fully wired, label it clearly as `manual/status-only` and keep the acceptance docs honest.

## Persistence Requirements

Prefer a small structured ops state helper, for example:

```text
src/lib/ops-kill-switches.ts
```

State should include:

```ts
type KillSwitchId =
  | 'checkout_pause'
  | 'proof_release_hold'
  | 'owner_print_go_hold'
  | 'marketing_hold'
  | 'provider_hold'
  | 'print_provider_hold';

type KillSwitchState = {
  id: KillSwitchId;
  active: boolean;
  reason: string;
  updatedAt: string;
  updatedBy: string;
  mode: 'enforced' | 'manual';
};
```

Use deterministic local/test storage. If Vercel Blob is used, keep it behind existing environment-aware store conventions. Tests must not require production Blob.

Create-only locks are not required for switches, but writes must be simple, auditable, and not silently discard unrelated switches.

## API Requirements

Add admin-authenticated API routes, for example:

```text
GET  /api/admin/kill-switches
POST /api/admin/kill-switches
```

Requirements:

- Must use existing admin auth helpers.
- Must return 401/403 when unauthenticated.
- Must require nonblank `updatedBy`.
- Must require nonblank `reason` when activating a switch.
- Must record an audit-like event in the ops state or a switch history list.
- Must never expose secrets.
- Must not accept query-string admin keys.
- Must not call external providers.

## UI Requirements

The admin page must:

- Link to/from `/admin/capacity`, `/admin/orders`, and `/admin/qa-room`.
- Show overall posture: `YELLOW-CANDIDATE / internal prep only` and `external RED/HOLD`.
- Show current env checkout pause state separately from persisted switch state if both exist.
- Show each switch with:
  - status (`Active` / `Clear`);
  - enforcement mode (`Enforced` / `Manual`);
  - reason;
  - updatedAt;
  - updatedBy;
  - expected operational effect;
  - activate/deactivate controls.
- Require operator id and reason before activation.
- Warn that deactivation does not approve deploy, paid traffic, G5, print, or customer sends.
- Avoid customer-facing/public promise changes.

## Server Enforcement Requirements

Wire enforced switches only where local boundaries are clear:

- Checkout pause must refuse `/api/order` before Stripe Checkout or form parsing.
- Proof release hold must refuse admin QA pass/proof release before artifact release/customer email send.
- Owner print-go hold must refuse before `recordOwnerPrintGo`, before durable lock acquisition, and before print side effects.
- Print-provider hold must refuse before any Lulu/RPI submit call.

Expected refusal shape can be simple JSON with stable codes:

```text
KILL_SWITCH_ACTIVE
CHECKOUT_PAUSED
PROOF_RELEASE_HELD
OWNER_PRINT_GO_HELD
PRINT_PROVIDER_HELD
```

Do not make customer approval submit print. Do not weaken G1/G2/G3/G5 gates.

## Tests Required

Add focused tests proving:

1. Unauthenticated users cannot read or mutate kill-switch state.
2. Authenticated admin can activate/deactivate switches with `updatedBy` and reason.
3. Activating without reason is refused.
4. Activating without operator id is refused.
5. Checkout pause is enforced before Stripe/order creation.
6. Proof release hold refuses QA pass/proof release before email transport or state advance.
7. Owner print-go hold refuses before `recordOwnerPrintGo` / print side effects.
8. Print-provider hold refuses before Lulu/RPI submission.
9. Marketing/provider manual switches render honestly as manual/status-only if not wired.
10. Console source contains no public/customer-facing deploy approval language and no Father’s Day guarantee/date promise.

Update existing tests if their expectations change, but do not loosen the accepted G1/G2/G3 tests.

## Docs Updates Required

Update:

- `docs/ops/hsb-yellow-ops-readiness-2026-06-01.md`
- Any new short implementation note under `docs/ops/` if useful.

The docs must clearly say which KS switches are enforced in code and which remain manual/status-only.

## Verification Commands

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

If code files change, run:

```bash
graphify update .
```

## Commit

Commit the implementation locally on the current branch only.

Suggested commit message:

```text
feat(hsb): add admin kill-switch console
```

Do not push.

## Final Report Format

```text
HSB KS console implementation: PASS / HOLD
Commit:
Files changed:
Switches enforced in code:
Switches still manual/status-only:
Admin auth evidence:
Checkout pre-Stripe evidence:
Proof release hold evidence:
Owner print-go hold evidence:
Print-provider hold evidence:
Tests/build:
Side effects performed: none
Residual blockers:
```
