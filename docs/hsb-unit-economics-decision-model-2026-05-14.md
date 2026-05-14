# HeroStoryBooks Unit Economics Decision Model — 2026-05-14

Purpose: answer the first premortem gate — **can HSB make money per order before paid acquisition?** This is a decision model, not audited accounting. It uses repo-confirmed pricing plus explicit assumptions we can replace with actual invoices.

## Current SKU prices found in repo

- Digital PDF: **$14.99** / 24 illustrated story pages
- Classic softcover: **$39.99** / 24 illustrated story pages / free shipping included
- Premium hardcover: **$59.99** / 32 illustrated story pages / free shipping included

## Key provisional inputs

- Stripe: 2.9% + $0.30/order.
- Classic Lulu print+ship: **$11.72** observed in local order evidence. Medium confidence.
- Premium Lulu print+ship: **$18.00 placeholder**. Low confidence; must verify with a real quote/readback.
- Image generation: Seedream primary, FAL edit (`fal_edit`) fallback. If the fallback uses Nano Banana as the underlying FAL model, keep the grep-able repo/provider name in docs and diagnostics.
- Gemini is the preferred planning/control path for story structure and image prompt control; FAL.ai is the preferred image generation/editing path. OpenAI image API is not modeled as the default path.
- Support labor is modeled directly per order:
  - Upside: 2 minutes/order at $20/hr = **$0.67/order**.
  - Base: 8 minutes/order at $20/hr = **$2.67/order**.
  - Stress: 20 minutes/order at $25/hr = **$8.33/order**.
- Voice beta is feature-flagged off by default and is not modeled as a cost driver here.

CSV note: scenario columns are rounded to cents for display. Minor ±$0.01 differences can appear if recomputing from rounded display values instead of full-precision assumptions.

## Scenario outputs

### Upside case

| SKU | Price | COGS before refunds | Refund reserve | Contribution | Margin | Break-even CAC | CAC for 30% margin |
|---|---|---|---|---|---|---|---|
| Digital | $14.99 | $2.12 | $1.20 | $11.67 | 77.9% | $11.67 | $7.17 |
| Classic softcover | $39.99 | $14.81 | $3.20 | $21.98 | 55.0% | $21.98 | $9.98 |
| Premium hardcover | $59.99 | $22.02 | $4.80 | $33.17 | 55.3% | $33.17 | $15.17 |

Assumes low refunds, low support, low fallback/regeneration, and minimal print defects.

### Base case

| SKU | Price | COGS before refunds | Refund reserve | Contribution | Margin | Break-even CAC | CAC for 30% margin |
|---|---|---|---|---|---|---|---|
| Digital | $14.99 | $4.39 | $2.25 | $8.35 | 55.7% | $8.35 | $3.85 |
| Classic softcover | $39.99 | $17.44 | $6.00 | $16.55 | 41.4% | $16.55 | $4.55 |
| Premium hardcover | $59.99 | $24.87 | $9.00 | $26.12 | 43.5% | $26.12 | $8.12 |

This is the planning case I’d use before reopening checkout: 15% refund reserve, 8 minutes support/order, 3 average regenerated pages, 15% fallback rate.

### Stress case

| SKU | Price | COGS before refunds | Refund reserve | Contribution | Margin | Break-even CAC | CAC for 30% margin |
|---|---|---|---|---|---|---|---|
| Digital | $14.99 | $11.26 | $3.75 | -$0.02 | -0.1% | -$0.02 | -$4.52 |
| Classic softcover | $39.99 | $24.89 | $10.00 | $5.10 | 12.8% | $5.10 | -$6.90 |
| Premium hardcover | $59.99 | $32.88 | $15.00 | $12.11 | 20.2% | $12.11 | -$5.89 |

This is the “holiday weekend things get messy” case: 25% refund reserve, 20 minutes support/order, 6 average regenerated pages, 35% fallback rate, and higher image costs.

## Immediate conclusions

1. **Classic is probably the best initial business SKU, but it is support-sensitive.** In the base case it has about **$16.55 contribution after reserves**, meaning paid CAC must stay below ~$16.50 just to break even, and ideally below ~$4.50 if we want a 30% contribution margin after CAC.
2. **Digital has nice software margin but weak absolute dollars.** Base contribution is only about **$8.35**, so paid ads can’t work unless CAC is tiny or digital is a referral/upsell/lead product.
3. **Premium could be good, but it is not trustworthy until hardcover Lulu cost is verified.** Base contribution shows **$26.12**, but the $18 print+ship assumption is the weakest number in the model.
4. **Image cost is not the main danger at current assumptions.** Support minutes, refunds, print/reprint reserves, and CAC are the real killers.
5. **Paid ads are not safe yet.** If first paid CAC comes in at $30–$50, Classic loses money unless AOV rises or there is strong repeat/referral LTV.
6. **Stress-case support/rework breaks the paid-acquisition model.** In the stress case, CAC targets for a healthy margin go negative because support + refunds absorb the available contribution.

## Kill / pause thresholds

Before spending real ad money, pause or rethink if any of these are true after 10–20 real orders:

- Classic contribution after refunds/support/reprints is **below $15/order**.
- Average support + QA time exceeds **15 minutes/order**.
- Refunds + remake/reprint requests exceed **20% of gross revenue**.
- Average paid CAC is above **gross contribution after reserves** for two consecutive small tests.
- Organic/referral share is below **20%** after influencer/free-book seeding.
- Premium real Lulu landed cost is above **$25** at current $59.99 price.
- Chargebacks are not separately modeled; if early chargebacks appear, treat them as part of refund/rework reserve and re-run the model immediately.

## Recommended launch math rules

- Treat **$16.50 CAC** as the rough Classic break-even ceiling in the current base case.
- Treat **$4.50 CAC** as the Classic “healthy paid acquisition” target if we want 30% margin after CAC.
- Do not run Meta/Google scale tests until hand-selling/influencer seeding shows CAC can plausibly land below those numbers.
- If paid ads are tested, cap the first test at a deliberately small budget and judge on contribution margin, not revenue.

## Data we still need to replace assumptions

1. Actual FAL/Seedream/FAL-edit/Nano-Banana-underlying-model invoice costs, including failures and retries.
2. Actual fallback rate from Seedream to FAL edit (`fal_edit`).
3. Average regenerated pages per customer after proof-review flow.
4. Real Lulu quote for premium hardcover with current package/page count/shipping/tax.
5. Classic Lulu costs across destination states/countries.
6. Real refund/reprint/chargeback rate from first 10–20 orders.
7. Support minutes per order, especially around photo upload, proof approval, and print exceptions.
8. Actual Vercel Blob/runtime costs at production volume.

## Operational decision

My recommendation: **do not reopen HSB for broad traffic yet**, but this model does *not* say the business is dead. It says Classic can work if:

- face fidelity is gift-quality,
- recovery/support time is bounded,
- refund/reprint rate stays under control,
- and CAC is proven through non-scalable channels before paid ads.

CSV model: `hsb-unit-economics-scenarios-2026-05-14.csv`
