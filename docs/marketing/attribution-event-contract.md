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
