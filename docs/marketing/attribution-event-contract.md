# HSB attribution and event contract — v1.0.0

**Status:** candidate, under review. **Owner:** Alexy. **Date:** 2026-08-26.
**Code:** `src/lib/marketing/utm-contract.ts`, `src/lib/marketing/event-contract.ts`,
`src/lib/marketing/route-sanitizer.ts`.
**Tests:** `tests/marketing-utm-contract.test.ts`,
`tests/marketing-meta-pixel.test.ts`,
`tests/marketing-attribution-preservation.test.ts`.

This document and that code are the same contract. Where they disagree, the code is
wrong and must be fixed — the tests assert the code against the statements here.


---

# 0. CURRENT TRUTH (authoritative)

**This section describes the code at the branch head. Where anything later in
this document disagrees, this section wins.** Sections 1–5 and 8 remain accurate.
Sections 6, 7, and 9 are marked superseded in place. The three dated
"correction pass" appendices at the foot are history, retained so the reversals
are legible, not instructions.

## 0.1 Consent

One shared, reactive consent surface governs **browser GA4, Vercel Analytics,
and Meta together** — `src/lib/marketing/consent-store.ts` plus
`consent-surface.tsx`. There is no second mechanism.

- Default is `unknown`; `unknown` enables nothing. **Nothing is stored at all
  until the visitor chooses**, so a visitor who never answers leaves no record.
- **None of the three loads or emits before a grant.** GA4's script tags and
  Vercel's `<Analytics />` are not *rendered* until consent is granted; the Meta
  pixel neither loads nor initialises.
- **Google Consent Mode denied-before-config is NOT the mechanism.** It was
  tried and rejected: a denied Consent Mode still loads Google's library and
  still sends cookieless pings. There is no `gtag('consent','default')` call in
  this codebase.
- Accept and decline share one style object, so neither can be made quieter than
  the other. No pre-checked consent, no fingerprinting, no cross-site identifier.
- "Cookie choices" re-opens the banner and **withdraws** the stored choice
  first, so measurement is off while the decision is reconsidered.
- Essential behaviour is never gated: the order route, the Stripe webhook, and
  `ga4-purchase.ts` contain no reference to the consent store.

## 0.2 GA readiness coordination

Consent grant and `window.gtag` becoming callable are two different moments.
`src/lib/marketing/analytics-coordinator.ts` closes the gap with an explicit
readiness contract — no sleeps, no polling:

