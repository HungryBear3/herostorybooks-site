# GPT vs FLUX Image Eval

Use this when GPT subscription samples look better than the production-candidate FLUX.2 pipeline and we need a side-by-side decision artifact.

## Folder Layout

Private eval artifacts live outside the public app tree:

```text
../artifacts/hsb-family-photo-eval-2026-05-25/
  inputs/          # private family refs; do not commit
  prompts/         # scene prompts
  outputs/         # FLUX.2/fal outputs
  gpt-exports/     # manually exported GPT subscription images
  contact-sheets/  # generated local HTML sheets
```

## Add GPT Outputs

Export GPT images into `gpt-exports/` with names that include the scene slug:

```text
01-bedtime-room.png
02-dinosaur-clearing.png
03-family-reading.png
family-reading-v2.png
```

The script matches by normalized scene slug, so numeric prefixes are optional.

## Build Contact Sheet

From the repo root:

```bash
node scripts/build-image-eval-contact-sheet.mjs \
  --run ../artifacts/hsb-family-photo-eval-2026-05-25
```

Output:

```text
../artifacts/hsb-family-photo-eval-2026-05-25/contact-sheets/gpt-vs-flux2-contact-sheet.html
```

Open the HTML locally and score each scene on:

- Child likeness
- Watercolor / book feel
- Family + dog realism
- Text artifacts avoided
- Gift-quality confidence

## Decision Rule

Prefer the provider that can repeat recognizable child identity across scenes while staying gift-quality. A strong one-off image is not enough for production unless the workflow can reliably repeat it.

Keep contact sheets and source images private. Do not copy family photos, child likeness outputs, or generated eval sheets into `public/`.
