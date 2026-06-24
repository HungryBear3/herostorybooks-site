# Kind Dragon v5 Website Sample Lane

Date: 2026-06-18
Status: local implementation prepared, production deploy not approved
Source order/run: `ord_1742e92a3f8a457a`

## Approval Scope

Alexy approved the Lukas / Kind Dragon v5 contrast packet for use as a public website sample artifact on 2026-06-18.

Approved:
- Website sample use for this artifact.
- Clear "digital sample / illustrative only" framing.
- Treat this as a replaceable sample artifact. Newer versions may supersede it when materially better and held to the same public-use framing.
- Supporting website use of recent printed hardcover photos as real-book context, framed as illustrative sample photos rather than a print-quality guarantee.

Not approved by this lane:
- Production deploy or apex/www alias changes.
- Customer proof release, proof email, delivery email, or order state advancement.
- Attaching artifacts to the live order.
- Print/Lulu/RPI/provider action.
- Stripe/payment/refund/coupon mutation.
- Social post, ad, creator push, email promo, or public `ERIC50` copy.

## Asset Map

Source directory:
`/Users/abigailclaw/.openclaw/workspace/hsb-bookgen-runs/ord_1742e92a3f8a457a/outputs/text-placement-packet-fullbleed-v5-contrast/`

Public web assets copied locally:
- `public/assets/kind-dragon-v5/cover.jpg`
- `public/assets/kind-dragon-v5/01-scale-in-the-creek.jpg`
- `public/assets/kind-dragon-v5/04-first-clue.jpg`
- `public/assets/kind-dragon-v5/13-big-dragon-problem.jpg`
- `public/assets/kind-dragon-v5/19-dragon-lantern.jpg`
- `public/assets/kind-dragon-v5/23-bravest-magic.jpg`
- `public/assets/kind-dragon-v5/contact-sheet.jpg`
- `public/assets/hsb-lukas-dino-photo-cover.jpg`
- `public/assets/hsb-lukas-dino-photo-feast.jpg`
- `public/assets/hsb-lukas-dino-photo-hands-1.jpg`
- `public/assets/hsb-lukas-dino-photo-hands-2.jpg`
- `public/assets/hsb-lukas-dino-photo-parade.jpg`

The full source packet remains local and should not be treated as proof delivery.

## Website Copy Rules

Use:
- "Digital sample - illustrative only"
- "Real book photos - illustrative only"
- "Current replaceable website sample"
- "Each paid book still gets its own proof and approval pass"
- "Newer proof packets can replace this when materially stronger"
- "Supporting sample photos, not a guarantee that every book will look identical"

Avoid:
- "Final customer proof"
- "Delivered book"
- "Ready to print"
- "Same-day delivery"
- "Guaranteed arrival"
- Public discount/coupon language.

## Implementation Notes

Current local code changes:
- `src/components/editorial-site.tsx` now introduces `kindDragonSample`.
- `src/components/editorial-site.tsx` also introduces `hardcoverPhotoSample` for the recent printed hardcover photos.
- Home sample preview uses Kind Dragon as the current website sample.
- `/samples` leads with the Kind Dragon packet, shows the printed hardcover photo strip as supporting real-book context, and moves the older dinosaur proof into a supporting "Previous print proof" section.
- The contact sheet is linked from the sample module for review context.

Suggested preview checks before any deploy approval:
- `npm test -- tests/editorial-samples-copy.test.ts tests/samples.test.ts`
- `npm run build`
- Local browser check of `/` and `/samples` at desktop and mobile widths.
- Confirm no public ERIC50 copy, no print/delivery promise, and no proof-release wording.

Production remains untouched until Alexy explicitly approves a named deploy target.
