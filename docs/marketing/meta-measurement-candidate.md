# Meta Pixel candidate + Conversions API deferral — privacy model, rollout, blockers

**Status:** pixel is a candidate under review and enabled nowhere. **Conversions
API is DEFERRED and has no send path.** **Date:** 2026-08-26 (revised).

> The section headed "UPDATE 2026-08-26" at the foot of this document is the
> current truth for CAPI. The body below describes the pixel, which still
> exists, plus history that is retained deliberately.

---

## 1. The short version

- **Browser pixel** — mounted in the root layout; inert without a public pixel
  id, a feature flag, **granted consent**, and a public funnel route. Emits
  `PageView` and `InitiateCheckout` only. A browser `Purchase` is prohibited by
  contract.
- **Conversions API** — **deferred**. Not "disabled by default": there is no
  `fetch`, no endpoint, no payload builder, and no call site, and the Stripe
  webhook no longer references Meta at all. Setting the three environment
  variables changes nothing, which is asserted by test. See §UPDATE for why the
  original payload could never have worked.

**Nothing Meta-related can send anything on any deployment today.** The pixel is
blocked by the absent pixel id and flag — and now also by a real consent gate
rather than a placeholder global. CAPI is blocked by the absence of a matching
contract, which no amount of configuration supplies.

## 2. Environment variables — names only

| Name | Scope | Effect when absent |
|---|---|---|
| `NEXT_PUBLIC_META_PIXEL_ID` | browser, public | pixel disabled; no script, no init, no event |
| `NEXT_PUBLIC_META_PIXEL_ENABLED` | browser, public | must be exactly `true`; anything else disables |
| `META_CAPI_DATASET_ID` | **server only** | CAPI disabled; no request constructed |
| `META_CAPI_ACCESS_TOKEN` | **server only** | CAPI disabled |
| `META_CAPI_ENABLED` | **server only** | must be exactly `true`; anything else disables |

No value of any of these appears in this repository, this PR, or any log line.
`tests/marketing-meta-capi.test.ts` asserts that no CAPI name carries a
`NEXT_PUBLIC_` prefix and that no client module imports the CAPI module or mentions a
CAPI name.

`NEXT_PUBLIC_*` values are substituted at build time, so setting the pixel id
requires a **redeploy**, not a settings toggle. That is a rollout fact, not a bug.

## 3. Privacy and threat model

### What could go wrong, and what stops it

| Threat | Control | Test |
|---|---|---|
| A child's name in a URL reaches Meta (`/checkout?childName=…`, `/thank-you?…email=…`) | Query and fragment are stripped before any decision is made; `/thank-you` is not on the trackable allowlist at all | `marketing-meta-pixel.test.ts` — "query strings and fragments are stripped", "private, post-purchase, and family surfaces load nothing" |
| An order id or review token reaches Meta as a route | Dynamic segments are templated to `[orderId]` / `[reviewToken]` before any allowlist check, and none of those templates is allowlisted | same file — "dynamic segments are templated" |
| A third-party script loads on the family-review portal, violating its `default-src 'self'` CSP | Script loading is gated on the route allowlist, so nothing is requested there | same file — private-surface test asserts `scriptLoaded === false` |
| HSB funnel properties (theme, photo/voice flags, family counts, URL prefills) reach Meta | The bridge passes a frozen two-key constant, never the event record; the controller re-filters against the contract | `marketing-meta-pixel.test.ts` — "begin_checkout maps to InitiateCheckout with allowlisted parameters only"; `marketing-attribution-preservation.test.ts` — "the bridge receives only the event name" |
| Advanced Matching or customer identity is added later "just to improve matching" | `META_BLOCKED_FIELD_NAMES` + `assertNoBlockedFields` throw structurally on `user_data`, `em`, `ph`, `fn`, `ln`, `external_id`, `client_ip_address`, `client_user_agent`, `fbp`, `fbc` | `marketing-meta-pixel.test.ts`, `marketing-meta-capi.test.ts` |
| A Stripe session, PaymentIntent, or order id reaches Meta | The session id is used only to derive a SHA-256 pseudonym and is asserted absent from the payload; identifier-shaped values are rejected wherever they appear | `marketing-meta-capi.test.ts` — "no user_data, no identity, no order or session identifier reaches the wire" |
| Revenue is double-counted across GA4, Stripe, and Meta | GA4 dedupes on the Stripe session id; Meta dedupes on a deterministic hash of it; no browser Purchase exists to compete | `marketing-attribution-preservation.test.ts` — "a webhook replay produces one GA4 transaction_id and one Meta event_id" |
| An analytics failure breaks a payment, a confirmation email, or fulfillment | `scheduleMetaCapiPurchase` mirrors `scheduleGa4Purchase`: deferred through `after()`, bounded 2.5s timeout, no retry, every error swallowed and logged without an identifier | `marketing-meta-capi.test.ts` — timeout, network, HTTP, and scheduler-failure cases |
| A refunded order is re-reported as a purchase on replay | The refunded branch returns before any analytics call | `marketing-attribution-preservation.test.ts` — "the refund and terminal-state guards are untouched" |
| The access token leaks into a log or a URL | Sent as an `Authorization: Bearer` header, never as a query parameter | `marketing-meta-capi.test.ts` asserts the token is absent from the request URL |

