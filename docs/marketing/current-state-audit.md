# HSB marketing measurement — current-state audit

**Audited:** 2026-08-26 · **Against:** `origin/main` at `d6c5602`
**Method:** read from source in this repository. Nothing below is carried over from
an older note; every claim names the file it was read from.

---

## 1. What exists today

### 1.1 Google Analytics 4 — browser

| Fact | Source |
|---|---|
| Measurement ID `G-68FKEDZEG3` is a hard-coded literal, not an environment variable | `src/app/layout.tsx:7` |
| GA4 loads **only** when `process.env.VERCEL_ENV === 'production'` | `src/app/layout.tsx:8` |
| `gtag('config', …, { send_page_view: false })` — automatic page views are off | `src/app/layout.tsx:50-55` |
| `page_location` is rebuilt as `origin + pathname`; the query string never reaches GA4 | `src/app/layout.tsx:39` |
| `page_referrer` is rebuilt as `origin + pathname`, and `ignore_referrer` is set when the referrer is `checkout.stripe.com` | `src/app/layout.tsx:43-47` |
| Exactly one `page_view` per pathname, latched against StrictMode double-effects | `src/components/analytics-page-view.tsx` |
| Funnel events forward to `gtag` once, and to Vercel Analytics for everything except `page_view` | `src/lib/analytics.ts` `track()` |

**Live GA4 event names, read from their call sites — not from a naming document:**

| Event | Emitted at |
|---|---|
| `page_view` | `src/components/analytics-page-view.tsx` (root layout) |
| `begin_checkout` | `src/app/checkout/checkout-form.tsx:460` (checkout mount) |
| `format_selected` | `src/app/checkout/checkout-form.tsx:2340` |
| `story_selected` | `src/app/checkout/checkout-form.tsx:1188`, `:1232` |
| `order_submit_attempt` | `src/app/checkout/checkout-form.tsx:840` |
| `purchase_intent` | `src/app/checkout/checkout-form.tsx:841` |
| `name_preview_submitted` | `src/components/name-preview.tsx:150` |
| `proof_approved` | `src/app/review/[orderId]/review-client.tsx:687` |
| `cover_variant_shown` | `src/components/CoverPreview.tsx:43` |
| `purchase` | server only — see 1.3 |

### 1.2 Campaign capture

`src/lib/analytics.ts` reads `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`, and `ref` from `window.location.search`, truncates each to 160
characters, stores the first-touch set in `sessionStorage` under
`hsb:first-touch-campaign:v1`, and attaches it to every event. It also maps them onto
GA4's `campaign_*` fields via `gtag('set', …)`.

There is **no validation**: any value of any shape is accepted, truncated, and
forwarded to both GA4 and Vercel Analytics.

`src/lib/checkout-tracking.ts` is a separate, stricter mechanism: `cohort` and
`invite` from the `/checkout` URL, token-validated against
`/^[a-z0-9][a-z0-9_-]{0,39}$/`, persisted on the order and copied into Stripe
metadata. It is not connected to the UTM path.

### 1.3 Purchase — server, authoritative

`src/lib/ga4-purchase.ts` sends GA4's recommended `purchase` event through the
Measurement Protocol (`https://www.google-analytics.com/mp/collect`):

- gated on `payment_status ∈ {paid, no_payment_required}`;
- `transaction_id` = the Stripe Checkout Session id, which is stable across replays;
- `client_id` = the anonymous GA client id captured at checkout, or a SHA-256
  fallback derived from the transaction id;
- value, currency, and item come from the server-side Stripe/order record;
- requires `GA4_MEASUREMENT_ID` (or `NEXT_PUBLIC_GA_MEASUREMENT_ID`) **and**
  `GA4_API_SECRET`; absent either, it no-ops;
- scheduled through `after()` with every failure swallowed, so it cannot affect
  payment, confirmation, or fulfillment.

