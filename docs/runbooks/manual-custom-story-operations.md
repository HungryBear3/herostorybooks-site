# Runbook — Media-backed Custom Story orders (manual / operator-authored)

> **Status:** current policy for this release. Supersedes the Father's Day
> beta runbook `docs/runbooks/voice-note-transcription.md`, which is not
> present on this branch and survives only on
> `backup/hsb-dev-stuff-clean-20260624` (blob `ef89371`). See
> [Superseded history](#12-superseded-history--the-fathers-day-voice-beta)
> before quoting anything from it.
>
> **The one-line policy:** an order carrying customer audio or a customer
> document is produced by a human. No prose, image, PDF, proof, retry,
> rebuild, print, or email step for such an order is automatic, and this
> runbook does not authorize making one automatic.

Inspection in this runbook is **read-only by default**. Every state-changing
step is labeled, and each one requires (a) explicit owner or customer
authorization for that specific order, and (b) an authoritative fresh read of
the order taken immediately before acting. A read from earlier in your shift is
a stale read.

---

## 1. Scope and non-goals

### In scope

Orders where the customer supplied **audio** (recorded or uploaded) or a
**document** (`.txt`, `.pdf`, `.doc`, `.docx`) as story source material. The
product calls this a Custom Story with a media-backed source.

### Explicitly out of scope

| Not covered here | Where it belongs |
| --- | --- |
| Stuck / disputed orders generally | `docs/runbooks/support-stuck-order-checklist.md` |
| Unresolved Stripe provider create ("Checkout reconciliation required") | `docs/runbooks/support-stuck-order-checklist.md` |
| Live order smoke validation | `docs/runbooks/live-order-validation.md` |
| Image provider routing | `docs/runbooks/gemini-image-routing.md` |
| Family Review submissions (a separate lane with its own storage and its own admin surface under `/api/family-review/admin/...`) | not this runbook |

### Typed-only vs media-backed — the distinction that decides everything

Both are "Custom Stories" in customer-facing copy. They are **not** the same
operationally.

| | Typed-only Custom Story | Media-backed Custom Story |
| --- | --- | --- |
| Source | `order.customStoryText` (free text, capped at 1200 chars by the checkout field) and/or `order.characterNotes`, `order.lesson`, `order.giftMessage` | customer audio and/or a customer document held in Blob storage |
| Classifying predicate | `hasMediaBackedCustomStorySource(order) === false` | `hasMediaBackedCustomStorySource(order) === true` |
| Automated prose | Permitted by the media gate. Still subject to every other gate (`fulfillmentMode`, shape lane, brief validation). | **Refused.** `customStoryGenerationGate` throws. |
| Template fallback | Refused separately — `assertTemplateFallbackAllowed` throws for any typed custom story too (`template fallback is disabled for typed custom stories; route to manual_queue`) | Refused |
| Proof build / rebuild / page regen / admin retry | Permitted subject to normal state preconditions | **Refused** at every one of those entry points |

A typed-only Custom Story is not in scope for this runbook. If the order has
**both** typed text and media, it is media-backed: the predicate is an OR, and
media-backed is the stricter lane.

### Non-goals of this document

This runbook does **not** describe, authorize, or provide steps for:

- automatic prose, image, PDF, or proof generation for a media-backed order;
- automatic proof publication, retry, regeneration, print submission, or
  fulfillment;
- automatic email to the customer;
- automatic payment, refund, customer-record, or Blob mutation;
- editing order JSON or Blob objects directly.

Where the product has no safe supported mutation, this runbook says
**"not implemented; escalate"** rather than inventing one.

---

## 2. Intake triage — read-only

All four surfaces below are read-only. Opening them changes nothing.

| Surface | Path | Notes |
| --- | --- | --- |
| Order detail (web) | `/admin/orders/<orderId>` | `src/app/admin/orders/[orderId]/page.tsx`. Requires a configured admin key and an authed cookie; renders "Ops dashboard disabled" without one. |
| Diagnostics (JSON) | `/api/admin/orders/<orderId>/diagnostics` | `src/app/api/admin/orders/[orderId]/diagnostics/route.ts` |
| Diagnostics (paste-friendly text) | `/api/admin/orders/<orderId>/diagnostics?format=text` | Same route, `format=text` branch → `formatDiagnosticsSummary`. **Contains PII — see §9 before pasting it anywhere.** |
| Diagnostics (CLI) | `npm run order:status -- <orderId>` | `scripts/order-status.ts`, wired in `package.json` as `node --experimental-strip-types scripts/order-status.ts`. Accepts a trailing `--json`. |

`npm run order:status` reads from the same store the app uses (Vercel Blob when
`BLOB_READ_WRITE_TOKEN` is set; otherwise `HSB_ORDER_STORE_DIR` or a tmp
fallback). It only calls `getOrder` + `buildOrderDiagnostics`; it performs no
writes.

### Triage checklist

1. **Open `/admin/orders/<orderId>`.** Read the **Diagnostics** section first —
   any `FAIL` is real.
2. **Decide the lane.** Read the **Story source + input** section. Then apply §3
   yourself, because the admin panel's own summary is not equivalent to the
   product predicate (see the divergence warning in §3).
3. **Confirm the automation hold.** In the same page, check the **Payment**
   section and confirm the order's `fulfillmentMode` intent (§3.2). Note that
   diagnostics does not print it — you are reading the order record.
4. **Read the consent and provenance evidence** (§4) before you even consider
   opening media.
5. **Read the brief state** — the admin page renders "Custom brief title",
   "Custom story shape", "Brief sanitized", "Operator approved", "Validation
   route", "Sanitized source summary", and any "Validation failures" **only
   when `order.customStoryBrief` exists.** No brief means those rows are absent
   entirely, which is different from "present and failing".
6. **Read the audit trail** — diagnostics `review.recentEvents` (last 10) and
   the admin page's full "Review audit trail".
7. **Stop and apply §7** before doing anything else.

### What triage will *not* tell you

`buildOrderDiagnostics` / `formatDiagnosticsSummary`
(`src/lib/order-diagnostics.ts`) contain **no** media-backed markers, no
`fulfillmentMode`, and no `customStoryBrief` state. Verified: none of
`voiceBlobPath`, `documentBlobPath`, `fulfillmentMode`, `voiceIntakeMedia`,
`documentIntakeMedia`, `customStoryBrief` appear in that module.

**Consequence:** `npm run order:status` and the diagnostics JSON/text cannot
classify a media-backed order. Never conclude "not media-backed" from
diagnostics alone. Use the order record via `/admin/orders/<orderId>` and §3.

---

## 3. The classifying predicate and the automation holds

### 3.1 The media-backed predicate

`hasMediaBackedCustomStorySource(order)` — `src/lib/story-generator.ts:220`,
exported. It returns `true` if **any** of these twelve fields is truthy:

| Field | Kind | Notes |
| --- | --- | --- |
| `order.voiceBlobPath` | audio | direct-upload path |
| `order.voiceBlobUrl` | audio | direct-upload URL |
| `order.voiceConsentAt` | audio | consent timestamp alone is sufficient |
| `order.voiceSource` | audio | `'recorded' \| 'uploaded'` |
| `order.voiceTranscript` | audio | `VoiceTranscriptMeta`; see §13 — nothing writes this today |
| `order.legacyVoiceUploadPresent` | audio | **legacy marker**, see below |
| `order.documentBlobPath` | document | |
| `order.documentBlobUrl` | document | |
| `order.documentConsentAt` | document | consent timestamp alone is sufficient |
| `order.documentSource` | document | `'uploaded'` |
| `order.voiceIntakeMedia` | audio | private-intake `FinalizedSelectionEntry` |
| `order.documentIntakeMedia` | document | private-intake `FinalizedSelectionEntry` |

**Legacy marker.** `legacyVoiceUploadPresent` is not written at checkout. It is
derived while reading a legacy record in `src/lib/orders.ts` (~line 1805): a
retired `voiceFileName` string on the stored JSON sets
`legacyVoiceUploadPresent = true` and the original filename is dropped. It is a
non-PII compatibility signal, and it holds automation exactly like a live
marker. An old order can therefore be media-backed with **no** blob path and
**no** consent timestamp — treat that as ambiguous source and stop (§7).

> **Divergence warning — the admin page under-reports audio.**
> `src/app/admin/orders/[orderId]/page.tsx:67` computes its "Voice upload
> present" row from only four of the six audio fields:
> `voiceBlobPath || voiceConsentAt || voiceTranscript || legacyVoiceUploadPresent`.
> It omits `voiceBlobUrl`, `voiceSource`, and **`voiceIntakeMedia`**. The
> document row (`:76`) covers `documentBlobPath || documentConsentAt ||
> documentIntakeMedia` but omits `documentBlobUrl` and `documentSource`.
>
> So an order whose only audio evidence is a private-intake asset can render
> **"Voice upload present: no"** while `hasMediaBackedCustomStorySource` returns
> `true` and every production path refuses it. Do not use the panel row as the
> classification. Read the fields. This is a known gap (§14).

### 3.2 Hold #1 — `fulfillmentMode`

`FulfillmentMode = 'auto' | 'manual_hold'` (`src/lib/orders.ts`). It is set
**explicitly by the creating workflow and never inferred** from product,
payment, or cohort. Customer checkout passes `fulfillmentMode: 'manual_hold'`
(`src/lib/checkout-order-route-handler.ts:588`); order recovery does the same
(`src/lib/order-recovery.ts:59`). A legacy order with `undefined` fails closed.

`evaluateFulfillmentSweepEligibility` (`src/lib/fulfillment-sweep.ts`) returns
`{ eligible: false, reason: 'manual_hold' }` for anything where
`fulfillmentMode !== 'auto'`. This hold applies to **every** current customer
order, media-backed or not.

`order-incident.ts` tracks a `manual_hold_sla` incident class with a 24-hour
operator SLA (`DEFAULT_INCIDENT_THRESHOLDS.manualHoldMs`). A hold is a
commitment to act, not a place to park an order.

### 3.3 Hold #2 — the media gate, enforced at every production entry point

This is the hold specific to media-backed orders. Each site re-reads the order
and refuses:

| Entry point | Source | Refusal |
| --- | --- | --- |
| Story generation | `customStoryGenerationGate`, first statement of `generateStoryWithMeta` (`src/lib/story-generator.ts:238`, called at `:1157`) | throws `media-backed custom stories require operator-authored prose; automated generation is disabled` |
| Template fallback | `assertTemplateFallbackAllowed` (`src/lib/story-generator.ts:260`) | throws `template fallback is disabled for custom stories with voice or document source material; route to manual_queue` |
| Fulfillment kickoff claim | `src/lib/fulfillment.ts:153` | abort `media_story_manual_review_required` |
| Fulfillment stage transitions | `src/lib/fulfillment.ts:214`, `:292` | abort |
| `triggerFulfillment` | `src/lib/fulfillment.ts:1401` | `{ status: 'skipped_already_running', fulfillmentStatus: 'media_story_manual_review_required' }` |
| Proof / print-interior build | `buildProofArtifactFromPageArtifacts` (`src/lib/fulfillment.ts:1154`), re-checked after proof render (`:1187`) and after interior render (`:1197`) | `{ ok: false, error: 'media_story_manual_review_required' }` |
| Admin retry | `retryOrderFulfillment` (`src/lib/admin-actions.ts:104`, predicate again at `:133`) | HTTP 409 `Media-backed Custom Stories require manual fulfillment` |
| Proof publish | `src/lib/page-review.ts:296` | `media_story_manual_review_required` |
| Page regeneration | `src/lib/page-review.ts:391`, `:455` | HTTP 409 `media_story_manual_review_required` |
| Resolve customer text change | `src/lib/page-review.ts:1074` | HTTP 409 `media_story_manual_review_required` |
| Print rebuild | `src/lib/rebuild-print-order.ts:155` | reason `media_story_manual_review_required`, detail "Audio/document-backed Custom Stories require operator-authored prose; automated rebuild is disabled." |

**Seeing `media_story_manual_review_required` is the system working correctly.**
It is not an error to clear, retry, or route around.

### 3.4 Hold #3 — brief and shape gates (apply when a brief exists)

`customStoryGenerationGate` also refuses, with
`custom story requires manual_queue before generation (<reasons>)`, when a
`customStoryBrief` is present and any of these hold:

- `validateCustomStoryBrief(brief)` fails (`src/lib/custom-story/validate.ts`);
- `statusForShape(brief.storyShape).conciergeAllowed` is false
  (`src/lib/custom-story/shapes.ts`). Note the two halves of the fail-closed
  behaviour differ for a shape that is not in `STORY_SHAPE_STATUS`: such a shape
  is **always** `sellableSelfServe: false` and `lane: 'not-accepted'`, but
  `conciergeAllowed` is `!NOT_ACCEPTED_STRUCTURES.has(shape.heroStructure)` — so
  it is false only for the not-accepted hero structures `sibling`,
  `whole-family`, and `custom-cast`, and **true** for any other unmapped hero
  structure. An unmapped shape can therefore still clear this particular gate
  via the concierge lane; it can never clear self-serve;
- `brief.provenance.briefApprovedByOperator` is not `true`.

At checkout, `src/lib/checkout-order-route-handler.ts` validates the brief
**before** any Stripe Session is created and returns
`custom_story_manual_review_required` or, for a shape that is not
`sellableSelfServe` without the paid-beta flag, `custom_story_paid_beta_required`
(flag `HSB_CUSTOM_STORY_PAID_BETA` / `NEXT_PUBLIC_HSB_CUSTOM_STORY_PAID_BETA`,
`:130`).

---

## 4. Consent, provenance, and private-media access — before anyone opens media

Do all of §4 **before** opening, downloading, playing, or transcribing anything.

### 4.1 Consent evidence must exist

| Lane | Consent field | Source refusal if absent |
| --- | --- | --- |
| Direct order upload — audio | `order.voiceConsentAt` | `voice_consent_required` (`src/lib/checkout-order-route-handler.ts:352`) — "Parent/guardian consent is required to attach a voice recording." |
| Direct order upload — document | `order.documentConsentAt` | `document_consent_required` (`:379`) |
| Private intake — either | `order.voiceIntakeMedia.consentAt` / `order.documentIntakeMedia.consentAt` on the `FinalizedSelectionEntry` (`src/lib/checkout-intake.ts:168`) | intake record validation rejects a non-ISO `consentAt` |

The consent the customer actually gave is the checkbox copy in
`src/components/checkout/VoiceRecorderSection.tsx`:

- Audio (`:343`) — "I'm the parent/guardian or an authorized adult for everyone
  in this recording. Hero Story Books may use it only to write this book. It
  won't be used for voice cloning or AI training, and won't be shared."
- Document (`:347`) — "I have the right to share this document. Hero Story Books
  may use it only to write this book. It won't be used for AI training and won't
  be shared."

**That copy is the boundary of your authorization.** "Only to write this book"
does not cover samples, marketing, testimonials, training data, or sharing
outside the people producing this order.

### 4.2 Provenance must be coherent

Check the audio lane's `voiceSource` is `'recorded'` or `'uploaded'` and the
document lane's `documentSource` is `'uploaded'`. For a private-intake asset,
`FinalizedSelectionEntry` carries `assetId`, `category`
(`voice_inspiration` / `document_inspiration`), `pathname`, `mimeType`, `size`,
`etag`, `generation`, `consentAt`, and `voiceSource`. The intake validator
requires a `voiceSource` for `voice_inspiration` and forbids one otherwise
(`src/lib/checkout-intake.ts:716`), and requires the stored `pathname` to equal
the derived `intakeAssetPath(...)` — a mismatch is rejected as a pointer at
someone else's bytes (`:707`).

If consent timestamp, source, and asset do not agree — or if the only marker is
`legacyVoiceUploadPresent` — **stop** (§7).

### 4.3 Storage must be private

Customer story media may only be stored in a private Blob store.
`assertPrivateStorySourceStorage(orderId)` (`src/lib/orders.ts:1495`) throws
`OrderPersistenceError` — "Private Blob storage is required for customer voice
notes and story documents." — unless `getBlobAccessMode() === 'private'`, i.e.
`HSB_BLOB_ACCESS_MODE=private`. Both `uploadOrderVoice` and
`uploadOrderDocument` call it before writing, so in a production-like
environment a public store fails checkout closed **before** Stripe rather than
storing media publicly.

Note `getBlobAccessMode()` defaults to `'public'` (`src/lib/orders.ts:1081`),
which is the mode order JSON and hero photos use. The story-media lane is the
exception that requires `private`. The checkout media UI is gated on the same
condition: `isCheckoutStoryMediaEnabled()`
(`src/lib/checkout-direct-flags.ts:23`) requires
`HSB_BLOB_ACCESS_MODE === 'private'` **and** a non-empty `BLOB_READ_WRITE_TOKEN`
(or a hermetic-E2E-only branch), and `/checkout` passes the result into
`CheckoutForm` as `storyMediaEnabled` (`src/app/checkout/page.tsx:60`).

### 4.4 Opening the media — not implemented; escalate

**There is no product surface that serves a media-backed order's audio or
document bytes to an operator.** Verified across `src/app/api/**`: no route
resolves `voiceBlobUrl`, `documentBlobUrl`, or an intake asset path for an
order. The Family Review lane has such a route
(`/api/family-review/admin/submissions/[submissionId]/asset/[assetId]`); the
**order** lane does not. `/admin/orders/<orderId>` renders the storage *path*
only ("Upload blob path", "Document storage path"), never a playable or
downloadable link.

Therefore:

- **Do not** construct a Blob URL, mint a token, or reach into the Blob store to
  fetch the bytes. That is direct Blob surgery and it is prohibited by this
  runbook.
- Record the storage path and the consent evidence in the ticket, and
  **escalate to engineering** for an authorized, logged retrieval.
- Any actual transcription this release is a human listening to media obtained
  through that escalated path. There is no automated transcription (§13).

---

## 5. Sanitized brief — no raw transcript downstream

### 5.1 The required conceptual sequence

```
durable media evidence  (private Blob, consent + provenance recorded)
        ↓  operator inspection / human transcription, as applicable
sanitized brief         (CustomStoryBrief.sanitizedSourceSummary)
        ↓  human approval  (provenance.briefApprovedByOperator = true)
operator-authored prose
```

Raw transcript never advances past the second arrow. The type system is built
to make that structural: `CustomStoryBrief`
(`src/lib/custom-story/types.ts:116`) has **no** `rawTranscript` field, by
design, and the module header states the raw transcript "must NEVER be
represented on the downstream brief."

### 5.2 The no-raw-transcript checklist

Before a brief is treated as approved, confirm every line:

- [ ] The brief carries **no** forbidden key. `FORBIDDEN_DOWNSTREAM_KEYS`
      (`src/lib/custom-story/validate.ts:57`) = `rawTranscript`, `transcript`,
      `rawAudioUrl`, `voiceMemoUrl`, `audioBlob`. Any of them produces failure
      code `raw_source_leak`.
- [ ] `provenance.source` is one of `'voice-memo' | 'written-note' |
      'guided-theme' | 'operator-authored'` and matches what actually arrived.
- [ ] If `provenance.voiceMemoDerived` is `true`, then
      `provenance.transcriptSanitized` is `true` — otherwise
      `unsanitized_source`.
- [ ] If `provenance.voiceMemoDerived` is `true`, then
      `sanitizedSourceSummary` is non-empty — otherwise
      `missing_sanitized_summary`.
- [ ] `sanitizedSourceSummary` is a **paraphrase**. It quotes nothing verbatim
      and contains no address, phone number, school name, employer, medical
      detail, or other family PII that the story does not need.
- [ ] `castLock` lists only the names permitted to appear in the brief or the
      book, and `primaryHeroes.length <= MAX_PRIMARY_HEROES` (2).
- [ ] `validateCustomStoryBrief(brief)` returns `route: 'proceed'`. Any failure
      routes to `manual_queue`; there is **no** template fallback.
- [ ] `statusForShape(brief.storyShape).conciergeAllowed` is `true`.

Two later validators exist for the same pipeline and are equally fail-closed:
`validateCustomStoryPlanAnchors` (after a beat plan) and
`validateFinalCustomStoryProse` (after final prose, including a verbatim-quote
check against the source transcript **only** when
`provenance.sourceTranscriptAvailableToProofLane` is true and the transcript is
passed in as an argument — it is never persisted on the brief).

### 5.3 Approval record requirements

An approval is not a memory or a Slack thumbs-up. Record, in the order ticket:

1. order id;
2. the exact brief version approved (working title + shape key
   `heroStructure|storySource|childRole`);
3. who approved it (operator handle, not a customer name) and the ISO timestamp;
4. that consent (§4.1) and provenance (§4.2) were verified, and how;
5. the sanitization confirmation — that §5.2 was walked line by line;
6. any operator intervention, categorized per `InterventionCategory`
   (`src/lib/custom-story/intervention-log.ts`): `brief_correction`,
   `anchor_correction`, `sanitization_correction`, `role_cast_correction`,
   `manual_prose_fix`, `manual_art_fix`.

`briefApprovedByOperator` on the brief is the machine-readable form of (3).

> **Not implemented; escalate.** `src/lib/custom-story/intervention-log.ts` is
> schema and pure helpers only — its header states "No persistence here —
> callers decide where entries live", and no caller in `src/` persists an entry.
> Until a store is wired, the intervention log lives in the ticket. Do not
> invent a write path.

---

## 6. Operator-authored story and proof handoff

### 6.1 Implemented (read-only or already-gated)

- Read the order, its media markers, consent, provenance, and brief state via
  `/admin/orders/<orderId>`.
- Read diagnostics via the three surfaces in §2.
- The refusals in §3.3. They are implemented, tested, and require nothing from
  you.
- Checkout-side validation of a `customStoryBrief` before Stripe, with
  `custom_story_manual_review_required` / `custom_story_paid_beta_required`.

### 6.2 Manual (a human does this, outside the product)

- Obtaining the media through an escalated, authorized retrieval (§4.4).
- Listening to / reading it and transcribing as applicable.
- Writing the sanitized brief and getting it approved (§5).
- **Authoring the story prose.** For this release the prose for a media-backed
  Custom Story is written by a person.
- Producing the proof for owner review, and every customer communication about
  it (§8).

### 6.3 Prohibited / not implemented

| Action | Status |
| --- | --- |
| Automated prose or template fallback for a media-backed order | Prohibited; refused in source |
| Admin "Retry fulfillment" on a media-backed order | Prohibited; returns 409 |
| Page regeneration, proof publish, resolve-text-change | Prohibited; return 409 |
| Print rebuild | Prohibited; refused |
| Fetching order media bytes from an operator surface | **Not implemented; escalate** (§4.4) |
| Writing operator-authored prose back onto the order through a supported product path | **Not implemented; escalate.** No admin route or script accepts operator prose for an order. |
| Persisting an intervention-log entry | **Not implemented; escalate** (§5.3) |
| Editing order JSON or Blob objects directly to work around any of the above | **Prohibited.** No exceptions in this runbook. |

The gap between §6.2 and §6.3 is real and deliberate: a human can author the
prose, and the product currently offers no supported way to land it on the
order. That handoff is an engineering escalation, not an operator workaround.

---

## 7. Fail-closed stop conditions

**Stop, change nothing, and escalate (§9)** on any of these:

1. **Missing consent** — no `voiceConsentAt` / `documentConsentAt` and no
   `consentAt` on the corresponding `FinalizedSelectionEntry`.
2. **Missing or incoherent provenance** — absent/contradictory `voiceSource` or
   `documentSource`; an intake `pathname` that is not the derived
   `intakeAssetPath`; a `category` that disagrees with the `mimeType`.
3. **Ambiguous source** — the only marker is `legacyVoiceUploadPresent`, or
   markers exist for media whose bytes cannot be located.
4. **Missing media** — a marker is set but the referenced path holds nothing.
   Do **not** "clean up" the marker; it is the automation hold.
5. **Conflicting identity** — names in the media, the brief's `castLock`,
   `order.familyCharacters`, and the hero/recipient fields do not agree; or the
   brief names anyone outside `castLock`.
6. **Stale order read** — your read predates any action you are about to take,
   or `updatedAt` moved while you worked. Re-read authoritatively and start the
   decision over.
7. **Unknown payment state** — `paymentStatus` is not a state you can explain,
   or the order shows **Checkout reconciliation required**
   (`checkoutSessionProvisioning` evidence rendered in the admin Payment
   section). Stripe is the only authority; follow
   `docs/runbooks/support-stuck-order-checklist.md` and tell the customer
   nothing about a charge until Stripe confirms it.
8. **Missing proof gate** — anyone proposes print, ship, or delivery for an
   order that has not been through proof review and approval.
9. **Any automation attempt** — you, a script, or a teammate is about to press
   retry, rebuild, regenerate, sweep, or "just kick it". Including "to see what
   happens."
10. **The panel and the predicate disagree** — "Voice upload present: no" while
    §3.1 fields say otherwise (the §3.1 divergence). The predicate wins.
11. **A delivery-side action is available that the media gate does not cover** —
    see §10's warning. Treat availability as a bug, not as permission.

---

## 8. Customer communication rules

Never say, imply, or let stand:

| Do not say | Why |
| --- | --- |
| Anything about voice cloning, voice synthesis, generated speech, published audio, or "training" on the recording | The consent copy explicitly excludes cloning and AI training. The product does none of it. |
| "Your recording is deleted automatically" / "deleted after your book ships" | There is no deletion sweep in the codebase. The `HSB_VOICE_DELETE_ON_SHIP`-style sweep described in the superseded beta runbook was never implemented. Manual deletion on request is the only honest offer, and executing it is **not implemented; escalate** (§14). |
| Any date or turnaround for the proof, the print, or delivery | Media-backed orders are hand-authored with no committed SLA. Give the customer the next step, not a date. |
| "You've paid, so it's in production" / "it's generating now" | Payment does not start production. Every current order is `manual_hold` and media-backed orders are additionally refused by every automated path. |
| "It failed" / "there was an error", when you are looking at `media_story_manual_review_required` | That refusal is the design. Describe it as human review, not failure. |
| Confirmation or denial that a charge occurred, when the order shows checkout reconciliation required | Verify in Stripe first. |

Safe framing: *"Your story is being written by a person on our team from the
material you sent. We'll come back to you with a proof to review before
anything is printed."*

---

## 9. Escalation packet — PII-safe fields only

> **Warning: the text diagnostics block is NOT PII-safe.**
> `formatDiagnosticsSummary` (`src/lib/order-diagnostics.ts:524`) opens with
> ``Order <id> — <childName> <<email>> · <formatLabel>`` and later emits
> ``Proof: <storyArtifactUrl>``. So `?format=text` and `npm run order:status`
> both carry **the child's name, the customer's email, and a Blob artifact URL**.
> `docs/runbooks/support-stuck-order-checklist.md` tells you to paste that block
> plus the customer's email when escalating. **For media-backed Custom Story
> orders, that instruction is superseded by this section:** redact first.

### Include

- `orderId`
- `bookFormat` / `formatLabel`
- `paymentStatus`, and `paidAt` if present
- `fulfillmentMode`, `fulfillmentStatus`, `status`
- `hasMediaBackedCustomStorySource` = yes, plus **which marker field names** are
  set (names only — e.g. "`voiceIntakeMedia`, `voiceConsentAt`")
- consent timestamps (ISO values are fine — they are not PII)
- `voiceSource` / `documentSource`
- media `mimeType`, `size`, `generation`, `etag`, `assetId`
- brief working title, shape key, `transcriptSanitized`,
  `briefApprovedByOperator`, `customStoryValidation.route`, and failure **codes**
- the exact refusal string you saw (e.g. `media_story_manual_review_required`)
- operator handle and ISO timestamps
- what you did — which should be "read only"

### Never include, in any shared or public channel

- customer email, customer name, child name, or any family member's name
- shipping address or any postal/phone detail
- raw media URLs, Blob URLs, signed URLs, or artifact URLs (treat every Blob URL
  as a bearer credential)
- raw transcript, verbatim quotes from the media, or the media file itself
- brief `sanitizedSourceSummary`, `coreMemory`, `castLock`, or any narrative
  family detail
- the unredacted `?format=text` diagnostics block
- Stripe customer identifiers beyond the session id, when a session id is
  genuinely needed

### Redaction rules

1. Replace names with roles: `<hero>`, `<recipient>`, `<parent>`.
2. Replace any email with `<customer-email>`; the order id is the join key.
3. Replace any URL with its **path shape**, never the URL:
   `orders/<orderId>/document-<assetId>.pdf`.
4. Quote **codes and field names**, never customer content.
5. If you cannot describe the problem without customer content, that is an
   engineering escalation through a private channel with the order id only — not
   a paste.

---

## 10. Authorization matrix

**Read-only — no authorization beyond admin access:**

| Action | Surface |
| --- | --- |
| View order detail | `/admin/orders/<orderId>` |
| View diagnostics (JSON / text / CLI) | §2 |
| View the orders list and the ops queue | `/admin/orders`, `/api/admin/orders?opsIssue=paid_artifact` |
| View the checkout-reconciliation panel | `/admin/orders`, order Payment section |
| Read the review audit trail | admin page |

**Owner-gated — explicit owner authorization for that specific order, plus a
fresh authoritative read immediately before acting:**

| Action | Route / symbol | Media-backed status |
| --- | --- | --- |
| Retry fulfillment | `/api/admin/orders/<id>/retry` → `retryOrderFulfillment` | **Blocked** — 409 |
| Regenerate a page | `/api/admin/orders/<id>/page-review` → `src/lib/page-review.ts` | **Blocked** — 409 |
| Resolve a text-change request | `/api/admin/orders/<id>/resolve-text-change` | **Blocked** — 409 |
| Proof layout override | `/api/admin/orders/<id>/proof-layout` | Gated by review-mutation eligibility |
| Mark shipped + notify | `/api/admin/orders/<id>/ship` → `markOrderShipped` | Only after the print partner confirms a real shipment |
| Print upgrade | `/api/admin/orders/<id>/print-upgrade` | Route currently answers `410` |
| Refund | `/api/admin/orders/<id>/refund` → `refundOrder` | **Owner approval always required.** Never initiate a refund or financial reversal without it. |

**Customer-gated — requires the customer's own authorization, evidenced in the
ticket:**

| Action | Route / symbol | Notes |
| --- | --- | --- |
| Manually approve a proof | `/api/admin/orders/<id>/manual-approve` → `manuallyApproveProof` | Bypasses the customer's own acknowledgement. Only with explicit written customer approval, attached to the ticket. Requires `fulfillmentStatus === 'proof_ready'` and a `proofApprovalToken`. |
| Resend proof email | `/api/admin/orders/<id>/resend-proof` → `resendProofEmail` | Customer-visible send. |
| Resend digital delivery | `resendDigitalDelivery` | Requires `fulfillmentStatus === 'delivery_email_failed'` and an existing `storyArtifactUrl`. |

> **Warning — the media gate does not cover the delivery side.**
> `manuallyApproveProof`, `markOrderShipped`, `resendProofEmail`,
> `resendDigitalDelivery`, and `refundOrder` do **not** call
> `hasMediaBackedCustomStorySource`. They are held shut only by state
> preconditions (`proof_ready`, `delivery_email_failed`, `storyArtifactUrl`
> present) that a media-backed order cannot reach *automatically*, because
> production is refused upstream. If a media-backed order is nonetheless sitting
> in one of those states, something put it there out of band: **stop and
> escalate (§7.11)** rather than approving, shipping, or emailing. Tracked as a
> gap in §14.

Separately approvable, never bundled: **(a)** brief approval, **(b)** proof
approval, **(c)** any public/marketing use of the story or media, **(d)** print
submission, **(e)** customer email, **(f)** fulfillment/shipping. Approval for
one is never approval for another. Proof always precedes print.

---

## 11. Reconciling the docs — one current policy

| Existing statement | Where | Status |
| --- | --- | --- |
| "Retry fulfillment — only on `failed_manual_review`" and "admin retry can kick fulfillment" | `docs/runbooks/support-stuck-order-checklist.md`, "Mutating actions" | **Superseded for media-backed orders.** `retryOrderFulfillment` returns 409 regardless of `fulfillmentStatus`. Do not attempt it. |
| "paste the **text diagnostics** (`?format=text`) and the customer's email" | same doc, "Read-only escalation packet" | **Superseded for media-backed orders** by §9. That block contains child name, customer email, and the proof URL. Redact first. |
| "Don't paste blob URLs publicly — they're bearer credentials in the current `public` access mode" | same doc | Still true for order JSON and hero photos (`getBlobAccessMode()` defaults to `public`). **Not** true of story media: `assertPrivateStorySourceStorage` requires `private` for voice and document uploads. Treat every Blob URL as a bearer credential either way. |
| "Manually approve proof — bypasses the customer ack. Only with explicit customer consent" | same doc | Still current. §10 adds: for a media-backed order in `proof_ready`, stop and escalate first (§7.11). |
| The Father's Day voice-note beta runbook in its entirety | `docs/runbooks/voice-note-transcription.md` (absent here; `ef89371` on `backup/hsb-dev-stuff-clean-20260624`) | **Superseded.** See §12. |
| "Do not enable story upload broadly in production until legal/owner approval confirms retention/deletion and provider-use copy" | `docs/qa/fully-custom-checkout-qa.md` | Still current and still open. |
| "Do not simply flip `NEXT_PUBLIC_HSB_VOICE_BETA` in production" | `docs/plans/2026-07-06-fully-custom-checkout.md` | Stale but harmless: that flag no longer gates checkout media (§13). It still gates the family-review portal recorder (`src/app/family-review/review/[reviewToken]/review-portal.tsx:612`). |

---

## 12. Superseded history — the Father's Day voice beta

Kept because the history is useful, marked because the mechanics are gone.

**What that runbook described (2026-05/06):** a checkout voice recorder gated by
`NEXT_PUBLIC_HSB_VOICE_BETA`; `/api/order` calling `transcribeVoiceNote()` from
`src/lib/voice-transcription.ts` synchronously before Stripe when
`HSB_VOICE_TRANSCRIPTION_ENABLED=true`; a bounded ~600-char `inspiration`
summary persisted as `voiceTranscript`; and story generation splicing that
summary into the prose prompt.

**What is actually true at this commit:**

| Beta-era claim | Now |
| --- | --- |
| `src/lib/voice-transcription.ts` | **Does not exist.** |
| `transcribeVoiceNote()` | **Does not exist.** No definition, no call site. |
| `HSB_VOICE_TRANSCRIPTION_ENABLED` turns transcription on | **No code reads it.** It survives only in a doc comment (`src/lib/orders.ts:369`) and a `TODO(voice-beta)` (`src/lib/fulfillment.ts:422`). Setting it does nothing. |
| `voiceTranscript` is populated at checkout | **Nothing writes it.** `createOrderRecord` passes `input.voiceTranscript ?? null` through, and no caller supplies one. The field, the admin "Transcript status/model/preview" rows, and `voiceInspirationBlock` are all inert for orders created today. Legacy records may still carry one. |
| The transcript feeds the prose prompt | `voiceInspirationBlock` (`src/lib/story-generator.ts:606`) still exists inside the pure `buildUserPrompt`, but it returns `''` with no `voiceTranscript`, and `customStoryGenerationGate` throws at the top of `generateStoryWithMeta` before generation for any media-backed order. |
| `NEXT_PUBLIC_HSB_VOICE_BETA` gates the checkout recorder | **No longer.** The gate is `isCheckoutStoryMediaEnabled()` (`src/lib/checkout-direct-flags.ts:23`), which requires private Blob + a token. The old flag now gates only the family-review portal recorder. |
| Audio stored at `orders/<orderId>/voice-<name>` | Path now includes a random asset id and a lease scope: `orders/<orderId>/<scope>voice-<assetId>.<ext>`, namespaced by `withBlobNamespace`. Documents mirror it with `document-<assetId>`. Original filenames are never retained. |
| "Deleted after your book ships" | Removed from customer copy in the beta era and **still** unbacked. No deletion sweep exists. |

**Still true from that era, and still policy:** audio is source material only —
never voice cloning, synthesized speech, imitation, or published audio; consent
is enforced before upload; the 15 MB audio cap holds (now
`STORY_MEDIA_MAX_BYTES.audio` in `src/lib/story-media-size.ts`, with a 10 MB
document cap alongside it, enforced on both the browser and the server).

---

## 13. Verification checklist

Walk this before you consider a media-backed order handled.

- [ ] Classified with §3.1 against the order record — not the admin summary row.
- [ ] `fulfillmentMode` confirmed (`manual_hold`, or `undefined` on a legacy
      order — both hold).
- [ ] Consent present for the lane that actually has media (§4.1).
- [ ] Provenance coherent (§4.2).
- [ ] Storage confirmed private (§4.3).
- [ ] No media opened without an authorized, escalated retrieval (§4.4).
- [ ] If a brief exists: every line of §5.2 checked, `route: 'proceed'`,
      `briefApprovedByOperator === true`.
- [ ] Approval record written with all six items in §5.3.
- [ ] No automated path attempted. No `media_story_manual_review_required`
      "cleared", retried, or routed around.
- [ ] Every state-changing action taken had explicit owner or customer
      authorization **and** a fresh authoritative read immediately before it.
- [ ] Nothing in §9's "never include" list left a private channel.
- [ ] No customer promise made about deletion, cloning, timing, or automatic
      production (§8).
- [ ] Ticket records: order id, markers found, consent/provenance evidence,
      decisions, approvals, and that inspection was read-only.

---

## 14. Source-drift checklist

This runbook cites source. Source moves. Re-run these before trusting it, and
after any change to checkout, intake, fulfillment, or the custom-story modules.

| # | Check | Command / location | Expected today |
| --- | --- | --- | --- |
| D1 | The predicate still exists and still lists twelve fields | `grep -n "export function hasMediaBackedCustomStorySource" -A 18 src/lib/story-generator.ts` | 12 fields, matching §3.1 |
| D2 | Every media gate call site still exists | `grep -rn "hasMediaBackedCustomStorySource" src/` | call sites in `story-generator.ts`, `fulfillment.ts`, `admin-actions.ts`, `page-review.ts`, `rebuild-print-order.ts` |
| D3 | The refusal string is unchanged | `grep -rn "media_story_manual_review_required" src/` | present at the §3.3 sites |
| D4 | `manual_hold` is still set explicitly at checkout | `grep -n "fulfillmentMode: 'manual_hold'" src/lib/checkout-order-route-handler.ts src/lib/order-recovery.ts` | both hits |
| D5 | The sweep still refuses non-`auto` | `grep -n "fulfillmentMode !== 'auto'" src/lib/fulfillment-sweep.ts` | one hit |
| D6 | Private storage still asserted for story media | `grep -n "assertPrivateStorySourceStorage" src/lib/orders.ts` | definition + both upload call sites |
| D7 | Forbidden downstream keys unchanged | `grep -n "FORBIDDEN_DOWNSTREAM_KEYS" -A 8 src/lib/custom-story/validate.ts` | the five keys in §5.2 |
| D8 | `CustomStoryBrief` still has no raw-transcript field | `grep -n "rawTranscript" src/lib/custom-story/types.ts` | only the prose comment |
| D9 | Transcription is still absent | `grep -rn "transcribeVoiceNote\|voice-transcription" src/` | comment references only; **any real definition invalidates §12 and this runbook's core claim** |
| D10 | Nothing writes `voiceTranscript` | `grep -rn "voiceTranscript" src/` | reads only, plus the pass-through in `createOrderRecord` |
| D11 | Still no operator route serving order media | `grep -rln "voiceBlobUrl\|documentBlobUrl\|intakeAssetPath" src/app/` | **no matches**; a match means §4.4 may now be implemented |
| D12 | Diagnostics still omits media markers | `grep -n "voiceBlobPath\|documentBlobPath\|fulfillmentMode\|IntakeMedia\|customStoryBrief" src/lib/order-diagnostics.ts` | **no matches**; matches mean §2's caveat can be relaxed |
| D13 | The admin/predicate divergence still stands | compare `src/app/admin/orders/[orderId]/page.tsx:67` with §3.1 | still four of six audio fields; if fixed, drop the §3.1 warning |
| D14 | Delivery-side actions still ungated | `grep -n "hasMediaBackedCustomStorySource" src/lib/admin-actions.ts` | only in `retryOrderFulfillment`; more hits mean §10's warning can narrow |
| D15 | `order:status` still wired | `grep -n '"order:status"' package.json` | one hit |
| D16 | Media size caps unchanged | `grep -n "STORY_MEDIA_MAX_BYTES" -A 4 src/lib/story-media-size.ts` | audio 15 MB, document 10 MB |
| D17 | Consent refusal codes unchanged | `grep -n "voice_consent_required\|document_consent_required" src/lib/checkout-order-route-handler.ts` | both |
| D18 | Story-media UI gate unchanged | `grep -n "isCheckoutStoryMediaEnabled" -A 8 src/lib/checkout-direct-flags.ts` | private Blob + token |
| D19 | Shape lanes unchanged | `src/lib/custom-story/shapes.ts` `STORY_SHAPE_STATUS` | `dual-parent\|memory\|audience` still `concierge` |
| D20 | Consent copy unchanged | `src/components/checkout/VoiceRecorderSection.tsx:343`, `:347` | no cloning / no AI training / not shared |

If **D9** or **D11** changes, stop using this runbook and get it rewritten: an
automated transcription path or an operator media route would move the safety
boundary this document is built on.

---

## 15. Known operational gaps

Open, deliberate, and not fixed by this documentation-only change.

1. **No operator media retrieval.** §4.4. The single largest blocker to actually
   executing this runbook end to end.
2. **No supported path to land operator-authored prose on an order.** §6.3.
3. **Admin panel under-reports audio** vs. the product predicate. §3.1 / D13.
4. **Diagnostics cannot classify a media-backed order** — no markers, no
   `fulfillmentMode`, no brief state. §2 / D12.
5. **The escalation text block leaks PII** (child name, customer email, proof
   URL) and an existing runbook still tells operators to paste it. §9 / §11.
6. **Delivery-side actions are not media-gated** — approve, ship, resend, refund
   rely on state preconditions alone. §10 / D14.
7. **Intervention log has no persistence.** §5.3.
8. **No deletion mechanism.** Manual deletion on request is promised in customer
   copy; executing it requires direct Blob access, which this runbook forbids.
   Needs a supported, logged, owner-gated operation.
9. **No committed SLA** for hand-authored media-backed orders, against a
   24-hour `manual_hold_sla` incident threshold that will fire regardless.
10. **`docs/runbooks/voice-note-transcription.md` is absent from this branch**,
    so its stale claims cannot be corrected in place. §12 carries the
    correction; anyone recovering that file from
    `backup/hsb-dev-stuff-clean-20260624` must treat it as superseded on
    arrival.
