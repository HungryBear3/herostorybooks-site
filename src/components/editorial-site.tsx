import Link from 'next/link';
import { NamePreview } from '@/components/name-preview';
import { AnalyticsPageView } from '@/components/analytics-page-view';
import { getFathersDayCountdown, type FathersDayCountdown } from '@/lib/fathers-day';

type TierId = 'digital' | 'softcover' | 'hardcover';

type Tier = {
  id: TierId;
  name: string;
  price: number;
  sub: string;
  blurb: string;
  badge?: string;
  featured?: boolean;
};

// Canonical pricing — matches src/lib/orders.ts FORMAT_META.priceCents
// (1499 / 4499 / 6499) and src/lib/pricing.ts PUBLIC_PRICING_PLANS.
// If backend priceCents change, update this list AND lib/pricing.ts in
// the same commit so the customer-facing display never diverges from
// what Stripe actually charges.
const tiers: Tier[] = [
  {
    id: 'digital',
    name: 'Digital PDF',
    price: 14.99,
    sub: 'Proof first, then high-resolution PDF',
    blurb: 'We email a digital proof first, usually within 2 business days. Once you approve, you receive the final high-resolution PDF to print at home, share, or read on any screen. No printing or shipping step.',
  },
  {
    id: 'softcover',
    name: 'Classic softcover',
    price: 44.99,
    sub: '8.5″ × 8.5″ · perfect-bound',
    blurb: 'Full-color matte pages, perfect-bound spine, and a keepsake feel without the hardcover price.',
    badge: 'Most popular',
    featured: true,
  },
  {
    id: 'hardcover',
    name: 'Premium hardcover',
    price: 64.99,
    sub: '8.5″ × 8.5″ · keepsake gift finish',
    blurb: 'Premium full-color pages, sturdy case binding, and a gift-ready finish for grandparents and big occasions.',
  },
];

const sampleBooks = [
  {
    // Was hsb-lukas-print-front-cover.jpg, which carried "Made for Lukas
    // Kaplun" on the cover subtitle — exposing a real customer surname on
    // a marketing tile. Swapped to the watercolor dinosaur cover, which
    // shows the child + dinosaurs without any real-name overlay. This is
    // the ONE cover-style tile in the 3-card cluster (cards 2 and 3 are
    // now interior spreads, per the "at most one cover-style per cluster"
    // rule).
    tag: 'WATERCOLOR DINOSAUR COVER',
    title: 'A Dinosaur Adventure Cover',
    star: 'the child',
    tone: 'hardcover',
    image: '/assets/lukas-watercolor-dino-cover.jpg',
    copy: 'A watercolor dinosaur cover proof — example of the personalized cover direction, with no real customer details on the artwork.',
  },
  {
    // Was lukas-dino-companion-proof.jpg, which shows only a T-Rex and a
    // Triceratops in a forest — no child. Card copy claimed "Lukas meets
    // the dinosaur," which the image did not back up. Swapped to the
    // bedtime proof, where the child is clearly present alongside the
    // dinosaur dream-bubble.
    tag: 'DINOSAUR STORY ART',
    title: 'Bedtime With Dinosaurs',
    star: 'the child',
    tone: 'softcover',
    image: '/assets/lukas-dino-bedtime-proof.jpg',
    copy: 'A bedtime spread from the proof set — the child reading the book while a friendly dinosaur dream takes shape above the lamp. Illustration only, no story text overlaid.',
  },
  {
    // Was lukas-watercolor-adventure-page.jpg. The jungle-kneeling shot
    // had the child far from camera with a small, indistinct face —
    // likeness was visibly weak in QA. Swapped to the "King of All
    // Dinosaurs" interior proof from the print book set: the child's
    // face is centered, in focus, smiling, and reads unambiguously as
    // the canonical Lukas. The page-text panel sits cleanly in the
    // lower-left corner of the image, so it reads as an intentional
    // inside-book proof rather than an unreadable hero thumbnail.
    // Tag + title + copy updated honestly to reflect it is an interior
    // proof, not a watercolor-direction concept.
    tag: 'INTERIOR PROOF',
    title: 'Lukas, King of All Dinosaurs',
    star: 'the child',
    tone: 'digital',
    image: '/assets/hsb-lukas-print-story-21.jpg',
    copy: 'A real interior proof with a stronger Lukas likeness — the same proof-approved book that digital orders receive as a high-resolution PDF.',
  },
];

const lukasStorySnippets = [
  {
    page: '1',
    title: 'The wish',
    body: 'Lukas did not want to just visit Dinosaur World. He wanted to be a real dinosaur, with a tail behind him and jungle light on his claws.',
  },
  {
    page: '2',
    title: 'The big decision',
    body: 'The leaves smelled wet and green. Lukas could stay where the room was quiet, or he could step through the bright doorway. He stepped through.',
  },
  {
    page: '3',
    title: 'The two sides of Lukas',
    body: 'One side of him was T-Rex brave. One side was triceratops strong. Lukas stood between them and understood that both sides belonged to him.',
  },
  {
    page: 'Final',
    title: 'The crown',
    body: 'The brontosauruses lowered a leafy crown onto his head. Lukas held very still. Then the whole valley stomped once, very softly, for their king.',
  },
];

