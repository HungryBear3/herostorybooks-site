# HeroStoryBooks — Build Brief for Max

## Goal
Polish and complete the HeroStoryBooks site so it's ready to deploy to Vercel. The foundation is already built — components exist, routing works. This is a quality pass + gap-fill + deploy prep.

## Current State
- `/` — Landing page with Hero, HowItWorks, SampleGallery, Pricing, FAQ, Footer components
- `/order` — Order page exists
- `/thank-you` — Thank you page exists
- Tailwind + shadcn installed, TypeScript, Next.js App Router
- 3 sample images in `/public/`: sample1.png, sample2.png, sample3.png

## What Needs Doing

### 1. Audit & Polish Landing Page Components
Review each component in `src/components/landing/`:
- **Hero.tsx** — Does it have: big headline ("Your Child Is the Hero"), sub-headline, CTA button → /order?
- **HowItWorks.tsx** — 3 steps with icons (Tell us → Upload photo → Get book)?
- **SampleGallery.tsx** — Shows sample1.png, sample2.png, sample3.png in responsive grid?
- **Pricing.tsx** — 3 tiers: Digital $29 / Printed $49 / Bundle $59, each with "Order Now" → /order?
- **FAQ.tsx** — Accordion with 5 questions from PRD.md?
- **Footer.tsx** — © 2026 HeroStoryBooks, contact email placeholder?

Fix anything missing or broken. Make it look warm and magical (soft purples, peach, cream per PRD).

### 2. Complete the Order Page (`/order`)
The order page at `src/app/order/page.tsx` needs a clean multi-step form:
- Step 1: About the child (name, age, gender optional, favorite color, favorite animal)
- Step 2: Story customization (book type radio, theme dropdown, art style radio)
- Step 3: Photo upload (drag & drop, jpg/png, max 10MB, preview thumbnail)
- Step 4: Your info (name, email, shipping address conditional on print)
- Step 5: Checkout summary (selected tier, price, "Coming Soon" Stripe button)

Use shadcn components (Button, Input, Select, RadioGroup, etc.) — they're already installed.
State management with React useState. No backend needed — form just needs to be functional UI.

### 3. Complete the Thank You Page (`/thank-you`)
Simple, warm confirmation page:
- "Your storybook is being created! ✨"
- "Check your email in ~15 minutes for your personalized PDF"
- Nice illustration or emoji treatment, link back to home

### 4. Responsive + Mobile Check
Make sure all pages look good on mobile. Tailwind responsive classes throughout.

### 5. Vercel Deploy Prep
- Confirm `next.config.js` has no issues
- Check `package.json` build script works: `npm run build` should succeed with 0 errors
- No hardcoded API keys anywhere
- Add `.env.example` with placeholder keys:
  ```
  STRIPE_SECRET_KEY=
  STRIPE_PUBLISHABLE_KEY=
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
  ```
- Run `npm run build` and fix any TypeScript/lint errors

### 6. README
Update or create `README.md` with:
- What the site is
- How to run locally (`npm install && npm run dev`)
- Env vars needed
- Deploy to Vercel instructions

## Design Tokens (use these throughout)
```css
Primary purple: #5B4A8A
Accent peach: #E8A87C
Background cream: #FDF8F4
Text dark: #2D2D2D
```

## 21st.dev Magic Components
You have access to pre-built UI components via 21st.dev. API key: `$TWENTYFIRST_API_KEY` (in env).
Use for: pricing cards, FAQ accordion, step indicators, upload zones — anything that'd take time to build from scratch.

## Tech Constraints
- Next.js 14 App Router only (no Pages Router)
- TypeScript strict mode
- Tailwind CSS + shadcn/ui (already installed)
- No new dependencies unless absolutely necessary

## Done Criteria
- [ ] Landing page looks polished and complete
- [ ] Order form is 5 steps, functional UI (no backend needed)
- [ ] Thank you page complete
- [ ] `npm run build` passes with 0 errors
- [ ] README updated
- [ ] All changes committed with `git add -A && git commit -m "feat: complete HSB site for Vercel deploy"`

## Notify when done
When completely finished (build passing, all committed), run:
`openclaw system event --text "Max done: HSB site ready for Vercel deploy" --mode now`
