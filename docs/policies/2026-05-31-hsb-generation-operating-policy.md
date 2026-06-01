# HSB — Generation Operating Policy

**Binding:** Father's Day launch through 2026-06-21.

**Canonicalized from the Rex/Alexy implementation prompt body because the original full standalone "Generation Operating Policy" artifact was not available in-repo at implementation time.** Sections 2 through 13 below preserve the enforceable rules as written. Any section the implementation prompt referenced but did not include (notably "Section 10 customer messages" and "the decision matrix") is marked with a **Source gap** note and a pointer to the closest available material.

**Effective date:** 2026-05-31.
**Owner:** Alexy / Rex.
**Implementation reference:** `src/lib/generation-policy.ts`, `src/lib/generation-manifest.ts`, `src/lib/admin-actions.ts releaseOrderAfterQa`, `src/lib/fulfillment.ts runPrintProduction`, `data/policies/generation-route.json`, `tests/generation-*.test.ts`.

---

## Locked business decisions

- Default paid-customer generation route: **Abby / OpenAI manual subscription workflow** (`OPENAI_MANUAL`).
- Approved fallback: **OpenAI API route only when explicitly enabled by Alexy AND manual capacity is full** (`OPENAI_API`).
- fal / Seedream: **not a default customer fulfillment path.** Emergency only, per-order Alexy approval required (`FAL` / `SEEDREAM` + `emergencyApprovedBy` + `emergencyApprovalRef`).
- Template prose / fixture / sample / internal content: **blocked for paid, gifted, and creator customer-facing proof release.**
- Human QA gate is **mandatory** before customer proof release.
- Print submission must **independently re-check** proof/QA/provenance state.

---

## Section 2 — Route selection hard gate

Implemented as `chooseGenerationRoute(orderContext)` in `src/lib/generation-policy.ts`. Returns one of:

- `OPENAI_MANUAL`
- `OPENAI_API`
- `FAL`
- `SEEDREAM`
- `TEMPLATE_FIXTURE`
- `BLOCKED`

Hard requirements:

- All paid-order generation callers must go through this function or an equivalent central gate.
- For `paid === true`:
  - Template fixture is never allowed.
  - fal / Seedream is allowed only if:
    - `emergencyApprovedBy` is populated
    - `emergencyApprovalRef` is populated
    - emergency image route feature flag is enabled (`emergencyImageRoute=true`)
    - the order-level route decision is audit-logged (`route_decision_recorded` + `emergency_override_recorded`)
  - OpenAI API is allowed only if:
    - API fallback feature flag is enabled (`apiFallbackEnabled=true`)
    - manual queue/capacity condition is satisfied or explicitly represented (`manualCapacityFull=true`)
    - Alexy authorization is logged per day/batch (recorded as `apiAuthorizedBy` / `apiAuthorizedAt` in the audit payload)
  - Default route must be `OPENAI_MANUAL`.
- If the requested route violates policy, return/block with a **named error**, not a silent fallback. Codes: `BLOCKED_TEMPLATE_PAID`, `BLOCKED_FAL_NO_APPROVAL`, `BLOCKED_FAL_FLAG_OFF`, `BLOCKED_API_FLAG_OFF`, `BLOCKED_API_MANUAL_CAPACITY_AVAILABLE`, `BLOCKED_UNKNOWN_REQUEST`.

No existing default image provider config may silently route paid orders to fal/Seedream. Existing in-process `image-generator.ts defaultProviderOrder` is treated as the **lower** layer that produces the page-level `generationProvider` field; the policy guard at release time (`evaluateReleaseGuard`) cross-checks the recorded provenance and refuses release if a paid page ended up on `fal_edit`/`seedream`/`gemini` without `emergencyApprovedBy` + `emergencyApprovalRef`.

## Section 3 — Production config guardrails

Tracked policy lives at `data/policies/generation-route.json`. Conservative fail-closed defaults:

```json
{
  "defaultPaidCustomerRoute": "OPENAI_MANUAL",
  "apiFallbackEnabled": false,
  "emergencyImageRoute": false,
  "allowTemplateFallbackForPaid": false,
  "orderIntakeOpen": true,
  "digitalFirstMode": true,
  "printCtaEnabled": true
}
```

Implementation:

- `loadGenerationPolicyConfig` reads the tracked JSON.
- In production (`NODE_ENV='production'` or `VERCEL_ENV='production'`), it **throws** when:
  - `allowTemplateFallbackForPaid=true`
  - `defaultPaidCustomerRoute` is anything other than `OPENAI_MANUAL`
  - default route is `FAL` / `SEEDREAM` / `TEMPLATE_FIXTURE`