### What Meta would receive if fully enabled

- `PageView` with the sanitised template route as the page context — no parameters.
- `InitiateCheckout` with `{content_type: 'product', content_category: 'storybook'}`.
- `Purchase` with `{currency, value, content_ids: ['book_premium'], content_type}`,
  an `event_id` pseudonym, `action_source: 'website'`, and `event_source_url` fixed
  to `https://herostorybooks.com/`.

That is the complete list. There is no identity, no matching, and no order context.

### What HSB gives up by that design

Meta's conversion optimisation works better with Advanced Matching. Refusing it means
weaker attribution and weaker optimisation. That is a deliberate trade, and the
board's Meta row states it as a kill condition rather than a knob: *"If Meta
optimisation requires them, the row stops rather than the privacy posture bending."*

## 4. CSP

There is no site-wide CSP to extend. `next.config.js` and `vercel.json` set no
headers; the only CSP is `FAMILY_REVIEW_CSP` in `middleware.ts`, which must stay
`self`-only. **This candidate adds no CSP directive anywhere**, and two tests assert
that no Meta origin appears in `middleware.ts` and that no global CSP was introduced.

If a site-wide CSP is ever added, the **exact** directives Meta needs are:

```
script-src   https://connect.facebook.net
img-src      https://www.facebook.com
connect-src  https://www.facebook.com
```

No wildcards, no `*.facebook.com`, and nothing on the family-review CSP. The pixel
adapter names exactly one origin (`https://connect.facebook.net`), asserted by test.

## 5. Rollout

Strictly ordered. Each step is a separate approval.

1. **Merge inert.** Nothing set. The pixel and CAPI are dead code paths verified by
   test and by a Chromium run that blocks every external host.
2. **Ship a consent surface.** Blocker B1 below. Until it exists the pixel cannot
   fire, so there is nothing to validate.
3. **Preview pixel validation.** Set `NEXT_PUBLIC_META_PIXEL_ID` and
   `NEXT_PUBLIC_META_PIXEL_ENABLED=true` on **Preview only**, redeploy, and confirm in
   Meta Events Manager Test Events: exactly one `PageView` per navigation, an
   `InitiateCheckout` on the checkout page, no event on `/thank-you`, and no event on
   any `/family-review` route. Note that GA4 does **not** run on Preview
   (`VERCEL_ENV === 'production'`), so GA4 parity cannot be checked there.
4. **Connect the CAPI dataset.** Separate `account_connection` approval. Set the
   three server variables on Preview and drive a Stripe **test-mode** paid session.
   Confirm one `Purchase` in Test Events, and confirm a redelivered webhook produces
   no second conversion.
5. **Production pixel.** Separate approval. Set the two public variables on
   Production and redeploy. Confirm GA4 purchase counts are unchanged.
6. **Production CAPI.** Separate approval. Set the three server variables.
7. **Only then** may the board's Meta row leave `proposed` — and it still needs its
   own `paid_spend` approval and a re-derived contribution figure.

## 6. Rollback

| Step to undo | Action | Time to effect |
|---|---|---|
| CAPI | unset `META_CAPI_ENABLED` (or the dataset id / token) | next server invocation — no redeploy needed |
| Pixel | set `NEXT_PUBLIC_META_PIXEL_ENABLED` to anything but `true`, then redeploy | one deploy, because `NEXT_PUBLIC_*` is build-time |
| Everything | revert this PR | one deploy |

