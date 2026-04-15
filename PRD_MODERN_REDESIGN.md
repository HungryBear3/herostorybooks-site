# HeroStoryBooks Modern Redesign PRD

## Executive Summary
Current HSB site is functional but visually dated (1990s aesthetic). Competitors use modern, clean design with:
- Clean white/light backgrounds with strategic color accents
- Large, bold typography (serif + sans-serif combinations)
- Minimal layouts with tons of whitespace
- Emotional storytelling with real customer testimonials + faces
- Interactive product previews
- Trust badges prominently displayed above the fold
- Mobile-first responsive design

**Goal:** Redesign HSB to compete with Wonderbly, Hooray Heroes, LionStory, WonderWraps on visual appeal while maintaining warm, magical storybook aesthetic.

---

## Competitive Landscape

### Top 3 Design Leaders
1. **Wonderbly** — Clean, spacious hero. Serif headlines ("Tell mom what she means to you"). Minimal color palette. Strong CTA buttons. Trust section: "10M+ happy readers since 2013"
2. **Hooray Heroes** — Bold typography. Heavy use of character illustrations as hero section backdrop. Clear step-by-step flow. Customer testimonials with avatars/names
3. **LionStory** — Emotional positioning ("Raising emotionally intelligent children"). Serif headlines. Warm color palette (sage greens, warm golds). Strong emphasis on learning outcomes + values

### Common Modern Patterns
- ✅ Large hero section (60-70vh) with compelling headline + subheading
- ✅ High-quality product photography or illustration (not sketches)
- ✅ Step-by-step "How It Works" reduced to 3-4 steps, inline with product flow
- ✅ Customer testimonials with real names + locations (builds trust)
- ✅ Pricing tiers laid out clearly (often with recommended tier highlighted)
- ✅ FAQ section at bottom (not intrusive)
- ✅ Newsletter signup integrated throughout
- ✅ Mobile-first responsive design (critical for conversion)
- ✅ High contrast buttons (bold colors, clear CTAs)
- ✅ Whitespace — lots of breathing room, not cramped

---

## Design Direction for HSB

### Visual Style
- **Color Palette:**
  - Primary: Warm gold (`#D4AF37` or `#C9A961`)
  - Secondary: Deep forest green (`#1B4D3E`)
  - Accent: Soft lavender (`#D4C5F9`)
  - Neutral: Off-white backgrounds (`#F9F8F6`), charcoal text (`#2C2C2C`)
  - Use restraint — max 2-3 colors per section

- **Typography:**
  - Serif headlines (e.g., Playfair Display, Garamond) — convey premium, magical feel
  - Sans-serif body copy (e.g., Inter, Sohne) — clean, readable
  - Font sizing: Large headlines (3xl-4xl), clear hierarchy

- **Whitespace:**
  - Min 40px padding around major sections
  - Min 20px gap between text elements
  - Breathing room = premium feel

### Layout Structure

#### 1. Hero Section
- 70vh height, centered on desktop
- Compelling headline (e.g., "Every child deserves to be the hero of their own story")
- Subheading (e.g., "Personalized storybooks that celebrate your child's magic")
- High-quality book mockup or illustration (right side, desktop; below headline, mobile)
- Primary CTA button ("Create Your Book Now")
- Secondary CTA link ("See how it works")
- Trust badge: "✨ Join 50,000+ families who've created magical books"

#### 2. Value Proposition (below hero)
- 3-4 value pillars:
  - 🎨 "Personalization That Matters" — child's name, photo, details
  - ⚡ "Fast & Easy" — create in 10 minutes
  - 🎁 "Perfect for Every Occasion" — birthdays, holidays, gifts
  - 💚 "Values-Driven" — emotional intelligence, inclusivity
- Short description + icon for each
- No more than 2 sentences per pillar

#### 3. How It Works
- Simplify to 3 steps (not 4-5):
  1. Choose your book
  2. Add your child's details
  3. Preview & order
- Each step: icon + headline + 1-line description
- Mobile: Stacked vertical, clear spacing

#### 4. Featured Books / Sample Gallery
- Show 3-4 high-quality book samples
- Each: thumbnail image + title + short description + "Personalize" CTA
- On hover (desktop): slight scale/shadow effect
- Mobile: swipeable carousel or stacked cards

#### 5. Social Proof / Testimonials
- Min 3 customer testimonials
- Each includes:
  - Customer name + location
  - 5-star rating
  - Real quote (short, 1-2 sentences)
  - Optional: customer avatar/photo
- Layout: Grid (3 columns on desktop, 1 column mobile)

#### 6. Pricing Tiers
- 3-4 tiers displayed clearly
- Recommended tier should stand out (border, shadow, or slight background color)
- Price-per-book clearly visible
- Features list for each tier (bullet points, not paragraphs)
- CTA button per tier

#### 7. Trust/Social Proof Footer
- Metrics:
  - "50,000+ books created"
  - "4.8/5 average rating"
  - "Ships within 7 days"
  - "100% satisfaction guarantee"
- Awards/certifications if applicable
- Newsletter signup CTA

#### 8. Footer
- Links (About, FAQ, Contact, Privacy, Terms)
- Social media links
- Newsletter signup (optional duplicate)

---

## Design Constraints (from current HSB PRD)
- **Font:** Playfair Display required for headlines (already set)
- **Colors:** Use --lavender, --deep-gold, --forest from existing tailwind config
- **Animations:** Framer Motion for all interactive elements
- **Components:** Must include 'use client' directive for Next.js 14 App Router
- **Build:** npm run build must pass with 0 errors

---

## Technical Implementation

### Components to Create/Refactor
- `Hero.tsx` — Large hero with book mockup + dual CTAs
- `ValueProposition.tsx` — 3-4 value pillars with icons
- `HowItWorks.tsx` — Simplified 3-step process
- `FeaturedBooks.tsx` — High-quality book samples (replace current SampleGallery)
- `Testimonials.tsx` — Customer social proof
- `Pricing.tsx` — Pricing tiers (likely refactor existing)
- `TrustBadges.tsx` — Metrics + social proof footer
- `Newsletter.tsx` — Email signup (optional)

### Styling
- Tailwind CSS for layout + spacing
- Custom CSS for animations (Framer Motion)
- Dark mode support (optional, but modern sites have it)
- Responsive breakpoints: mobile (375px), tablet (768px), desktop (1024px+)

---

## Success Metrics
1. ✅ Site load time < 2s (Vercel + image optimization)
2. ✅ Mobile responsiveness (all sections stack cleanly)
3. ✅ Hero section converts (clear, compelling CTA)
4. ✅ npm run build passes (0 errors)
5. ✅ Vercel deployment succeeds (no 500 errors)
6. ✅ Design passes accessibility check (WCAG AA minimum)

---

## Timeline
- **Phase 1:** Refactor Hero + Value Proposition (1-2 days)
- **Phase 2:** Refactor How It Works + Featured Books (1 day)
- **Phase 3:** Add Testimonials + Trust Badges (1 day)
- **Phase 4:** Refactor Pricing section (1 day)
- **Phase 5:** Testing + bug fixes (1 day)
- **Deployment:** Once Penny provides copy + final approval

**Start once:** Penny provides modern copy/messaging for hero + value props

---

## Next Steps
1. ✅ Abigail shares SWOT + competitor analysis (done)
2. ⏳ Penny provides modern copy/messaging
3. 🛠️ Max begins implementation (this PRD is the blueprint)
4. 🧪 Test across devices
5. 🚀 Deploy to production