- In dev/preview, env vars may shift flags for testing (`HSB_POLICY_*`). The release/print guards still fail closed regardless.
- `validateGenerationPolicyConfig(config)` is a pure validator used by tests; returns the list of policy-violating reasons (empty = safe).

`orderIntakeOpen`, `digitalFirstMode`, `printCtaEnabled` remain operator-controlled and are not subject to the production hard-fail.

## Section 4 — Provenance / manifest model

Implemented as additive optional fields on the existing `OrderRecord`, `PageArtifact`, and `StoryMeta` types (no new database). `src/lib/generation-manifest.ts buildManifest(order)` projects them into a stable JSON-serializable `OrderManifest`.

**Order-level:** `qaStatus` (`pending | passed | blocked`), `qaReviewer`, `qaBlockedReason`, `customerProofReleasedAt`, `printApprovedAt` (alias for legacy `proofApprovedAt`), `printSubmittedAt`, `manualInterventionRequired`, `emergencyOverrideUsed`, `emergencyApprovedBy`, `emergencyApprovalRef`, `sourcePhotoPresent`, `personalizationInputsPresent`, `manifestComplete`, `manifestHash`.

**Story attempt:** `storyProvider`, `storyModel`, `storyFallbackUsed`, `storyFallbackReason`, `generatedBy`, `promptRevisionId`, `attemptResult`. Persisted on `StoryMeta`; derived from existing `source`/`model`/`fallbackError` when absent.

**Page/image:** `pageId`, `imageProvider` (existing `generationProvider`), `imageModel` (existing `generationModel`), `imageFallbackUsed`, `imageFallbackReason`, `assetSource` (`live | fixture | sample | internal`; defaults to `live`), `likenessScoreOrFlag`.

Manifest invariants:

- Unknown/null provider lineage on any customer-facing page must block proof release.
- Any `assetSource=fixture|sample|internal` on a paid/gifted/creator order must block release.
- Template story provider (`template` or `template_after_openai_failure`) must block release.
- `manifestHash` is computed deterministically at release time using SHA-256 over the canonical-keyed manifest payload. Stored on `OrderRecord.manifestHash` for later integrity diff. **TODO** for the next slice: integrity hash check at print-submission time (the current print guard re-runs `evaluateReleaseGuard` which fully re-validates lineage but does not yet diff hash).

## Section 5 — Customer proof release guard

`evaluateReleaseGuard(order)` in `src/lib/generation-manifest.ts` enforces every condition below before `releaseOrderAfterQa` calls `sendDigitalDeliveryEmail` / `sendProofReadyEmail`:

1. Manifest is complete.
2. Every page has non-null `imageProvider`.
3. Every paid-order page provider is allowed by policy (OpenAI manual/api, or emergency-approved fal/Seedream).
4. `storyProvider !== template_fixture` (covers both `template` and `template_after_openai_failure`).
5. No page has `assetSource ∈ {fixture, sample, internal}`.
6. `qaStatus === passed`.
7. `qaReviewer` is set.
8. Required personalization / source-photo flags are present (or explicitly overridden).
9. Any fallback/emergency route has matching approval fields (`emergencyApprovedBy` + `emergencyApprovalRef`).
10. Manifest hash is computed at release time and persisted (`manifestHash` field on `OrderRecord`).

Named return codes:

- `MISSING_LINEAGE`
- `TEMPLATE_STORY_BLOCKED`
- `FIXTURE_ASSET_BLOCKED`
- `QA_NOT_PASSED`
- `EMERGENCY_APPROVAL_MISSING`
- `MANIFEST_INCOMPLETE`
- `PROVIDER_ROUTE_BLOCKED`
- `PAYMENT_NOT_CONFIRMED`
- `NO_ARTIFACT`

No proof email is sent when the guard fails. `releaseOrderAfterQa` appends a `proof_release_failed` audit event with the failure code and continues to refuse `qaPassAt` write.

## Section 6 — Print submission guard

`evaluatePrintGuard(order)` in `src/lib/generation-manifest.ts` runs **independently** from the release guard inside `runPrintProduction` before `submitPrintJob` is called. Refuses unless:

- Customer approved proof (`printApprovedAt` / `proofApprovedAt` timestamp present).
- Proof release guard conditions are still valid (re-runs `evaluateReleaseGuard`).
- Manifest/provenance still valid (re-built from current order state to catch artifact drift since `proof_approved`).
- QA pass still valid.
- Order status is compatible with print queue/submission (`fulfillmentStatus ∈ {proof_approved, submitting_to_print}`).
- No emergency/fallback approval data is missing.

