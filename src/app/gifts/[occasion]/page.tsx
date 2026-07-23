import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { APPROVED_SAMPLE, GIFT_OCCASIONS, getGiftOccasion, giftCheckoutHref } from '@/lib/gift-occasions';

export function generateStaticParams() {
  return GIFT_OCCASIONS.map(({ id }) => ({ occasion: id }));
}

export async function generateMetadata({ params }: { params: Promise<{ occasion: string }> }): Promise<Metadata> {
  const { occasion: id } = await params;
  const occasion = getGiftOccasion(id);
  if (!occasion) return {};
  return { title: `${occasion.title} | HeroStoryBooks`, description: occasion.description };
}

export default async function GiftOccasionPage({ params }: { params: Promise<{ occasion: string }> }) {
  const { occasion: id } = await params;
  const occasion = getGiftOccasion(id);
  if (!occasion) notFound();

  return (
    <main className="min-h-screen bg-[#f8f0dd] text-[#1f1a16]">
      <section className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-[1.05fr_0.95fr] md:px-8 md:py-24">
        <div className="self-center">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#a64c4c]">{occasion.eyebrow}</p>
          <h1 className="mt-4 font-serif text-5xl font-medium leading-[1.02] md:text-7xl">{occasion.title}</h1>
          <p className="mt-6 max-w-2xl text-base leading-8 text-[#695f54]">{occasion.description}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={giftCheckoutHref(occasion)} className="inline-flex min-h-12 items-center justify-center rounded-full bg-[#a64c4c] px-6 text-sm font-semibold text-white">Start a custom story</Link>
            <Link href="/samples" className="inline-flex min-h-12 items-center justify-center rounded-full border border-[#d8c6a2] bg-[#fff8ec] px-6 text-sm font-semibold">See a sample page</Link>
          </div>
        </div>
        <figure className="overflow-hidden rounded-xl border border-[#d8c6a2] bg-[#fff8ec] shadow-[0_28px_80px_-55px_rgba(36,25,20,0.7)]">
          <img src={APPROVED_SAMPLE.src} alt={APPROVED_SAMPLE.alt} className="aspect-square w-full object-cover" />
          <figcaption className="px-5 py-4 text-sm font-semibold text-[#695f54]">{APPROVED_SAMPLE.framing}</figcaption>
        </figure>
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
              <li><strong className="text-[#1f1a16]">2. Review the private proof.</strong> Proofs are usually ready in 2–3 business days after we have the needed photos.</li>
              <li><strong className="text-[#1f1a16]">3. Approve before fulfillment.</strong> The final digital PDF follows approval. Printed books enter production only after approval; carrier timing can vary.</li>
            </ol>
          </div>
        </div>
      </section>
    </main>
  );
}