Called from three places in `src/app/api/webhooks/stripe/route.ts`: the print-upgrade
path, the already-paid replay path, and the first `pending → paid` transition.

**The GA client id crosses the boundary like this:**
`document.cookie _ga` → `currentGaClientId()` (`src/lib/analytics.ts`) →
`FormData.gaClientId` (`checkout-form.tsx:939`) → `sanitizeGaClientId()`
(`api/order/route.ts:149`) → Stripe session metadata (`api/order/route.ts:659`) →
webhook (`clientId: session.metadata?.gaClientId`).

### 1.4 Vercel Analytics

`src/components/safe-vercel-analytics.tsx` wraps `@vercel/analytics` with a
`beforeSend` that rewrites every event URL to `origin + pathname`. Custom events
arrive through `trackVercelEvent` in `src/lib/analytics.ts`.

### 1.5 Headers, robots, and CSP

- **No site-wide Content-Security-Policy exists.** `next.config.js` sets no headers
  and `vercel.json` has none. The only CSP in the codebase is
  `FAMILY_REVIEW_CSP` in `middleware.ts:49-61`, which is `default-src 'self'` and
  applies to `/family-review/*` and `/api/family-review/*`.
- `middleware.ts` marks `/admin`, `/api`, `/checkout`, `/order`, `/partner`,
  `/review`, `/status`, `/thank-you` as `X-Robots-Tag: noindex, nofollow`.
- `src/app/robots.ts` disallows the same set for `User-agent: *`, with
  `/api/public/v1/catalog` as the single deliberate `Allow`.
- `vercel.json` permanently redirects `www.herostorybooks.com` to the apex host.

### 1.6 What is NOT present

Verified by grep across `src/`, `middleware.ts`, `next.config.js`, `vercel.json`,
and `scripts/`:

- no Meta Pixel, no `fbq`, no `fbevents.js`;
- no Meta Conversions API;
- no Reddit pixel or Reddit CAPI;
- no Google Ads tag or conversion linker;
- no product feed, merchant feed, or Agentic Commerce surface;
- no referral-tracking code beyond `ref` and `cohort`/`invite`;
- **no consent mechanism of any kind** — no banner, no consent cookie, no Google
  Consent Mode call.

One Meta-adjacent artefact does exist: a `facebook-domain-verification` meta tag
(`src/app/layout.tsx:14`). The domain is verified with Meta; nothing measures.

---

## 2. Which source is authoritative for purchase

**Stripe is, via the signed webhook.** `src/app/api/webhooks/stripe/route.ts`
verifies the signature, converges payment state, performs the durable payment write,
and only then schedules the GA4 purchase. No browser surface emits a purchase, and
`/thank-you` renders no purchase event.

Anything added later must derive purchase from this same path or not exist.

---

## 3. Conflicts and double-counting risks found

