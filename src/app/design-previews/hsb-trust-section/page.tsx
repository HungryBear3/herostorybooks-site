import type { Metadata } from 'next';
import { ProofFirstTrust } from '@/components/landing/ProofFirstTrust';

export const metadata: Metadata = {
  title: 'HSB Proof-First Trust Preview',
  description: 'Internal preview of the extracted HeroStoryBooks proof-first trust section.',
  robots: {
    index: false,
    follow: false,
  },
};

export default function HsbTrustSectionPreviewPage() {
  return (
    <main className="min-h-screen bg-[#f8f0dd]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 md:px-8">
        <div>
          <p className="text-xs font-bold uppercase text-[#a64c4c]">Internal preview</p>
          <h1 className="mt-1 font-serif text-3xl font-semibold text-[#1f1a16]">
            HSB proof-first trust section
          </h1>
        </div>
        <a
          href="/design-previews/hsb-mockups"
          className="inline-flex min-h-10 items-center justify-center rounded-full border border-[#d8c6a2] bg-[#fff8ec] px-4 text-sm font-semibold text-[#1f1a16]"
        >
          Mockups
        </a>
      </div>
      <ProofFirstTrust />
    </main>
  );
}
