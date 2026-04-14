# CLAUDE.md — HeroStoryBooks Build Instructions

You are building HeroStoryBooks.com — a personalized children's storybook e-commerce site.
Read `PRD.md` for full spec before touching any code.

## Tech Stack
- **Next.js 14** (App Router) + **TypeScript** + **Tailwind CSS**
- **Framer Motion** for animations (install: `npm install framer-motion`)
- **shadcn/ui** for base components (install: `npx shadcn@latest init`)
- **Deploy:** Vercel

## UI Component Strategy

### 21st.dev Magic Components (install when API key available)
**21st.dev key is LIVE** (`TWENTYFIRST_API_KEY` in env). Use 21st.dev for pre-built, polished components:
- Accordion FAQ: `npx shadcn@latest add "https://21st.dev/r/accordion"`
- Hero section: `npx shadcn@latest add "https://21st.dev/r/hero-section"`
- Pricing cards: `npx shadcn@latest add "https://21st.dev/r/pricing"`
- Multi-step form: `npx shadcn@latest add "https://21st.dev/r/stepper"`
- Image gallery: `npx shadcn@latest add "https://21st.dev/r/gallery"`
- File upload: `npx shadcn@latest add "https://21st.dev/r/file-upload"`

If API key is NOT available, build components from scratch with Tailwind. Don't block on 21st.dev.

### Framer Motion Usage
Use for:
- Hero headline entrance (fade up, stagger children)
- "How It Works" steps (scroll-triggered fade in, left/right alternating)
- Sample pages gallery (hover zoom, lightbox open/close)
- Multi-step form transitions (slide left/right between steps)
- CTA button (subtle pulse on idle, scale on hover)

Keep animations tasteful — this is a children's product site, not a portfolio. Fast durations (0.3–0.5s), ease-out.

## Design Principles
- **Warm, magical, trustworthy** — parents are buying for their kids
- Color palette: warm cream backgrounds, deep forest green accents, golden CTA buttons
- Typography: large, readable, friendly (use `font-serif` for headlines, `font-sans` for body)
- Mobile-first — most parents will order from their phone
- Accessibility matters: alt text on all images, keyboard nav on forms, sufficient contrast

## Page Architecture

```
src/app/
  page.tsx              ← Landing page (Hero → How It Works → Samples → Pricing → FAQ → Footer)
  order/page.tsx        ← Multi-step order form (5 steps)
  thank-you/page.tsx    ← Post-purchase confirmation

src/components/
  ui/                   ← shadcn components
  landing/
    Hero.tsx
    HowItWorks.tsx
    SampleGallery.tsx
    Pricing.tsx
    FAQ.tsx
    Footer.tsx
  order/
    OrderForm.tsx
    steps/
      ChildInfo.tsx
      StoryCustomization.tsx
      PhotoUpload.tsx
      YourInfo.tsx
      Checkout.tsx
```

## Placeholder Assets
- Use placeholder images from `https://placehold.co/` for book spreads and samples
- Drop real PuLID images into `public/samples/` when available
- Art style previews: generate 3 placeholder thumbnails (watercolor, storybook, cartoon)

## Stripe Integration
- Stripe keys are in env (`FS_STRIPE_SECRET_KEY` for Fresh Start, use `OT_STRIPE_SECRET_KEY` for Overtaxed)
- For HSB: create a NEW Stripe product in the dashboard — do NOT reuse Fresh Start or Overtaxed keys
- For now: render a "Coming Soon" or Stripe Payment Link button as placeholder
- When Alexy provides `HSB_STRIPE_SECRET_KEY` → wire up Stripe Checkout session

## Environment Variables Needed
```
TWENTYFIRST_API_KEY=    ← ✅ CONFIGURED (in ~/.zshrc and MCP server)
HSB_STRIPE_SECRET_KEY=   ← pending (new product in Stripe dashboard)
```

## Build Order
1. Install deps: `npm install framer-motion` + `npx shadcn@latest init`
2. Global styles in `src/styles/globals.css` (color vars, font stack)
3. Landing page — all sections, mobile responsive
4. Order page — multi-step form with validation
5. Thank You page — simple confirmation
6. Wire up Stripe when key is available
7. Deploy to Vercel: `vercel --prod`

## Git Discipline
- Commit after each page/section is complete
- Branch: `main` only (solo project, no PRs needed)
- Commit message format: `feat: add [section name]`

## Do NOT
- Do not use `create-next-app` — scaffold already exists
- Do not overwrite `tailwind.config.js` or `next.config.js` without reading them first
- Do not install conflicting CSS frameworks (no Bootstrap, no Chakra UI)
- Do not ask questions — read PRD.md and make reasonable decisions