| # | Risk | Evidence | Status |
|---|---|---|---|
| C1 | `purchase_intent` and `order_submit_attempt` are emitted back-to-back with **identical** properties. Any funnel that counts both double-counts intent. | `checkout-form.tsx:840-841` | Open. Pre-existing; not changed by this candidate. |
| C2 | Three names exist for "checkout started": live `begin_checkout`, dead `checkout_start` (`trackCheckoutStart`, no call sites), and dead `start_checkout` (declared in `HsbEventName`, never emitted). | `src/lib/analytics.ts` | Open. Only `begin_checkout` is real; the contract maps that one. |
| C3 | GA4 `purchase` is also sent from the **replay** branch, so one Stripe session can produce several Measurement Protocol hits. GA4 deduplicates on `transaction_id`, so revenue is correct — but only because the id is stable. | `webhooks/stripe/route.ts` replay branch | Accepted, and now depended upon. Any new platform must have its own stable dedupe key. |
| C4 | UTM values are unvalidated and truncated to 160 characters, then sent to **two** destinations (GA4 and Vercel Analytics). A partner who puts an email in `utm_content` puts it in both. | `src/lib/analytics.ts` `campaignParamsFromUrl()` | Open. `src/lib/marketing/utm-contract.ts` is the governed replacement; adopting it inside the live GA4 path is a separate change. |
| C5 | UTMs are **not** propagated to the server. Stripe metadata carries `gaClientId`, `cohort`, and `invite` — no campaign fields. The trusted purchase therefore has no campaign attribution of its own; it is joined to a session only through the GA client id, and only when the `_ga` cookie exists. | `api/order/route.ts:652-662` | Open. Design in the event contract; not implemented here. |
| C6 | `utm_term` and `ref` are captured and forwarded although HSB runs no paid search and no referral programme. Unowned fields are unvalidated fields. | `src/lib/analytics.ts` | Open. Both are excluded from the governed contract. |
| C7 | `success_url` places `childName` and `email` in the `/thank-you` query string. GA4 and Vercel Analytics both sanitise it away, but the raw URL is in browser history and would be read by any future tag that reads `location.href`. | `api/order/route.ts:645-650`, `:684` | Mitigated for Meta: `/thank-you` is excluded from the trackable route allowlist entirely, and the sanitiser strips queries before any decision. |
| C8 | GA4 loads only on `VERCEL_ENV === 'production'`, so **GA4 behaviour cannot be validated on Preview.** Any test-event validation plan that assumes Preview parity is wrong. | `src/app/layout.tsx:8` | Open. Called out in the rollout plan. |
| C9 | No consent signal exists anywhere, while GA4 runs unconditionally on production. | absence, verified by grep | Open, and the top blocker for Meta. See `meta-measurement-candidate.md`. |

## 4. Dead analytics surface

`trackCoverEvent`, `trackPreviewClick`, `trackPremiumSelect`, `trackCheckoutStart`,
and `isUnwantedReferral` are exported from `src/lib/analytics.ts` with zero call
sites outside that module and its tests. `trackVariantShown` is the only
cover-variant helper still used (`src/components/CoverPreview.tsx`).

Left in place deliberately. Removing them is a cleanup with its own review, and
mixing it into a measurement change would make both harder to read.


---

# Reconciliation, 2026-08-26 — what this branch changed

This audit was written against `d6c5602` and remains an accurate record of that
commit. Two of its findings no longer describe the branch head, and one of its
statements is now the opposite of the truth. Recorded here rather than edited
in place, so the original audit stays readable as history.

**"There is no consent mechanism of any kind" — no longer true.** There is one
consent surface governing GA4, Vercel Analytics, and Meta together. Default is
`unknown`, `unknown` enables nothing, and **nothing is stored until the visitor
chooses**. GA4's script and Vercel Analytics are not rendered at all before a
grant — this is deliberately not a denied Consent Mode, which would still load
Google's library and still send cookieless pings.

**"Unvalidated UTM values forwarded to two destinations" — closed.** The
ungoverned browser campaign path in `src/lib/analytics.ts` (which read
`utm_term`, `ref`, and 160-character raw values into sessionStorage and
forwarded them to GA4 and Vercel) has been **removed**, not merely bounded.
Campaign attribution now comes only from the governed record, validated by
`utm-contract.ts`. A link using a non-allowlisted medium, or a legacy
`utm_term`/`ref` link, contributes **no** campaign attribution rather than
bypassing governance.

**"No campaign attribution on the trusted purchase" — closed.** The governed
tuple is bound to the order record, carried in Stripe metadata only, recovered
from the signed session, and re-validated before it reaches GA4's reserved
`campaign_*` parameters on the webhook purchase.

**Still true, and unchanged:** Stripe remains the sole purchase authority, there
is no site-wide CSP, and no Reddit/Google Ads/feed code exists. Meta remains
inert, and the Conversions API is now explicitly **deferred** with its send path
removed — see `meta-measurement-candidate.md`.