Named error codes:

- `CUSTOMER_APPROVAL_REQUIRED`
- `PRINT_QA_GUARD_FAILED`
- `PRINT_MANIFEST_INVALID`
- `PRINT_LINEAGE_INVALID`
- `PRINT_STATE_INVALID`
- `PRINT_PAYMENT_INVALID`

When the print guard fails, `runPrintProduction` appends a `print_submission_blocked` audit event with `failureCode` + `underlyingReleaseFailure` and throws a named error. The runWithRetry wrapper records `fulfillmentLastError` and moves the order to `failed_manual_review`.

## Section 7 — QA checklist enforcement

Canonical 12-item operator checklist enforced server-side by `missingQaChecks` in `src/lib/admin-actions.ts`:

1. story personalization quality
2. family/details correctness
3. no template/generic prose
4. image consistency
5. child likeness/safety
6. no missing pages
7. no broken images
8. no fixture artifacts
9. no provider/fallback mismatch
10. print/digital suitability
11. mobile proof page check
12. email/review link check

Implementation:

- Checklist visible/admin-editable in QA Production Room (`/admin/qa-room`).
- Server requires all 12 items `true` for `qaStatus='passed'`. Legacy 5-item callers (existing `detail-client.tsx`, in-flight admin requests) are auto-expanded into the 12-item set; explicit booleans always override expansion.
- `qaStatus=passed` cannot be set unless all 12 items pass.
- Failed/indeterminate item blocks proof release at the route layer (the qa-pass POST returns 400).

**Deferred for follow-up:** per-item reviewer/timestamp/remediation note (currently the checklist as a whole is recorded under `qa_pass_recorded` with `qaPassBy` + `qaPassAt`). The minimum acceptable implementation per the prompt — "checklist is visible/admin-editable" + "qaStatus=passed cannot be set unless required checklist items pass" — is shipped.

## Section 8 — Admin/operator visibility

`/admin/qa-room` (QA Production Room) shows:

- Per-order analysis (`analyzeOrderQa`) with route/provider/provenance, manifest completeness, QA status, fallback flags, emergency override fields, fixture/internal flags, blocked reasons.
- Risk pills on queue cards: `template fallback`, `policy: <FAILURE_CODE>`, `emergency override`, `print go/no-go`.
- New `PolicyGuardCard` in detail view shows the live `evaluateReleaseGuard` result, per-page risk detail, and the manifest hash prefix.
- Customer-visible preview is sourced ONLY from `buildOrderStatusView` + a "Your book is in review" override when blockers are present. No internal provider/QA/template/fallback names ever reach the customer surface (locked by `tests/qa-room.test.ts` "customer-visible status does not leak internal provider details").

## Section 9 — Customer-safe communication templates

Canonical wording lives in `docs/policies/hsb-customer-delay-message-templates.md`. The QA Production Room links to the doc for operators. No automated sending wired in this slice; the only customer email path remains `releaseOrderAfterQa` → `sendDigitalDeliveryEmail` / `sendProofReadyEmail`, both gated by the release guard.

**Source gap:** the implementation prompt referenced "Section 10 customer messages" but the original artifact text was not available. The customer-delay templates doc captures the minimum operator wording needed for delay/refund/manual-rework holds without exposing provider/model/internal errors. Expand with Alexy's blessing when the original text surfaces.

## Section 10 — Required tests

`tests/generation-policy.test.ts` + `tests/generation-manifest.test.ts` + `tests/admin-shipping-proof.test.ts` cover all 12 required Section 10 cases:

| # | Case | File · test |
|---|---|---|
| 1 | Paid order forced to fal without `emergencyApprovedBy` → blocked | `generation-policy.test.ts` |
| 2 | Paid order with approval but `emergencyImageRoute=false` → blocked | `generation-policy.test.ts` |
| 3 | Paid order with approval + flag → permitted, audit | `generation-policy.test.ts` |
| 4 | Paid order with template story fallback → no email, no state advance | `admin-shipping-proof.test.ts` (digital + print) + `generation-manifest.test.ts` |
| 5 | Page with `imageProvider=null` → `MISSING_LINEAGE` | `generation-manifest.test.ts` |
| 6 | Page with `assetSource=fixture` → `FIXTURE_ASSET_BLOCKED` | `generation-manifest.test.ts` (fixture/sample/internal) |
| 7 | `qaStatus !== passed` → `QA_NOT_PASSED` | `generation-manifest.test.ts` |
| 8 | `qaStatus=passed` but missing `qaReviewer` → rejected | `generation-manifest.test.ts` |
| 9 | Print without customer approval timestamp → `CUSTOMER_APPROVAL_REQUIRED` | `generation-manifest.test.ts` |
| 10 | Print with approval but invalid manifest/lineage → rejected | `generation-manifest.test.ts` |
| 11 | Production config with `allowTemplateFallbackForPaid=true` → fails | `generation-policy.test.ts` |
| 12 | Production config with default route fal/Seedream → fails | `generation-policy.test.ts` |

