# HSB Production Env Activation Checklist — 2026-06-02

Read-only checklist for verifying the Vercel **Production** environment
has every variable the deploy-candidate branch
(`hsb/deploy-candidate-20260602`) needs.

## Hard rules

- **Do not modify Vercel env from this checklist.** Use the Vercel
  dashboard / `vercel env add` only in a separately-scoped human-driven
  flow.
- **Do not print or paste secret values anywhere** — not in logs, not
  in tickets, not in chat, not in commit messages.
- This checklist verifies **presence + shape + trim status only**.

## Two ways to run the verifier

```bash
# 1. Pull a fresh production snapshot from Vercel (preferred).
vercel env pull --environment=production .env.production.local

# 2. Run the read-only checker against the snapshot.
node --env-file=.env.production.local \
  scripts/check-production-env.mjs --env=production
```

OR, if you already have the secrets exported in your shell:

```bash
node scripts/check-production-env.mjs --env=production
```

JSON for CI:

```bash
node scripts/check-production-env.mjs --env=production --json
```

The `.env.production.local` file is gitignored. **Delete it after
verification.** Verify your shell history is private before running.

Exit codes: `0` = all required PRESENT + shape-ok; `1` = at least one
failure; `2` = bad invocation.

## What the verifier checks

| Var | Required on Production | Shape signal | Why |
|---|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | **YES** | starts with `vercel_blob_rw_` | Durable persistence for orders, owner-print-go locks, KS state, Resend event log. Missing → R1 fail-closed refuses every protected action. |
| `RESEND_WEBHOOK_SECRET` | **YES** | starts with `whsec_` | Svix HMAC. Missing → `/api/webhooks/resend` returns 503 for every inbound event; `/admin/email-health` renders the unconfigured banner. |
| `RESEND_API_KEY` (or alias `HSB_RESEND_API_KEY`) | **YES** | starts with `re_` | Outbound email send (proof / digital / lifecycle). |
| `HSB_ORDER_ADMIN_KEY` | **YES** | ≥ 16 chars | Operator cookie/header secret for `/admin/*` and `/api/admin/*`. |
| `LULU_CLIENT_KEY` | **YES** | ≥ 8 chars | Lulu OAuth client id. |
| `LULU_CLIENT_SECRET` | **YES** | ≥ 8 chars | Lulu OAuth client secret. |
| `LULU_API_URL` | optional | should be `https://api.lulu.com`; flags sandbox | Production must NOT point at `api.sandbox.lulu.com`. |
| `LULU_WEBHOOK_SECRET` | optional but recommended | ≥ 8 chars | HMAC for `/api/webhooks/lulu` status updates. |
| `STRIPE_SECRET_KEY` | **YES** | starts with `sk_live_` | Production must be a live key; `sk_test_` is flagged. |
| `STRIPE_WEBHOOK_SECRET` | **YES** | starts with `whsec_` | Stripe webhook HMAC for `/api/webhooks/stripe`. |
| `NEXT_PUBLIC_URL` | **YES** | `https://…`, no localhost / vercel.app / trailing slash | Canonical site origin used in emails, review URLs, og:url. |
| `HSB_BLOB_NAMESPACE` | **must be unset/empty on Production unless explicitly approved** | flagged if set | Production must use the canonical blob namespace. Override only with `HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION=true` set as a sibling env var (forces the operator to acknowledge the namespace split). |

## How to read the report

The script prints one block per variable:

```text
RESEND_WEBHOOK_SECRET           PRESENT                [required]
  starts with 'whsec_', length 36
  → Svix HMAC for /api/webhooks/resend. Without this the webhook 503s every inbound event.
```

Status values:

- `PRESENT` — set, non-empty, shape OK
- `MISSING` — env var not set at all
- `PRESENT_BUT_EMPTY` — set to an empty or whitespace-only string
- `SHAPE_FAIL` — set but failed the shape check (e.g., `sk_test_` on Production)
- `PRESENT_DISALLOWED` — set when it should be unset (currently only `HSB_BLOB_NAMESPACE` on Production without the approved-for-production flag)

## What the script never does

- Print the value of any env var (only length and prefix observations on documented public markers).
- Write to `.env` files.
- Call the Vercel API / `vercel env add` / `vercel env rm`.
- Make any network call.
- Deploy.
- Mutate orders / customers / payments / print / email.

## Activation order (operator)

When the checker reports `FAIL`, fix one variable at a time in the
Vercel dashboard, then re-pull and re-run:

1. **`BLOB_READ_WRITE_TOKEN`** first — without it, KS state and Resend
   event persistence fail-closed across the app.
2. **`HSB_ORDER_ADMIN_KEY`** — without it, the entire `/admin/*`
   surface returns "ops dashboard disabled".
3. **`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`** — without the
   webhook secret, paid order ingestion stalls.
4. **`RESEND_API_KEY`** — outbound proof / digital delivery email
   transport.
5. **`RESEND_WEBHOOK_SECRET`** + Resend dashboard webhook registration
   pointing at `https://<production>/api/webhooks/resend` — enables
   bounce monitoring at `/admin/email-health`.
6. **`LULU_CLIENT_KEY` + `LULU_CLIENT_SECRET`** — print submission.
7. **`NEXT_PUBLIC_URL`** — set to the canonical custom domain.
8. **Verify `HSB_BLOB_NAMESPACE` is unset** on Production (default is
   empty / no namespace prefix per `src/lib/orders.ts:getBlobNamespace`).

Re-run the checker after each Vercel save. Re-deploy only after the
checker reports `Verdict: PASS`.

## Final sanity step (manual)

After `Verdict: PASS`:

- Open the Vercel dashboard → Production deployment → Logs.
- Confirm no `[ops-kill-switches] durability failure` lines.
- Confirm no `[resend-webhook] persistence failed` lines on a real
  Resend webhook hit (send a test event from the Resend dashboard).
- Open `/admin/email-health` once signed in and confirm the
  `configured-not-verified` banner disappears after the first event
  ingests.

If any of the above fails, treat the deployment as RED/HOLD and revert.
