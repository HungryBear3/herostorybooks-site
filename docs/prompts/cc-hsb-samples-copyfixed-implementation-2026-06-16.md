# CC prompt — HSB /samples copy-fixed implementation

You are implementing a safe `/samples` page refresh for Hero Story Books.

## Hard stops

- Do **not** deploy production, alias domains, mutate env vars, touch Stripe/customer/order/proof/print/Lulu/RPI/provider/social state, or send emails.
- Do **not** reintroduce fixed price/SLA/free-revision/shipping claims into `/samples` unless dynamically sourced from existing source-of-truth code and explicitly noted in the PR.
- Do **not** use title pages, dedication pages, back-cover wrap, blank/end pages, or printer filler as marketing samples.
- Do **not** label French Fry City clean art as `print proof`, `real sample book`, or physical book proof.
- Do **not** imply exact child likeness. Use approved language: `recognizably inspired by your child` and `reference photos guide the art — a storybook character, not an exact portrait`.

## Inputs

Review/handoff packet:
- `/Users/abigailclaw/.openclaw/workspace/rex/ops/hsb-samples-cc-handoff-copyfixed-2026-06-16.md`

Copy-fixed design artifact:
- `/Users/abigailclaw/Downloads/Samples Page Directions (standalone)-2.copyfixed.html`

Renderable QA artifact:
- `/Users/abigailclaw/.openclaw/workspace/rex/ops/hsb-samples-directions-copyfixed-renderable-2026-06-16.html`

Asset packet:
- `/Users/abigailclaw/.openclaw/workspace/rex/ops/hsb-samples-asset-packet-2026-06-16/`

Current repo source facts:
- Current checkout prices live in `src/app/checkout/checkout-form.tsx`; do not duplicate them into `/samples` unless imported/wired from source-of-truth.
- Print preview promise lives in `src/lib/checkout-flow.ts` as `PRINT_PREVIEW_PROMISE`.

## Implementation scope

Implement an A-led `/samples` refresh with C gallery polish.

Required sections:
1. Proof-first hero using physical Dinosaurs book photo.
2. Trust strip with safe copy only:
   - `You approve every page before we print`
   - `Timing shown before order`
   - `Proof revisions before print`
3. Real sample book photo carousel using physical Dinosaurs photos only.
4. Clean interior page band using Dinosaurs and French Fry City sample art.
5. `One child. Two real adventures.` beat with explicit caveat that current examples both star Lukas.
6. How-it-becomes-real steps.
7. Honest expectations block:
   - `Printed and bound as a keepsake. Made to be read for years.`
   - `Reference photos guide the art — a storybook character, not an exact portrait.`
   - `Proof timing is shown before you order; print and delivery timing are shown before checkout.`
8. CTA copy:
   - `See current pricing · approve before we print`
   - no hardcoded `From $19`, `$39`, `$64`, or equivalent.
9. C-style editorial gallery clusters:
   - `King of the Dinosaurs`
   - `French Fry City`

Hold/exclude:
- Direction B photo→story reference-photo module unless left as an abstract/non-shipping placeholder.
- Any motion/page-flip engine beyond CSS/scroll-snap.
- Different-child range claims.

## Asset rules

Allowed `real sample book` / physical proof assets:
- `photoParade`
- `photoCover`
- `photoFeast`
- `photoHands1`
- `photoHands2`

Allowed clean sample art assets:
- King of the Dinosaurs clean/exported pages: label as `sample interior page` or `sample cover` only unless visibly physical photo.
- French Fry City assets: label as `sample interior page` / `clean art from a real title` only.

Excluded source files from asset packet:
- `hsb-lukas-print-dedication.jpg`
- `hsb-lukas-print-cover-wrap.jpg`
- `hsb-lukas-print-back-cover.jpg`

## Required verification before PR/handoff

Run:
- focused tests relevant to `/samples` if present
- `npm run build`
- `git diff --check`
- visual QA at mobile width around 390px and a desktop width
- string scan proving none of these are present in `/samples` output/source:
  - `US shipping included`
  - `Free revisions`
  - `From $19`
  - `$39 softcover`
  - `$64 hardcover`
  - `2 business days`
  - `Most parents read it for years`
  - `King of All Dinosaurs`
  - `and the French Fry City`
  - `exactly like your child`

## Output expected

Open a PR against `hsb/deploy-candidate-20260602` or report a clean local diff if PR creation is not available.

Final report must include:
- branch name / PR URL if created
- files changed
- verification commands + results
- screenshots or paths for visual QA
- explicit statement: no prod/customer/payment/proof/print/social mutation
