# HeroStoryBooks Unit Economics Baseline — 2026-05-13

Local-only baseline for Phase 3 stabilization. No external paid APIs were called; this uses repo/docs/memory evidence plus explicit placeholders for costs we still need to fetch from billing dashboards.

## Source facts found locally

- Current public/order prices are **not** `$14.99 / $44.99 / $79.99`; repo currently uses:
  - Digital: **$14.99** (`src/lib/pricing.ts`, `src/lib/orders.ts`, checkout UI)
  - Classic softcover: **$39.99** (`src/lib/pricing.ts`, `src/lib/orders.ts`, checkout UI)
  - Premium hardcover: **$59.99** (`src/lib/pricing.ts`, `src/lib/orders.ts`, checkout UI)
- Stripe Checkout uses inline `price_data.unit_amount = order.priceCents`; no fixed Stripe Price IDs found in checkout path (`src/app/api/order/route.ts`).
- Story page counts from `getStoryPageCount` (`src/lib/orders.ts`): digital 24, classic 24, premium 32.
- Print package defaults (`src/lib/lulu.ts`):
  - Softcover POD package default: `0850X0850.FC.STD.PB.080CW444.GXX`
  - Hardcover POD package default: `0850X0850.FC.STD.CW.080CW444.MXX`
  - Shipping level default: `MAIL`
- Local memory contains repeated read-only Lulu observations for classic/softcover jobs: **$11.72 total incl. tax/shipping** for 8.5x8.5 softcover, 32-page interior / 24 images (jobs `2857729`, `2860733`, `2864996`). No Lulu payment performed.
- Image generation path is Seedream primary then Nano Banana edit fallback (`src/lib/image-generator.ts`), both through FAL (`FAL_KEY`); no text-only fallback for photo books.
- Regeneration thresholds: warning at 3, manual review at 5 (`src/lib/page-review.ts`).
- Blob storage is Vercel Blob, public by default unless `HSB_BLOB_ACCESS_MODE=private` (`src/lib/orders.ts`).

## Baseline cost assumptions

These are placeholders for modeling, not audited billing truth.

| Cost input | Baseline assumption | Confidence | Notes |
|---|---:|---|---|
| Stripe card fee | 2.9% + $0.30/order | Medium | Standard US card assumption; verify actual Stripe account pricing, international/card mix, taxes. |
| Seedream primary generation | $0.030/image | Low | Placeholder until FAL invoice/model pricing is fetched. |
| Nano Banana fallback/regeneration | $0.039/image | Low | Placeholder until FAL invoice/model pricing is fetched. |
| Story/prose generation | $0.020/order | Low | Repo indicates template/OpenAI-gated paths; use small placeholder until actual provider usage known. |
| Blob/storage/bandwidth | Digital $0.02, Classic $0.03, Premium $0.04/order | Low | Placeholder for JSON/photo/artifacts/PDF storage and delivery. |
| Lulu classic print+ship | $11.72/order | Medium | Observed locally for classic softcover unpaid jobs, incl tax/shipping. |
| Lulu premium print+ship | $18.00/order | Low | Placeholder; must fetch real hardcover quote/readback. |
| Refund reserve | 15% and 20% of gross revenue | Scenario | Modeled as gross revenue reserve, separate from payment processor refund behavior. |

## Baseline unit economics

Base generation assumes one image per story page and zero customer regenerations.

| SKU | Price | Pages/images | Stripe fee | AI base | Blob | Lulu print+ship | COGS before refund reserve | Contribution before reserve | Contribution after 15% reserve | Contribution after 20% reserve |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Digital | $14.99 | 24 | $0.73 | $0.74 | $0.02 | $0.00 | $1.49 | $13.50 | $11.25 | $10.50 |
| Classic | $39.99 | 24 | $1.46 | $0.74 | $0.03 | $11.72 | $13.95 | $26.04 | $20.04 | $18.04 |
| Premium | $59.99 | 32 | $2.04 | $0.98 | $0.04 | $18.00* | $21.06 | $38.93 | $29.93 | $26.93 |

\* Premium Lulu is placeholder, not observed.

### Formula notes

- `Stripe fee = price * 0.029 + 0.30`
- `AI base = story/prose cost + (page_count * Seedream primary cost)`
- `COGS before reserve = Stripe fee + AI base + Blob + Lulu`
- `Contribution before reserve = price - COGS before reserve`
- `Contribution after reserve = contribution before reserve - (price * reserve_rate)`

## Regeneration sensitivity

Each regenerated page adds direct image cost and may add proof rebuild/blob bandwidth. Baseline direct image-only impact:

| Regen path | Added cost/page | Example +3 pages | Example +5 pages |
|---|---:|---:|---:|
| Seedream primary | $0.030 | $0.09 | $0.15 |
| Nano Banana fallback | $0.039 | $0.12 | $0.20 |

Operationally, the larger risk is not direct model cost; it is manual QA time and repeated proof rebuilds. Current code warns at 3 regenerations and escalates at 5.

## Critical unknowns to fetch later

1. Actual FAL billing/pricing for `fal-ai/bytedance/seedream/v4/edit` and `fal-ai/nano-banana/edit`, including failed requests and any queue/storage fees.
2. Actual observed fallback rate from Seedream to Nano Banana in production.
3. Actual average regeneration count per customer/order after review UX is used.
4. Real Lulu quote/readback for premium hardcover with current page count/package/shipping/tax.
5. Whether classic $11.72 holds across destination states/countries; current checkout allows US, CA, GB, AU, NZ but memory observations appear US-based.
6. Stripe effective fee schedule for the HSB account: international cards, disputes, refunds, tax handling, and whether Stripe Tax is enabled later.
7. Vercel Blob actual storage + egress cost per order, including large PDFs, source photos, page artifacts, and repeat downloads.
8. Resend/email costs if volume exceeds free/plan limits.
9. Vercel function/runtime costs from 24/32 image generation, PDF building, proof rebuilds, and retries.
10. Customer support/QA labor for proof review, regen/manual-review thresholds, refunds, and print exceptions.
11. Tax/VAT/sales-tax liability and whether listed prices are tax-inclusive or tax-exclusive by market.
12. Print defect/reprint allowance and lost/delayed shipment reserve.
13. True refund rate after launch; 15%/20% are stress reserves, not actual history.

## Immediate pricing implication

At current assumptions, digital has high gross contribution but is very exposed to refund/support time. Classic at $39.99 looks viable only if the observed $11.72 Lulu total is representative and manual QA is bounded. Premium needs a real Lulu hardcover quote before margin confidence; the current $59.99 price could be fine or thin depending on hardcover shipping/tax by destination.
