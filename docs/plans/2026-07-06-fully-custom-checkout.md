# Fully Custom Checkout Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Reposition Hero Story Books checkout from child-only hero generation to a fully custom family story intake that supports adult heroes, multiple family members, voice/audio uploads, photo person selection/cropping, and optional face capture.

**Architecture:** Keep this as a staged checkout-intake expansion, not a production fulfillment mutation in one jump. First update the data model/contracts and checkout UI language, then add richer upload/selection metadata, then route the new custom fields into admin/story generation prompts behind proof-review gates. Do not auto-print, auto-send, or relax proof approval gates.

**Tech Stack:** Next.js App Router, React checkout form, FormData order creation, local/Supabase order store, Stripe checkout, existing story-generator/order pipeline.

## Fable review amendments — must absorb before code

Fable agreed with the direction but identified four launch-blocking corrections. Treat these as binding phase gates:

1. **Do not sell what the generator cannot render.** Adult/parent/grandparent hero checkout cannot ship unless minimal story-generator prompt plumbing ships in the same phase. If that plumbing is not ready, keep adult hero options hidden and only enable child/sibling/pet/family-support roles that existing generation can safely proof.
2. **Privacy/terms/consent move to Phase A.** Voice/document upload and face/photo processing are not just UX. Illinois/BIPA risk may apply to face embeddings, likeness extraction, and voiceprints. Get legal review before broad production rollout; meanwhile add explicit consent, usage limits, and retention/deletion schedule language before enabling new media intake.
3. **Every ordered identity needs a pinned usable face source.** Whole-family books multiply the known likeness QA failure mode. Do not start generation for any human identity without an assigned, approved reference. Whole-family / 4–5 identity books should be premium/manual/LoRA-tier until quality is proven.
4. **Audio upload must have ingestion, not just storage.** Exposing uploads requires a confirmed transcript/story-input path and admin visibility, or customers will assume unused uploads were reflected in the story.

Additional hard rules:
- Multi-face photos must block checkout or proof-start if no person/focus selection is recorded.
- Keep `childName` as a derived legacy field for old orders/admin compatibility.
- Flipping `NEXT_PUBLIC_HSB_VOICE_BETA` requires preview → QA → Alexy sign-off; first inspect what else the flag controls.
- Add E2E Stripe test-mode order per enabled hero type.
- Add per-identity likeness checks to proof QA.

---

## Product decision

Current checkout is too narrow:
- audio upload is present in code but hidden behind `NEXT_PUBLIC_HSB_VOICE_BETA === "true"` and likely unavailable in production;
- family members exist but are capped at 4 supporting characters and framed as secondary;
- no explicit photo crop/person-selection metadata for multi-person photos;
- no face capture flow offered;
- marketing/form language assumes a child is always the hero.

New positioning:
- **Fully custom family storybook.**
- Primary hero can be child, parent, grandparent, sibling, pet, or family/group.
- Child can be hero, co-hero, recipient, narrator, or audience.
- Parent/grandparent hero stories are allowed when the book is still for a child/family gift.
- Checkout collects reference media and role intent clearly, then proof review remains the safety/quality gate.

## Non-negotiable guardrails

- No production deploy until preview QA and owner approval.
- No customer/order mutation beyond checkout fields unless explicitly approved.
- Uploaded children/family photos and voice files are order-only assets; no model training, no voice cloning.
- Treat Illinois/BIPA exposure as a launch blocker: before enabling face capture, likeness embeddings, voice processing, or broader media upload in production, add written consent + retention/destruction language and get legal review.
- If adult is hero, copy must avoid implying we market to children directly.
- Face capture must be optional, parent/adult initiated, and not required if upload works.
- Multi-person photo support must make selection explicit: “Who should we use from this photo?”
- Generated proof must not auto-print; print remains proof-approved.
- No adult/parent/grandparent hero option goes live unless story-generator prompts/templates are hero-type aware in the same release.
- No human identity enters generation without an assigned usable pinned face reference.

## Target UX

### Step 1 — Story setup
Replace child-only labels:
- From: “Your child becomes the hero.”
- To: “Choose who this story celebrates.”

Fields:
- Story recipient: child / family / adult gift / other
- Primary hero type: child / parent / grandparent / sibling / pet / whole family / custom
- Primary hero name
- Primary hero age or life stage: child age, parent, grandparent, adult, pet, optional
- Relationship to recipient: e.g. “Grandpa to Emma,” “Mom to Lukas,” “family dog”

### Step 2 — Characters
Support multiple people as first-class story characters:
- Primary hero
- Co-hero(s)
- Supporting family members
- Gift recipient / dedication recipient
- Pets

Each character has:
- role
- name
- relationship label
- pronouns
- appears in story
- is primary hero
- is gift recipient
- reference photo(s)
- appearance notes
- personality / memory notes

