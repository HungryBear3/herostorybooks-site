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

## 6. Event ID lifecycle and dedupe rules

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

## 7. Consent behaviour

`resolveConsent()` returns `granted`, `denied`, or `unknown`, and only `granted`
enables an ad platform. Absent, malformed, or throwing signals all resolve to
`unknown`.

There is no consent surface in this repository. See
`meta-measurement-candidate.md` §Blockers: today this means the Meta pixel **cannot
fire**, even with the pixel id and the flag both set. GA4's existing posture is
unchanged by this contract — altering it is an owner decision, not a side effect.

## 8. Retention

HSB stores nothing new. The only new persisted state is the board JSON in this
directory, which contains no customer data. Retention at GA4, Vercel Analytics, and
(if ever activated) Meta is governed by each platform's own settings, which are
operator-console facts and are listed as unverified in
`search-reconciliation-checklist.md`.

## 9. Carrying campaign attribution through checkout — designed, not built

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

### Known remaining ungoverned surface (deliberate, needs an owner decision)

`src/lib/analytics.ts` has a pre-existing browser campaign path that forwards
`utm_term` and `ref` and 160-character raw values to GA4 and Vercel Analytics.
It is **not** governed by the contract, and it was left in place: tightening it
changes live attribution semantics for any link already in circulation using a
non-allowlisted medium (`utm_medium=social`, for instance, which the closed
vocabulary does not contain). That is an owner call, not a side effect of this
follow-up. It is now the only ungoverned campaign surface left, and it feeds
GA4 exploration only — never the trusted purchase, which uses the governed
tuple exclusively.

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