| Transition | Behaviour |
|---|---|
| Grant before script ready | queues **only the current sanitized route**; no GA call |
| Readiness (`markGtagReady`, from the GA4 inline script's own `onReady`) | delivers that route **exactly once** |
| Route changed before readiness | delivers **only the latest** route; never a backlog |
| Repeat readiness / remount / StrictMode / repeat consent notification | no duplicate initialisation, no duplicate PageView |
| Decline or withdrawal before readiness | pending delivery **cancelled** |
| Withdrawal after grant | no further calls to GA4, Vercel, or Meta |
| Re-grant later | **exactly one** current-route PageView |

The emitter is the authority on whether delivery is possible, because only it
can see `gtag`; `markReady` is the retry trigger, not the permission. The
delivered-route latch moves **only** on a truthful success — a route is never
marked delivered because an unavailable adapter was called.

Meta and Vercel keep their own single lifecycle and are deliberately not routed
through the coordinator: Meta's controller already orders config → consent →
route latch, and Vercel's `<Analytics />` performs its own page view.

## 0.3 Governed attribution — IMPLEMENTED, not designed

Built end to end and covered by tests:

landing capture → validate → bounded first-party record (first-touch, 30-day
expiry) → client navigation → checkout POST → **server re-validation** →
`order.campaignAttribution` → **Stripe metadata only**, never a customer-visible
field → recovered from the **signature-verified** session → validated a third
time → GA4 reserved `campaign_*` parameters on the trusted purchase.

**Whole-tuple rejection** applies — the tuple is discarded entirely, never
stripped and partially accepted:

| Condition | Reason code |
|---|---|
| any `utm_*` outside the governed four (incl. `utm_term`) | `ungoverned_utm_key` |
| `ref` / `referrer` | `legacy_companion_key` |
| a repeated governed key | `duplicate_key` |
| malformed percent-encoding | `malformed_encoding` |
| invalid value (medium not allowlisted, over 40 chars, bad token shape, PII-shaped) | per-field reason from `validateUtmTuple` |
| partial tuple (missing source, medium, or campaign) | per-field reason |

Approved platform click identifiers (`fbclid`, `gclid`, `msclkid`, `ttclid`,
`twclid`) **may coexist** with a governed tuple without rejecting it — platforms
append them automatically — and are **never read, stored, or forwarded**.

The same check runs at landing capture and at the checkout POST through one
shared helper, so the two boundaries cannot drift.

## 0.4 Purchase ownership

**Purchase is owned only by the signature-verified, post-convergence Stripe
webhook**, sent to GA4 via the Measurement Protocol and deduplicated on the
Stripe **Checkout Session id**. A browser `Purchase` is **prohibited by
contract**. There is no second purchase path.

## 0.5 Meta CAPI — DEFERRED, no send path

There is **no send path**: no `fetch`, no endpoint, no payload builder, no
scheduler, and no call site. The Stripe webhook does not reference Meta at all.
Setting `META_CAPI_ENABLED`, `META_CAPI_DATASET_ID`, and
`META_CAPI_ACCESS_TOKEN` changes nothing, and `metaCapiStatus()` reads no
environment.

The reason is structural, not configuration: Meta requires `user_data` with at
least one matching parameter on every server event, and **no approved
privacy-safe matching contract exists** — there is no server-side consent
evidence at the webhook, no privacy approval for customer matching, and no
`fbp`/`fbc` because the pixel is inert.

## 0.6 Preview analytics validation — fail-closed

GA4 and Vercel are production-only, so ordinary Preview cannot exercise the real
lifecycle. `resolveAnalyticsMode` adds a fail-closed switch requiring **both**
documented Preview-only variables (names only; nothing configured):

```
NEXT_PUBLIC_HSB_ANALYTICS_PREVIEW_VALIDATION
NEXT_PUBLIC_HSB_PREVIEW_GA_MEASUREMENT_ID
```

It cannot override consent, cannot operate outside `VERCEL_ENV=preview`, and
cannot use the Production property — a missing, malformed, or
Production-colliding preview id **disables** the mode rather than falling back.

## 0.8 Interaction with the Family Review private-Blob work (PR #157)

Merged from `origin/main` and inspected. **No file, route, environment
variable, or test is touched by both.** #158 changes nothing under
`/family-review` or in Blob storage; #157 changes nothing in analytics, consent,
or attribution. Env namespaces are disjoint (`FAMILY_REVIEW_*` / `BLOB_*` versus
`META_*` / `NEXT_PUBLIC_HSB_*`).

Two deliberate interactions, both verified:

1. **The consent surface renders on family-review pages too.** It is inline-styled
   React with no external resource, so it satisfies that lane's
   `default-src 'self'` CSP, and it reserves its own height so it cannot cover
   page content.
2. **GA4 is not route-gated the way the Meta pixel is.** On a granted consent the
   GA4 script tag is rendered site-wide, including under `/family-review/*`,
   where #157's middleware CSP is self-only and therefore **blocks the request**.
   That is fail-closed and is asserted by the `family-review CSP still forbids
   third-party scripts` Chromium spec.

   This is not a regression introduced by #158 — before this branch GA4 loaded
   *unconditionally* in production on every page including that lane, with no
   consent required at all. #158 strictly narrows it. **Recommended follow-up,
   not done here:** give GA4 the same route allowlist the Meta pixel already has,
   so a private family page attempts no third-party request even for a visitor
   who granted consent elsewhere. Out of scope for a docs/base-sync pass.

## 0.7 Reporting caveat

Consent enforcement **reduces reported GA4 browser volume** by however many
visitors decline or never answer. **Purchases are unaffected** — they come from
the server. A conversion rate computed as purchases ÷ browser sessions therefore
mixes a server numerator with a consent-suppressed denominator and reads high.
Use **absolute trusted purchases per campaign**, and do not compare rates against
pre-consent baselines.

---

## 1. Governed UTM fields

Four fields, and only four.

| Field | Required | Rule |
|---|---|---|
| `utm_source` | yes | token |
| `utm_medium` | yes | token **and** in the closed vocabulary below |
| `utm_campaign` | yes | token |
| `utm_content` | no | token — the partner / creative discriminator |

**Token rule:** lowercase, `^[a-z0-9][a-z0-9_-]{0,39}$`, at most 40 characters.
Deliberately the same shape `src/lib/checkout-tracking.ts` already enforces for
`cohort` and `invite`, so operators learn one rule.

**Closed `utm_medium` vocabulary.** A medium says how a visit was paid for and who is
accountable, which is not a per-link decision:

`partner` · `flyer` · `email` · `organic_social` · `paid_social` · `referral`

`paid_social` is the only paid medium. A board row using it must carry a positive
spend cap, and may not reach a public status without both a `paid_spend` and an
`account_connection` approval.

**Deliberately excluded.** `utm_term` (HSB runs no paid search) and `ref` (no referral
programme owns it). Both are captured by today's `src/lib/analytics.ts`; neither is
governed, and neither may appear in a board row.

**Values are never coerced.** `School Pilot A` is rejected, not silently turned into
`school-pilot-a`. A coerced value changes which experiment a visit is attributed to.

**PII rejection.** Beyond the token shape, a value is rejected when it looks like a
person or an internal identifier: a mailbox provider (`gmail`, `yahoo`, …), an
`-at-`/`_at_` mangling, seven or more consecutive digits, sixteen or more hex
characters, a Stripe/HSB id prefix (`cs_`, `pi_`, `ord_`, …), or a token/secret word.

**Collision.** `(source, medium, campaign, content)` is the identity of an
experiment. Two board rows sharing it are rejected, because GA4 cannot tell them
apart.

**Bounds.** 40 characters per value. Long enough to be a label, short enough that a
name or address does not fit.

---

## 2. Canonical business events

The canonical stage names are `page_view`, `view_product`, `begin_checkout`, and
`purchase`. They are semantic; they do not rename anything live.

| Stage | GA4 today | Meta browser | Meta server | Reddit (design only) | Owner | Dedupe key |
|---|---|---|---|---|---|---|
| `page_view` | `page_view` | `PageView` | — | `PageVisit` | browser | sanitised template route per navigation |
| `view_product` | — | — | — | — | — | not emitted |
| `begin_checkout` | `begin_checkout` | `InitiateCheckout` | — | `AddToCart` | browser | one per checkout mount |
| `purchase` | `purchase` | **prohibited** | `Purchase` | `Purchase` | Stripe webhook | Stripe Session id → GA4 `transaction_id`, Meta hashed `event_id` |

### Why `view_product` is empty

No live surface fires a discrete product-view event. The nearest existing emission is
`cover_variant_shown` (`src/components/CoverPreview.tsx`), which is an A/B variant
impression. Mapping `ViewContent` onto it would report an experiment artefact as
shopping intent. `ViewContent` stays on the allowlist and unmapped until a real
product-view surface exists.

### Why the browser cannot emit `Purchase`

`src/lib/ga4-purchase.ts` already emits purchase from the signed Stripe webhook after
the durable payment write. A browser purchase would fire on a page the customer can
reload, would not know whether payment converged, and would compete with the
authoritative number. `META_BROWSER_EVENT_ALLOWLIST` therefore contains only
`PageView`, `ViewContent`, and `InitiateCheckout`, and
`META_BROWSER_PROHIBITED_EVENTS` names `Purchase` explicitly so the ban is greppable.

### Event ownership

| Owner | Events | Failure posture |
|---|---|---|
| browser | `page_view`, `begin_checkout` | best effort; blocked by consent, ad blockers, and the route allowlist |
| Stripe webhook | `purchase` | authoritative; deferred past the response, failures swallowed |

---

## 3. Safe parameters

| Meta event | Allowed keys | Allowed values |
|---|---|---|
| `PageView` | none | — |
| `ViewContent` | `content_type`, `content_category` | `product`; `storybook` |
| `InitiateCheckout` | `content_type`, `content_category`, `num_items` | `product`; `storybook`; integer 1–20 |

Both the keys and the values are allowlisted. Bounding only the keys would still
permit `content_category: <child name>`.

The bridge in `src/lib/marketing/meta-bridge.ts` does not forward the live event
record at all — it passes a frozen `{content_type, content_category}` pair. The
controller re-filters that against the contract, so two independent layers have to
fail before anything unexpected reaches Meta.

## 4. Blocked data — never sent to any ad platform

Child, family, or parent names · email addresses · phone numbers · postal addresses ·
photos, voice notes, or any uploaded asset · asset URLs · free text of any kind
(notes, memories, story briefs) · order ids · Stripe session / PaymentIntent /
customer ids · review, proof, or capability tokens · raw or dynamic URLs · IP
addresses · user agents · Advanced Matching fields (`em`, `ph`, `fn`, `ln`, `ge`,
`db`, `ct`, `st`, `zp`, `country`, `external_id`, `fbp`, `fbc`) · any `user_data`
object.

`assertNoBlockedFields` in `event-contract.ts` enforces this structurally on both the
browser and the server payload. It **throws rather than trimming**: a payload that
reaches it carrying a child's name means an upstream caller is wrong, and silently
sending less than intended would hide that.

One deliberate exemption: HSB's purchase dedupe pseudonym, exactly `hsb_` plus 32 hex
characters. It is hex by construction. The exemption is anchored and fixed-length, so
a value that merely *contains* that shape is still rejected.

## 5. Route sanitisation

1. **Strip** the query string and fragment. HSB puts real customer data in both
   (`/thank-you?…childName=…&email=…`, `/checkout?childName=…`).
2. **Template** dynamic segments: `/status/<id>` → `/status/[orderId]`,
   `/family-review/review/<token>` → `/family-review/review/[reviewToken]`.
3. **Allowlist** the result. Only `/`, `/about`, `/samples`, `/gifts`,
   `/gifts/[occasion]`, and `/checkout` produce any Meta behaviour.

Step 3 gates the script load, not just the event. Nothing is requested from a
third party on a route we are not permitted to measure — which is what keeps Meta off
`/family-review/*`, whose middleware CSP is `default-src 'self'`.

`/thank-you` is excluded on purpose: it is purchase-adjacent, purchase is server-only,
and its query string carries an email, a child's name, and a Stripe session id.

## 6. Event ID lifecycle and dedupe rules — ⚠️ SUPERSEDED (see §0.4, §0.5)

> **The Meta CAPI row below is no longer true.** CAPI is deferred and has no
> send path, so no `event_id` is derived, sent, or deduplicated — nothing owns
> that lifecycle today. The GA4 row remains exactly correct. Retained for the
> future contract's sake only.

| Platform | Dedupe value | Lifetime |
|---|---|---|
| GA4 (server) | `transaction_id` = Stripe Checkout Session id | permanent; stable across every webhook replay |
| Meta CAPI | `event_id` = `hsb_` + first 32 hex of `SHA-256("hsb:meta:purchase:" + session id)` | permanent and deterministic; the same session always produces the same id |
| Meta browser | none needed | no browser event is deduplicated against a server event, because no browser event overlaps one |

The Meta id is derived, not stored — nothing has to be persisted for a replay six
months later to deduplicate. It is not an HMAC: there is no key to hold, and a
key rotation would break the exact property the value exists to provide.

A second guard refuses a repeated send of the same `event_id` inside one runtime,
which covers the webhook's own replay branch. A **failed** send does not burn the id,
so a later delivery can still report the purchase.

## 7. Consent behaviour — partially superseded (see §0.1)

`resolveConsent()` returns `granted`, `denied`, or `unknown`, and only `granted`
enables an ad platform. Absent, malformed, or throwing signals all resolve to
`unknown`.

> ⚠️ **SUPERSEDED — see §0.1.** The paragraph that stood here said "there is no
> consent surface in this repository" and that GA4's existing posture was
> unchanged. **Both statements are now false.** There is one shared reactive
> consent surface governing browser GA4, Vercel Analytics, and Meta together,
> and none of them loads or emits before a grant. The `resolveConsent()` rule
> above is unchanged and still correct; its source of truth is now
> `consent-store.ts`.

## 8. Retention

HSB stores nothing new. The only new persisted state is the board JSON in this
directory, which contains no customer data. Retention at GA4, Vercel Analytics, and
(if ever activated) Meta is governed by each platform's own settings, which are
operator-console facts and are listed as unverified in
`search-reconciliation-checklist.md`.

## 9. Carrying campaign attribution through checkout — ⚠️ SUPERSEDED: BUILT

> **This section described an unimplemented design and ends with "Not
> implemented in this candidate." That is no longer true — it is implemented.**
> See §0.3 for the shipped contract. Two details differ from the sketch below:
> the first-touch record is a bounded `localStorage` entry (not the old
> `sessionStorage` key, which was removed with the ungoverned path), and the
> tuple is rejected as a whole rather than validated field by field. Retained so
> the design intent and its review are legible.

Today (see `current-state-audit.md` C5) Stripe metadata carries `gaClientId`,
`cohort`, and `invite`, but no campaign fields, so the trusted purchase has no
campaign attribution of its own.

The design, when approved:

1. `parseGovernedUtms()` reads the first-touch set on the checkout page — the same
   `sessionStorage` first-touch key that exists today, validated instead of truncated.
2. Only validated fields are appended to the order `FormData`.
3. `src/app/api/order/route.ts` re-validates server-side and writes them into Stripe
   session metadata as `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` —
   four short tokens, each already proven free of PII by the same contract.
4. The webhook reads them back alongside `gaClientId`.

This exposes no order or customer identifier: the values are campaign labels HSB
minted itself, and the token rule plus the PII rejection is what makes step 3 safe.

**Not implemented in this candidate.** It changes the checkout submit path and the
order route, which is a launch-safety surface, and it deserves its own review rather
than riding along with an ad-platform candidate.

---

# Follow-up: the three independent-review gaps, closed

Reviewed head: `50ee5cd`. This section records what changed to close the three
gaps that review identified, and the decisions taken along the way.

## 1. Governed campaign attribution, end to end

`src/lib/marketing/utm-contract.ts` was already the contract. What was missing
was anything that used it on the path a real visitor takes. The chain is now:

| Hop | What happens | Where |
|---|---|---|
| Landing | `?utm_*` read; **only** the four governed keys are even looked at | `components/marketing/attribution-capture.tsx` |
| Validate | `validateUtmTuple` — allowlisted medium, token shape, 40-char bound, PII rejection | `utm-contract.ts` |
| Persist | one bounded first-party record: the tuple plus a first-touch timestamp | `attribution-session.ts` |
| Navigate | preserved across client navigation; nothing re-read from the URL | `attribution-session.ts` |
| Checkout POST | only the governed four are sent | `checkout/checkout-form.tsx` |
| Re-validate | the server does not trust the client; same contract, again | `api/order/route.ts` |
| Bind | `order.campaignAttribution` on the server-authoritative record | `lib/orders.ts` |
| Stripe | `metadata` only — never a product name, description, or any customer-visible field | `api/order/route.ts` |
| Webhook | recovered from the **signed** session, re-validated a third time | `api/webhooks/stripe/route.ts` |
| Purchase | GA4 reserved `campaign_*` parameters on the trusted purchase | `lib/ga4-purchase.ts` |

**Precedence: first touch wins, for 30 days.** A later valid tuple does not
displace a live first touch; credit belongs to the campaign that introduced the
visitor. Once the stored tuple passes 30 days, the next valid tuple becomes the
new first touch. An invalid, empty, or partial tuple never overwrites, never
extends the window, and never clears storage. Expiry is inclusive at exactly the
boundary. All of it is asserted in `tests/marketing-attribution-session.test.ts`.

**Failure is closed and whole.** A tuple is valid or it is nothing. A partial
tuple is not stored in pieces, an unapproved medium contributes no fields at
all, and an ungoverned key alongside the governed four rejects the *whole*
tuple rather than being silently dropped — so a caller cannot smuggle a
passenger field and keep its campaign.

**Never persisted:** raw URLs, referrers, fragments, `utm_term`, `ref`,
`gclid`, or any other query parameter. Asserted by both a payload test and a
source-level test that the session module never reads `document.referrer`,
`location.href`, `location.pathname`, or `location.hash`.

**Deduplication is unchanged.** Stripe's Checkout Session id remains
`transaction_id`; GA4 deduplicates on it, and three replayed deliveries produce
one transaction id and one identical campaign, so a replay cannot reattribute a
purchase. Browser `Purchase` remains prohibited.

### ~~Known remaining ungoverned surface~~ — SUPERSEDED, the path was removed

> This section described leaving the ungoverned browser campaign reader in
> `src/lib/analytics.ts` in place. **Independent review overruled that, and the
> path was removed entirely** in the second correction pass. `utm_term`, `ref`,
> the `hsb:first-touch-campaign:v1` sessionStorage record, and the 160-character
> raw values are gone; `analytics.ts` reads no query parameter of its own. See
> "Correction, 2026-08-26 (second pass)" and "Final correction (third pass)"
> below. Retained here only so the reversal is legible.

## 2. One reactive consent surface

`consent.ts` previously read a global that nothing ever set, which meant Meta
could never fire — correct, but a placeholder. The real surface is
`src/lib/marketing/consent-store.ts` plus
`src/components/marketing/consent-surface.tsx`.

- **Default is not consent.** No stored choice means `unknown`, and `unknown`
  enables nothing. **Nothing at all is stored until the visitor chooses**, so a
  visitor who never answers leaves no storage behind.
- **Google Consent Mode v2 defaults to denied** (`ad_storage`, `ad_user_data`,
  `ad_personalization`, `analytics_storage`), emitted *before* `gtag('config')`.
  On a grant the surface issues `gtag('consent','update')`.
- **One source of truth.** GA4, Vercel Analytics, and the Meta bridge are all
  gated behind a single `optionalAnalyticsAllowed()` check in `analytics.ts`,
  and a test asserts each destination is unreachable before that gate.
- **Reactive in the current tab.** Subscribers are notified synchronously; a
  grant initialises the adapters with no reload, and the Meta mount re-offers
  the current route. Because the controller latches a route only after it has
  passed every gate, a route skipped for consent emits exactly one PageView on a
  grant, and a route that already emitted one is refused as a duplicate.
- **Revisit and change.** A persistent "Cookie choices" control re-opens the
  banner. Re-opening **withdraws** the stored choice first, so optional
  measurement is off while the decision is being reconsidered.
- **No dark patterns.** Accept and decline share one style object, so neither
  can be made quieter than the other without changing both. No pre-checked
  consent, no fingerprinting, no advanced matching, no cross-site identifier.
- **Essential behaviour is never gated.** Asserted: `api/order/route.ts`,
  `api/webhooks/stripe/route.ts`, and `lib/ga4-purchase.ts` contain no reference
  to the consent store at all.

The stored record is `{"v":1,"c":"granted"|"denied","at":<epoch>}` — the choice
and the date, with nothing that could distinguish one visitor from another.

## 3. Meta CAPI: DEFERRED

**The finding.** The candidate payload sent no `user_data`. Meta's Conversions
API requires `user_data` on every server event, carrying at least one customer
matching parameter. An event without it is not weakly matched; it is rejected or
unattributable. `event_id` exists to deduplicate a server event against a
browser event of the same name, and `event_source_url` describes a page. Neither
identifies a person. **The path could not have worked**, and configuring
credentials would not have changed that.

**The decision.** Defer. The minimum viable matching contract would be a
normalised, hashed purchaser email, optionally with `fbp`/`fbc`. HSB cannot
satisfy that safely today:

1. **No server-side consent evidence.** The consent surface is a browser
   mechanism; the Stripe webhook holds no consent record for the purchaser.
   Hashing is not consent — a hashed email is still personal data disclosed to
   a third party.
2. **No privacy approval** exists for customer matching to an ad platform, and
   the purchaser is a parent buying a product about their child.
3. **`fbp`/`fbc` do not exist here.** They are written by the Pixel, which is
   inert on every deployment and, when it runs at all, only after a grant.

**What was removed:** the entire send path — `fetch`, endpoint, Graph API
version, timeout, payload builder, scheduler, and all three webhook call sites.
The webhook no longer references Meta at all.

**What was retained:** the environment-variable *names*, a `metaCapiStatus()`
that always returns `deferred` with its blockers and **reads no environment at
all**, a type-only `FutureMetaCapiPurchaseContract` naming `user_data` as the
required block, and the explicit never-send list. Tests assert the module
contains no network primitive, that no endpoint/timeout/send symbol is
*declared*, and that setting all three credentials plus the flag cannot change
the status.

**Purchase ownership and `event_id`.** Unchanged and unambiguous: the
signature-verified Stripe webhook is the sole purchase authority, GA4's
Measurement Protocol is its only destination, and browser `Purchase` remains
prohibited. Nothing owns `event_id` today because nothing sends; the seam
records that a future implementation must own it server-side and derive it as a
pseudonym of the Stripe session, never the session id itself.

## Environment variables (names only)

| Name | Scope | Effect today |
|---|---|---|
| `NEXT_PUBLIC_META_PIXEL_ID` | browser | absent -> pixel inert |
| `NEXT_PUBLIC_META_PIXEL_ENABLED` | browser | not `'true'` -> pixel inert |
| `META_CAPI_DATASET_ID` | server | **no effect** — CAPI is deferred |
| `META_CAPI_ACCESS_TOKEN` | server | **no effect** — CAPI is deferred |
| `META_CAPI_ENABLED` | server | **no effect** — CAPI is deferred |
| `GA4_MEASUREMENT_ID` / `GA4_API_SECRET` | server | existing trusted purchase |
| `NEXT_PUBLIC_HSB_ANALYTICS_DEBUG` | browser | existing debug logging |

No credential is configured by this work, and none may be given a
`NEXT_PUBLIC_` prefix beyond the two already public by design.

## Rollout and rollback

**Rollout.** Merging changes no ad-platform behaviour: Meta stays inert (no
pixel id, no flag), and CAPI has no path to enable. What *does* change on merge
is browser-visible and intended: the consent banner appears, Consent Mode
defaults to denied, and GA4 events stop until a visitor accepts. **Expect
reported GA4 event volume to fall**, by however many visitors decline or ignore
the banner. That is the point, not a regression — but it should be announced
before it is observed, or it will read as an outage.

**Rollback.** Two independent levers, neither requiring a data migration:

1. *Consent gating* — revert `optionalAnalyticsAllowed()` in `analytics.ts` and
   the `gtag('consent','default')` block in `layout.tsx`. GA4 returns to its
   previous unconditional posture. The stored choices are inert, not harmful.
2. *Attribution* — revert the `campaign` field on `Ga4PurchaseInput` and the
   `campaignFromSession` call sites. Purchases continue exactly as before; the
   stored tuples and the `order.campaignAttribution` field are additive and
   optional, so no record becomes unreadable.

Neither lever touches payment, fulfilment, or order state.

---

# Correction, 2026-08-26 (second pass)

Independent review rejected two judgement calls from the first pass. Both are
now corrected, and the reasoning is recorded so the reversal is legible.

## Consent Mode was not sufficient

The first pass loaded gtag unconditionally and set Google Consent Mode to
denied. That is not the same as "no optional analytics": a denied Consent Mode
**still loads Google's script and still sends cookieless pings**, so a visitor
who had not chosen — or who had declined — had already had a third-party
request made on their behalf.

Now: GA4's script and Vercel Analytics are **not rendered at all** until consent
is granted, from `src/components/marketing/browser-analytics.tsx`. The
`gtag('consent','default')` block is gone, because relying on it would imply the
script were loaded. Because the decision is made in the browser, the scripts are
`afterInteractive` rather than `beforeInteractive`; the inline stub still runs
before the remote library, so queued `gtag()` calls survive exactly as before.

One honest limit: a script cannot be un-run. If a visitor grants and then
withdraws, Google's library may remain resident for the rest of that page's
life. `analytics.ts` refuses to call it, and a reload yields a page with no
Google script present at all.

## The route latch swallowed the grant

The page-view emitter latched the pathname unconditionally, so a route seen
*before* consent was consumed: granting while standing on that page produced no
page view at all. The latch is now written only after a page view is actually
emitted. The Meta controller already had the correct ordering (consent gate
before latch) and is unchanged.

Behaviour now, asserted with injected adapters and no network:

| Transition | GA4 / Vercel / Meta |
|---|---|
| Land, no choice | nothing loaded, nothing latched, nothing emitted |
| Decline | nothing |
| Grant, same tab, same page | initialise once, **exactly one** PageView for the current route |
| Navigate while granted | **exactly one** PageView per route transition, no re-init |
| Withdraw | nothing further |
| Re-grant later | **exactly one** PageView for the CURRENT route — no backlog of routes visited while declined |

Routes are templated before they leave: `/review/<id>` is reported as
`/review/[orderId]`, and query strings and fragments are stripped, so an order
id, review token, or asset id can never itself be the route.

## The legacy campaign path is gone, not tolerated

The first pass left the ungoverned reader in `analytics.ts` in place, arguing
that governing it would stop attributing links already in circulation that use a
non-allowlisted medium. Review overruled that, correctly: tolerating an
ungoverned path is not a smaller risk than losing attribution on a
badly-formed link.

Removed entirely: `campaignParamKeys`, `campaignSessionKey`,
`campaignParamsFromUrl`, `parseStoredCampaign`, the `hsb:first-touch-campaign:v1`
sessionStorage record, `utm_term`, and `ref`. `analytics.ts` now reads no query
parameter of its own at all. Campaign fields come only from the governed record.

**Consequence, stated plainly:** a live link using `utm_medium=social`, or
carrying `utm_term`/`ref`, now contributes **no** campaign attribution. That is
the intended behaviour — governance is the point — but anyone holding printed or
scheduled links should re-check them against the closed vocabulary
(`partner`, `flyer`, `email`, `organic_social`, `paid_social`, `referral`)
before a campaign starts.

## Consent banner and page layout

The banner is fixed to the foot of the viewport, which means it overlaps
whatever is there. That was not only cosmetic: the complete Chromium suite
caught it making the customer text editor's resize handle unreachable. The
banner now reserves its own height at the foot of the document while visible,
and releases it on dismissal.

---

# Final correction, 2026-08-26 (third pass)

Three review blockers, closed. This section is the current truth; where it
disagrees with anything above, it wins.

## 1. GA4 readiness is coordinated, not assumed

**The bug.** Consent grant and gtag becoming callable are two different moments.
GA4's scripts mount only on a grant and load asynchronously, so the emitter
frequently ran while `window.gtag` did not yet exist — and `analytics.ts` checks
for it before calling. The visitor consented and their first page was never
counted.

**The fix.** An explicit readiness contract, no sleeps:

- `markGtagReady()` is called from the GA4 inline script's own `onReady`, which
  is exactly when `window.gtag` becomes callable.
- `analytics-coordinator.ts` holds **one** pending route — never a queue.
- The **emitter is the authority** on whether delivery is possible, because it
  is the only thing that can see `window.gtag`. The coordinator always asks it;
  asking is safe before readiness because `deliverGa4PageView` performs no GA
  call when GA is absent. `markReady` is the *retry trigger*, not the
  permission.
- The delivered-route latch moves **only** on a truthful `true`. An emitter that
  found no adapter, or threw, leaves the route pending.

| Transition | Result |
|---|---|
| Grant before readiness | queued; **no GA call** |
| Readiness arrives | the pending route delivered **exactly once** |
| Route changed before readiness | **only the latest** route delivered — no backlog |
| Repeated readiness / remount / StrictMode / repeated consent | no duplicate init, no duplicate PageView |
| Decline or withdraw before readiness | pending emission **cancelled** |
| Withdraw after grant | nothing further |
| Re-grant later | **exactly one** current-route PageView |

**Meta and Vercel are deliberately not routed through the coordinator.** Meta's
controller already orders config → consent → route latch correctly and emits one
PageView per route; Vercel's `<Analytics />` does its own page view and mounts
only on a grant, and `page_view` is excluded from the custom-event forwarder.
Adding a second source would be the opposite of the point. Asserted by test.

**Local observability.** Where GA4 never mounts (local, CI, Preview without the
switch), the route is still recorded in the in-memory `window.hsbEvents` buffer
and the emitter reports `false`. The buffer never leaves the tab, carries no
identifier, and is not a measurement destination — writing to it is not
"emitting analytics".

## 2. Whole-tuple rejection, at every boundary

Governed keys are exactly `utm_source`, `utm_medium`, `utm_campaign`,
`utm_content`. The tuple is rejected **entirely** — not stripped and accepted —
when the query carries:

| Condition | Reason code |
|---|---|
| any `utm_*` outside the four (incl. `utm_term`) | `ungoverned_utm_key` |
| a legacy companion (`ref`, `referrer`) | `legacy_companion_key` |
| a repeated governed key | `duplicate_key` |
| malformed percent-encoding | `malformed_encoding` |

Plus the pre-existing value rules: closed medium vocabulary, 40-character bound,
token shape, PII rejection, and `validateUtmTuple`'s own rejection of smuggled
object keys. The same check runs at landing capture **and** at the checkout POST
(`ungovernedCampaignKey` is shared, so the two cannot drift). First-touch and
expiry apply only to a fully valid tuple; a rejected query never displaces a
live or an expired first touch.

### Documented exception: platform click ids

`fbclid`, `gclid`, `msclkid`, `ttclid`, and `twclid` are **not** treated as
campaign companions. They are appended automatically by the platform, not typed
by the link author, so rejecting them would mean a correctly governed partner
link attributes from an email and attributes to **nothing** from a Facebook
share. They are never read, stored, or forwarded. This is a deliberate,
documented assumption; if the owner prefers them rejected, add them to
`REJECTED_COMPANION_KEYS` and one test flips.

## 3. Preview validation switch

GA4 and Vercel are production-only, so ordinary Preview cannot exercise the real
lifecycle. `resolveAnalyticsMode` adds the smallest fail-closed switch:

```
NEXT_PUBLIC_HSB_ANALYTICS_PREVIEW_VALIDATION   'true' to arm; absent = inert
NEXT_PUBLIC_HSB_PREVIEW_GA_MEASUREMENT_ID      throwaway GA4 property id
```

Both are public by construction — a measurement id is not a credential, and
neither is a token. Nothing here touches `GA4_API_SECRET`, which is server-only
and belongs to the trusted purchase path. **Neither is configured by this
change.**

It **cannot**: override consent (the consent gate runs after the mode gate, and
no preview-specific conditional exists in the component); operate outside
`VERCEL_ENV=preview`; or use the Production property — a missing, malformed, or
Production-colliding preview id disables the mode rather than falling back.
Production behaviour is byte-identical to before.

**Safe setup:** set both variables on the Preview environment only; deploy;
open a Preview URL; confirm no `googletagmanager.com` script before choosing;
accept; confirm exactly one `page_view` to the throwaway property; navigate and
confirm one per route; withdraw via "Cookie choices" and confirm nothing
further. **Teardown:** remove both variables; Preview returns to inert.

## Reporting caveat, restated

Consent enforcement **reduces reported GA4 volume** by however many visitors
decline or never answer. Purchases are unaffected — they come from the
signature-verified Stripe webhook via the Measurement Protocol, deduplicated on
the Checkout Session id. Any conversion rate computed as purchases ÷ browser
sessions therefore mixes a server numerator with a consent-suppressed
denominator and will read high. **Use absolute trusted purchases per campaign**,
and do not compare rates against pre-consent baselines.

## Unchanged

Stripe webhook remains the sole purchase authority. Browser `Purchase` remains
prohibited. Meta CAPI remains deferred with no send path, no environment reads,
and no call site.
