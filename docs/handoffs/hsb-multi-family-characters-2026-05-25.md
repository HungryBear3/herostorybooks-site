# Claude Code Prompt - HSB Multi-Family Character Books

You are Claude Code working in the isolated worktree:

`/Users/abigailclaw/cc-worktrees/hsb-multi-family-characters`

Task: wire the first safe version of a multi-family-character book feature for HeroStoryBooks, aimed at the Father's Day sales push.

Context:
- Production is currently live at `https://herostorybooks.com` with the Father's Day/voice-note release.
- The public product is currently strongest as **one personalized child hero** from the uploaded child photo, with voice/story notes influencing writing.
- Alexy wants a differentiating upgrade: books can include Dad, Mom, siblings, grandparents, or the whole family as story characters.
- Current checkout/order/story code assumes one hero child in many places:
  - `src/app/checkout/checkout-form.tsx`
  - `src/app/api/order/route.ts`
  - `src/lib/orders.ts`
  - `src/lib/story-generator.ts`
  - `src/lib/checkout-flow.ts`
  - related tests under `tests/`
- The worktree is intentionally dirty because it mirrors the just-shipped Father's Day/voice production state plus local WIP. Do not revert unrelated changes.

Hard boundaries:
- Do **not** deploy production.
- Do **not** run live Stripe, Lulu, fulfillment, payment, email, social posting, or customer-data actions.
- Do **not** use Gemini/Nano Banana for HSB image generation.
- Do **not** add paid image-generation calls.
- Do **not** claim photo-real likeness for multiple family members unless the implementation truly supports and verifies multi-reference photos end-to-end.
- Do **not** alter the currently live one-child checkout path in a way that can block normal orders.
- Keep work scoped to this isolated worktree and this feature lane.

Product decision for this first pass:
- Ship the feature as **narrative family-character customization first**.
- The uploaded child photo remains the required visual identity anchor.
- Supporting family members can be added by name/role/pronouns/notes and woven into the story prose, dedication, and scene planning.
- Marketing-safe wording: "starring your child, with Dad, Mom, siblings, grandparents, or the whole family woven into the story."
- Avoid wording like "upload photos for every family member" unless you deliberately add a fully gated UI/data path for secondary photos and clearly mark them as optional/reference-only, not guaranteed likeness.

Implementation goals:
1. Add a small typed family-character model, for example:
   - `role`: dad, mom, parent, sibling, grandparent, pet, other
   - `name`
   - `relationshipLabel`
   - `pronouns`
   - `notes`
   - optional `isGiftRecipient` / `appearsInStory`
2. Add checkout UI for "Who else should appear in the story?" with quick choices for Dad, Mom, sibling, grandparent, and whole family.
   - Keep it optional and compact.
   - Let the buyer add 0-4 supporting characters.
   - Make Father's Day ergonomic: one tap should add Dad as gift recipient/supporting character.
   - Preserve mobile layout at 320px.
3. Submit and persist `familyCharacters` through `/api/order`.
   - Validate/truncate inputs server-side.
   - Store on `OrderRecord` in a backward-compatible way.
   - Existing orders with no family characters must behave exactly as before.
4. Feed family-character context into story generation/planning.
   - Use a bounded helper like `familyCharactersBlock(order)`.
   - Keep instructions additive and safe.
   - Include Dad/Mom/family in the story naturally without turning every page into a cast list.
   - If Dad is marked gift recipient, story/dedication should feel Father's Day appropriate.
5. Update customer-facing copy only where appropriate:
   - "Fully customizable" FAQ can mention family characters.
   - Father's Day route/home can say the story can feature Dad/family in the prose.
   - Do not overpromise multiple photo likeness.
6. Tests:
   - server parses/validates/persists family characters
   - invalid/oversized family-character payload is bounded and does not crash checkout
   - no-family order path remains unchanged
   - story prompt/planning includes bounded family character context when present
   - Father's Day/Dad character copy does not imply multi-photo likeness
   - mobile/checkout rendering does not overflow if feasible with Playwright

Verification:
- Run focused tests first.
- Then run `npm test` if feasible.
- Run `npm run build` if feasible.
- Create a preview deployment only if checks pass and the worktree is deployable. Preview only, no `--prod`.
- If preview deploys, run a route/content smoke on `/`, `/fathers-day`, `/checkout`, and `/pricing`.

Deliverables:
- A short final report in the tmux session with:
  - changed files
  - tests/build results
  - preview URL if created
  - any residual risks or product decisions needed before production
  - clear statement that production/Stripe/Lulu/social were untouched