const faqs: Array<[string, string]> = [
  ['How personalized is the book?', 'Every book uses your child’s name, age, interests, dedication, and photo/character notes. We make the child the hero of the story instead of dropping their name into a generic template.'],
  ['Do I approve it before printing? Can I request changes?', 'Yes — and always. Physical books are not printed until you approve the digital proof. Reply to the proof email with any changes: story wording, photo placement, dedication, character details, scene tone. Revisions before approval are included, not an upsell.'],
  ['How long does it take from order to delivery?', 'Digital proofs are usually ready within 2 business days. After you approve, digital PDFs are delivered the same day; printed books ship 5–7 business days after approval, then US delivery is typically 3–5 days. We don’t guarantee specific holiday-delivery dates because carriers can vary.'],
  ['Will it arrive in time for a birthday or Father’s Day?', 'Most US orders that approve their proof at least 9–12 days before the date arrive in time, but we don’t promise specific dates — shipping carriers vary. If timing is tight, the Digital PDF is a reliable fallback you can print at home or share instantly.'],
  ['Can I send it as a gift or surprise someone?', 'Yes. Add a dedication and gift message at checkout. The proof email goes to whoever you list as the buyer, not the recipient, so the surprise stays intact.'],
  ['What if my child doesn’t like the proof?', 'Reply to the proof email with what to change — a different scene, a softer dinosaur, a recolored sweater, whatever. Revisions before approval are free. We don’t print until you say go.'],
  ['What is the refund policy for digital orders?', 'Digital orders are fully refundable up until you approve the proof. Once you approve and we deliver the high-resolution PDF, the digital order is final.'],
  ['What is the refund policy for printed books?', 'Printed books are refundable up until you approve the proof for print. After proof approval, we can only replace books with printing defects or fulfillment errors — the book goes to print and generally cannot be canceled.'],
  ['Do you ship internationally?', 'For launch, printed books ship within the US only. International buyers can order the Digital PDF from anywhere with a US-billed payment method.'],
  ['Can I order multiple copies?', 'Yes. Add the book to checkout once for the personalization, then email support after approval and we’ll arrange additional softcover or hardcover prints at a reduced rate.'],
  ['What kind of photo should I upload?', 'One clear, well-lit, front-facing photo where your child’s face is in focus. Phone snapshots are fine — we don’t need a studio portrait. A recent everyday photo usually works best.'],
];

