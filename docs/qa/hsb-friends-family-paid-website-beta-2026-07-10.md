# HSB Friends/Family Paid Website Beta — Readiness Plan

Date: 2026-07-10
Owner: Rex
Scope: Option B — friends/family run through website with real payment receipt, while custom-memory production remains human-reviewed/manual.

## Goal

Enable a controlled friends/family website lane where a buyer can submit a custom/family-memory book request, pay through Stripe, and receive a payment receipt — **without** triggering automated proof generation, print/provider submission, customer proof release, or public/self-serve custom-memory launch.

## Non-negotiable operating model

- Website-mediated, not fully self-serve generation.
- Payment can happen only after server-side shape validation and durable order persistence.
- Paid custom-memory orders must land in manual review / concierge production state.
- No proof/image generation, likeness rendering, print/provider job, proof email, customer fulfillment email, or public/sample use without separate approval.
- Raw transcripts/audio/source material never pass downstream. Use sanitized brief only.

## Current source facts

- `origin/main` at `ab9fe75` contains PR #95 custom-memory validation gates.
- API `/api/order` already parses `customStoryBrief`, validates it before Stripe, persists the order before Stripe, and blocks template fallback for custom briefs.
- For non-self-serve custom shapes, the API requires `HSB_PRIMARY_HERO_BETA=true` or `NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA=true` before allowing checkout progression.
- Public checkout UI currently shows Phase-A story upload/primary-hero groundwork, but no confirmed visible customer field that sends `customStoryBrief`; this needs a dedicated controlled intake path or UI wiring.
- `herostorybooks.com` / `www.herostorybooks.com` currently point to an older Jul 8 deployment, not the latest PR #95 deployment.

## Minimal implementation needed before inviting friends/family

### 1. Live baseline cutover

- Add Meta/Facebook domain verification tag to server-rendered `src/app/layout.tsx` metadata.
- Build from clean `origin/main` + meta patch.
- Deploy/alias current build to `herostorybooks.com` and `www.herostorybooks.com`.
- Verify source HTML at `https://www.herostorybooks.com/` includes the Meta tag inside `<head>`.
- Verify live domains inspect to the same latest deployment.

### 2. Controlled website intake route/UI

Implement one explicit friends/family concierge route, preferred:

- `/custom-memory` or `/create/your-memory`

Required UI fields:

- buyer name/email
- recipient/audience
- primary hero / hero type
- cast list / relationships
- memory/source summary
- inclusions / avoid list
- optional private reference photos with consent
- explicit consent checks
- copy: “request + payment receipt, not automatic proof/print”

Submission must send a sanitized `customStoryBrief` into `/api/order`.

### 3. Paid beta server state

For valid custom-memory beta orders:

- validation passes
- order persists before Stripe
- Stripe checkout session is created
- order remains manual/concierge after payment
- generation/proof/print/provider flags remain off

Expected paid order state after payment:

```text
paymentStatus: paid
status/generationStatus: manual_generation_required or queued_for_review
proofStatus: not_started
printStatus: not_started
source: custom_story / custom_memory
```

If current order schema lacks exact fields, add them explicitly or document the existing equivalent fields in admin.

### 4. Admin queue visibility

Admin must show:

- payment status
- customStoryBrief summary
- customStoryValidation result
- story shape / lane
- cast list
- reference upload metadata
- consent flags
- manual generation/proof/print status

If admin cannot review the submitted custom-memory payload, do not invite friends/family yet.

### 5. Feature/env gate

Production env for controlled beta:

- `HSB_PRIMARY_HERO_BETA=true` only when the UI/admin/manual queue are ready.
- Story-upload/custom-memory public entry must be scoped to the dedicated beta route; do not globally imply self-serve generation.
- `HSB_ENABLE_OPENAI_STORY=false` or equivalent manual-production gate for custom-memory path if present.
- Stripe live is allowed only for this controlled beta after one no-payment and one paid smoke.
- Print/provider env/actions remain disabled or manually gated.

### 6. Smoke tests before friend/family invite

Run in this order:

1. **Live HTML/deploy smoke**
   - apex + www point to latest deploy
   - Meta tag visible in `<head>`
   - `/`, `/checkout`, dedicated custom-memory route, `/thank-you`, admin route health

2. **No-payment/custom-memory dry submit**
   - submit sanitized fixture or use server-level test mode
   - prove validation/manual queue behavior
   - prove no Stripe when disabled or unsafe

3. **Unsafe payload regression**
   - raw `rawTranscript` / unsanitized keys → fail before Stripe

4. **Paid internal smoke**
   - one controlled Stripe payment through website
   - verify Stripe session/payment intent
   - verify local order record persisted and linked by `client_reference_id` / metadata `orderId`
   - verify thank-you/status page
   - verify admin queue sees custom-memory fields
   - verify no proof/print/provider/customer fulfillment side effects

5. **Cleanup/disposition**
   - mark internal smoke record clearly
   - no refund/customer email unless explicitly approved

## Invite cap

Start with 3–5 friends/family only. Pause after each paid order until order/payment/admin/proof handoff is verified.

## HOLD conditions

Stop immediately if:

- live domains serve stale deployment
- checkout creates Stripe before durable order persistence
- paid order cannot be found by orderId/email/Stripe session
- custom-memory order lacks admin-visible brief/consent/cast data
- raw transcript is accepted downstream
- template fallback produces a proof for custom-memory
- proof/print/provider starts automatically
- public copy implies instant AI/custom generation

## Next code tasks

1. Meta tag patch/build/deploy/cutover.
2. Add/verify dedicated custom-memory paid-beta intake route or safely extend checkout UI to send `customStoryBrief`.
3. Add tests that a valid concierge custom-memory brief can proceed to Stripe **only** with beta flag on and is persisted as manual review.
4. Add admin visibility for custom-memory fields if missing.
5. Add docs/QA evidence file after no-payment + paid smoke.
