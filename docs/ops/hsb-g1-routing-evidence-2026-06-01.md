# HSB G1 Routing Evidence — 2026-06-01

**Verifier:** Rex
**Repo/worktree:** `/Users/abigailclaw/.openclaw/workspace/cc-worktrees/cc-hsb-awaiting-qa-20260531`
**Commit tested:** `58b9701` — `fix(hsb): pass updateFulfillmentState result to appendAuditEvent in auto-send refusal paths`
**Mode:** local synthetic orders only, temp `HSB_ORDER_STORE_DIR`, mocked generation/PDF/upload/email deps.
**No production actions:** no deploy, no push, no Stripe, no Lulu/RPI, no Resend/customer email, no Blob write.

## Verdict

**G1 verdict: PARTIAL, not PASS.**

Rex verified that:

- tracked policy config is conservative: `defaultPaidCustomerRoute=OPENAI_MANUAL`, `apiFallbackEnabled=false`, `emergencyImageRoute=false`, `allowTemplateFallbackForPaid=false`;
- safe manual/subscription provenance persists on generated artifacts before customer release;
- forced API-disabled and template-fallback scenarios fail closed at the release boundary;
- no synthetic scenario sent email or made unmocked HTTP calls.

Remaining gap preventing full G1 PASS:

- There is no explicit persisted `route_decision_recorded` audit event / selected route field before proof artifact creation. Current evidence relies on persisted `storyMeta` + per-page `generationProvider`/`generationModel` provenance and release-time guard evaluation. That is strong release-boundary evidence, but not the exact "route persisted before any proof state is reachable" artifact Rex requested.

## Commands run

```bash
pwd
git status --short
git rev-parse --short HEAD
git branch --show-current
```

Result:

```text
/Users/abigailclaw/.openclaw/workspace/cc-worktrees/cc-hsb-awaiting-qa-20260531
58b9701
cc-hsb-awaiting-qa-20260531
```

Synthetic harness command summary:

```bash
TMPDIR=$(mktemp -d /tmp/hsb-g1-rex-XXXXXX)
HSB_ORDER_STORE_DIR="$TMPDIR" BLOB_READ_WRITE_TOKEN=*** \
  node --experimental-strip-types --input-type=module <local synthetic harness>
rm -rf "$TMPDIR"
```

The harness imported:

- `createOrderRecord`, `persistOrder`, `getOrder` from `src/lib/orders.ts`
- `triggerFulfillment` from `src/lib/fulfillment.ts`
- `buildManifest`, `evaluateReleaseGuard` from `src/lib/generation-manifest.ts`
- `chooseGenerationRoute`, `loadGenerationPolicyConfig` from `src/lib/generation-policy.ts`

Global `fetch` was stubbed to count any unmocked HTTP escape. Result: `unmockedFetchCalls=0`.

## Policy config observed

```json
{
  "policyVersion": "2026-05-31",
  "binding": "Father's Day launch through 2026-06-21",
  "defaultPaidCustomerRoute": "OPENAI_MANUAL",
  "apiFallbackEnabled": false,
  "emergencyImageRoute": false,
  "allowTemplateFallbackForPaid": false,
  "orderIntakeOpen": true,
  "digitalFirstMode": true,
  "printCtaEnabled": true
}
```

## Synthetic order results

### S1 — happy safe manual/subscription route

**Synthetic order ID:** `ord_g1_s1_manual_happy_20260601`

**Route decision:**

```json
{
  "route": "OPENAI_MANUAL",
  "permitted": true,
  "reason": "OPENAI_MANUAL (default Abby / subscription) route",
  "requiresAuditLog": false
}
```

**Final persisted state:**

- `status`: `preview_ready`
- `fulfillmentStatus`: `awaiting_qa`
- `storyArtifactUrlPresent`: `true`
- `pageArtifacts`: `2`
- `storyMeta.source`: `manual`
- `storyMeta.model`: `abby:manual-subscription`
- first page provider/model: `manual` / `abby:manual-subscription`
- audit events: `proof_generated`
- email calls: `0`

**Manifest / guard:**

- manifest complete: `true`
- story route allowed: `true`
- page route allowed: `true`
- manifest hash present: `true`
- release guard: `QA_NOT_PASSED`, because QA has not passed yet

**Result:** PASS for safe-generation hold. Proof artifact exists for internal QA, but no customer release occurs.

### S2 — forced OpenAI API route while `apiFallbackEnabled=false`

**Synthetic order ID:** `ord_g1_s2_api_flag_off_20260601`

**Route decision:**

