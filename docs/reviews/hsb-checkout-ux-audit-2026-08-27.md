# HSB checkout UX audit and five-step wizard implementation plan

- **Date:** 2026-08-27
- **Branch:** `cc/hsb-checkout-ux-audit-20260827`
- **Base:** `origin/main` @ `edf23f8` (`feat(hsb): private-capable Family Review asset storage + dry-run migration (#157)`)
- **Scope:** read-only product/code audit + review-ready implementation plan. No order, Stripe session, PaymentIntent, charge, refund, customer record, upload, proof, or fulfillment action was created. No env var, deploy, or Preview/Production data was touched.
- **Companion:** [`hsb-checkout-feature-migration-matrix-2026-08-27.md`](./hsb-checkout-feature-migration-matrix-2026-08-27.md)

> **Status: AUDIT COMPLETE — IMPLEMENTATION NOT STARTED, NOT AUTHORIZED.**
> Nothing in this document has been implemented. Several findings below are
> truthfulness/policy items that need an Alexy or legal ruling before any copy
> ships, and the phased plan depends on rulings listed in §10.

---

## 0. Reconciliation note on "PR #117" — MISMATCH, must be resolved before use

The task brief asks to reconcile current checkout source against "the historical
PR #117 findings." **PR #117 in this repository is not a checkout PR.**

```
$ gh pr view 117 --json number,title,state,mergedAt,headRefName
117  MERGED  "fix: harden public indexing surfaces"
     head: fix/seo-indexing-surfaces-20260726   merged: 2026-07-27
```

Its body is an SEO/indexing change: `/about` wiring, canonical metadata,
sitemap inventory, `X-Robots-Tag` on operational paths. It explicitly states
"no payment, fulfillment, customer-message, or production behavior changes."
There are no checkout UX findings in it to reconcile.

**This is an unknown, not a defect.** Either the number is wrong or the findings
live outside this repo. The closest real checkout-UX ancestry, which this audit
reconciled against instead, is:

| PR | State | What it established that is still live |
|---|---|---|
| #137 | MERGED | `src/lib/checkout-progressive.ts` — the current 5-step progressive model (`hero-details`/`hero-appearance`/`story`/`people`/`review`) and `getCheckoutPaymentBlockers` |
| #132 | MERGED | Formats bound to stable Stripe Product ids (`getRequiredStripeProductId`), fail-closed |
| #120 | MERGED | Likeness intent derived from actual photo presence, not a buyer toggle; media persistence aborts before Stripe |
| #112 | MERGED | "What happens next" 3-step confidence panel, `PRINT_PREVIEW_PROMISE` |
| #86  | MERGED | `PROMO_CODE_HELP` — promo codes are entered on Stripe's page, not ours |
| #62  | MERGED | Hero-photo-first ordering, per-character camera+upload |
| #35  | MERGED | Email validated before the pay CTA (**see F-07 — this regressed**) |
| #79  | DRAFT (open, stale 2026-06-27) | "Harden HSB checkout readiness and status honesty" — overlapping intent, unmerged |
| #82  | OPEN (stale 2026-07-02) | "Harden checkout fulfillment recovery gates" |

**Action required:** supply the correct reference for "PR #117 findings", or
confirm the reconciliation above is an acceptable substitute. §10 tracks this
as U-01.

---

## 1. Current-state map: routes, files, and what actually renders

### 1.1 Payment-session creation path (documented, not redesigned)

There is exactly **one** customer-facing Stripe Checkout Session creation site
in the tree:

```
$ grep -rn "checkout.sessions.create" --include="*.ts" --include="*.tsx" src/ scripts/
src/app/api/order/route.ts:652:    const session = await stripe.checkout.sessions.create({
```

- `POST /api/order` (`src/app/api/order/route.ts:127-705`) is the whole path:
  validate → resolve Stripe Product → persist durable draft → upload media →
  final persist → create Session → bind Session id → return `{ redirectTo }`.
- `POST /api/checkout` (`src/app/api/checkout/route.ts:1-5`) is a **retired
  404 stub**. It is dead surface, not an alternate path.
- A second, **admin-only** payment path exists for print upgrades
  (`src/app/api/admin/orders/[orderId]/print-upgrade/route.ts`). It is not a
  customer checkout, but it is load-bearing for refunds — see F-01.

**Seam for a later narrow incident bugfix.** This audit deliberately proposes
no change to `route.ts:640-705` (the ordering of `markRecoveryLeadConverted`
→ `getStripe()` → `getReturnBaseUrl` → `requireActiveLease()` →
`sessions.create` → `bindOrderCheckoutSession`). Every UI slice in §9 is
confined to `src/app/checkout/**` and `src/lib/checkout-*.ts`. A Rex incident
fix landing inside that server block will merge without conflict against every
slice except PR-5, which touches the *client-side* `handleSubmit` payload
assembly only. **No incident cause is diagnosed or assumed here.**

### 1.2 Screen inventory as rendered today

| Screen | File | Notes |
|---|---|---|
| Checkout shell / pause gate | `src/app/checkout/page.tsx:54-60` | `isCheckoutPaused()` → static paused page; otherwise `<CheckoutForm/>` |
| Checkout form (all steps) | `src/app/checkout/checkout-form.tsx` (2701 lines) | One client component, one `<form>`, 9 `<section>`s, visibility by `className="hidden"` |
| Step model | `src/lib/checkout-progressive.ts:234-305` | 5 steps; `review` is hard-coded `complete: false` (`:276`) |
| Post-pay landing | `src/app/thank-you/page.tsx` | Branches on server-fetched `paymentStatus`; never trusts URL params |
| Status tracking | `src/app/status/[orderId]/page.tsx` + `src/lib/order-status-view.ts` | 4-step digital timeline, 6-step print timeline |
| Dead stub route | `src/app/order/page.tsx` | Live route, non-functional form (`<form>` with no action/fetch, `:31-79`) |

**F-13 (dead surface).** `/order` is a reachable route rendering a fake
"Details → Payment → Confirm" progress bar and a form that submits nowhere. It
is linked only from `src/components/landing/*`, which is imported by **no live
route** (`src/app/page.tsx` renders `editorial-site.tsx`). A customer who
reaches `/order` by URL, history, or an old share link hits a dead end with no
path to `/checkout`. Not in the wizard rewrite scope; listed so it is not
inherited.

### 1.3 The rendered step model does not match the declared one

Two competing step lists exist in the same file:

```
checkout-form.tsx:189   const CHECKOUT_STEPS = [theme, hero, format, email, photo]   // 5 labels
checkout-form.tsx:415   useState<"hero-details"|"hero-appearance"|"story"|"people"|"review">
```