Nothing here writes to the order store, the blob store, Stripe, or any customer
record, so no rollback has data to undo. Data already delivered to Meta would have to
be deleted through Meta's own console — an operator action, listed as unverified.

## 7. Open blockers

**B1 — ✅ CLOSED. A shared consent surface now exists.**
This blocker said there was no banner, no consent state, and no way for
`resolveConsent()` to return anything but `unknown`. That is resolved: one
reactive consent surface governs browser GA4, Vercel Analytics, and Meta
together, default `unknown` fails closed, and none of the three loads or emits
before an explicit grant. Google Consent Mode denied is deliberately **not** the
mechanism — the scripts simply are not rendered. See
`attribution-event-contract.md` §0.1.

The pixel still fires nothing on every deployment, now for the remaining
configuration reason only: no `NEXT_PUBLIC_META_PIXEL_ID` and no
`NEXT_PUBLIC_META_PIXEL_ENABLED` are set anywhere.

This is deliberate and it is stated here so nobody discovers it during a Preview
validation. It also creates a visible inconsistency worth an owner decision: **GA4
runs today with no consent gate at all** (`src/app/layout.tsx`). This candidate does
not change that, because changing the live GA4 consent posture is an owner decision,
not a side effect of adding Meta. Two coherent resolutions exist — ship a consent
surface that governs both, or record a decision that HSB's US-only footprint does not
require opt-in and relax the Meta gate to match GA4. Picking one is out of scope here.

**B2 — No Meta account configuration is known.**
No pixel id, no dataset id, no access token, no ad account, and no decision about
which Meta business asset would own them. `META_GRAPH_API_VERSION` is pinned to
`v21.0` as a conservative default and must be confirmed against the dataset's actual
supported version before step 4. Nothing was guessed.

**B3 — No privacy approval exists for customer matching.**
Assumed absent, per the task. The candidate therefore carries no `user_data`, no
Advanced Matching, and no IP/User-Agent forwarding. Adding any of them is a new
privacy decision, not a configuration change.

**B4 — `ViewContent` is unmapped.**
No live surface proves a product view. See the event contract §2.

**B5 — Campaign attribution does not reach the trusted purchase.**
Designed in the event contract §9, not implemented. It touches the checkout submit
path and the order route, and deserves its own review.

---

# UPDATE 2026-08-26 — CAPI is DEFERRED, and the send path is gone

This document previously described a Conversions API candidate that was
"disabled by default". That framing was wrong in a way worth stating plainly:
the payload it would have sent **could not have worked at all**, in any
configuration.

It sent no `user_data`. Meta requires `user_data` on every server event with at
least one customer matching parameter. `event_id` deduplicates a server event
against a browser event; `event_source_url` describes a page. Neither is a
matching signal. The candidate satisfied a schema, not a purpose — so
"disabled by default" implied a working path behind a flag, and there was none.

**Decision: defer, and remove the path** rather than leave a misleading one.
See `docs/marketing/attribution-event-contract.md` for the full reasoning. In
short, the minimum safe matching contract needs a hashed purchaser email, and
HSB has no server-side consent evidence, no privacy approval for customer
matching to an ad platform, and no `fbp`/`fbc` (the Pixel is inert).

What remains in `src/lib/marketing/meta-capi.ts`: environment-variable names, a
`metaCapiStatus()` that always returns `deferred` and reads no environment, a
type-only future contract naming `user_data` as the required block, and the
never-send list. No `fetch`, no endpoint, no scheduler, no call site. The Stripe
webhook no longer references Meta at all.

**The Pixel is unchanged and still inert** — no public pixel id, no flag, and
now also a real consent gate rather than a placeholder global.

**Blockers that must clear before CAPI is reconsidered**, in order:

1. A privacy/legal decision authorising customer matching to an ad platform,
   for an audience of parents buying a product about their child.
2. Server-side consent evidence available at the Stripe webhook — the current
   consent surface is browser-only.
3. A documented minimum field set, hashed and normalised, that never includes
   child data, order identifiers, or raw PII.
4. Only then: credentials, and a Preview test-event validation.

Configuring `META_CAPI_ENABLED`, `META_CAPI_DATASET_ID`, and
`META_CAPI_ACCESS_TOKEN` does **not** shorten this list and does not change what
the code does. That is asserted by test.
