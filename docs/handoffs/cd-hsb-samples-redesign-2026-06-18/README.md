# CD Handoff - HSB Samples Page Redesign

Date: 2026-06-18
Project: Hero Story Books
Page: `/samples`
Preview URL during handoff: `http://100.81.162.57:4322/samples`

## Goal

Redesign the samples page so the page feels like one coherent trust-and-sample experience, not several asset lanes stacked together.

The current page has useful material:

- A current digital proof sample: `Lukas and the Kind Dragon` v5.
- Real photos from a recently printed hardcover sample.
- Older dinosaur proof material that can remain as supporting history.

The redesign should organize those into a clearer hierarchy:

1. Lead with the best current digital sample.
2. Use real hardcover photos as tactile proof that these become physical books.
3. Keep older sample/proof material subordinate, not competing with the current sample.

## Preserve

- The current sample should remain `Lukas and the Kind Dragon`.
- The page must say this is a digital sample / illustrative sample, not a delivery promise.
- The page must say every paid book gets its own proof and approval pass before delivery or print.
- Real hardcover photos can be used, but only as supporting printed-book context.
- No public ERIC50 copy.
- No same-day, guaranteed delivery, ready-to-print, Father's Day, or broad availability claims.
- No customer surname or private family details in visible copy or asset captions.

## Redesign Direction

Make the page feel like an editorial product page for a premium children's keepsake book.

Suggested structure:

1. Hero / intro
   - One concise headline around seeing a real sample.
   - Supporting copy: digital sample shown for illustration; each new book gets proof review.
   - Primary visual could be the Kind Dragon cover or a composed spread.

2. Current sample story
   - Feature the Kind Dragon cover and selected pages.
   - Show 4-5 pages as a story arc, not a generic grid.
   - Make page captions quieter and less repetitive.

3. Printed hardcover proof
   - Use real hardcover photos as a tactile, object-focused section.
   - Consider one large cover-in-hand photo plus a tight row of open-spread details.
   - Copy should frame this as real sample photography, not a guarantee every book is identical.

4. Proof-before-print reassurance
   - Short, elegant section explaining that parents review a proof before anything physical is printed.
   - Avoid over-explaining AI, production mechanics, or policy detail.

5. Older supporting proof
   - Keep the older dinosaur sample as a smaller archive/supporting section.
   - It should not visually compete with the Kind Dragon sample.

## Assets Included

`assets/kind-dragon-v5/`

- `cover.jpg`
- `01-scale-in-the-creek.jpg`
- `04-first-clue.jpg`
- `13-big-dragon-problem.jpg`
- `19-dragon-lantern.jpg`
- `23-bravest-magic.jpg`
- `contact-sheet.jpg`

`assets/hardcover-photos/`

- `hsb-lukas-dino-photo-cover.jpg`
- `hsb-lukas-dino-photo-feast.jpg`
- `hsb-lukas-dino-photo-hands-1.jpg`
- `hsb-lukas-dino-photo-hands-2.jpg`
- `hsb-lukas-dino-photo-parade.jpg`

`screenshots/`

- `samples-desktop-1440.png`
- `samples-mobile-390.png`

`source/`

- `page.tsx` current route metadata wrapper.
- `editorial-site.tsx` current page/component source.
- `kind-dragon-v5-website-sample-lane-2026-06-18.md` current asset/copy notes.

## Implementation Notes

- Current route: `src/app/samples/page.tsx`.
- Main rendered page component: `EditorialSamplesPage` in `src/components/editorial-site.tsx`.
- Current sample helper components: `KindDragonFeature`, `HardcoverPhotoSection`, `SampleCard`.
- Existing tests include `tests/editorial-samples-copy.test.ts`.
- Keep local changes only unless Alexy explicitly approves production deploy/alias.

## Acceptance Criteria

- Desktop and mobile feel like one designed page.
- The digital sample, hardcover photos, and older proof each have a clear role.
- No visible text overlap at 390px or 320px widths.
- Images are not broken or badly cropped.
- Copy keeps the proof-before-print boundary clear.
- Forbidden claims are absent: `ERIC50`, `same-day`, `guaranteed`, `ready-to-print`, `Father's Day`.