`CHECKOUT_STEPS` is referenced exactly once — as a divisor in
`progressValue` (`:705`) — and `progressValue` is **never rendered**. The
`Progress` component imported at `:5` is never used either.

**F-12 (dead code / no progress bar).** `import { Progress }` (`:5`),
`CHECKOUT_STEPS` (`:189`), `completedStepCount` (`:698`) and `progressValue`
(`:705`) are all dead. There is no progress bar on checkout; the only progress
affordance is the chip row at `:1071-1098`. Confirmed by grep: `<Progress` has
zero occurrences in the file.

---

## 2. Per-screen findings with file/route evidence

Severity: **S1** = customer-visible incorrect claim, data loss, or money
correctness. **S2** = measurable conversion/abandonment or accessibility
failure. **S3** = polish / latent risk.

### F-01 — S1 — The published refund policy is not implementable by the refund tool

This is audit goal 4. **Do not publish "one-click full refund" or any
unqualified money-back promise.** Code, policy, and operator behavior do not
support it.

The only refund implementation is admin-only:
`POST /api/admin/orders/[orderId]/refund` → `refundOrder()`
(`src/lib/admin-actions.ts:403-543`), gated by
`preprintRefundRefusalReason()` (`src/lib/admin-actions.ts:545-568`). Condensed — the last branch is an
`if/||` chain in source, flattened here for readability:

```ts
if (order.paymentStatus === 'refunded' || order.refundedAt) return 'already_refunded';
if (order.paymentStatus !== 'paid')                          return 'not_paid';
if (order.printUpgradeStatus === 'paid' && order.printUpgradeStripeSessionId)
                                                             return 'multi_payment_refund_required';
if (order.status === 'shipped')                              return 'already_shipped';
if (order.status === 'print_in_production')                  return 'already_in_print';
if (order.fulfillmentKickoffId)                              return 'fulfillment_active';
if (['generating_story','generating_images','building_pdf',
     'submitting_to_print','complete'].includes(order.fulfillmentStatus))
                                                             return 'already_finalized';
```

Cross-referenced against when fulfillment actually starts and what status it
lands on:

- The Stripe webhook schedules kickoff immediately on payment
  (`src/app/api/webhooks/stripe/route.ts:10` → `scheduleFulfillmentKickoff`;
  `src/lib/fulfillment-kickoff.ts:1-60` documents a `setImmediate`+`after`
  pair, i.e. **seconds**, not minutes).
- Kickoff sets `fulfillmentKickoffId` and `fulfillmentStatus:'generating_story'`
  (`src/lib/fulfillment.ts:180`, `:211`).
- **Digital** terminates at `fulfillmentStatus: 'complete'`
  (`src/lib/fulfillment.ts:626`).
- **Print** terminates at `fulfillmentStatus: 'proof_ready'`
  (`src/lib/fulfillment.ts:816`), clearing `fulfillmentKickoffId`
  (`:669-672` / `:863-866`).

**Resulting real refund windows:**

| Format | Window in which `refundOrder()` succeeds | Published policy (`src/lib/public-catalog.ts:189-192`) |
|---|---|---|
| Digital PDF | **None after fulfillment starts.** Payment → `generating_*` → `complete`. `complete` is permanently `already_finalized`. | "Digital orders are **fully refundable up until the buyer approves the proof**." |
| Classic / Premium | Only while `proof_ready` (after the proof email, before approval). Blocked during `generating_*`/`building_pdf`, and from `proof_approved` onward. | "Printed books are refundable up until the buyer approves the proof for print." — **substantially accurate** |

So: the printed-book policy is roughly honored by the tool; **the digital
refund policy is not reachable through the product at all.** Any digital
refund granted today must be executed manually in the Stripe dashboard,
outside this codebase, leaving `paymentStatus` un-updated unless the
`charge.refunded` webhook path (`src/app/api/webhooks/stripe/route.ts:99`)
reconciles it.

There is also an internal copy conflict already on `main`:

- `src/components/faq-section.tsx:30` — "contact us within 30 days and we'll
  make it right with a **replacement or full refund**."
- `src/app/terms/page.tsx:25` — "After proof approval, we can **only replace**
  books with printing defects or fulfillment errors."

**Drafted accurate Step-5 risk-reversal copy (NOT approved, NOT implemented — needs D-01):**

> **Nothing prints until you approve it.** We email a digital proof first,
> usually in 2–3 business days. Ask for changes as many times as you need
> before approving — revisions before approval are included. If you decide
> not to go ahead before you approve a printed book, email
> support@herostorybooks.com and we'll refund it. After you approve, the book
> goes to print and we replace it only for printing defects or fulfillment
> errors.

Deliberately omitted from that draft, and why:
- No "one-click", "instant", or "self-serve" refund — no such code path exists.
- No refund promise for **Digital** — the tool cannot execute it and the
  high-res PDF is delivered with the proof email, so there is nothing to
  un-deliver (`src/app/thank-you/page.tsx:106`).
- No "30 days" — `preprintRefundRefusalReason` has no time-based branch at all;
  the FAQ's 30 days is unsupported by code.

### F-02 — S1 — Cancelling at Stripe destroys the buyer's entire checkout state

`checkout-form.tsx:985-991`:

```ts
setSuccess(true);
localStorage.removeItem(STORAGE_KEY);      // ← cleared BEFORE the buyer has paid
setTimeout(() => {
  window.location.href = result.redirectTo;
  sessionStorage.removeItem(attemptStorageKey);
}, 1200);
```

and `src/app/api/order/route.ts:681`:

```ts
cancel_url: `${baseUrl}/checkout`,
```

A buyer who reaches Stripe and backs out — the single highest-intent
abandonment point in the funnel — returns to `/checkout` with saved progress
already deleted and the session attempt id already cleared. Every field, the
hero photo, all supporting characters, and any voice note are gone. They must
retype the entire flow.

Worse, a fresh `checkoutAttemptId` is minted on the retry
(`checkout-form.tsx:848-854`), and the durable order id is derived from it
(`route.ts:388`: `ord_${sha256(checkoutAttemptId).slice(0,16)}`), so the retry
creates a **second, unrelated draft order record**, leaving the first as an
abandoned draft.

### F-03 — S1 — Restored supporting-character photos silently disappear while the UI claims they are attached

`saveProgress` (`checkout-form.tsx:277-308`) persists `familyCharacters` with a
raw spread at `:294-297`, which includes `photoFile: File` and
`photoDataUrl: string`. Verified round-trip behavior:

```
$ node -e "...JSON.parse(JSON.stringify([character]))..."
photoFile after round-trip = {}   typeof object   truthy? true
photoDataUrl preserved? true
FormData coerced value = "[object Object]"  | instanceof File? false
```

Consequences, all on the same restore:

1. `photoFile` becomes `{}` — **truthy**. `supportingCharacterDraftMissingFields`
   (`src/lib/checkout-progressive.ts:148-155`) checks `!character.photoFile`, so
   the character is scored **complete**, and the summary card renders
   "Reference photo: **Added**" (`checkout-form.tsx:2079`).
2. At submit, `if (character.photoFile)` passes and
   `payload.set(\`familyCharacterPhoto_${index}\`, {})` writes the **string**
   `"[object Object]"` (`checkout-form.tsx:918-922`).
3. The server correctly ignores it — `!(candidate instanceof File)` → `continue`
   (`route.ts:262`) — so no bad data is stored. But
   `missingSupportingCharacterDescriptionLabels` then runs against a photo-less
   character, and if that character had **only** a photo and no notes, the
   order is **rejected at the pay CTA** with "Add a few written details for X"
   (`route.ts:278-289`) for a photo the UI insists is attached.

`normalizeSavedFamilyCharacters` (`checkout-form.tsx:361-377`) backfills five
fields on restore but does **not** reset `photoFile`/`photoDataUrl`.

### F-04 — S1 — Persisted base64 photos will silently blow the localStorage quota

Same code path. `photoDataUrl` is a base64 data URL of a file shrunk to at most
`CHECKOUT_PHOTO_MAX_BYTES = 1.1 MB` (`checkout-form.tsx:38`), i.e. ~1.47 MB of
base64 each. `SUPPORTING_CHARACTER_LIMIT = 4` (`:131`). Four supporting photos
alone is ~5.9 MB against a typical 5 MB per-origin `localStorage` budget.

`saveProgress`'s `catch {}` (`:304-306`) is empty, so on `QuotaExceededError`
autosave **stops silently** and the customer receives no warning that their
progress is no longer being saved. The comment on that catch says
`/* localStorage unavailable */`, which is not what is actually happening.

### F-05 — S1 (latent) — Unknown or missing `bookFormat` silently bills $39

`src/app/api/order/route.ts:152`:

```ts
const bookFormat = String(form.get('bookFormat') || 'classic').trim();
```

`src/lib/orders.ts:906-912`:

```ts
function normalizeFormat(bookFormat: string): BookFormat {
  if (bookFormat === 'digital' || bookFormat === 'classic' || bookFormat === 'premium') return bookFormat;
  return 'classic';   // ← $39
}
```

An absent or malformed `bookFormat` is not rejected; it becomes Classic
softcover at `priceCents: 3900` (`src/lib/orders.ts:763`). The current client
always sends a valid value and `normalizeBookFormat` (`checkout-form.tsx:355-359`)
rejects unknown `?format=` values, so this is **latent today** — but the wizard
rewrite moves format selection to a new step, and this fallback would turn a
selection bug into a mispriced charge. Every other price-critical binding in
this route already fails closed (`getRequiredStripeProductId`, `route.ts:403`).
This one should too.

### F-06 — S2 — No persistent order summary on mobile, and the pay CTA is buried

`checkout-form.tsx:1159`:

```tsx
<form className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
```

with the summary at `:2426`: `<aside className="space-y-5 lg:sticky lg:top-6">`.

Below the `lg` breakpoint the grid collapses to one column and the `<aside>` —
which contains the cover preview, the full `<dl>` of order facts, the Order
summary block **and the pay CTA itself** (`:2684`) — stacks **after** all step
content. On a phone the buyer never sees price, format, or total while making
any selection, and must scroll past the entire summary to reach the button.
There is no sticky mobile footer bar. Target Step 5 requires a persistent order
summary; today mobile has none.

### F-07 — S2 — The pay CTA enables on a malformed email (regression against PR #35)

`checkout-form.tsx:689-696`:

```ts
const isReadyToPay =
  Boolean(form.theme) && Boolean(form.childName) && Boolean(form.bookFormat) &&
  Boolean(form.email) &&                       // ← presence only
  Boolean(form.photoFile || form.characterNotes.trim()) && ...
```

`isReadyToPay` is the sole `disabled` gate on the submit button (`:2684`), and
it uses `Boolean(form.email)`, while every *other* consumer in the same file
uses the regex: `completedStepCount` (`:701`), the `review` step blueprint
(`src/lib/checkout-progressive.ts:283`), and therefore `paymentBlockers`.

Net behavior with `email = "abc"`: the CTA renders **enabled and gold**, the
blocker panel above it simultaneously lists "Email address" as missing, and the
only thing that actually stops the submit is the browser's native
`<input type="email" required>` bubble (`:2402-2412`) — not the app's own
`submitError` banner. Three UI elements disagree about the same field.

### F-08 — S2 — Field errors are colour-only, single-slot, and never clear

- Errors are set as a **whole-map replacement** of one key:
  `setFieldErrors({ [currentStep.firstInvalidField]: true })`
  (`checkout-form.tsx:735`, `:602`). Only one field is ever marked, even when
  a step is missing two.
- The only rendering of `fieldErrors` is a border-colour swap
  (`:1437`, `:1698`, `:1810`, `:2410`). There is **no** `aria-invalid`, no
  `aria-describedby`, and no per-field text message anywhere in the file
  (`grep -n "aria-" checkout-form.tsx` returns 6 hits total: `aria-hidden`,
  `aria-current`, 2× `aria-pressed`, `aria-expanded`, `aria-live`).
  Colour as the sole error carrier fails WCAG 1.4.1 (Use of Color).
- `set()` (`:517-518`) does not clear `fieldErrors` or `stepError`. A corrected
  field keeps its red border until the next Continue/submit.

### F-09 — S2 — Keyboard-inaccessible primary photo control

`checkout-form.tsx:2213-2244` — the "Use camera roll" tile is a `<div>` with
`onClick={() => photoInputRef.current?.click()}` and drag handlers. It has no
`role`, no `tabIndex`, and no key handler, so it is unreachable by keyboard and
invisible to assistive tech. The adjacent "Take a new picture" tile (`:2246`)
is a `<label>` wrapping its `<input type="file">` and **is** accessible — so
one of the two photo entry points works by keyboard and the other does not.

### F-10 — S2 — Selection cards carry no radio/checkbox semantics

Story direction (`:1183`, `:1226`), format (`:2339`), lesson (`:1532`), occasion
(`:1575`), and hero type (`:1400`) are all plain `<button type="button">` in a
plain `<div>`, styled with a border on the selected one. No `role="radiogroup"`,
no `role="radio"`, no `aria-checked`. A screen-reader user hears "Digital proof,
button" with no indication of which option is selected or that the set is
mutually exclusive. The `mustInclude` chips at `:1718` and `:1867` do it
correctly with `aria-pressed` — the pattern exists in the file and is simply
not applied to the five single-select groups.

