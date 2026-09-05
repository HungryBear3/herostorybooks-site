# Search reconciliation checklist — read-only

**Date:** 2026-08-26 · **Against:** `origin/main` at `d6c5602`

Every row is either **source-proven** (verifiable from this repository, with the file
named) or **operator-unverified** (only visible in a console, and nobody has opened
one for this checklist).

Nothing here was executed. No property was claimed, no sitemap was submitted, no
indexing was requested, no DNS or Search Console setting was read or changed, and the
already-queued HSB indexing requests were not repeated.

---

## A. Source-proven

| # | Check | Finding | Evidence |
|---|---|---|---|
| A1 | Canonical host | Apex `herostorybooks.com`; `www` 308-redirects to it for the root and all deep paths | `vercel.json` redirects |
| A2 | Production origin constant | `PRODUCTION_ORIGIN = 'https://herostorybooks.com'`, used by the sitemap so previews cannot leak | `src/lib/site-url.ts:5` |
| A3 | Robots on production | One `User-agent: *` group; allows `/` and `/api/public/v1/catalog`; disallows nine private prefixes | `src/app/robots.ts` |
| A4 | Robots on preview | `Disallow: /` for everything | `src/app/robots.ts`, `shouldIndexSite()` |
| A5 | Named AI-crawler rules | **None.** No `OAI-SearchBot`, `GPTBot`, `ChatGPT-User`, `ClaudeBot`, `PerplexityBot`, or `CCBot` group exists | `src/app/robots.ts` |
| A6 | Sitemap contents | `/`, `/samples`, `/about`, `/gifts`, six gift-occasion pages, `/privacy`, `/terms` | `src/app/sitemap.ts` |
| A7 | Operational routes excluded from the sitemap | Asserted by test | `tests/seo-indexing-surfaces.test.ts` |
| A8 | Self-canonicals | Present on all seven public index routes plus the gift detail template | `tests/seo-indexing-surfaces.test.ts` |
| A9 | `/pricing` | Server redirect to `/#pricing`; correctly not in the sitemap and carries no canonical | `src/app/pricing/page.tsx` |
| A10 | Noindex headers | `/admin`, `/api`, `/checkout`, `/order`, `/partner`, `/review`, `/status`, `/thank-you` carry `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` | `middleware.ts` |
| A11 | Family review privacy headers | `noindex`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `default-src 'self'` CSP, `Cache-Control: private, no-store` | `middleware.ts` |
| A12 | Structured data | `Organization`, `WebSite`, three `Product` + `Offer`, `FAQPage`, all built from `PUBLIC_CATALOG`; escaped for `<script>` | `src/lib/public-structured-data.ts` |
| A13 | Structured-data price parity | Catalog `priceMinorUnits` asserted equal to `FORMAT_META.priceCents` in `orders.ts` | `tests/public-catalog.test.ts` |
| A14 | Product canonical URLs | All three point at the homepage — see AI-discovery finding A1 | `src/lib/public-catalog.ts:116,135,154` |
| A15 | `llms.txt` | Served static from the catalog; makes no indexing claim | `src/app/llms.txt/route.ts` |
| A16 | Catalog endpoint caching | `s-maxage=3600`, `stale-while-revalidate=86400`, stable SHA-256 ETag, `GET` only | `src/app/api/public/v1/catalog/route.ts` |
| A17 | Referrer suppression list | Exactly one host, `checkout.stripe.com` | `src/lib/analytics.ts` |
| A18 | GA4 on preview | Does **not** load: gated on `VERCEL_ENV === 'production'` | `src/app/layout.tsx:8` |
| A19 | Meta / Reddit / Google Ads tags on any served page | None. Asserted by unit test and by a Chromium run that blocks every external host | `tests/e2e/marketing-meta-inert.spec.ts` |

## B. Operator-unverified — needs someone to open a console

These are the facts a repository cannot answer. Each names the console and the exact
question, so whoever checks does not have to guess what was being asked.

| # | Console | Question | Why it matters |
|---|---|---|---|
| B1 | Search Console | Which property type is verified — domain property, or a URL-prefix property for the apex, or only for `www`? | A `www`-only URL-prefix property reports almost nothing after the apex redirect |
| B2 | Search Console | Who owns/has access to the property, and is that list current? | An unowned property blocks every other check here |
| B3 | Search Console | Has `https://herostorybooks.com/sitemap.xml` been submitted, and what is its last read status and discovered-URL count? | A never-submitted sitemap is still discovered via robots, but slowly and unreported |
| B4 | Search Console | Indexing coverage: how many of the 11 sitemap URLs are indexed, and what are the exclusion reasons for the rest? | The only way to tell "not crawled yet" from "crawled and rejected" |
| B5 | Search Console | Are there `www`-host URLs still indexed after the redirect? | Duplicate-host indexing splits authority |
| B6 | Search Console | Rich-results status for `Product`, `FAQPage`, and `Organization` — any warnings, and specifically any about the deliberately omitted fields (`availability`, `priceValidUntil`, `shippingDetails`, `hasMerchantReturnPolicy`)? | Those warnings are expected and are not to be "fixed" by inventing values |
| B7 | Search Console | Core Web Vitals field data for mobile: LCP, INP, CLS. Is there enough traffic for field data at all? | Likely "insufficient data" at current volume, which is itself the answer |
| B8 | Search Console | Any manual actions or security issues? | Cheap to check, expensive to miss |
| B9 | Search Console | Unresolved / anomalous URLs: anything indexed under `/checkout`, `/order`, `/thank-you`, `/review`, `/status`, or `/family-review` despite the noindex headers | An indexed private URL is a privacy incident, not an SEO issue |
| B10 | Search Console | Status of the already-queued HSB indexing requests | **Read only. Do not re-submit** — repeat requests are explicitly out of scope |
| B11 | GA4 admin | Does a custom channel group or referral-exclusion rule exist, and how are `chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `claude.ai` currently bucketed? | AI-discovery finding A4 |
| B12 | GA4 admin | Are `GA4_MEASUREMENT_ID` and `GA4_API_SECRET` actually set on Production, and is the Measurement Protocol secret current? | The server purchase silently no-ops if either is absent |
| B13 | GA4 admin | Data-retention setting, and whether Google Signals is on | Retention and Signals are consent-relevant and are not visible from code |
| B14 | GA4 property | Does the live `purchase` count reconcile with Stripe's paid-session count for the same window? | The one number that proves the trusted purchase path end to end |
| B15 | Vercel | Are `NEXT_PUBLIC_META_PIXEL_ID` / `NEXT_PUBLIC_META_PIXEL_ENABLED` / the three `META_CAPI_*` names absent on **all** environments? | They must stay absent until the rollout steps are approved |
| B16 | Meta Business | Which business asset owns the verified domain `dzkmx7nu5p61nc7end6o4xj4cl5qvo`, and does an ad account or dataset already exist under it? | Blocker B2 in `meta-measurement-candidate.md` |
| B17 | Bing Webmaster | Is the site verified at all? | Not required, but unknown, and it feeds several AI answer surfaces |

## C. Explicitly out of scope for this checklist

Submitting a sitemap · requesting indexing · repeating the queued HSB indexing
requests · changing DNS · claiming or transferring a Search Console property ·
changing any GA4 setting · creating or connecting any Meta or Reddit asset ·
submitting a product feed.
