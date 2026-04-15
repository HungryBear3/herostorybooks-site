# PRD: HeroStoryBooks Design Overhaul

## Goal
Transform herostorybooks.com from a bare-bones skeleton into a premium, conversion-optimized site that feels like a high-end children's gift brand. Think: warm, magical, story-book aesthetic. Parents should feel the magic immediately.

## Available Tools
- **21st.dev Magic MCP**: TWENTYFIRST_API_KEY available via env var. Use `npx @21st-dev/magic@latest` to fetch and install premium pre-built UI components. Run `npx @21st-dev/magic@latest search "hero section"` etc.
- **fal.ai**: FAL_KEY available via env var. Use to generate 3-5 high-quality sample illustration images (storybook style, watercolor, children's book aesthetic) to replace the placeholder sample1/2/3.png files.
- **framer-motion**: Already installed. Use for scroll animations, staggered reveals, parallax effects.
- All existing brand colors: `--forest` (#2D5016 or similar), `--cream`, `--gold`, `--peach`

## Section-by-Section Requirements

### 1. HERO SECTION (biggest impact)
- Full-viewport hero with a warm gradient background (cream → light peach)
- Large serif headline: "Your Child Is the Hero" — animate letter by letter or word by word
- Subheadline with social proof: "Join 2,000+ families who made their child the star of the story"
- TWO CTAs side by side: "Order Your Book →" (primary, gold) + "See a Sample" (ghost button)
- Right side: a large, beautiful illustrated book mockup image (use fal.ai to generate OR a strong placeholder with CSS book effect)
- Floating trust badges below the fold: ⭐⭐⭐⭐⭐ "5-star reviews" | 🎨 "AI Illustrations" | 📚 "Ages 2-10" | 🚀 "Ships in 7-10 days"
- Add a subtle sparkle/star particle animation in the background (CSS or framer-motion)

### 2. HOW IT WORKS
- Replace vertical list with a 3-column card layout
- Each step gets an icon (lucide-react), large step number, title, description
- Cards should have a soft shadow, rounded corners, and a hover lift effect
- Add a connecting dotted line between steps on desktop
- Background: soft lavender (#F5F3FF) instead of dark forest green

### 3. SAMPLE GALLERY — CRITICAL: Generate Real Images
Use fal.ai to generate 3-4 storybook illustration samples:
```
Model: fal-ai/flux/schnell
Prompts to use:
1. "Watercolor children's book illustration, a brave young boy with curly red hair holding a glowing lantern exploring an enchanted forest, magical fireflies, warm golden lighting, storybook style, high quality"
2. "Watercolor children's book illustration, a little girl with braids riding a friendly dragon over colorful clouds and rainbow mountains, magical adventure, soft pastel colors, professional children's book art"
3. "Watercolor children's book illustration, a young child in an astronaut suit floating in a whimsical space with friendly planets, stars, and a smiling moon, pastel colors, storybook style"
```
Save generated images to /public/sample1.png, /public/sample2.png, /public/sample3.png (overwrite placeholders).

Gallery display:
- 3-column masonry or grid with rounded corners and shadow
- Hover: subtle scale + overlay with "See Full Story →" text
- Section title: "Every Child Deserves Their Own Adventure"
- Add a caption under each: story theme name

### 4. PRICING SECTION
- Redesign pricing cards to feel premium:
  - Each card: large icon at top, plan name, price with /book, feature list with ✓ checkmarks
  - "Bundle" card: visually elevated — slightly larger, golden border, "Most Popular" badge rotated 45°
  - Add subtle background gradient per card (cream → white)
  - Hover: lift shadow effect
  - Add urgency text under bundle: "🎁 Perfect for gifts · Free gift message included"
- Add a value proposition row ABOVE pricing cards: "One-time payment · No subscription · Instant delivery"

### 5. TESTIMONIALS SECTION (NEW — add this)
Insert between Gallery and Pricing. 3 testimonial cards:
```
- "My daughter cried happy tears seeing herself as the hero. Best gift we've ever given." — Sarah M., Chicago
- "The illustrations actually look like my son! We've read it 50 times already." — James T., Austin  
- "Ordered for my nephew's birthday. The whole family was blown away." — Maria K., New York
```
Cards: avatar initial circle (colorful), quote, name, star rating (5 stars each), location

### 6. FAQ SECTION
- Keep existing questions but redesign:
  - Larger text, more breathing room
  - Add "+" / "−" icons instead of chevrons
  - Soft background (#FAFAFA)
  - Add one more FAQ: "Do I need to upload a photo?" → "A photo helps us create illustrations that look like your child, but you can also just describe them!"

### 7. FOOTER
- Add newsletter signup: "Get parenting inspiration + 10% off your first book" + email input + Subscribe button
- Add social icons (Instagram, Facebook, Pinterest — placeholder links)
- Make 3-column layout: Brand + tagline | Quick Links | Contact + Social
- Warm forest green background with cream text (keep existing)

### 8. ORDER PAGE
- Add a progress bar at top (Step 1 of 3, Step 2 of 3, etc.)
- Make form fields larger and more spacious
- Add a sidebar/summary panel on desktop showing order details
- Add "Your book will be ready in ~15 minutes" for digital, "7-10 days" for printed

## Typography & Colors
- Headlines: Use a warm serif font — add Google Font: `Playfair Display` or `Lora`
- Body: Keep Inter/system-ui
- Colors: Keep existing brand vars, but add:
  - `--lavender: #F0EDF8`
  - `--deep-gold: #C9A227`
  - Gradient: `linear-gradient(135deg, #FFFDF7 0%, #FFF3E8 100%)`

## Performance & Quality
- All images: next/image with proper width/height
- All client components: must have 'use client' at top
- Build must pass: `npm run build` with 0 errors
- After all changes: `git add -A && git commit -m "feat: full design overhaul — premium visual refresh"`
- Then deploy: `VERCEL_TOKEN=$VERCEL_TOKEN npx vercel --prod --yes`
- Alias to production domain: `VERCEL_TOKEN=$VERCEL_TOKEN npx vercel alias [deployment-url] herostorybooks.com`

## Definition of Done
- [ ] fal.ai images generated and saved to /public/
- [ ] Hero has animations + trust badges
- [ ] HowItWorks is 3-column with icons
- [ ] Gallery shows real AI-generated illustrations  
- [ ] Testimonials section added
- [ ] Pricing cards are premium with checkmarks
- [ ] FAQ redesigned with icons
- [ ] Footer has newsletter + socials
- [ ] `npm run build` passes clean
- [ ] Deployed to Vercel prod
- [ ] herostorybooks.com returns 200

When completely finished, run:
openclaw system event --text "Done: HSB design overhaul complete — deployed to herostorybooks.com" --mode now