### Step 3 — Reference photos
Support:
- one-person upload
- multi-person photo upload
- crop/person selection per photo
- multiple photos per character
- “I’ll send photos later” fallback only if proof cannot start yet

Minimum viable implementation:
- store `focusPersonLabel`, `cropHint`, and `photoAssignment` metadata per uploaded photo;
- show manual “tap/click crop box” if we implement UI crop now, or a text-based fallback if not;
- require at least one pinned usable face reference for every human identity before generation starts; allow checkout only if clearly marked “photo needed before proof,” and block proof/generation until received;
- auto-block multi-person photos if no person/focus selection is recorded.

### Step 4 — Audio / story notes
Make audio/document upload visible without beta flag, but still optional.
- Upload audio file
- Record audio
- Upload text/PDF/Word notes
- Consent checkbox stays required when file present
- Copy changes from “child voice note” to “story voice note / family memory note”
- It is inspiration only, no cloning.
- It must feed a confirmed ingestion path: upload -> stored asset -> transcript/extract or reviewer note -> story prompt/admin visibility.

### Step 5 — Face capture
Add optional “Take a quick face photo” path for mobile/desktop camera.
- Not required
- Uses browser camera only after tap
- One still frame capture, not biometric verification; still treat as biometric/likeness-risk until counsel says otherwise
- Save as normal reference photo
- Explain: “This helps the artist match the hero better.”

---

## Implementation tasks

### Task 1: Rename checkout contract from child-only to primary hero

**Objective:** Add backward-compatible fields while preserving existing `childName` orders.

**Files:**
- Modify: `src/lib/checkout-flow.ts`
- Modify: `src/app/checkout/checkout-form.tsx`
- Modify: order API route that receives `/api/order` FormData
- Test: existing checkout tests plus new contract tests

**Fields to add:**
- `heroName`
- `heroType`
- `heroAgeOrStage`
- `recipientName`
- `recipientRelationship`
- `storyPerspective`

**Backward compatibility:**
- If `heroName` missing, use `childName`.
- Keep `childName` populated as a derived legacy field for old pipeline/admin/tests even after `heroName` exists.

### Task 2: Replace child-only checkout labels

**Objective:** Make checkout say “hero/person/family” instead of only “child.”

**Files:**
- Modify: `src/app/checkout/checkout-form.tsx`
- Modify: `src/lib/checkout-flow.ts`
- Modify: tests expecting child-only copy

**Copy examples:**
- “Who is the main hero?”
- “Who is the book for?”
- “Add family members, pets, or co-heroes.”
- “Upload clear reference photos for each person you want illustrated.”

### Task 3: Promote family members to flexible characters

**Objective:** Remove the “supporting only” mental model.

**Files:**
- Modify: `src/app/checkout/checkout-form.tsx`
- Modify: `src/lib/orders.ts`
- Modify: admin order detail page

**Changes:**
- Rename UI section to “People, pets, and family details.”
- Allow selecting `primaryHeroCharacterId`.
- Allow more than 4 characters only if UI stays manageable; otherwise keep 4 visible plus “add more in notes” for launch.
- Do not auto-select Dad/parent as gift recipient.

### Task 4: Make audio/document upload available in checkout

**Objective:** Fix “won’t let me upload audio file.”

**Files:**
- Modify: `src/app/checkout/checkout-form.tsx`
- Modify: `src/components/checkout/VoiceRecorderSection.tsx`
- Modify: order API route handling `voice`
- Test: voice upload appears and FormData includes file + consent.

**Likely root cause from inspection:**
- The component exists and supports audio upload, but checkout only renders it when `NEXT_PUBLIC_HSB_VOICE_BETA === "true"`.

**Change:**
- Rename component to `StoryInspirationUploadSection` or keep export but update copy.
- Do not simply flip `NEXT_PUBLIC_HSB_VOICE_BETA` in production. First inspect all code controlled by that flag.
- Render by default in preview only after QA, or behind a production-safe config that is explicitly enabled after Alexy sign-off.
- Preserve consent requirement when attached.
- Add/verify ingestion path: uploaded audio/document is visible in admin and transcribed/extracted into story inputs before proof generation.

### Task 5: Add photo assignment metadata

**Objective:** Let customers upload multi-person photos and tell us who is who.

**Files:**
- Modify: checkout form state
- Modify: FormData serialization
- Modify: order API parsing
- Modify: admin order detail display

**Metadata:**
- `photoId`
- `assignedCharacterId`
- `focusPersonLabel`
- `cropHint` e.g. `left`, `center`, `right`, `top-left`, or normalized box
- `isPrimaryReference`

**MVP UI:**
- After upload, ask: “Who should we use from this photo?”
- Options: existing characters + “add new person.”
- Ask: “Where are they in the photo?” with left/center/right/top/bottom choices.

### Task 6: Add real crop/person selection UI

**Objective:** Replace text-only crop hints with a visual selector.

**Files:**
- Create: `src/components/checkout/PhotoFocusSelector.tsx`
- Modify: checkout form photo upload section
- Test: selector stores normalized crop box.

