# AI discovery audit — separate from ad pixels

**Audited:** 2026-08-26 · **Against:** `origin/main` at `d6c5602`
**Scope:** how models and agentic shopping surfaces can find and correctly describe
HSB. This is a different problem from ad measurement and shares no code with it.

Every row is labelled **source-proven** (read from this repository) or
**operator-unverified** (only visible in a console nobody has read for this audit).
Nothing was submitted, requested, or configured.

---

## 1. Public catalog and structured-data consistency — source-proven

One module is the origin of every machine-readable fact:
`src/lib/public-catalog.ts` feeds all three surfaces.

| Surface | Built from | Serving properties |
|---|---|---|
| `/api/public/v1/catalog` | `PUBLIC_CATALOG` | `force-static`, stable ETag, `s-maxage=3600`, `Allow: GET` only, request object never read |
| Homepage JSON-LD | `PUBLIC_CATALOG` + `PUBLIC_HOME_FAQS` | escaped for `<script>`, `Organization` / `WebSite` / `Product` / `FAQPage` |
| `/llms.txt` | `PUBLIC_CATALOG` | `force-static`, generated, never a second hand-written copy of the prices |

`tests/public-catalog.test.ts` walks the transitive import graph and fails if the
module ever imports orders, customers, checkout, Blob, Stripe, fulfillment, email,
admin, proofs, or signed assets. It also asserts `priceMinorUnits` equals
`FORMAT_META.priceCents` in `src/lib/orders.ts`, so the published price cannot drift
from what Stripe charges. Live prices: **$19 / $39 / $64**.

**Consistency verdict: strong.** The three surfaces cannot disagree, because there is
only one source and it is tested against the charging code.

### Deliberate omissions, and what they cost

`src/lib/public-structured-data.ts` deliberately omits `aggregateRating`, `review`,
`sku`, `gtin`/`mpn`, `availability`, `priceValidUntil`, `shippingDetails`, and
`hasMerchantReturnPolicy`, because no live public page states any of them.

That is the right call for truthfulness and it is the direct cause of finding **A2**
below: those are close to the exact fields a shopping or agentic-commerce surface
needs. The gap is not an oversight to be filled by inventing values — it is a
content decision (publish a real returns page, a real availability statement) that
must happen on the site before the markup can honestly follow.

### A1 — Three products share one canonical URL — source-proven

All three `Product` entries carry `canonicalUrl = https://herostorybooks.com/`
(`src/lib/public-catalog.ts:116,135,154`). The homepage genuinely is where all three
are described, so this is honest. But a product feed and most shopping surfaces
require a distinct landing URL per item, and a consumer that de-duplicates by URL
sees one product where HSB sells three.

*Not fixed here.* Fixing it means creating three real product pages, which is a
content and routing change, not a marketing-measurement change.

## 2. Robots policy, including OAI-SearchBot — source-proven

`src/app/robots.ts` emits exactly **one** rule group, `User-agent: *`:

- on production: `Allow: /`, `Allow: /api/public/v1/catalog`; `Disallow:` `/admin/`,
  `/api/`, `/checkout`, `/design-previews/`, `/family-review`, `/order`, `/partner/`,
  `/review/`, `/status/`, `/thank-you`;
- on any non-production deployment: `Disallow: /` for everything.

**There is no `OAI-SearchBot` rule, and no rule for `GPTBot`, `ChatGPT-User`,
`ClaudeBot`, `PerplexityBot`, or `CCBot`.** That is the source truth. Its effect is
that every one of those agents is governed by the `*` group: allowed on the public
site, allowed on the catalog endpoint, and disallowed from every private path.

The `/api/public/v1/catalog` `Allow` is longer and more specific than the `/api/`
`Disallow`, so crawlers following the most-specific-rule-wins convention (Google,
Bing, and the major AI crawlers) fetch it. Crawlers that use first-match-wins would
not. That is a real ambiguity in the standard, not a bug here.

### A3 — Named-agent rules are absent, which is a decision nobody has recorded

Adding named groups is only worth doing to *narrow* access (e.g. allowing search
indexing while disallowing training crawlers), and that is a business decision. The
finding is that no such decision exists in the repository — not that a rule is
missing. If HSB wants training crawlers and search crawlers treated differently, that
needs an owner decision first and a robots change second.

## 3. Sitemap, canonical, and host behaviour — source-proven

| Check | Finding |
|---|---|
| Sitemap `<loc>` host | Always `PRODUCTION_ORIGIN`, never the preview-aware helper, so a preview deploy cannot emit preview URLs into a crawlable sitemap (`src/app/sitemap.ts:9`) |
| Sitemap contents | `/`, `/samples`, `/about`, `/gifts`, six `/gifts/<occasion>` pages, `/privacy`, `/terms` |
| Operational routes in sitemap | None. `tests/seo-indexing-surfaces.test.ts` asserts `/checkout`, `/order`, `/thank-you`, `/review`, `/status`, `/admin`, `/api` never appear |
| Self-canonicals | Declared on `/`, `/about`, `/samples`, `/gifts`, `/gifts/[occasion]`, `/privacy`, `/terms` |
| `/pricing` | A **server redirect** to `/#pricing` (`src/app/pricing/page.tsx`). Correctly absent from the sitemap and correctly carries no canonical of its own |
| Host | `vercel.json` 308-redirects `www.herostorybooks.com` → apex, root and deep paths |
| Robots `host` directive | `getSiteOrigin()`, i.e. the preview URL on a preview deploy — harmless, since that deploy also emits `Disallow: /` |

**Verdict: no gap found.** This area is already well covered and already tested.

