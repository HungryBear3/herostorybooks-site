# HSB G5 — Operator/Env Evidence Packet

Status: PREPARED, NOT EXECUTED (no env mutation, no provider calls, no secrets printed)
Prepared by: Claude Code (read-only)
Date: 2026-06-03

This packet captures what is verifiable offline and lists the exact operator
steps that still require Alexy's approval (live Vercel env pull). No secret
value appears anywhere in this document or in any tool used to build it.

---

## 1. Deploy identity (verified offline)

- PR: #34 (DRAFT, do not merge) — https://github.com/HungryBear3/herostorybooks-site/pull/34
- Head branch: `fix/hsb-g5-owner-test-hardening`
- Head commit: `1790cfcc8a951420a19176c21191df552e9882a9`
- Base / deploy candidate: `hsb/deploy-candidate-20260602`
- PR checks: Vercel deployment = pass; Vercel Preview Comments = pass
- Mergeable state: CLEAN (informational; NOT to be merged at G5 prep)

## 2. Code-level gates (verified by test suite — 1121/1121 pass)

| Gate | Mechanism | Status |
|---|---|---|
| Checkout pause / KS | `isCheckoutPaused` + `enforceKillSwitch('checkout_pause')` (fail-closed on unreadable store) | present, precedence over owner-test gate |
| Owner-test checkout | `evaluateOwnerTestGate` — DEFAULT-CLOSED, requires flag + allowlist | added this PR |
| Proof release hold | `enforceKillSwitch('proof_release_hold')` gates customer proof/digital email | present |
| Owner print-go | `evaluatePrintGuard` requires `ownerPrintGoAt` separate from customer approval | present |
| Null/blank image | `validateManifest`→`MANIFEST_INCOMPLETE` blocks release + Lulu; `applyAcceptPage` rejects null | now pinned by regression tests |
| Stripe secret sanitize | `sanitizeStripeEnv` strips literal `\n`/CR-LF, fail-closed | present |
| Env checker normalization | `check-production-env.mjs` classifies literal `\n`/empty correctly | added this PR |

## 3. Production env — required-var inventory (from scripts/check-production-env.mjs)

The checker is read-only, makes no network calls, never prints values, never
mutates Vercel. Per-var expectations it enforces:

| Var | Required on prod | Expected shape |
|---|---|---|
| BLOB_READ_WRITE_TOKEN | yes (+preview) | starts `vercel_blob_rw_` |
| RESEND_WEBHOOK_SECRET | yes | starts `whsec_` |
| RESEND_API_KEY (alias HSB_RESEND_API_KEY) | yes | starts `re_` |
| HSB_ORDER_ADMIN_KEY | yes (+preview) | length ≥ 16 |
| LULU_CLIENT_KEY | yes | length ≥ 8 |
| LULU_CLIENT_SECRET | yes | length ≥ 8 |
| LULU_API_URL | optional | must NOT be api.sandbox.lulu.com on prod; default api.lulu.com |
| LULU_WEBHOOK_SECRET | optional (recommended) | length ≥ 8 |
| STRIPE_SECRET_KEY | yes | starts `sk_live_` (rejects `sk_test_`) |
| STRIPE_WEBHOOK_SECRET | yes | starts `whsec_` |
| FAL_KEY | yes | present + non-empty (length ≥ 8; value never shown) |
| NEXT_PUBLIC_URL | yes | https, no localhost / vercel.app / trailing slash |
| HSB_OWNER_TEST_CHECKOUT_ENABLED | yes | must equal `true` |
| HSB_OWNER_TEST_EMAILS | yes | ≥1 valid email (count-only, addresses never shown) |
| HSB_BLOB_NAMESPACE | must be UNSET on prod | present-on-prod = fail unless HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION=true |

## 4. Live env presence/shape — PENDING OPERATOR PULL (requires Alexy approval)

No `.env.production.*` snapshot exists in the candidate workspace, so live
presence/shape for the above vars is UNKNOWN from offline inspection.

Operator steps (run only after Alexy approves; writes secrets to a gitignored
local file — verify shell history is private):

```bash
vercel env pull --environment=production .env.production.local
node --env-file=.env.production.local scripts/check-production-env.mjs --env=production --json
```

Record below (status only — never paste values):

| Var | status (PRESENT / MISSING / PRESENT_BUT_EMPTY / SHAPE_FAIL / PRESENT_DISALLOWED) | observation |
|---|---|---|
| BLOB_READ_WRITE_TOKEN | _pending_ | |
| RESEND_WEBHOOK_SECRET | _pending_ | |
| RESEND_API_KEY | _pending_ | |
| HSB_ORDER_ADMIN_KEY | _pending_ | |
| LULU_CLIENT_KEY | _pending_ | |
| LULU_CLIENT_SECRET | _pending_ | |
| LULU_API_URL | _pending_ | |
| LULU_WEBHOOK_SECRET | _pending_ | |
| STRIPE_SECRET_KEY | _pending_ | |
| STRIPE_WEBHOOK_SECRET | _pending_ | |
| FAL_KEY | _pending_ | |
| NEXT_PUBLIC_URL | _pending_ | |
| HSB_OWNER_TEST_CHECKOUT_ENABLED | _pending_ | |
| HSB_OWNER_TEST_EMAILS | _pending_ (count-only) | |
| HSB_BLOB_NAMESPACE | _pending_ | |
| Checker verdict (PASS/FAIL) | _pending_ | |

## 5. Owner-test activation vars (validated by checker — status-only)

Checkout is default-closed. To open it for the controlled owner-test, set BOTH
in Vercel production (operator action, pending Alexy approval):

- `HSB_OWNER_TEST_CHECKOUT_ENABLED=true`  (must equal `true`; anything else = FAIL)
- `HSB_OWNER_TEST_EMAILS=<comma-separated owner emails>`  (≥1 valid email)

> `check-production-env.mjs` now VALIDATES both vars as required-on-production.
> The checker reports status only — for the email list it shows entry/valid
> COUNTS, never the addresses. No manual confirmation needed; a missing/blank/
> `false`/no-valid-email value fails the checker verdict.

Add to the §4 status table when the live pull runs:

| Var | status | observation |
|---|---|---|
| HSB_OWNER_TEST_CHECKOUT_ENABLED | _pending_ | |
| HSB_OWNER_TEST_EMAILS | _pending_ (count-only) | |

## 6. Kill-switch / hold posture to confirm before the run (operator)

- `HSB_CHECKOUT_PAUSED` posture documented.
- `proof_release_hold` ACTIVE unless Alexy approves customer-facing proof/digital release.
- `owner_print_go_hold` / print-provider posture: no Lulu submission until explicit owner-go.
- Resend webhook registered; a dashboard test event visible at `/admin/email-health`.

## 7. Remaining G5 blockers (operator/env — not code)

1. Real `whsec_` STRIPE_WEBHOOK_SECRET set in Vercel prod.
2. FAL key set.
3. Lulu creds + sandbox-vs-prod posture decided.
4. Owner-test env vars (§5) set.
5. Fresh `vercel env pull` + `npm run check:production-env` returns PASS.

Full G5 run capture template: docs/reviews/hsb-g5-owner-test-artifact-packet-skeleton-2026-06-02.md
