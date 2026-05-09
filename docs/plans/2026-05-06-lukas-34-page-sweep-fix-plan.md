# Lukas 34-page sweep fix plan — updated 2026-05-06

Scope: fix review-blocking issues before any new Lulu submission/payment.
Order: `ord_f5dcffc8a0b84d06`.
Status: PDF may be visually improved, but the book is **not shipping-ready**.

## Hard rules
- No Lulu submission or payment until Alexy explicitly approves the final revised proof.
- Preserve recovery backups and existing order/job evidence.
- Publish rebuilt proof/interior/cover artifacts under unique no-cache filenames every round.
- Review page must point at the newest proof URL before asking Alexy to approve.

## P0 — must fix before shipping

1. **Duplicate art on pages 7 & 9**
   - Regenerate one of them, preferably p9, so parent does not read it as a print mistake.

2. **Page 17 character drift**
   - Full regen with locked likeness/character anchor.
   - Must remove ghost-face edge artifact.

3. **Anatomy/continuity bugs**
   - p5: feather/parrot merge — regenerate or repair.
   - p11: remove wristbands/bracelets.
   - p14: correct face drift.
   - p16/p17: remove ghost faces; crop only if lossless and composition still works, otherwise regenerate.

4. **Interior style split**
   - Unify all 24 story pages toward watercolor/soft storybook style.
   - Use cover/p19/p21/p26/p27/p34 as current style anchors.
   - Do not leave obvious cel-shaded pages mixed with watercolor pages.

5. **End-matter structure**
   - Remove or intentionally fill blank pages 29–30.
   - Move keepsake page into a natural position: before “The End” or immediately after dedication.
   - Rebuild full proof/interior sequence and contact sheet.

6. **Approval safety UX**
   - Add confirmation modal for “Approve whole book & send to print.”
   - Modal must make clear: approval means the proof is accepted and the order may be sent to print.

## P1 — high impact

7. **Threatening beats**
   - p13: soften bees/wasps into friendly butterflies/fireflies/dragonflies, or resolve narratively.
   - p18: make leopard/jaguar relaxed/friendly, not stalking/threatening.

8. **Secondary duplication p8/p22**
   - Refresh one if it still reads repetitive after P0 regens.

9. **Hero prop consistency p23**
   - Listening stone should match the larger textured hero stone used on p21/p22/p27/p34.

10. **Page 26 family continuity**
   - Either remove family scene to preserve solo-adventure framing, or seed family earlier so it lands emotionally.

11. **Review UX improvements**
   - Per-page acceptance state visible on thumbnails.
   - Add undo/unaccept page if feasible.
   - Add “Accept all remaining.”
   - Revisit proof PDF public URL/token posture; current URL is guessable public Blob, review route is tokenized but direct PDF is not.

## P2 — polish

12. Replace navy/gold top bars with designed end-matter, e.g. small watercolor flourish.
13. Merge “About This Book” + “A Quiet Note” into one closing page.
14. Add visible writing space on “A Memory To Keep.”
15. Move story text out of cream overlay cards into light/safe zones of the art where possible.

## Back-cover no-card test

Alexy’s direction: remove the cream card from back-cover blurb if legibility holds.

Implementation notes:
- Place blurb directly in upper-left sky region, above hat/leaves/ruins.
- Explicit max width: about 60–65% of cover width.
- Fixed vertical anchor: ~8–10% from top.
- Use deeper navy/ink text, medium weight or slightly increased letter spacing.
- Run contrast check; target ~4.5:1 minimum across text area.
- If contrast dips, use a very subtle white glyph halo/glow (1–2px, ~30% opacity), not a card.
- Optional A/B: no-card vs 15–20% white wash.

## P3 — content

16. Tighten back-cover blurb around the “stones that listen” hook.
17. Strengthen story arc: current p13 → bedroom ending lacks a clear stakes/resolution beat. Consider one tighter narrative beat rather than adding random danger.

## Recommended execution order

1. Deterministic repo/UI/PDF work:
   - approval confirmation modal
   - end-matter ordering
   - memory writing space
   - merged closing note
   - back-cover no-card/contrast-safe text treatment
2. Image-regeneration batch:
   - p5, p9, p13, p14, p16, p17, p18, p23 minimum
   - plus p8/p22 and p26 if still needed
3. Rebuild proof/interior/cover under unique no-cache filenames.
4. Generate contact sheet and run visual QA against this checklist.
5. Update review order pointer only after artifacts pass QA.
6. Alexy review.
7. Only after explicit approval: fresh Lulu submission/payment flow.