### F-11 — S2 — Two competing primary CTAs on every step, and one of them is dead on the last step

The sticky header renders a "Continue" button on **every** step
(`:1061-1070`), while the always-rendered `<aside>` renders
"Continue to secure payment — $NN" on **every** step (`:2682-2696`, disabled
until review). On mobile both are visible simultaneously on all five steps.

On the `review` step, header-Continue calls `continueCurrentStep`
(`:739-748`), which computes `nextStep = checkoutSteps[currentStepIndex + 1]`
= `undefined` and then does nothing at all. The button looks live and is inert.

### F-14 — S2 — Unsupported image types are accepted at upload and only rejected at the pay CTA

Target Step 3 requires "requirements and feedback at upload time." Today:

- Drag-and-drop accepts anything matching `file.type.startsWith("image/")`
  (`:816`) — GIF, BMP, TIFF, AVIF, HEIC all pass.
- The `accept` attribute (`:156`) is a picker hint only and is not enforced in
  the change handlers (`:2229-2237`, `:2258-2266`).
- `processPhoto` (`:751-775`) only shrinks; it never validates format.
- The **only** real type check is server-side at submit —
  `validateOrderPhotoFile` (`src/lib/photo-file-validation.ts:46-56`, declared
  type must be one of jpeg/jpg/png/webp, then `sharp` re-decodes to confirm).

So a buyer selects a HEIC/GIF, sees a full-size preview and a green
"✅ filename · Ready for magic" confirmation (`:2170-2178`), completes the
remaining steps, and is rejected at the pay button with "Your hero photo must
be a valid JPEG, PNG, or WebP still image" (`route.ts:186`).

There is also a client/server ceiling mismatch: the client refuses anything it
cannot shrink below `1.1 MB` (`:38`, error copy at `:769-772`) while the server
accepts up to `12 MB` (`photo-file-validation.ts:3`). The client is ~11× stricter
than the contract it is submitting to.

### F-15 — S3 — "Most flexible" vs "Most loved": the recommended tier differs by surface

| Surface | Highlighted tier | Badge |
|---|---|---|
| Live homepage (`src/components/editorial-site.tsx:44-52`) | Digital PDF | **"Most loved"**, `featured: true` |
| Checkout (`checkout-form.tsx:95-104`, `:127`) | Digital, and **pre-selected** by `DEFAULT_BOOK_FORMAT` | **"Most flexible"** |
| `src/lib/pricing.ts:43` | **Classic** `featured: true` | (dead — its only consumer `src/components/pricing-section.tsx` is imported by no live route) |

Prices are consistent everywhere ($19/$39/$64, contract-enforced via
`public-catalog.ts` ↔ `FORMAT_META`), so this is a **claims** problem, not a
pricing one:

- **"Most flexible"** is a defensible product-attribute claim (no print/ship
  step, printable at home) → keep for target Step 4.
- **"Most loved"** is a **popularity claim with no substantiating source in
  the repo** — no sales-mix constant, no analytics export, no decision record.
  Target Step 4 says "recommended option only if supported by current product
  truth." Homepage is out of this audit's scope to change, but the wizard must
  not import "Most loved" into Step 4. Tracked as D-02.
- Label drift is also live: `Digital PDF` (homepage, `pricing.ts`) vs
  `Digital proof` (checkout `:97`, and `FORMAT_META` `src/lib/orders.ts:762`,
  which is what the receipt and status page show).

### F-16 — S2 — Customer email and child's first name travel in the thank-you URL

`src/app/api/order/route.ts:640-650`:

```ts
const successParams = new URLSearchParams({
  orderId: order.id, childName: order.heroName ?? order.childName,
  format: order.formatLabel, email: order.email,
});
success_url: `${baseUrl}/thank-you?${successParams}&sessionId={CHECKOUT_SESSION_ID}`
```

The buyer lands on a URL containing their email address and a child's name, in
the address bar, in browser history, and in any screenshot or shared link.
Mitigations that **are** in place and should be preserved: GA never receives it
(`sanitizedPageLocation` strips the query string,
`src/lib/analytics.ts:185-188`), Stripe referrer is suppressed (`:190-199`), and
the page never trusts the params for payment state
(`src/app/thank-you/page.tsx:10-14`, `:37-64`). The params are pure fallback
display when the order read fails. They can be reduced to `orderId` +
`sessionId` with no loss of function.

### F-17 — S3 — Progressive gate can yank the buyer backwards mid-typing

`checkout-form.tsx:707-714` force-sets `currentStepId` back to
`checkoutProgress.currentStep.id` whenever an earlier step becomes blocking.
Because `getPeopleStepDetails` returns `status:'needs_attention'` for **any**
open draft (`src/lib/checkout-progressive.ts:199-207`) and
`getCheckoutProgress` prefers `needs_attention` over `current` (`:310`), a buyer
who opens a supporting-character draft and then clicks a completed earlier chip
is pulled to `people` on the next render. There is no announcement of the jump
(`aria-live` exists only on the submit-error banner, `:2659`).

---

## 3. Post-payment status tracking audit (goal 3)

The status surface is in materially better shape than checkout. The
`received → creating → proof ready → approved → printing/shipped` model the
brief asks for **already exists** and is honest.

`src/lib/order-status-view.ts`:

- **Digital timeline, 4 steps** (`:218-243`): received → payment → creating → ready to download.
- **Print timeline, 6 steps** (`:245-315`): received → payment → creating → proof approval → in production → shipped.
- The queue-honesty note is gated to exactly the four states where it is true —
  `AWAITING_PROOF_PRODUCTION = {not_started, generating_story, generating_images, building_pdf}`
  (`:53-58`) — with a 20-line comment justifying every exclusion. **Preserve this
  set verbatim; do not widen it.**
- `failed_manual_review` gets its own tone, its own copy, and no CTA (`:86-92`,
  `src/app/status/[orderId]/page.tsx:71-87`).
- `proof_ready` is the only state that sets `needsAction: true` and a "View
  Proof" CTA (`:191-200`).

**Operational gates that MUST survive the migration** (each is a real gate, not
cosmetic):

| Gate | Where | Why it exists |
|---|---|---|
| `fulfillmentMode: 'manual_hold'` on every customer order | `route.ts:390-393` | In-code citation is `DECISIONS.md:51` — "no HSB workflow is approved as automatic". **That file is not present in this tree**, so the comment is the only record of the rule here. Never inferred from product/payment/cohort. |
| Print never leaves `proof_ready` without buyer approval | `fulfillment.ts:816` → `proof_approved` → `submitting_to_print` (`:1459`) | The entire "nothing prints until you say so" promise |
| Refund refusal ladder | `admin-actions.ts:545-568` | Prevents refunding a book already in print/shipped, and refuses when a second (print-upgrade) payment exists |
| Abort-before-Stripe on any media persistence failure | `route.ts:459-479`, `:500-547`, `:570-599`, `:602-639` | A customer must never pay for an order whose photo/voice is missing from durable storage |
| Replay-on-refunded refusal | `webhooks/stripe/route.ts:331-335` | A redelivered session must not resurrect a refunded order |
| Digital PDF ships **with** the proof email; approving accepts the book | `thank-you/page.tsx:106` | Digital has no separate approval gate — this is why F-01's digital refund promise is unbackable |

