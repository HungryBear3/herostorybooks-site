# HeroStoryBooks.com — Landing Page + Order Flow

## Overview
A Next.js site for HeroStoryBooks — personalized children's storybooks where the child is the hero. The site needs to sell the product, collect order details, and eventually integrate Stripe checkout.

## Tech Stack
- **Next.js 14** (App Router)
- **Tailwind CSS** for styling
- **TypeScript**
- **Deploy target:** Vercel

## Pages

### 1. Landing Page (`/`)
The hero section should sell the magic — "Your child is the hero of their own storybook."

**Sections (in order):**
1. **Hero** — Big headline, sub-headline, CTA button ("Create Your Book")
   - Headline: "Your Child Is the Hero"
   - Sub: "Personalized storybooks with AI illustrations that look like your kid"
   - Show a sample book spread (use placeholder image for now)
   
2. **How It Works** — 3 steps with icons
   - Step 1: "Tell us about your child" (name, age, interests)
   - Step 2: "Upload a photo" (we create illustrations that resemble them)
   - Step 3: "Get your book" (digital PDF delivered by email, optional printed book)

3. **Sample Pages** — Gallery of 3-4 illustration samples
   - Use the PuLID test images we already generated
   - Show variety: forest scene, meadow scene, bedroom scene

4. **Pricing** — Two tiers
   - **Digital Storybook** — $29 (PDF delivered by email in ~15 min)
   - **Printed Book** — $49 (hardcover shipped via Lulu, 7-10 business days)
   - **Bundle** — $59 (both digital + printed)
   - Each tier has a "Order Now" button → goes to /order

5. **FAQ** — Accordion style
   - How long does it take? (Digital: ~15 min, Print: 7-10 days)
   - What ages is this for? (2-10 years old)
   - Can I customize the story? (Yes — theme, lesson, characters)
   - What if I don't like it? (Full refund within 7 days)
   - How do the illustrations work? (AI generates art resembling your child)

6. **Footer** — Simple: © 2026 HeroStoryBooks, contact email, social links (placeholder)

### 2. Order Page (`/order`)
A clean, multi-step form that collects everything needed to generate the book.

**Form fields:**
- **Step 1: About the Child**
  - Child's first name (required)
  - Child's age (required, dropdown 1-12)
  - Child's gender (optional, for story pronouns)
  - Favorite color (optional)
  - Favorite animal (optional)
  
- **Step 2: Story Customization**
  - Book type: "Child Hero" / "Mom Tribute" / "Dad Tribute" (radio)
  - Story theme/lesson: Courage, Kindness, Creativity, Adventure, Friendship (dropdown)
  - Art style: Watercolor, Classic Storybook, Cartoon (radio with preview thumbnails)
  - Any special requests? (optional textarea)

- **Step 3: Upload Photo**
  - Photo upload (drag & drop or click, accepts jpg/png, max 10MB)
  - Helper text: "Upload a clear, front-facing photo for best results"
  - Photo preview thumbnail after upload

- **Step 4: Your Info**
  - Your name (for the dedication page)
  - Email address (required — where we send the PDF)
  - Shipping address (only shown if print option selected)

- **Step 5: Checkout**
  - Selected tier summary (digital/print/bundle)
  - Total price
  - "Pay with Stripe" button (placeholder for now — show "Coming Soon" or use Stripe Payment Links once key is ready)

### 3. Thank You Page (`/thank-you`)
- "Your storybook is being created! ✨"
- "Check your email in ~15 minutes for your personalized PDF"
- Order confirmation details

## Design Direction
- **Warm, whimsical, magical** — not corporate
- Color palette: soft purples (#5B4A8A), warm peach (#E8A87C), cream backgrounds (#FDF8F4)
- Typography: serif for headlines (Georgia or similar), clean sans-serif for body
- Rounded corners, soft shadows, playful but professional
- Mobile-first responsive design

## API Routes (for later)
- `POST /api/order` — receives form submission, validates, creates Stripe checkout session
- `POST /api/webhook/stripe` — Stripe webhook, triggers PDF generation on payment success
- `GET /api/status/[orderId]` — check order status

For now, the form can just POST to our existing webhook server. We'll wire Stripe in when the key is ready.

## Sample Images
Copy these from the gallery for use on the site:
- `../gallery/pulid_v1.png`
- `../gallery/pulid_v2.png`
- `../gallery/pulid_test.png`

## Important Notes
- Do NOT hardcode any API keys
- Stripe integration should be structured but can use placeholder env vars
- The order form we already have (`../order-form/index.html`) has good UX — reference its styling
- Keep it simple and shippable. We can iterate after launch.
