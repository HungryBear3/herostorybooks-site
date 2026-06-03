# HSB HER-6 Deploy Readiness Packet — 2026-06-02

Status: READY FOR OPERATOR REVIEW, NOT DEPLOYED
Prepared by: Rex
Timestamp: 2026-06-02 20:00 CDT
Scope: local deploy-candidate only. No Vercel deploy, production order mutation, Stripe charge/replay, Resend action, Lulu action, customer email, or print action performed.

## Executive verdict

- Code/build readiness: PASS for controlled deploy-candidate review.
- Production activation readiness: NOT READY until production env is configured and rechecked from a Vercel production env pull.
- Traffic posture: YELLOW internal/owner-test only. Public paid traffic, creator/gifting, and broad social traffic remain HOLD.
- Proof release safety: PASS. `proof_release_hold` now blocks both digital delivery auto-send and print proof-ready auto-send immediately before customer email transport.

## Verified commit / worktree

- Worktree: `/Users/abigailclaw/.openclaw/workspace/cc-worktrees/hsb-red-yellow-candidate-20260601`
- Branch: `hsb/deploy-candidate-20260602`
- Commit under review: `0cf0372` — `Guard fulfillment auto-send with proof release hold`

## Verification run

Commands run locally on deploy-candidate:

```bash
TMPDIR=/tmp node --experimental-strip-types --test tests/fulfillment.test.ts tests/resend-events.test.ts
TMPDIR=/tmp npm run build
node scripts/check-production-env.mjs --env=production --json
```

Results:

- Fulfillment + Resend tests: PASS — 70/70.
- Build: PASS.
- Known build warning: Turbopack NFT trace warning via `next.config.js` / dynamic filesystem import trace. Existing known warning; build completed.
- Production env checker without a Vercel env pull: FAIL as expected because this shell did not load production secrets. No secret values were read or printed.

## HER-6 readiness checklist

### 1. Release guard / proof-release hold

PASS.

Evidence:

- `tests/fulfillment.test.ts` includes proof-release hold tests for:
  - qa-passed digital auto-send blocked before customer email.
  - qa-passed print proof-ready auto-send blocked before customer email.
- `src/lib/fulfillment.ts` enforces `enforceKillSwitch('proof_release_hold')` immediately before legacy digital delivery email and print proof-ready email.
- Active hold maps to `PROOF_RELEASE_HELD`; unavailable kill-switch state maps to the fail-closed unavailable reason/message.

### 2. Resend webhook / email health monitor

CODE PASS, OPS CONFIG REQUIRED.

Evidence:

- `src/lib/resend-events.ts` persists allowlisted Resend events and fails closed when production Blob persistence is unavailable.
- `src/app/api/webhooks/resend/route.ts` requires `RESEND_WEBHOOK_SECRET`, verifies Svix HMAC, enforces replay window before persistence, and returns 503 on persistence failure so Svix retries.
- `/admin/email-health` is read-only and admin-auth-gated.
- `tests/resend-events.test.ts` passed as part of the 70/70 targeted run.
- Ops runbook exists: `docs/ops/hsb-resend-bounce-monitoring-2026-06-02.md`.

Required before deploy traffic:

1. Set `RESEND_WEBHOOK_SECRET` in Vercel Production.
2. Register Resend webhook endpoint: `https://<production-deploy>/api/webhooks/resend`.
3. Subscribe at minimum to `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.delivered`.
4. Send a Resend dashboard test event after deploy and confirm `/admin/email-health` displays it.

### 3. Production env gate

BLOCKED until operator/Vercel env pull.

Current read-only checker output from shell with no production env loaded:

- Missing required for production:
  - `BLOB_READ_WRITE_TOKEN`
  - `RESEND_WEBHOOK_SECRET`
  - `RESEND_API_KEY`
  - `HSB_ORDER_ADMIN_KEY`
  - `LULU_CLIENT_KEY`
  - `LULU_CLIENT_SECRET`
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `NEXT_PUBLIC_URL`
- Optional/mode-sensitive:
  - `LULU_API_URL`
  - `LULU_WEBHOOK_SECRET`
  - `HSB_BLOB_NAMESPACE` must remain unset/empty in Production unless explicitly approved.

Required operator check:

```bash
vercel env pull --environment=production .env.production.local
node --env-file=.env.production.local scripts/check-production-env.mjs --env=production --json
```

Do not paste or commit `.env.production.local`. The checker prints only presence/shape observations.

### 4. Deploy action

NOT PERFORMED.

Recommended deploy gate sequence if Alexy approves later:

1. Run production env checker from Vercel env pull — must return `verdict: PASS`.
2. Confirm `proof_release_hold` durable state is active before owner-test unless Alexy explicitly releases proof auto-send.
3. Deploy preview/production candidate through approved Vercel flow.
4. Validate `/admin/email-health`, `/admin/kill-switches`, `/admin/orders`, checkout smoke path, and webhook endpoints without sending customer email.
5. Only then run G5 owner-test with artifact packet capture.

## Remaining blockers before GREEN

- Production env presence/shape not verified from Vercel Production.
- Resend webhook not registered/tested against deployed endpoint.
- G5 real paid owner E2E artifact packet not executed yet.
- Broader traffic still requires at least two clean operating days at intake volume.

## Bottom line

HER-6 is ready for operator review as a deploy-candidate packet. It is not approval to deploy or launch traffic. Next highest-value action is the G5 artifact packet skeleton, then an approved production env pull/check.
