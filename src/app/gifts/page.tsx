import type { Metadata } from 'next';
import Link from 'next/link';

import { GIFT_OCCASIONS } from '@/lib/gift-occasions';

export const metadata: Metadata = {
  title: 'Personalized Storybook Gift Ideas | HeroStoryBooks',
  description:
    'Explore proof-first personalized storybook ideas for birthdays, grandparents, siblings, pets, holidays, and everyday child-as-hero gifts.',
};

export default function GiftsPage() {
  return (
    <main className="min-h-screen bg-[#f8f0dd] px-5 py-16 text-[#1f1a16] md:px-8 md:py-24">
      <div className="mx-auto max-w-6xl">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#a64c4c]">Gift ideas</p>
        <h1 className="mt-4 max-w-4xl font-serif text-5xl font-medium leading-[1.02] md:text-7xl">
          Start with the person and the moment. We&apos;ll help shape the story.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-8 text-[#695f54]">
          Every HeroStoryBook starts as a private digital proof. You review the whole book before
          approval, and physical books do not enter print until the proof is approved.
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {GIFT_OCCASIONS.map((occasion) => (
            <article key={occasion.id} className="rounded-xl border border-[#d8c6a2] bg-[#fff8ec] p-6">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#a64c4c]">{occasion.eyebrow}</p>
              <h2 className="mt-3 font-serif text-3xl font-semibold leading-tight">{occasion.title}</h2>
              <p className="mt-4 text-sm leading-7 text-[#695f54]">{occasion.description}</p>
              <Link href={`/gifts/${occasion.id}`} className="mt-6 inline-flex min-h-11 items-center font-semibold text-[#8f3f3f] underline decoration-[#d8c6a2] underline-offset-4">
                Explore this gift
              </Link>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
