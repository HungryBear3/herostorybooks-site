# HSB FLUX.2 Photo Eval Runbook

Status: required before new HSB image-pipeline/product code.

## Purpose

Decide whether AI-from-photo is gift-quality enough for HeroStoryBooks before building infrastructure around it.

Primary test lane: fal.ai FLUX.2 [pro] multi-reference.

Fallback only if primary fails: PuLID + FLUX.1 dev via fal hosted endpoint.

Do not use Gemini / Nano Banana for HSB. Do not use OpenAI as production primary.

## Consent

Use only photos from friends/family who give explicit written consent for this internal model evaluation. Do not use photos scraped from social media or public examples.

Keep each case in a private eval folder with:

- Original uploaded photo(s)
- Consent note
- Prompt set used
- Generated outputs
- Parent/non-technical reviewer scores
- Final pass/fail note

## Step 1: $5 Parent Sanity Check

Use 5 consented real child photos from different ages, skin tones, lighting conditions, and photo quality.

For each child, generate 3 illustrations:

1. Forest doorway
2. Bedtime room
3. Dinosaur clearing

Ask a parent or close family member:

> Would you give this as a gift?

If the honest answer is mostly "no" or "kind of, but it is not my kid," stop. Do not integrate.

## Step 2: Full 10-Photo Eval Set

Use these cases:

1. Light-skinned 4-year-old, clean studio-quality photo, neutral background, eyes to camera.
2. Dark-skinned 6-year-old, iPhone-casual, slight smile, missing front tooth.
3. East-Asian 3-year-old, warm indoor tungsten light, soft shadows, slightly off-camera.
4. South-Asian 8-year-old with glasses, mixed natural and artificial light.
5. Light-skinned 18-month-old toddler, baby fat, no defined jaw, sleeping or half-smile.
6. Mixed-race 5-year-old, freckles, red hair, harsh outdoor sunlight.
7. Black 10-year-old girl with braids, cluttered indoor background.
8. Hispanic 7-year-old boy with buzz cut, school portrait/fake blue backdrop.
9. Light-skinned 12-year-old with adult-like bone structure and acne.
10. Mom in her 30s holding her 2-year-old, two-face case.

## Reference Inputs

For FLUX.2 [pro] multi-reference, use:

- 3-5 photos of the child where available.
- 1 required front-facing photo.
- 1 optional side or three-quarter angle.
- 2-3 style-only watercolor panels from the locked Lukas watercolor direction.

Do not include story text in reference images. Style references should teach watercolor texture, palette, and lighting, not page layout.

## Prompt Template

Use this base prompt and substitute only the bracketed fields:

```text
Create a traditional watercolor children's picture-book illustration of the child from the identity reference photos as the same recognizable child.

Scene: [SCENE]

Identity requirements:
- Preserve the child's apparent age, face shape, skin tone, hair color, hair style, eye spacing, and distinctive features from the reference photos.
- Do not beautify, age up, age down, change ethnicity, change hair texture, remove glasses, remove braids, remove freckles, or erase visible distinctive features unless the scene naturally hides them.
- The child should look like the same child across every illustration in this set.

Style requirements:
- Traditional watercolor on warm cream paper.
- Warm forest, ochre, terracotta, and dusk palette.
- Golden side/back light.
- Soft painterly texture, not airbrushed, not anime, not flat cartoon.
- Child lower third composition when the scene allows.
- Leave clean negative space for later typography when the scene allows.

Composition:
- No readable text, captions, letters, book pages, signage, logos, UI, or watermarks inside the image.
- No extra children unless the scene explicitly asks for family.
- Keep hands simple and natural; avoid close-up fingers unless required.

Output should feel like a premium printed children's book illustration that a parent would recognize as their child.
```

## Scene Suite

Run the same 20 scenes for every photo:

1. Forest doorway after rain
2. Bedtime room with moonlight
3. Dinosaur clearing with a gentle T-rex
4. Kitchen table with a tiny map
5. Spaceship window looking at Earth
6. Underwater coral garden
7. Riding a dragon over hills
8. Library aisle with glowing shelves
9. Snowy path with lantern
10. Treehouse at sunset
11. Castle garden with leafy crown
12. Friendly robot workshop
13. Meadow with butterflies
14. Pirate ship deck at sunrise
15. Mountain trail with clouds below
16. Rainy city sidewalk with umbrella
17. Campfire with family silhouettes in background
18. Secret cave with crystal light
19. Back porch with fireflies
20. Final quiet portrait holding a small keepsake

## Scoring

Use blind scoring by at least one non-technical reviewer. A parent or grandparent is best.

Score every output from 1 to 5:

- Likeness to source photo: "Is this clearly the same child?"
- Cross-page consistency: "Do these panels look like the same child across the set?"

Also mark:

- Glasses preserved: yes/no/not applicable
- Braids preserved: yes/no/not applicable
- Freckles or distinctive feature preserved: yes/no/not applicable
- Parent gift answer: yes/no/maybe

## Go / No-Go

Proceed to engineering only if:

- At least 80% of test photos score 4/5 or higher on likeness.
- At least 70% of test photos score 4/5 or higher on cross-page consistency.
- The 18-month-old toddler passes.
- The dark-skinned 6-year-old passes.
- Glasses survive at least one scene.
- Braids survive at least one scene.

If FLUX.2 [pro] and fallback PuLID + FLUX.1 dev both miss these bars after one week of prompt/reference-selection iteration, pivot away from AI-from-photo and evaluate a template + color-picker personalization model.