## Section 11 — Audit logging

Uses the existing `appendAuditEvent` mechanism (no new system). New `ReviewAuditEventType` values added:

- `route_decision_recorded` — every route decision (paid orders)
- `route_fallback_attempted` — every fallback attempt
- `emergency_override_recorded` — every emergency override
- `qa_gate_evaluated` — every QA gate pass/fail/block decision
- `proof_release_failed` — every failed proof-release attempt (with failureCode in meta)
- `print_submission_blocked` — every failed print-submission attempt (with failureCode + underlyingReleaseFailure in meta)

Each event records: timestamp, orderId, paid flag (via order), route/provider/reason/authorizer/reviewer/named failure code as applicable.

`releaseOrderAfterQa` writes `proof_release_failed` whenever the release guard refuses. `runPrintProduction` writes `print_submission_blocked` when the print guard refuses. `chooseGenerationRoute` returns `requiresAuditLog: true` for any non-default decision; callers are responsible for writing the `route_decision_recorded` event.

## Section 12 — Status model alignment

Mapping the policy status names to current `FulfillmentStatus`:

- `paid_waiting_generation` → `not_started`
- `generating_story` → `generating_story` ✓
- `story_needs_review` → not yet (handled by `awaiting_qa` + `qaBlockedReason` for now)
- `generating_images` → `generating_images` ✓
- `images_need_review` → covered by `awaiting_qa`
- `qa_blocked` → **new**: added to `FulfillmentStatus` (distinct from `failed_manual_review`, which covers non-QA generation failures)
- `proof_ready_internal` → `awaiting_qa` (artifacts persisted, customer email held)
- `proof_released_to_customer` → `proof_ready` (print) / `complete` (digital), with `customerProofReleasedAt` timestamp now persisted
- `customer_changes_requested` → covered by `reviewStatus='customer_changes_requested'` on existing review flow
- `customer_approved` → `proof_approved` (existing `proofApprovedAt` / new `printApprovedAt` alias)
- `print_queued` → `proof_approved` (queued for `runPrintProduction`)
- `print_submitted` → `submitting_to_print` → `complete` (with `printSubmittedAt` now persisted)
- `failed_manual_review` → existing ✓
- `refunded` → tracked via `paymentStatus='refunded'` + `refundedAt`
- `cancelled` → not modeled (no use case)

No status churn beyond adding `qa_blocked`. The "false `complete` before customer proof release" risk is closed because `releaseOrderAfterQa` is the only path that flips `awaiting_qa → complete` (digital) and the release guard fires before that write.

## Section 13 — Definition of done

| Item | Status |
|---|---|
| Policy doc saved | ✓ (this file) |
| Route gate implemented | ✓ `src/lib/generation-policy.ts` |
| Proof release guard implemented | ✓ `evaluateReleaseGuard` wired into `releaseOrderAfterQa` |
| Print guard implemented | ✓ `evaluatePrintGuard` wired into `runPrintProduction` |
| Provenance/manifest data checked at release | ✓ |
| Admin/operator visibility added at least to order detail | ✓ `PolicyGuardCard` + risk pills in `/admin/qa-room` |
| QA checklist state gates `qaStatus=passed` | ✓ 12-item canonical set enforced server-side |
| Required tests added and passing | ✓ 21 new tests (12 Section-10 cases + supporting) |
| No production mutations performed | ✓ |
| No deploy performed | ✓ |

---

**Source-gap follow-ups for Alexy/Rex when the original artifact surfaces:**

- "Section 10 customer messages" — the standalone policy text was not in-repo. Customer-delay templates landed in `docs/policies/hsb-customer-delay-message-templates.md` as a conservative starting point.
- "Decision matrix" — the prompt referenced one but did not include it. The route gate (`chooseGenerationRoute`) plus the release/print failure-code tables above are the de facto decision matrix this slice implements.
