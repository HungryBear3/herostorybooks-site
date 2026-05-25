import type { Metadata } from 'next';

const mockups = [
  {
    id: 'evergreen-homepage',
    title: 'Evergreen Homepage',
    source: 'Evergreen Homepage - Standalone.html',
    href: '/design-mockups/hsb-evergreen-homepage-standalone.html',
    summary: 'Standalone homepage concept imported from Downloads for side-by-side review.',
  },
  {
    id: 'fathers-day-landing',
    title: "Father's Day Landing",
    source: 'Fathers Day Landing - Standalone (2).html',
    href: '/design-mockups/hsb-fathers-day-landing-standalone-v2.html',
    summary: 'Standalone Father\'s Day digital landing concept imported from Downloads for side-by-side review.',
  },
];

export const metadata: Metadata = {
  title: 'HSB Design Mockup Preview',
  description: 'Internal preview page for imported HeroStoryBooks standalone HTML mockups.',
  robots: {
    index: false,
    follow: false,
  },
};

export default function HsbMockupPreviewPage() {
  return (
    <main className="min-h-screen bg-[#f4ebdb] px-4 py-8 text-[#1f1810] sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <header className="border-b border-[#1f1810]/15 pb-6">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#6b5d4a]">
            Internal design preview
          </p>
          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="font-serif text-4xl font-semibold leading-tight sm:text-5xl">
                HeroStoryBooks HTML Mockups
              </h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-[#3a2f22]">
                Imported as isolated static artifacts from Downloads. These previews are not wired into
                checkout, fulfillment, image generation, analytics, or production navigation.
              </p>
            </div>
            <a
              href="/"
              className="inline-flex h-11 items-center justify-center rounded-md border border-[#1f1810]/20 px-4 text-sm font-semibold text-[#1f1810] transition hover:bg-white/45"
            >
              Back to live homepage
            </a>
          </div>
        </header>

        <section className="grid gap-6">
          {mockups.map((mockup) => (
            <article
              key={mockup.id}
              className="overflow-hidden rounded-lg border border-[#1f1810]/15 bg-[#fbf5e8] shadow-sm"
            >
              <div className="flex flex-col gap-4 border-b border-[#1f1810]/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">{mockup.title}</h2>
                  <p className="mt-1 text-sm leading-6 text-[#6b5d4a]">{mockup.summary}</p>
                  <p className="mt-1 font-mono text-xs text-[#8a7a62]">Source: {mockup.source}</p>
                </div>
                <a
                  href={mockup.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-[#9c5e60] px-4 text-sm font-semibold text-white transition hover:bg-[#824c4e]"
                >
                  Open full mockup
                </a>
              </div>
              <iframe
                title={`${mockup.title} standalone HTML mockup`}
                src={mockup.href}
                className="h-[76vh] w-full bg-white"
                loading="lazy"
              />
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