**MVP behavior:**
- Show uploaded image preview.
- Allow user to drag/resize a focus rectangle.
- Store normalized `{x,y,width,height}`.
- Show label: “We’ll focus on this person for the hero reference.”

### Task 7: Add optional face capture

**Objective:** Let users take a clean hero reference photo from camera.

**Files:**
- Create: `src/components/checkout/FaceCaptureSection.tsx`
- Modify: checkout photo section
- Test: mock mediaDevices path and fallback.

**Behavior:**
- Button: “Take a quick hero photo.”
- Ask permission only after tap.
- Capture one still image to File.
- Add to same photo assignment flow.
- Stop camera tracks immediately after capture/cancel.

### Task 8: Phase-A minimal story-generator plumbing for enabled hero types

**Objective:** Stop hardcoding “child named {{childName}}” in story templates/prompts before any non-child hero option is enabled. This is Phase A, not Phase C, if adult/parent/grandparent hero choices are visible.

**Files:**
- Modify: `src/lib/story-generator.ts`
- Modify: provider prompts if present
- Test: adult hero prompt does not call adult a child.

**Changes:**
- Add `heroDisplayName(order)` and `heroDescriptor(order)` helpers.
- Replace child-only templates with hero-type aware language.
- Add story relationship block: “This is a children’s story for [recipient], featuring [hero] as the hero.”
- If this minimal plumbing is not complete, hide adult/parent/grandparent hero types from checkout and only launch safe narrower roles.

### Task 9: Phase-A privacy/terms/consent update

**Objective:** Cover adult/family media, optional voice/document uploads, face-photo/likeness processing, retention/deletion, and Illinois/BIPA-sensitive consent before enabling new media intake in production.

**Files:**
- Modify: `src/app/privacy/page.tsx`
- Modify: `src/app/terms/page.tsx`

**Copy:**
- parent/guardian or authorized adult must have permission for uploaded child/family photos and recordings;
- uploaded media used only for requested order/support;
- no voice cloning;
- deletion available via support;
- written consent for uploaded likeness/voice/media by authorized adult;
- retention/destruction schedule language;
- legal review required before broad production rollout.

### Task 10: Add preview QA checklist

**Objective:** Validate the new fully custom checkout before launch.

**Files:**
- Create: `docs/qa/fully-custom-checkout-qa.md`

**Scenarios:**
1. child hero only
2. grandparent hero, child recipient
3. parent hero, kid story audience
4. whole-family story
5. multiple people in one photo with crop hint
6. per-character photos
7. audio upload
8. face capture fallback blocked
9. photo later path
10. Stripe checkout preserves order fields

---

## Phase recommendation

### Phase A — safe immediate conversion fix
- Update copy from child-only to “main hero” only where the generator can support it.
- Add data contract fields and keep `childName` derived for legacy compatibility.
- Enable audio/document upload in preview only after verifying flag scope, consent, storage, admin visibility, and transcript/story-input ingestion.
- Add flexible family character role labels.
- Add text-based photo assignment/crop hints.
- Add Phase-A privacy/terms/consent updates, including retention/deletion language and legal-review note.
- Include minimal story-generator plumbing for every enabled hero type. If adult/parent/grandparent plumbing is not ready, hide those options.

### Phase B — photo quality fix
- PhotoFocusSelector crop box.
- FaceCaptureSection only after consent/privacy language is ready and legal risk is understood.
- Per-character photo assignment UX.
- Hard-block multi-face photos without focus/person selection.

### Phase C — generator depth / premium identity tier
- Deeper adult/parent/grandparent hero story arcs.
- Whole-family/4–5 identity books routed to premium/manual/LoRA-quality tier until identity consistency is proven.
- Admin proof QA display for custom roles/media.

## Acceptance criteria

- Customer can order a story where Grandpa or Mom is the main hero and Lukas/child is recipient/audience **only after** generator prompts/templates prove they render adult heroes correctly.
- Customer can add more family members/co-heroes with photos/notes.
- Customer can upload an audio file without hidden beta flag blocking it, and that file is visible to admin plus transcribed/extracted into the story-input path.
- Customer can assign a multi-person photo to a specific person and provide focus/crop guidance; no multi-face reference proceeds without selection.
- Customer can optionally capture a face photo if browser supports camera.
- Admin order view shows all custom hero/family/audio/photo metadata.
- Existing child-hero checkout still works; legacy child-hero checkout regression is byte-identical where intentionally unchanged.
- Test-mode Stripe order passes for each enabled hero type.
- Proof QA checklist includes per-identity likeness checks and pinned face source confirmation.
- Stripe checkout still works and no print order submits without proof approval.

## Test commands

Run after implementation:

```bash
npm test -- checkout
npm test -- voice
npm test -- story-generator
npm run build
```

If graphify is available after code changes:

```bash
graphify update .
```