**Gap G-1 (status discoverability).** `/status/{orderId}` is reachable only
from the thank-you page (`thank-you/page.tsx:126-133`, `:213-217`) and from
emails. It is unauthenticated and keyed by a 16-hex order id. There is no
"look up my order" entry point. Any wizard work that changes the thank-you
hand-off must keep that link, or the status page becomes unreachable for a
buyer who closes the tab.

**Gap G-2 (vocabulary).** Status says "Creating your book" for
`generating_story`/`generating_images`/`building_pdf`; checkout's confidence
panel says "We send a digital proof / You review and reply / Then we print or
deliver" (`checkout-form.tsx:2571-2612`). These are compatible. The
**misleading** vocabulary is elsewhere: the interstitial at `:1014` says
"Taking you to secure payment…" but the surrounding copy says "We saved your
details" (`:1017-1023`) — at that moment the durable draft exists but no
payment has occurred and, per F-02, `localStorage` has just been wiped. The
word "saved" reads to a buyer as "my order is placed." Recommend
"We're holding your details" and an explicit "You have not been charged yet."

---

## 4. Proposed information architecture (five steps)

Mapping the brief's target flow onto what the code can truthfully support today.

```
┌─ Step 1 · Who is the hero ────────────────────────────────────────┐
│ Hero type: [Child ✓ available now]                                │
│            [Parent · Coming soon] [Grandparent · Coming soon]     │
│              ↑ rendered, visibly disabled, NOT selectable         │
│ Hero name*                       Age (optional)                   │
└───────────────────────────────────────────────────────────────────┘
┌─ Step 2 · The story ──────────────────────────────────────────────┐
│ Direction*: [Custom Story] | [6 template cards]  (radiogroup)     │
│ if Custom  → voice note / typed memory (gated on STORY_UPLOAD)    │
│ Occasion (opt) → reveals Gift message (opt, 200 char)             │
│ Lesson (opt) · custom lesson (opt)                                │
│ Who the book is for (opt) · relationship (opt)                    │
└───────────────────────────────────────────────────────────────────┘
┌─ Step 3 · Photos ─────────────────────────────────────────────────┐
│ Requirements stated BEFORE the picker: JPG/PNG/WebP, ≤12 MB       │
│ Hero photo (optional) → validate on select → preview + who/where  │
│ Guided angles (optional, flag-gated)                              │
│ No photo? → written appearance description (required)  ← same gate│
│ People & pets (0–4) — each: name + (photo OR description)         │
└───────────────────────────────────────────────────────────────────┘
┌─ Step 4 · Format ─────────────────────────────────────────────────┐
│ 3 tier cards, truthful comparison table                           │
│ Digital: "Most flexible" (attribute claim — keeps)                │
│ NO popularity badge on any tier unless D-02 supplies evidence     │
└───────────────────────────────────────────────────────────────────┘
┌─ Step 5 · Pay ────────────────────────────────────────────────────┐
│ Persistent order summary (sticky on mobile too)                   │
│ Email* · promo-code location note · risk-reversal copy (D-01)     │
│ ONE primary CTA: "Continue to secure payment — $NN"               │
└───────────────────────────────────────────────────────────────────┘
```

**Deliberate divergences from the brief, with reasons:**

1. **Photos absorbs "people and pets."** The brief's Step 3 is "Photos". Today
   supporting characters live in their own step (`people`) and carry their own
   photo+description gate identical to the hero's
   (`checkout-progressive.ts:139-157`). Splitting photos from the people who
   need them would mean two steps that each half-satisfy the same server
   validation (`route.ts:278-289`). Keeping them together is the only mapping
   that preserves the existing gate 1:1.
2. **Format moves after Photos.** Today format sits with email in `review`
   (`:2315-2389`). The brief's order (Format = 4, Pay = 5) is better: it lets Step 5
   be nothing but summary + email + pay, which is what makes a single primary
   CTA possible (F-11).
3. **`heroType` selector must render even when the beta flag is off.** Today the
   whole block is hidden unless `NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA === 'true'`
   (`:132`, `:1387`), and the fallback is a paragraph saying "Adult-led hero
   stories are coming soon" (`:1383-1386`). The brief explicitly wants the
   unavailable types **visibly marked "Coming soon" and not competing for
   selection**. Note the server refuses non-child heroes regardless
   (`route.ts:303-309`), so rendering them as disabled is safe and honest.
   The current helper text `"Available by review only"` (`:135-136`) must **not**
   be shown while the flag is off — it implies a path a buyer cannot take.

---

## 5. Mobile wireflow

```
 ┌──────────────────────┐   sticky, 48px:  ◀ Back   Step 2 of 5   [chips]
 │ HeroStoryBooks   🔒  │   chips: ● ● ○ ○ ○  (done / current / locked)
 ├──────────────────────┤
 │  Step content        │   one step visible; others display:none
 │  (single column)     │   inline error text under each invalid field
 │                      │
 │  ...                 │
 ├──────────────────────┤
 │ ▸ Order summary  $19 │   collapsed accordion, ALWAYS present from Step 4
 │   [ Continue → ]     │   sticky bottom bar, ONE primary CTA
 └──────────────────────┘
```

Rules the wireflow encodes:

- Exactly **one** primary CTA visible at any time (fixes F-11). Header
  "Continue" is removed; the sticky bottom bar is the only forward action, and
  its label becomes "Continue to secure payment — $NN" on Step 5.
- The order summary becomes a collapsed sticky accordion on `< lg`, expanded
  sidebar on `≥ lg` (fixes F-06). It is populated from Step 4 onward; before a
  format is chosen it shows "Choose a format" rather than "—".
- Back is an explicit in-page control **and** a `history.pushState` entry per
  step, so the phone's system Back button moves one step back instead of
  leaving checkout (see §6).
- Touch targets ≥ 44×44. Today the step chips are `px-3 py-1.5` (`:1083`) —
  ~28px tall, below the minimum.

---

## 6. State-persistence and back-navigation design

### 6.1 What is persisted today