## 4. llms.txt — source-proven

Served from `src/app/llms.txt/route.ts` as `force-static` `text/plain`. Generated
from `PUBLIC_CATALOG`, so it cannot state a price the catalog does not state. It
carries the brand description, a link to the catalog JSON with its schema version and
review date, the canonical page list, the three products, the key policies, an
explicit *Limits of this information* section, and a statement that order-specific
questions are private and go to support.

Its own header says it makes no claim that publishing it causes indexing, citation,
or recommendation. That framing is correct and should not be softened: **llms.txt is
not a standard any model provider has committed to honouring.** Its value here is
that it is a cheap, truthful, self-consistent map — not that it guarantees anything.

## 5. ChatGPT referral classification in GA4 — partly source-proven

**Source-proven, in this repository:**

- `sanitizedPageReferrer()` (`src/lib/analytics.ts`) reduces `document.referrer` to
  `origin + pathname` and passes it as `page_referrer`.
- The inline gtag config does the same for the initial page
  (`src/app/layout.tsx:43-47`).
- `unwantedReferralHosts` contains exactly one entry, `checkout.stripe.com`. Nothing
  else is suppressed.
- Therefore a visit referred by `chatgpt.com`, `chat.openai.com`,
  `perplexity.ai`, or `claude.ai` arrives at GA4 with a sanitised referrer host and
  **no HSB-side source/medium override**.

**Operator-unverified:** how GA4's default channel grouping currently buckets those
hosts, and whether any custom channel group or referral exclusion exists in the GA4
property. That is a GA4 admin console fact and nobody has read it for this audit.

### A4 — No sanitised source/medium rule exists for AI referrers

The recommended shape, when someone chooses to act on it, is a **GA4-side** custom
channel group matching a small explicit host list — not new code. Doing it in the
property rather than in `src/lib/analytics.ts` keeps the host list editable without a
deploy and keeps HSB's code free of a list that will change as new assistants appear.

Deliberately **not** implemented here: it is a console change, and this task does not
touch consoles.

## 6. Readiness for an official structured product-feed / agentic-commerce route

Stated carefully. The precise field names, submission mechanism, and eligibility
rules for OpenAI's merchant/agentic-commerce programme are **operator-unverified**:
they must be read from OpenAI's current merchant documentation at the time anyone
acts, not reproduced from memory here. What can be stated from source is what HSB
already has and what it plainly lacks.

**Already in place — source-proven:**

- a versioned, static, cacheable machine-readable catalog with a stable ETag;
- one enforced source of truth for prices, tested against the charging code;
- per-product identifiers (`digital`, `classic`, `premium`), names, descriptions,
  currency, and minor-unit prices;
- explicit public policy text for proof-first fulfillment, refunds (digital and
  printed), shipping geography, and dispatch/delivery expectations;
- an explicit `limitations` array that already says delivery dates are not
  guaranteed and no rush fulfillment exists.

**Missing before any feed could be honest — source-proven gaps:**

| Gap | Why it blocks a feed |
|---|---|
| No distinct product URL per SKU (finding A1) | feeds key on a landing URL per item |
| No `availability` statement anywhere public | a feed must state whether an item can be ordered |
| No `sku`, `gtin`, or `mpn` | most feeds require a stable item identifier beyond a slug |
| No public returns/refund **policy page** with the structure a merchant return policy needs — the refund facts exist only as FAQ prose | a feed asks for a structured return window and method |
| No structured shipping cost or delivery window | HSB deliberately promises no dates; a feed will ask for one, and the honest answer may be that HSB is not a fit yet |
| Attended, capacity-bound fulfillment | agentic checkout assumes an order can be placed without an operator in the loop; HSB's proof-first flow requires one |

**Recommendation:** do not pursue an agentic-commerce feed in this 30-day window. The
last row above is not a data gap, it is a business-model mismatch, and the others are
content decisions that must land on the public site first. Revisit only after the
partnership rows have produced a decision.

## 7. Is an MCP or action surface justified? — source-proven

No MCP server, tool manifest, action schema, or agent-callable endpoint exists in
this repository. The public catalog endpoint is a static document, not an action.

**It is not justified, and it is not a discovery mechanism.** An MCP server does not
make a business findable; it lets an already-connected client call functions. HSB has
nothing an external agent should be able to *do* — every meaningful action touches an
order, a payment, a child's photo, or a proof, and all of those are exactly what the
privacy rule keeps out of the public contract.

The only shape that could ever be justified is a read-only tool returning the same
public catalog an agent can already `GET` for free, which adds a maintained surface
and an auth story in exchange for nothing.

Revisit only if a specific partner asks for a specific capability, and treat it then
as an integration with an auth boundary, not as marketing.

---

## Findings summary

| # | Finding | Type | Action |
|---|---|---|---|
| A1 | Three products share one canonical URL | source-proven | needs three real product pages — content change, own review |
| A2 | Shopping-feed fields deliberately absent because no page states them | source-proven | publish the facts on the site first; never invent markup |
| A3 | No named AI-crawler robots rules, and no recorded decision about them | source-proven | owner decision, then a robots change |
| A4 | No sanitised source/medium rule for AI referrers | partly source-proven | GA4 console custom channel group — not code |
| A5 | Agentic-commerce route blocked by attended fulfillment, not by data | source-proven | do not pursue this window |
| A6 | GA4 channel grouping for AI referrer hosts unread | operator-unverified | see `search-reconciliation-checklist.md` |

**Nothing was submitted.** No feed, no indexing request, no DNS change, no Search
Console change. The already-queued HSB indexing requests were not repeated.