```json
{
  "route": "BLOCKED",
  "permitted": false,
  "reason": "OPENAI_API requested but apiFallbackEnabled flag is disabled",
  "failureCode": "BLOCKED_API_FLAG_OFF",
  "requiresAuditLog": true
}
```

**Injected story provenance:**

- `storyMeta.source`: `openai_chat`
- `storyMeta.model`: `gpt-4o-mini`

**Final persisted state:**

- `status`: `preview_ready`
- `fulfillmentStatus`: `qa_blocked`
- `qaStatus`: `blocked`
- `qaBlockedReason`: `PROVIDER_ROUTE_BLOCKED: Story route not allowed: openai (storyFallbackUsed=false)`
- `storyArtifactUrlPresent`: `true`
- `pageArtifacts`: `2`
- audit events: `proof_generated`, `proof_release_failed` with source `runDigitalFulfillment:auto_send_guard`
- email calls: `0`

**Manifest / guard:**

- manifest complete: `true`
- story route allowed: `false`
- story route failure code: `PROVIDER_ROUTE_BLOCKED`
- page route allowed: `true`
- release guard: `PROVIDER_ROUTE_BLOCKED`

**Result:** PASS for fail-closed release boundary. The order does not reach customer send / `complete`; it lands `qa_blocked` with a named reason and no email side effect.

### S3 — forced provider failure / template fallback

**Synthetic order ID:** `ord_g1_s3_template_fallback_20260601`

**Route decision:**

```json
{
  "route": "BLOCKED",
  "permitted": false,
  "reason": "Template / fixture prose blocked for paid orders by policy §2",
  "failureCode": "BLOCKED_TEMPLATE_PAID",
  "requiresAuditLog": true
}
```

**Injected story provenance:**

- `storyMeta.source`: `template_after_openai_failure`
- `storyMeta.model`: `template:Quest`
- `storyMeta.fallbackError`: `forced provider failure for G1 evidence`

**Final persisted state:**

- `status`: `preview_ready`
- `fulfillmentStatus`: `qa_blocked`
- `qaStatus`: `blocked`
- `qaBlockedReason`: `TEMPLATE_STORY_BLOCKED: Story route not allowed: template (storyFallbackUsed=true)`
- `storyArtifactUrlPresent`: `true`
- `pageArtifacts`: `2`
- audit events: `proof_generated`, `proof_release_failed` with source `runDigitalFulfillment:auto_send_guard`
- email calls: `0`

**Manifest / guard:**

- manifest complete: `true`
- story route allowed: `false`
- story route failure code: `TEMPLATE_STORY_BLOCKED`
- page route allowed: `true`
- release guard: `TEMPLATE_STORY_BLOCKED`

**Result:** PASS for fail-closed release boundary. Template fallback is blocked from customer release with a named reason and no email side effect.

## Cross-cutting source checks

Observed implementation points:

- `generation-policy.ts` defines conservative tracked policy and `chooseGenerationRoute`.
- `generation-manifest.ts` builds release manifest from `storyMeta` + `pageArtifacts` and re-runs route allowance via `evaluatePaidRouteAllowance`.
- `fulfillment.ts` runs `evaluateReleaseGuard` immediately before auto-send customer email paths and persists `qa_blocked` on refusal.
- Commit `58b9701` ensures refusal-state audit appends do not stale-read clobber the just-written `qa_blocked` state.

## Required side-effect attestation

- `unmockedFetchCalls`: `0`
- `sendDigitalDeliveryEmail` mock calls: `0` for all three synthetic cases
- no real Stripe session creation
- no Resend call
- no Lulu/RPI call
- no Vercel Blob write
- no deploy/push
- local temp order store removed after run

## Gap / smallest CC patch

To move G1 from PARTIAL to PASS, add an explicit route-decision persistence artifact before any proof artifact is created.

Recommended smallest CC patch:

1. Add fields to `OrderRecord` or audit trail, e.g.:
   - `generationRouteDecision.route`
   - `generationRouteDecision.permitted`
   - `generationRouteDecision.policyVersion`
   - `generationRouteDecision.decidedAt`
   - `generationRouteDecision.reason/failureCode`

   Or append an audit event:
   - `route_decision_recorded`

2. In fulfillment, call `chooseGenerationRoute` / route-decision persistence before `generating_story` / proof artifact build.

3. Tests:
   - synthetic safe manual order records route decision before `proof_generated`;
   - blocked OpenAI API route records blocked decision and refuses before generation or before customer-visible proof state, per desired operator semantics;
   - template/unknown route records blocked decision and cannot reach `complete` / `proof_ready` / customer email.

Until that exists, G1 remains **PARTIAL** despite the release boundary behaving safely.