| Field group | localStorage (`hsb_order_v1`, 7-day TTL) | sessionStorage | In memory only |
|---|---|---|---|
| theme, names, age, recipient, lesson, occasion, gift message, notes, custom memory, mustInclude, bookFormat, email | ✅ `:281-315` | — | — |
| `familyCharacters` incl. `photoDataUrl` | ⚠️ **yes — see F-03/F-04** | — | — |
| Hero `photoFile` / `photoDataUrl` | ❌ | — | ✅ lost on reload |
| `voiceFile` / `voicePreviewUrl` / `voiceConsent` | ❌ | — | ✅ lost on reload |
| `guidedFrames` / `guidedConsent` | ❌ | — | ✅ lost on reload |
| `checkoutAttemptId` | — | ✅ `hsb-checkout-attempt-id` `:848-854` | — |
| NamePreview hand-off | — | ✅ `hsb_name_preview_handoff` `:328` | — |
| Current step | ❌ | ❌ | ✅ **lost on every reload** |

### 6.2 Proposed design

1. **Never persist binary payloads.** Strip `photoFile`, `photoDataUrl`,
   `voiceFile`, `voicePreviewUrl` and every supporting-character equivalent
   **at the serializer**, and mark the character `photoPendingReattach: true`.
   On restore, render "Re-attach {name}'s photo" instead of "Added". This is
   the minimal fix for F-03 **and** F-04 together, and it makes the stored
   record small enough that quota is no longer reachable.
2. **Persist `currentStepId`** alongside the form, clamped on restore by
   `canNavigateToCheckoutStep` so a stale step id cannot skip a gate.
3. **One history entry per step.** `history.pushState({step}, '', '?step=photos')`
   on forward navigation, `popstate` → `setCurrentStepId`. The system Back
   button then walks the wizard; Back from Step 1 leaves checkout, which is
   correct. Uses `?step=` only — never a customer value (the existing
   `childName`-out-of-URL discipline at `:325-341` must be preserved).
4. **Do not clear `localStorage` before payment is confirmed** (fixes F-02).
   Move `localStorage.removeItem(STORAGE_KEY)` off the pre-redirect path
   (`:986`) and onto the thank-you page, gated on server-confirmed
   `paymentStatus === 'paid'` (`thank-you/page.tsx:49`).
5. **Make `cancel_url` state-preserving.** `cancel_url: \`${baseUrl}/checkout?resume=1\``
   and reuse the existing `checkoutAttemptId` from `sessionStorage` on resume,
   so a cancel-and-retry rebinds the **same** draft order id
   (`route.ts:388`) instead of orphaning one. Server-side this is already
   supported: `persistOrResumeCheckoutOrder` + the open-session replay branch at
   `route.ts:405-416` returns the existing session URL. **This is the one item
   that touches the payment path; it is isolated into its own slice (PR-6) so
   it can be held if it collides with the incident fix.**

---

## 7. Accessibility and validation plan

### 7.1 Accessibility

| Item | Today | Target | Fixes |
|---|---|---|---|
| Single-select groups | plain buttons | `role="radiogroup"` + `role="radio"` + `aria-checked`, roving tabindex, ←/→ | F-10 |
| Multi-select chips | `aria-pressed` ✅ | unchanged — this is the reference pattern | — |
| Field errors | border colour only | `aria-invalid`, `aria-describedby` → visible `<p id role="alert">` | F-08 |
| Multiple errors | one key only | full `Record<field, message>`, cleared per-field on change | F-08 |
| Photo drop zone | `<div onClick>` | `<button>` wrapping the input, or `<label>` like its sibling | F-09 |
| Step chips | `disabled`, ~28px, no group role | `<nav aria-label="Checkout steps"><ol>`, `aria-current="step"`, ≥44px, `aria-disabled` + explanatory text instead of bare `disabled` | §5 |
| Headings | two `<h1>` (`:1059`, `:2431`) | one `<h1>` per page; summary heading → `<h2>` | F-12 adjacent |
| Step change | silent | `aria-live="polite"` region announcing "Step 3 of 5, Photos" | F-17 |
| Progress | dead `Progress` import | either render it with a correct denominator or delete the import + `CHECKOUT_STEPS` + `progressValue` | F-12 |
| Reduced motion | `framer-motion` unconditional (`:1191`, `:1616`) | honour `prefers-reduced-motion` | — |

### 7.2 Validation timing

| Field | Validate when | Message |
|---|---|---|
| Hero name | on blur + on Continue | "Add the hero's name so we know who the book stars." |
| Story direction | on Continue | "Choose a story direction to continue." |
| Photo file | **on select, before preview** — extension + MIME + size against the *server's* contract (`ALLOWED_PHOTO_MIME_TYPES`, 12 MB) | "We can use JPG, PNG, or WebP. This looks like a {x} — please pick another." (fixes F-14) |
| Appearance description | on blur, only when no photo | "Describe the hero so we can illustrate them without a photo." |
| Supporting character | on Save person (already correct, `checkout-progressive.ts:139-157`) | unchanged |
| Format | on Continue | "Pick a format to see your total." |
| Email | on blur **with the same regex `isReadyToPay` uses** | "That email doesn't look right — we send your proof there." (fixes F-07) |
| Voice consent | on Continue when a voice file exists | unchanged (`checkout-progressive.ts:284`) |

**Non-negotiable:** `isReadyToPay`, `getCheckoutPaymentBlockers`, and the
server's `missingRequiredField` (`src/lib/checkout-flow.ts:68-76`) must be
driven by **one** predicate set. Today they are three near-copies that already
disagree (F-07). The regression test for this is T-4 in §9.

---

## 8. Risk and collision analysis

### 8.1 vs PR #158 (DRAFT, head `9ae155f`) — analytics / consent / UTM

Verified by `git diff edf23f8...9ae155f`. #158 touches exactly two checkout
files, both in the **submit path**:

| PR #158 hunk | Location | Collision with wizard work |
|---|---|---|
| `import { attributionMetadata, currentAttribution }` | `checkout-form.tsx` imports, ~`:27` | **Low** — import block only |
| `for (const [k,v] of Object.entries(attributionMetadata(currentAttribution()))) payload.set(k,v)` | `checkout-form.tsx` `handleSubmit`, inserted at ~`:942` (current `:938-946`) | **HIGH** — any slice that rewrites `handleSubmit` conflicts textually |
| `validateUtmTuple` + `ungovernedCampaignKey([...form.keys()])` | `api/order/route.ts` ~`:155-176` | **Semantic, not textual** — see below |
| `campaignAttribution` into `createOrderRecord` + Stripe `metadata` | `route.ts` ~`:414`, `:690` | **Low** — no wizard slice touches these |

