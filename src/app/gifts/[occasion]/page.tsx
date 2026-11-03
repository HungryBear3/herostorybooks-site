import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EditorialPageShell } from '@/components/editorial-site';
import { GIFT_OCCASIONS, getGiftOccasion, giftCheckoutHref } from '@/lib/gift-occasions';
import { PROOF_TURNAROUND_WINDOW } from '@/lib/proof-turnaround';
import { PRODUCTION_ORIGIN } from '@/lib/site-url';

export function generateStaticParams() {
  return GIFT_OCCASIONS.map(({ id }) => ({ occasion: id }));
}

export async function generateMetadata({ params }: { params: Promise<{ occasion: string }> }): Promise<Metadata> {
  const { occasion: id } = await params;
  const occasion = getGiftOccasion(id);
  if (!occasion) return {};
  return {
    title: `${occasion.title} | HeroStoryBooks`,
    description: occasion.description,
    alternates: { canonical: `/gifts/${occasion.id}` },
    openGraph: {
      title: occasion.title,
      description: occasion.description,
      url: `${PRODUCTION_ORIGIN}/gifts/${occasion.id}`,
      siteName: 'HeroStoryBooks',
      locale: 'en_US',
      type: 'website',
      images: [
        {
          url: '/assets/og-social-share.png',
          width: 1200,
          height: 630,
          alt: 'HeroStoryBooks social share image',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: occasion.title,
      description: occasion.description,
      images: ['/assets/og-social-share.png'],
    },
  };
}

export default async function GiftOccasionPage({ params }: { params: Promise<{ occasion: string }> }) {
  const { occasion: id } = await params;
  const occasion = getGiftOccasion(id);
  if (!occasion) notFound();

  return (
    <EditorialPageShell>
      <section className="mx-auto max-w-6xl px-5 py-16 md:px-8 md:py-24">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#a64c4c]">{occasion.eyebrow}</p>
        <h1 className="mt-4 max-w-4xl font-serif text-5xl font-medium leading-[1.02] md:text-7xl">{occasion.title}</h1>
        <p className="mt-6 max-w-2xl text-base leading-8 text-[#695f54]">{occasion.description}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href={giftCheckoutHref(occasion)} className="inline-flex min-h-12 items-center justify-center rounded-full bg-[#a64c4c] px-6 text-sm font-semibold text-white">Start a custom story</Link>
          <Link href="/samples" className="inline-flex min-h-12 items-center justify-center rounded-full border border-[#d8c6a2] bg-[#fff8ec] px-6 text-sm font-semibold">See a sample page</Link>
        </div>
      </section>

      <section className="border-y border-[#d8c6a2] bg-[#fff8ec]">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-2 md:px-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#a64c4c]">Story directions</p>
            <ul className="mt-5 grid gap-3">
              {occasion.storyIdeas.map((idea) => <li key={idea} className="rounded-lg border border-[#e5d7bd] bg-[#fbf5e8] px-5 py-4 font-serif text-2xl">{idea}</li>)}
            </ul>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#a64c4c]">What happens next</p>
            <ol className="mt-5 grid gap-4 text-sm leading-7 text-[#695f54]">
              <li><strong className="text-[#1f1a16]">1. Share the details.</strong> Add the child&apos;s photo, interests, dedication, and optional voice note.</li>
              <li><strong className="text-[#1f1a16]">2. Review the private proof.</strong> Proofs are usually ready in {PROOF_TURNAROUND_WINDOW} after we have the needed photos.</li>
              <li><strong className="text-[#1f1a16]">3. Approve before fulfillment.</strong> Digital orders receive the full PDF with the proof email; approving accepts the book. Printed books enter production only after approval; carrier timing can vary.</li>
            </ol>
          </div>
        </div>
      </section>
    </EditorialPageShell>
  );
}