const comparisonRows = [
  ['24-page personalized story', true, true, true],
  ['Full-color illustrated spreads', true, true, true],
  ['Digital proof before print', true, true, true],
  ['US shipping included', false, true, true],
  ['Keepsake hardcover finish', false, false, true],
  ['PDF copy', true, false, false],
];

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function EditorialPageShell({ active, children }: { active?: 'home' | 'sample' | 'pricing'; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[#f8f0dd] text-[#1f1a16]">
      {/* Fires page_view exactly once per mount. Vendor-free push to
          window.dataLayer + window.hsbEvents. */}
      <AnalyticsPageView />
      <EditorialHeader active={active} />
      {children}
      <EditorialFooter />
    </main>
  );
}

/**
 * Honest Father's Day urgency badge. Hidden once the event has passed.
 * Copy stays non-promising ("best chance" / "order by") because shipping
 * carriers vary.
 */
function FathersDayBadge({
  countdown,
  variant = 'default',
}: {
  countdown: FathersDayCountdown;
  variant?: 'default' | 'inverted';
}) {
  if (countdown.tier === 'past-event' || !countdown.badgeCopy) return null;
  const palette =
    variant === 'inverted'
      ? 'border-[#e2c889]/40 bg-[#e2c889]/15 text-[#fff8ec]'
      : countdown.tier === 'last-call' || countdown.tier === 'final-hours'
        ? 'border-[#a64c4c]/40 bg-[#a64c4c]/12 text-[#1f1a16]'
        : countdown.tier === 'digital-only'
          ? 'border-[#695f54]/40 bg-[#fff8ec] text-[#1f1a16]'
          : 'border-[#a64c4c]/35 bg-[#fff8ec] text-[#1f1a16]';
  return (
    <p
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[12px] font-semibold ${palette}`}
      aria-label="Father's Day timing"
    >
      <span aria-hidden="true">⏳</span>
      {countdown.badgeCopy}
    </p>
  );
}

function EditorialHeader({ active }: { active?: 'home' | 'sample' | 'pricing' }) {
  const linkClass = (id: typeof active) => cx(
    'text-sm font-medium underline-offset-8 transition hover:text-[#a64c4c]',
    active === id ? 'text-[#1f1a16] underline decoration-[#a64c4c]' : 'text-[#695f54]'
  );

  // Mobile-nav menu items reused inside the <details> drawer so visitors
  // at 375/390px have a one-tap path to Sample, Pricing, FAQ, and Start.
  const mobileItems: Array<[string, string]> = [
    ['How it works', '/#how'],
    ['Sample', '/samples'],
    ['Pricing', '/pricing'],
    ['FAQ', '/#faq'],
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-[#dfd2b8] bg-[#f8f0dd]/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:gap-4 md:px-8 md:py-4">
        {/* Logo. min-w-0 lets the truncate class work; tracking-[0.10em] on
            mobile shaves enough letter-spacing to keep "HeroStoryBooks"
            from overflowing at 375px. */}
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 font-serif text-[15px] font-semibold uppercase tracking-[0.10em] text-[#1f1a16] md:gap-3 md:text-lg md:tracking-[0.14em]"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#a64c4c] shadow-[0_0_0_4px_rgba(166,76,76,0.14)]" />
          <span className="truncate">HeroStoryBooks</span>
        </Link>

        {/* Desktop nav. */}
        <nav className="hidden items-center gap-8 md:flex">
          <Link href="/#how" className={linkClass('home')}>How it works</Link>
          <Link href="/samples" className={linkClass('sample')}>Sample</Link>
          <Link href="/pricing" className={linkClass('pricing')}>Pricing</Link>
          <Link href="/#faq" className="text-sm font-medium text-[#695f54] transition hover:text-[#a64c4c]">FAQ</Link>
          <PrimaryCta href="/checkout" size="sm">Start your book</PrimaryCta>
        </nav>

        {/* Mobile: compact Start button + accessible <details> drawer.
            <details>/<summary> is a native disclosure widget; it
            announces correctly to screen readers and needs no React
            state or client JS. The drawer panel positions absolutely so
            it overlays page content instead of pushing it down. */}
        <div className="flex items-center gap-2 md:hidden">
          <Link
            href="/checkout"
            className="rounded-full bg-[#1f1a16] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#fff8ec] shadow-sm"
          >
            Start
          </Link>
          <details className="relative">
            <summary
              aria-label="Open navigation menu"
              className="inline-flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-full border border-[#d8c6a2] bg-[#fff8ec] text-[#1f1a16] [&::-webkit-details-marker]:hidden"
            >
              <span aria-hidden="true" className="relative block h-3 w-5">
                <span className="absolute left-0 top-0 h-[2px] w-5 rounded bg-[#1f1a16]" />
                <span className="absolute left-0 top-[5px] h-[2px] w-5 rounded bg-[#1f1a16]" />
                <span className="absolute bottom-0 left-0 h-[2px] w-5 rounded bg-[#1f1a16]" />
              </span>
            </summary>
            <div
              role="menu"
              aria-label="Site navigation"
              className="absolute right-0 top-12 z-50 w-60 overflow-hidden rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] shadow-[0_30px_60px_-30px_rgba(31,26,22,0.45)]"
            >
              <ul className="divide-y divide-[#eadfc7] py-1 text-sm">
                {mobileItems.map(([label, href]) => (
                  <li key={label}>
                    <Link
                      href={href}
                      className={cx(
                        'block px-4 py-3 font-medium text-[#1f1a16] transition hover:bg-[#f5ead2]',
                        (label === 'Sample' && active === 'sample') ||
                          (label === 'Pricing' && active === 'pricing') ||
                          (label === 'How it works' && active === 'home')
                          ? 'text-[#a64c4c]'
                          : ''
                      )}
                      role="menuitem"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link
                    href="/checkout"
                    role="menuitem"
                    className="block bg-[#1f1a16] px-4 py-3 text-center text-xs font-semibold uppercase tracking-[0.14em] text-[#fff8ec]"
                  >
                    Start your book
                  </Link>
                </li>
              </ul>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

function EditorialFooter() {
  return (
    <footer className="border-t border-[#dfd2b8] bg-[#f5ead2]">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 md:grid-cols-[1.4fr_1fr_1fr] md:px-8">
        <div>
          <div className="mb-3 flex items-center gap-3 font-serif text-lg font-semibold uppercase tracking-[0.14em]">
            <span className="h-2 w-2 rounded-full bg-[#a64c4c]" />
            HeroStoryBooks
          </div>
          <p className="max-w-sm text-sm leading-6 text-[#695f54]">
            Personalized children&apos;s books, made from your child&apos;s photo, interests, and family story. Approved by you before we print.
          </p>
        </div>
        <FooterLinks title="Product" items={[['How it works', '/#how'], ['See a sample', '/samples'], ['Pricing', '/pricing'], ['Start your book', '/checkout']]} />
        <FooterLinks title="Help" items={[['FAQ', '/#faq'], ['support@herostorybooks.com', 'mailto:support@herostorybooks.com'], ['Privacy', '/privacy'], ['Terms', '/terms']]} />
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-[#dfd2b8] px-5 py-5 text-xs text-[#695f54] md:px-8">
        <span>© 2026 HeroStoryBooks · Made by a small team in California · <a href="mailto:support@herostorybooks.com" className="hover:text-[#a64c4c]">support@herostorybooks.com</a></span>
        <span>SSL-encrypted · Stripe-secured · US shipping included on printed books</span>
      </div>
    </footer>
  );
}

function FooterLinks({ title, items }: { title: string; items: Array<[string, string]> }) {
  return (
    <div>
      <h3 className="mb-3 font-serif text-lg font-semibold text-[#1f1a16]">{title}</h3>
      <ul className="space-y-2 text-sm text-[#695f54]">
        {items.map(([label, href]) => (
          <li key={label}><Link href={href} className="hover:text-[#a64c4c]">{label}</Link></li>
        ))}
      </ul>
    </div>
  );
}

function PrimaryCta({ href, children, size = 'md' }: { href: string; children: React.ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Link
      href={href}
      className={cx(
        'inline-flex items-center justify-center rounded-full bg-[#1f1a16] font-semibold uppercase tracking-[0.14em] text-[#fff8ec] shadow-[0_10px_25px_-18px_rgba(31,26,22,0.6)] transition hover:-translate-y-0.5 hover:bg-[#332a22]',
        size === 'sm' && 'px-5 py-2.5 text-xs',
        size === 'md' && 'px-6 py-3 text-xs',
        size === 'lg' && 'px-8 py-4 text-sm'
      )}
    >
      {children}
    </Link>
  );
}

function GhostCta({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center justify-center rounded-full border border-[#c9b891] px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#1f1a16] transition hover:border-[#a64c4c] hover:text-[#a64c4c]">
      {children}
    </Link>
  );
}

export function EditorialHomePage() {
  return (
    <EditorialPageShell active="home">
      <HeroSection />
      <TrustStrip />
      <NamePreview />
      <HowItWorksSection />
      <SamplePreviewSection />
      <PrivacyBand />
      <PricingPreviewSection />
      <SeasonalCallout />
      <FaqSection />
      <FinalCta />
    </EditorialPageShell>
  );
}

function HeroSection() {
  const fathersDay = getFathersDayCountdown();
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 opacity-60 [background:radial-gradient(circle_at_20%_10%,#fff4d6_0,transparent_32%),radial-gradient(circle_at_80%_0,#ead8b8_0,transparent_28%)]" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 md:grid-cols-[1.02fr_0.98fr] md:px-8 md:py-24">
        <div>
          <div className="mb-5 inline-flex rounded-full border border-[#d8c6a2] bg-[#fff8ec]/65 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[#695f54]">
            Personalized children&apos;s books
          </div>
          <h1 className="max-w-3xl font-serif text-[clamp(3.2rem,8vw,7.9rem)] font-medium leading-[0.86] tracking-[-0.045em] text-[#1f1a16]">
            Your child becomes <em className="font-normal italic text-[#a64c4c]">the hero</em> of the story.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-[#695f54] md:text-xl">
            Create a personalized keepsake storybook from your child&apos;s photo, interests, and family details. AI-assisted illustration and hand-reviewed story edits come together in a proof you approve before anything prints.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <PrimaryCta href="/checkout" size="lg">Start your book</PrimaryCta>
            <GhostCta href="/samples">See a sample</GhostCta>
          </div>
          {fathersDay.tier !== 'past-event' && (
            <div className="mt-4">
              <FathersDayBadge countdown={fathersDay} />
            </div>
          )}
          <p className="mt-5 text-sm italic text-[#695f54]">
            <b className="not-italic text-[#1f1a16]">Digital $14.99</b> · <b className="not-italic text-[#1f1a16]">Softcover $44.99</b> · <b className="not-italic text-[#1f1a16]">Hardcover $64.99</b>
            <span className="block text-sm not-italic font-semibold text-[#a64c4c]">US shipping included on printed books</span>
          </p>
        </div>
        <BookCoverStack />
      </div>
    </section>
  );
}

function BookCoverStack() {
  return (
    // Single strong main visual — no floating side thumbs. Both the
    // upper-right interior-page inset and the lower-left bedside thumb
    // were removed in the 2026-05-19 hotfix series; the prior
    // composition kept reading as a "loose-sticker" collage at every
    // viewport. The watercolor cover + its caption panel is the hero.
    <div className="relative mx-auto w-full max-w-[520px]">
      <div className="overflow-hidden rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] shadow-[0_30px_80px_-50px_rgba(31,26,22,0.55)]">
        <div className="aspect-[4/5] bg-[#eadfc7]">
          {/* Watercolor cover proof, off-center crop. The child's face
              sits slightly left and below center on the source art;
              object-position [30%_55%] biases the visible window so
              the face lands in the upper-left third instead of being
              clipped by the default 50%/50% center crop. */}
          <img
            src="/assets/lukas-watercolor-dino-cover.jpg"
            alt="Watercolor dinosaur cover proof — child with a friendly T-Rex"
            className="h-full w-full object-cover object-[30%_55%]"
          />
        </div>
        <div className="border-t border-[#eadfc7] p-5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.22em] text-[#a64c4c]">Watercolor cover proof</div>
          <p className="font-serif text-2xl leading-tight text-[#1f1a16]">An example of the personalized dinosaur direction — shown without any real customer details.</p>
        </div>
      </div>
      {/* Above-fold side thumbnails. The previous pass swapped tiny
          text-bearing page screenshots out; this pass fixes two new
          issues spotted in QA:
            (1) lukas-dino-companion-proof.jpg shows only two
                dinosaurs and no child, so it cannot serve as "Lukas
                with a friendly dinosaur." Replaced with the bedtime
                proof, which shows the child clearly.
            (2) lukas-watercolor-dino-cover.jpg now lives as the main
                hero center, so reusing it as a side thumb made the
                hero look like two near-identical covers. Side thumb
                moved to the jungle adventure illustration for a
                visually distinct second impression. */}
      {/* Both side thumbs removed in 2026-05-19 hotfix series. The
          upper-right interior-page inset was removed first (likeness
          break + readable body copy at thumbnail size). The lower-left
          bedside thumb was removed second after launch review: even
          when repositioned below the caption panel it still read as a
          loose sticker rather than an intentional design element. The
          hero is now a single watercolor cover + caption — no collage. */}
    </div>
  );
}

function BookFace({ title, star, tag }: { title: string; star: string; tag: string }) {
  return (
    <div className="flex h-full flex-col justify-between rounded-lg border border-white/35 bg-[#fff8ec]/90 p-5 text-center text-[#1f1a16] shadow-inner">
      <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#a64c4c]">{tag}</div>
      <div>
        <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full border border-[#dbc58f] bg-[#f5ead2] font-serif text-4xl">✦</div>
        <h3 className="font-serif text-2xl leading-none">{title}</h3>
      </div>
      <div className="text-xs uppercase tracking-[0.18em] text-[#695f54]">starring {star}</div>
    </div>
  );
}

function TrustStrip() {
  const items = [
    'Proof approval before any printing',
    'Revisions included before approval',
    'US shipping included on printed books',
    'Your photos stay private — never used to train AI',
    'Stripe-secured checkout',
  ];
  return (
    <div className="border-y border-[#dfd2b8] bg-[#fff8ec]/55">
      <div className="mx-auto flex max-w-6xl flex-wrap gap-x-8 gap-y-3 px-5 py-5 text-sm text-[#695f54] md:px-8">
        {items.map((item) => <span key={item} className="inline-flex items-center gap-2"><span className="text-[#a64c4c]">✓</span>{item}</span>)}
      </div>
    </div>
  );
}

function SectionHeader({ eyebrow, title, sub, centered = false }: { eyebrow: string; title: string; sub?: string; centered?: boolean }) {
  return (
    <div className={cx('mb-10', centered && 'mx-auto max-w-3xl text-center')}>
      <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">{eyebrow}</div>
      <h2 className="font-serif text-4xl font-medium leading-tight tracking-[-0.02em] text-[#1f1a16] md:text-6xl">{title}</h2>
      {sub && <p className="mt-4 text-base leading-7 text-[#695f54] md:text-lg">{sub}</p>}
    </div>
  );
}

function HowItWorksSection() {
  const steps = [
    ['1', 'Tell us about your child', 'Their name, one photo, and a few details — age, interests, anything special. Voice note optional.'],
    ['2', 'We craft a 24-page story', 'Your child becomes the hero through AI-assisted illustration, hand-reviewed writing, and a dedication page if you want one.'],
    ['3', 'You approve, then we print', 'We email a full digital proof. Nothing prints until you approve. Revisions are free.'],
  ];
  return (
    <section id="how" className="mx-auto max-w-6xl px-5 pt-10 pb-20 md:px-8 md:pt-16 md:pb-24">
      <SectionHeader eyebrow="How it works" title="A custom book without the custom-project chaos." centered />
      <div className="grid gap-5 md:grid-cols-3">
        {steps.map(([n, title, body]) => (
          <article key={n} className="relative rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] p-7 shadow-[0_20px_60px_-50px_rgba(31,26,22,0.35)]">
            <div className="mb-8 inline-grid h-10 w-10 place-items-center rounded-full bg-[#a64c4c] font-serif text-xl text-white">{n}</div>
            <h3 className="mb-3 font-serif text-2xl font-semibold text-[#1f1a16]">{title}</h3>
            <p className="text-sm leading-6 text-[#695f54]">{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function SamplePreviewSection() {
  return (
    <section className="bg-[#fff8ec]/45 py-20">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <SectionHeader eyebrow="Real order sample" title="One finished book, shown consistently." sub="The sample art below comes from the latest Lukas print production packet. Digital orders use the same proof-first story experience, without the print-and-ship step." />
        <div className="grid gap-5 md:grid-cols-3">
          {sampleBooks.map((book) => <SampleCard key={book.title} {...book} />)}
        </div>
        <div className="mt-9"><GhostCta href="/samples">Read the sample pages</GhostCta></div>
      </div>
    </section>
  );
}

function SampleCard({ tag, title, copy, tone, image }: (typeof sampleBooks)[number]) {
  const colors = tone === 'hardcover' ? 'from-[#5b6047] to-[#9d8260]' : tone === 'softcover' ? 'from-[#b96b5f] to-[#dfb286]' : 'from-[#705d87] to-[#b59aca]';
  return (
    <article className="overflow-hidden rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] shadow-[0_20px_60px_-50px_rgba(31,26,22,0.35)]">
      <div className={cx('h-64 bg-gradient-to-br', colors)}>
        <img src={image} alt={`${title} proof example`} className="h-full w-full object-cover" />
      </div>
      <div className="p-6">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-[#a64c4c]">{tag}</div>
        <h3 className="font-serif text-2xl font-semibold leading-tight">{title}</h3>
        <p className="mt-3 text-sm leading-6 text-[#695f54]">{copy}</p>
      </div>
    </article>
  );
}

function PrivacyBand() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 md:px-8">
      <div className="grid gap-5 rounded-3xl border border-[#d8c6a2] bg-[#f5ead2] p-7 md:grid-cols-3 md:p-10">
        {[
          ['Private by default', 'Your photo and details are used only to make the book. We never sell them or use them to train AI.'],
          ['Proof before print', 'You see the story and art first. We only print once you approve.'],
          ['Small-team care', 'If the photo, name, or story tone feels wrong, we fix it before fulfillment.'],
        ].map(([title, body]) => (
          <div key={title}>
            <h3 className="mb-2 font-serif text-2xl font-semibold">{title}</h3>
            <p className="text-sm leading-6 text-[#695f54]">{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReviewsSection() {
  const reviews = [
    ['“It felt like an heirloom, not a novelty gift.”', 'Aunt shopping for a 6-year-old'],
    ['“The approval step made me comfortable ordering a printed copy.”', 'Parent preview tester'],
    ['“The story actually sounded like our kid.”', 'Grandparent gift buyer'],
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 md:px-8">
      <SectionHeader eyebrow="Parent-friendly" title="Built for gifts that have to feel right." centered />
      <div className="grid gap-5 md:grid-cols-3">
        {reviews.map(([quote, by]) => (
          <article key={quote} className="rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] p-6">
            <div className="mb-4 text-[#c9963b]">★★★★★</div>
            <p className="font-serif text-2xl leading-tight">{quote}</p>
            <p className="mt-5 text-xs uppercase tracking-[0.18em] text-[#695f54]">{by}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function PricingPreviewSection() {
  return (
    <section id="pricing" className="bg-[#fff8ec]/45 py-20">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <SectionHeader eyebrow="Pricing" title="One book. Three ways to hold it." sub="Same hand-edited story and full-color illustrations in all formats. Physical books include US shipping." centered />
        <TierCards />
        <div className="mt-8 text-center"><GhostCta href="/pricing">Compare all options</GhostCta></div>
      </div>
    </section>
  );
}

function TierCards() {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {tiers.map((tier) => <TierCard key={tier.id} tier={tier} />)}
    </div>
  );
}

function TierCard({ tier }: { tier: Tier }) {
  return (
    <article className={cx('relative rounded-2xl border bg-[#fff8ec] p-7 shadow-[0_20px_60px_-50px_rgba(31,26,22,0.35)]', tier.featured ? 'border-[#a64c4c] ring-4 ring-[#a64c4c]/10' : 'border-[#d8c6a2]')}>
      {tier.badge && <div className="absolute right-5 top-5 rounded-full bg-[#a64c4c] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white">{tier.badge}</div>}
      <h3 className="pr-28 font-serif text-3xl font-semibold">{tier.name}</h3>
      <p className="mt-2 text-sm text-[#695f54]">{tier.sub}</p>
      <div className="my-7 flex items-end gap-1">
        <span className="font-serif text-6xl leading-none">${tier.price}</span>
        <span className="pb-2 text-sm text-[#695f54]">/ book</span>
      </div>
      <p className="min-h-20 text-sm leading-6 text-[#695f54]">{tier.blurb}</p>
      <div className="mt-7"><PrimaryCta href={`/checkout?format=${tier.id === 'softcover' ? 'classic' : tier.id === 'hardcover' ? 'premium' : 'digital'}`}>Choose {tier.id}</PrimaryCta></div>
    </article>
  );
}

function SeasonalCallout() {
  const fathersDay = getFathersDayCountdown();
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 md:px-8">
      <div className="grid items-center gap-8 rounded-3xl border border-[#d8c6a2] bg-[#fff8ec] p-7 md:grid-cols-[1fr_0.8fr] md:p-10">
        <div>
          <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">Father&apos;s Day gift</div>
          <h2 className="font-serif text-4xl font-medium leading-tight md:text-5xl">A gift Dad will actually keep.</h2>
          <p className="mt-4 text-base leading-7 text-[#695f54]">Choose Father&apos;s Day at checkout and we&apos;ll shape the story around your child&apos;s favorite memories with Dad — camping, building, bedtime stories, backyard adventures, or the little rituals only your family knows.</p>
          {fathersDay.tier !== 'past-event' && (
            <div className="mt-5">
              <FathersDayBadge countdown={fathersDay} />
            </div>
          )}
        </div>
        <div className="rounded-2xl bg-[#f5ead2] p-6 text-center">
          <div className="mb-3 text-xs uppercase tracking-[0.2em] text-[#a64c4c]">Gift timing</div>
          <h3 className="font-serif text-3xl">Proof first, print after approval.</h3>
          <p className="mt-3 text-sm leading-6 text-[#695f54]">Digital proofs are usually ready within 2 business days. Printed books ship 5–7 business days after you approve.</p>
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section id="faq" className="mx-auto max-w-4xl px-5 py-20 md:px-8">
      <SectionHeader eyebrow="FAQ" title="The details parents ask before ordering." centered />
      <div className="space-y-4">
        {faqs.map(([q, a]) => (
          <details key={q} className="group rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] p-6" open={q === faqs[0][0]}>
            <summary className="cursor-pointer list-none font-serif text-2xl font-semibold text-[#1f1a16] marker:hidden">{q}<span className="float-right text-[#a64c4c] group-open:rotate-45">+</span></summary>
            <p className="mt-4 text-sm leading-6 text-[#695f54]">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="px-5 py-20 md:px-8">
      <div className="mx-auto max-w-5xl rounded-[2rem] bg-[#1f1a16] px-6 py-14 text-center text-[#fff8ec] md:px-12">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#e2c889]">Ready when you are</div>
        <h2 className="font-serif text-4xl font-medium leading-tight md:text-6xl">Start with a name and a photo. We&apos;ll handle the story.</h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-[#e7dcc8]">Create the first version now, approve the proof later, and turn it into a digital book, softcover, or hardcover keepsake.</p>
        <div className="mt-8"><Link href="/checkout" className="inline-flex rounded-full bg-[#fff8ec] px-8 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-[#1f1a16]">Start your book</Link></div>
      </div>
    </section>
  );
}

export function EditorialPricingPage() {
  return (
    <EditorialPageShell active="pricing">
      <section className="mx-auto max-w-6xl px-5 py-16 md:px-8 md:py-24">
        <SectionHeader eyebrow="Pricing" title="One book. Three ways to hold it." sub="Digital $14.99, Classic softcover $44.99, Premium hardcover $64.99. US shipping included for printed books. Digital proofs are usually ready within 2 business days; printed books ship 5–7 business days after approval." centered />
        <TierCards />
        <div className="mt-12 overflow-hidden rounded-2xl border border-[#d8c6a2] bg-[#fff8ec]">
          <div className="grid grid-cols-[1.3fr_repeat(3,0.8fr)] border-b border-[#d8c6a2] bg-[#f5ead2] text-sm font-semibold text-[#1f1a16]">
            <div className="p-4">Feature</div><div className="p-4 text-center">Digital</div><div className="p-4 text-center">Softcover</div><div className="p-4 text-center">Hardcover</div>
          </div>
          {comparisonRows.map(([feature, digital, softcover, hardcover]) => (
            <div key={String(feature)} className="grid grid-cols-[1.3fr_repeat(3,0.8fr)] border-b border-[#eadfc7] text-sm last:border-b-0">
              <div className="p-4 text-[#1f1a16]">{feature}</div>
              {[digital, softcover, hardcover].map((v, idx) => <div key={idx} className="p-4 text-center text-[#695f54]">{v === true ? '✓' : v === false ? '—' : v}</div>)}
            </div>
          ))}
        </div>
      </section>
      <FinalCta />
    </EditorialPageShell>
  );
}

export function EditorialSamplesPage() {
  return (
    <EditorialPageShell active="sample">
      <section className="mx-auto max-w-6xl px-5 py-16 md:px-8 md:py-24">
        <SectionHeader eyebrow="Sample" title="A peek inside a personalized proof book." sub="This page uses watercolor proof art from the Lukas book work as a sample: one child, one story, one consistent watercolor direction. Real customer details aren't shown on the artwork. Digital buyers receive the same proof-first book as a PDF after approval." centered />
        <div className="grid items-start gap-8 md:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-3xl border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_20px_60px_-50px_rgba(31,26,22,0.35)]">
            <div className="mx-auto max-w-[320px] [perspective:1200px]">
              <div className="relative origin-left overflow-hidden rounded-xl bg-[#fff8ec] shadow-2xl ring-1 ring-[#d8c6a2] [transform:rotateY(-10deg)_rotateZ(-1deg)]">
                {/* Was hsb-lukas-print-front-cover.jpg, which exposed
                    "Made for Lukas Kaplun" as the cover subtitle.
                    Replaced with the watercolor dinosaur cover that
                    shows the child + dinosaurs without any real
                    customer surname on the artwork. */}
                <img
                  src="/assets/lukas-watercolor-dino-cover.jpg"
                  alt="Watercolor dinosaur cover proof — child with a friendly T-Rex"
                  className="aspect-[4/5] h-full w-full object-cover object-[30%_55%]"
                />
                <div className="absolute inset-y-0 left-0 w-7 bg-gradient-to-r from-black/18 to-transparent" aria-hidden="true" />
                <div className="absolute inset-y-0 right-0 w-4 bg-white/30" aria-hidden="true" />
              </div>
            </div>
            <p className="mt-5 text-center text-xs leading-5 text-[#695f54]">A watercolor dinosaur cover proof, displayed as a book-style mockup. Every new order still receives its own proof and approval pass.</p>
          </div>
          <div className="space-y-5">
            {/* Was hsb-lukas-print-cover-wrap.jpg, the front-and-back
                production cover wrap — which exposed "Made for Lukas
                Kaplun" on the front face AND "With Love from Alexy
                Kaplun & Michelle Kim" on the back face. Replaced with
                the bedtime illustration proof. We lose the
                "production-artifact" framing for the lead figure, but
                we keep the child-visible, no-surname rule intact.
                Real production artifacts still appear lower on this
                page as "inside the book" interior proofs. */}
            <figure className="overflow-hidden rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] p-3 shadow-[0_20px_60px_-50px_rgba(31,26,22,0.35)]">
              {/* Bedtime hero figure crop tightened from 16:10 → 4:3 so
                  the child reading on the bed isn't letterboxed off the
                  top edge. object-position center-top keeps the lamp +
                  dream bubble in frame instead of cropping them. */}
              <img
                src="/assets/lukas-dino-bedtime-proof.jpg"
                alt="Bedtime illustration proof — child reading the book with a dinosaur dream above the lamp"
                className="aspect-[4/3] w-full rounded-xl object-cover object-[50%_30%]"
                loading="lazy"
              />
              <figcaption className="mt-3 px-2 text-center text-xs leading-5 text-[#695f54]">
                A bedtime illustration proof from the watercolor direction. Illustration only — no real customer details shown on the artwork.
              </figcaption>
            </figure>
            {/* Supporting-proof grid — three real interior pages from
                the Lukas print order. lukas-watercolor-adventure-page.jpg
                was removed in the 2026-05-19 launch round: weak Lukas
                likeness (kneeling, far from camera, indistinct face),
                no story-text context, and read as disconnected from the
                proofed book. No replacement asset substituted; per the
                rule "remove the tile rather than show weak art." Grid
                drops to sm:grid-cols-3 so the row stays balanced. */}
            {/* Interior-proof grid. Square crops biased upward
                (object-position 50% 35%) so the child's face / upper
                body stays in frame on each tile instead of being
                clipped by the centered crop default. */}
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                ['/assets/hsb-lukas-print-story-07.jpg', 'Interior page from a real Lukas-book order — dinosaur story page'],
                ['/assets/hsb-lukas-print-story-16.jpg', 'Interior page from a real Lukas-book order — two sides of the hero'],
                ['/assets/hsb-lukas-print-story-21.jpg', 'Interior page from a real Lukas-book order — story spread'],
              ].map(([src, alt]) => (
                <img
                  key={src}
                  src={src}
                  alt={alt}
                  className="aspect-square w-full rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] object-cover object-[50%_35%]"
                  loading="lazy"
                />
              ))}
            </div>
          </div>
        </div>
        <div className="mx-auto mt-10 max-w-3xl space-y-5">
          {lukasStorySnippets.map(({ page, title, body }) => (
            <article key={page} className="relative rounded-2xl border border-[#d8c6a2] bg-[#fff8ec] p-7 shadow-[0_20px_60px_-52px_rgba(31,26,22,0.35)]">
              <div className="absolute right-5 top-5 font-serif text-sm italic text-[#9a8d7b]">— {page} —</div>
              <h3 className="pr-16 font-serif text-3xl font-semibold">{title}</h3>
              <p className="mt-4 text-base leading-8 text-[#695f54]">{body}</p>
            </article>
          ))}
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {sampleBooks.map((book) => <SampleCard key={book.title} {...book} />)}
        </div>
      </section>
      <FinalCta />
    </EditorialPageShell>
  );
}