**Semantic hazard S-1 (must be respected, do not "fix"):** #158 rejects the
*whole* attribution tuple if the POST carries any ungoverned campaign key.
`REJECTED_COMPANION_KEYS = ['ref', 'referrer']`
(`attribution-session.ts:170`) and any non-allowlisted `utm_*` key
(`:211-221`). **If a wizard slice ever adds a form field literally named `ref`
or `utm_*`, it silently disqualifies campaign attribution for every order.**
Today's checkout is safe because the referral code is posted as `referralCode`
(`checkout-form.tsx:935`), not `ref`. Any new field name must be checked
against that list.

**Observation (for #158's owner, not this audit's to change):** HSB's own
referral links use `?ref=` (`checkoutReferralCode()`, `checkout-form.tsx:378-388`,
plus the `hsb_ref` cookie). Under #158's landing-boundary rule
(`governedCampaignFromSearch`, `attribution-session.ts:234-260`), a visit
arriving on `?ref=alexy&utm_source=…` has its **entire** UTM tuple rejected as
`legacy_companion_key`. That is a deliberate design decision in #158, but it
means referral traffic and campaign traffic are mutually exclusive for
attribution. Flagged, not actioned.

**Sequencing recommendation:** land the wizard's submit-path slice (PR-5)
**after** #158 merges, or rebase PR-5 onto #158's head. Slices PR-1 through
PR-4 and PR-7 do not touch `handleSubmit` and can proceed in parallel.

### 8.2 vs merged PR #157 (`edf23f8`) — private-capable Family Review blob storage

`#157` is confined to `src/app/api/family-review/**`,
`src/app/family-review/**`, and the Family Review blob helpers. **No overlap**
with `/checkout`, `/api/order`, or the order blob prefix
(`orders/<id>/…`, `src/lib/orders.ts:772-790`). Checkout media access mode is
still governed independently by `getBlobAccessMode()`
(`src/lib/orders.ts:785-790`), which **defaults to `'public'`** because the
production store rejects private writes. Order photos therefore remain
unguessable-but-unauthenticated URLs. That is a pre-existing condition, out of
scope here, and specifically *not* changed by #157.

### 8.3 vs other open branches

| PR | Risk | Note |
|---|---|---|
| #79 DRAFT "Harden HSB checkout readiness and status honesty" | **HIGH — duplicate intent** | Stale since 2026-06-27, predates PR #137's progressive model. Should be closed or explicitly rebased before wizard work starts, or two branches will fight over the same file. |
| #82 OPEN "Harden checkout fulfillment recovery gates" | Medium | Touches `fulfillment.ts` recovery, not checkout UI. Stale since 2026-07-02. |
| #81 OPEN digital→print upgrade | Medium | Interacts with `multi_payment_refund_required` (F-01). If it lands, the Step-5 refund copy needs re-review. |
| #122 DRAFT voice filename privacy | Low | Touches voice upload naming only. |
| Live checkout incident (Rex) | **Reserved** | No diagnosis assumed. §1.1 documents the seam. PR-6 is the only slice that could collide and is explicitly held. |

---

## 9. Phased implementation plan — smallest safe PR slices

Each slice is independently revertable, has an explicit RED test gate, and
names its dependency. **None of these are implemented.**

| # | Slice | Files | Test gate | Depends on |
|---|---|---|---|---|
| **PR-1** | **Truthfulness first.** Step-5 risk-reversal copy + delete the unsupported FAQ refund promise. No structural change. | `src/lib/checkout-flow.ts` (new `RISK_REVERSAL_COPY`), `checkout-form.tsx` (render), `src/components/faq-section.tsx:30` | **T-1:** assert the checkout risk-reversal string contains no "refund" claim for `digital`; assert FAQ and `terms/page.tsx:25` make no mutually contradictory refund statement; assert no surface says "one-click", "instant refund", or "30 days" | **D-01 ruling** |
| **PR-2** | **State-persistence fix.** Strip binaries from `saveProgress`; add `photoPendingReattach`; persist `currentStepId`. | `checkout-form.tsx:277-360`, `src/lib/checkout-progressive.ts` | **T-2:** round-trip a character with a `File` through save/load and assert `photoFile === null` and the summary renders "Re-attach", not "Added"; assert serialized payload < 64 KB with 4 characters | none — **land first, it is the highest-severity self-contained fix (F-03/F-04)** |
| **PR-3** | **Validation unification.** One predicate set behind `isReadyToPay` / blockers / server; email regex everywhere. | `src/lib/checkout-flow.ts`, `src/lib/checkout-progressive.ts`, `checkout-form.tsx:689-705` | **T-3:** property test — for a matrix of form states, `isReadyToPay === (getCheckoutPaymentBlockers().length === 0)` and both agree with `missingRequiredField`. **T-4:** `email:"abc"` ⇒ CTA disabled | none |
| **PR-4** | **Accessibility pass.** radiogroups, `aria-invalid`/`aria-describedby` + visible messages, keyboard-reachable drop zone, single `<h1>`, 44px targets, live step announcement. | `checkout-form.tsx` (markup only) | **T-5:** axe-core clean on each step (new `tests/e2e/checkout-a11y.spec.ts`, desktop + `mobile-chromium`); **T-6:** keyboard-only traversal reaches both photo controls | PR-3 (error messages need the unified predicate) |
| **PR-5** | **Five-step IA.** Re-partition sections into hero / story / photos / format / pay; delete dead `CHECKOUT_STEPS`, `progressValue`, `Progress` import; one primary CTA; `history.pushState` per step. | `checkout-form.tsx`, `src/lib/checkout-progressive.ts` | **T-7:** step-machine unit tests for the new 5 ids incl. forward-gating; **T-8:** e2e — Back button walks steps and does not leave checkout; **T-9:** exactly one enabled primary CTA per step | PR-2, PR-3, PR-4, **and PR #158 merged or rebased** |
| **PR-6** | **Cancel-resume.** `cancel_url` → `?resume=1`; stop clearing `localStorage` pre-payment; reuse `checkoutAttemptId`; clear on confirmed-paid thank-you. | `checkout-form.tsx:985-991`, `src/app/api/order/route.ts:681`, `src/app/thank-you/page.tsx` | **T-10:** assert `localStorage` survives a simulated cancel-return and the same `checkoutAttemptId` yields the same `ord_` id; **T-11:** assert storage IS cleared when `paymentStatus === 'paid'` | **HELD** pending Rex incident diagnosis — this is the only slice inside the payment seam |
| **PR-7** | **Upload-time photo feedback.** Client-side MIME/extension/size validation on select, aligned to the server contract; raise the client shrink ceiling toward the 12 MB server limit. | `checkout-form.tsx:751-818`, `src/lib/photo-upload.ts` | **T-12:** selecting a GIF/HEIC surfaces an inline error and no preview; **T-13:** a 6 MB JPEG is accepted (currently refused client-side) | none |
| **PR-8** | **Format step truth.** Comparison table; drop any popularity badge lacking evidence; reconcile `Digital PDF` vs `Digital proof`. | `checkout-form.tsx:93-125`, `src/lib/pricing.ts` (or delete it + `pricing-section.tsx` as dead) | **T-14:** assert every checkout badge string maps to a documented product attribute, not a popularity claim; assert format labels match `FORMAT_META` | **D-02 ruling** |

**Suggested order:** PR-2 → PR-3 → PR-7 → PR-4 → (await #158) → PR-5 → PR-8 → (await Rex) → PR-6.

**Do not batch.** PR-2 and PR-3 alone remove two S1 defects and are worth
shipping before any visual restructuring.

---

## 10. Unknowns requiring live or operator evidence

| # | Unknown | Why it cannot be settled from source | Who decides |
|---|---|---|---|
| **U-01** | The "PR #117 findings" referenced in the brief do not exist in this repo (§0). | `gh pr view 117` returns an SEO PR with no checkout content. | Requester |
| **U-02** | Is a **digital** refund ever actually granted, and by what mechanism? | `refundOrder()` cannot execute one after `fulfillmentStatus:'complete'` (F-01). Any that happen are Stripe-dashboard-manual and invisible to this repo. | Alexy / Ops |
| **U-03** | Real operator behavior on the printed-book refund window. | Code allows it only at `proof_ready`. Whether Ops honors requests during `generating_*` is not observable in source. | Ops |
| **U-04** | Substantiation for "Most loved" on the homepage Digital tier (F-15). | No sales-mix constant, analytics export, or decision record in the repo. | Alexy |
| **U-05** | Mobile abandonment rate by step. | `track()` fires `begin_checkout`, `story_selected`, `format_selected`, `order_submit_attempt`, `purchase_intent` (`checkout-form.tsx:461`, `:1188`, `:2340`, `:838-839`) but there is **no per-step view event**, so step-level drop-off is unmeasurable today. PR-5 should add one. | Analytics (post-#158) |
| **U-06** | iOS HEIC behavior at the picker. | `accept` (`:156`) excludes HEIC; iOS *usually* transcodes to JPEG on selection, but this is device/OS-version dependent and untestable from source. | Live device test |
| **U-07** | Whether `?ref=` referral links are actively in use in market. | Would determine how much traffic #158's `legacy_companion_key` rejection actually costs (§8.1). | Alexy / Marketing |
| **U-08** | Live checkout incident cause. | **Deliberately not investigated.** No Rex evidence packet was supplied with this task. | Rex |
| **U-09** | Whether `/order` (F-13) should redirect to `/checkout` or 410. | Product decision; it is a live route with no owner in the current IA. | Alexy |

## 11. Decisions blocking implementation

- **D-01 — Step 5 risk-reversal copy (blocks PR-1).** The draft in F-01 is
  written to be defensible against the code as it stands. It still needs an
  Alexy/legal ruling because it (a) promises a pre-approval refund for printed
  books that the tool only supports during `proof_ready`, and (b) declines to
  promise anything for Digital. Both are policy calls, not engineering calls.
- **D-02 — Recommended-tier badge (blocks PR-8).** Keep "Most flexible"
  (attribute) and drop "Most loved" (popularity) from anything the wizard
  renders, unless evidence is supplied for U-04.
- **D-03 — FAQ vs Terms refund conflict.** `faq-section.tsx:30` and
  `terms/page.tsx:25` currently disagree in public. PR-1 proposes changing the
  FAQ; if the FAQ is the intended policy, Terms and `public-catalog.ts:189-192`
  must change instead. Someone must pick one.

---

## 12. Verification — exact commands and results

All commands run in the isolated worktree
`/Users/abigailclaw/cc-worktrees/hsb-checkout-ux-audit-20260827` at `edf23f8`.

```
$ git worktree add -b cc/hsb-checkout-ux-audit-20260827 <path> edf23f8
  HEAD is now at edf23f8 feat(hsb): private-capable Family Review asset storage + dry-run migration (#157)

$ npm ci --no-audit --no-fund
  added 247 packages in 48s

$ npm test          # node --experimental-strip-types --test tests/*.test.ts
  tests 1765 | pass 1765 | fail 0 | duration_ms 118322

$ node --experimental-strip-types --test \
    tests/checkout-progressive.test.ts tests/checkout-flow.test.ts \
    tests/order-status-view.test.ts tests/checkout-promo-code-copy.test.ts \
    tests/order-route-required-fields.test.ts tests/checkout-photo-policy.test.ts \
    tests/checkout-capacity-and-processing-expectations.test.ts \
    tests/order-status-processing-note-states.test.ts tests/checkout-design-layout.test.ts
  tests 92 | pass 92 | fail 0

$ grep -rn "checkout.sessions.create" --include="*.ts" --include="*.tsx" src/ scripts/
  src/app/api/order/route.ts:652

$ grep -n "aria-" src/app/checkout/checkout-form.tsx
  1046 aria-hidden | 1082 aria-current | 1718 aria-pressed | 1867 aria-pressed
  2284 aria-expanded | 2659 aria-live        (6 total in 2701 lines)

$ grep -n "progressValue\|<Progress" src/app/checkout/checkout-form.tsx
  705 (definition only — zero render sites)

$ gh pr view 117 --json number,title,state
  117 MERGED "fix: harden public indexing surfaces"     ← §0 mismatch

$ git diff edf23f8...9ae155f -- src/app/checkout/checkout-form.tsx src/app/api/order/route.ts
  2 files, +46 −0   (collision surface for §8.1)

$ node -e "<File JSON round-trip + FormData coercion probe>"
  photoFile after round-trip = {}   truthy? true
  FormData coerced value = "[object Object]"  instanceof File? false      ← F-03
```

**Not run, and why:** `npm run lint` — a known baseline blocker documented in
PR #117's own body (ESLint 9 installed with no `eslint.config.*` on `main`);
this audit changes no lint config. `npm run test:e2e` — boots a Next production
server; not required to substantiate any finding above, and every proposed e2e
gate (T-5, T-6, T-8, T-9, T-12) is specified as new work in §9. `next build` —
no source change to validate.

**Scope-drift and safety inspection.** Changed files on this branch are
documentation only (`docs/reviews/*.md`). No `src/`, `tests/`, config, or
environment file was modified. No order, session, payment, refund, upload,
proof, or fulfillment call was made; no Preview or Production data was read or
written. Output was inspected for secrets, credentials, PII, and customer or
order data: none appear — the only order identifier referenced is the format of
the derived id (`ord_<16 hex>`), no real order id, customer name, or email is
reproduced anywhere in this document, and F-16 is described without quoting a
real URL.
