'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';

import { SAMPLE_ADVENTURES } from '@/lib/sample-adventures';

export default function SamplesPage() {
  const [currentAdventure, setCurrentAdventure] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const adventure = SAMPLE_ADVENTURES[currentAdventure];
  const samplePages = adventure.pages;
  const page = samplePages[currentPage];

  const nextPage = () => {
    if (currentPage < samplePages.length - 1) {
      setCurrentPage((prev) => prev + 1);
    } else if (currentAdventure < SAMPLE_ADVENTURES.length - 1) {
      setCurrentAdventure((prev) => prev + 1);
      setCurrentPage(0);
    }
  };

  const prevPage = () => {
    if (currentPage > 0) {
      setCurrentPage((prev) => prev - 1);
    } else if (currentAdventure > 0) {
      setCurrentAdventure((prev) => prev - 1);
      setCurrentPage(SAMPLE_ADVENTURES[currentAdventure - 1].pages.length - 1);
    }
  };

  const selectAdventure = (idx: number) => {
    setCurrentAdventure(idx);
    setCurrentPage(0);
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-cream via-peach to-cream py-12 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="font-serif text-5xl font-bold text-navy mb-4">
            See Sample Story Flows
          </h1>
          <p className="text-lg text-navy/70 mb-4 max-w-3xl mx-auto">
            Browse fuller sample stories for each adventure. We&apos;re refreshing artwork scene by scene so the sample text and visuals stay aligned.
          </p>
          <p className="text-sm text-navy/50 mb-8">
            Each sample shows a 5-page preview arc. Your finished book includes your child&apos;s details, photo or character notes, and print-preview approval for physical copies.
          </p>

          <div className="flex flex-wrap justify-center gap-3 mb-8">
            {SAMPLE_ADVENTURES.map((adv, idx) => (
              <button
                key={idx}
                onClick={() => selectAdventure(idx)}
                className={`px-4 py-2 rounded-full font-medium transition-all ${
                  currentAdventure === idx
                    ? 'bg-gold text-navy shadow-lg'
                    : 'bg-white border-2 border-gold text-navy hover:border-gold/70'
                }`}
              >
                {adv.name}
              </button>
            ))}
          </div>
        </motion.div>

        <motion.div
          key={`${currentAdventure}-${currentPage}`}
          initial={{ opacity: 0, x: 80 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -80 }}
          className="mb-8"
        >
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden border-8 border-navy/10">
            <div className="relative aspect-video bg-navy/5">
              {page.image ? (
                <Image
                  src={page.image}
                  alt={page.subtitle}
                  fill
                  className="object-cover"
                  priority
                />
              ) : (
                <div className={`absolute inset-0 bg-gradient-to-br ${page.sceneAccent} flex items-center justify-center p-8`}>
                  <div className="max-w-xl rounded-3xl bg-white/12 backdrop-blur-sm border border-white/20 px-8 py-10 text-center text-white shadow-xl">
                    <p className="text-xs uppercase tracking-[0.3em] text-white/75 mb-3">Scene Preview</p>
                    <h2 className="font-serif text-3xl md:text-4xl mb-3">{page.sceneTitle}</h2>
                    <p className="text-sm md:text-base text-white/85 leading-relaxed">
                      Artwork refresh in progress — this page now reflects the actual story beat instead of a generic AI placeholder.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 bg-white">
              <p className="text-navy/60 text-sm mb-2">
                {adventure.name} • Page {currentPage + 1} of {samplePages.length}
              </p>
              <h2 className="font-serif text-2xl font-bold text-navy mb-4">
                {adventure.title}
              </h2>
              <p className="text-navy/70 font-medium mb-4">
                {page.subtitle}
              </p>
              <div className="border-t-2 border-gold/20 pt-4">
                <p className="text-navy text-base leading-relaxed">
                  {page.story}
                </p>
              </div>
            </div>
          </div>
        </motion.div>

        <div className="flex items-center justify-between mb-12">
          <button
            onClick={prevPage}
            disabled={currentAdventure === 0 && currentPage === 0}
            className="p-3 rounded-full bg-navy text-gold hover:bg-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>

          <div className="flex gap-2 flex-wrap justify-center">
            {samplePages.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentPage(idx)}
                className={`w-3 h-3 rounded-full transition-all ${
                  idx === currentPage ? 'bg-navy w-8' : 'bg-navy/40 hover:bg-navy/60'
                }`}
                aria-label={`Go to page ${idx + 1}`}
              />
            ))}
          </div>

          <button
            onClick={nextPage}
            disabled={currentAdventure === SAMPLE_ADVENTURES.length - 1 && currentPage === samplePages.length - 1}
            className="p-3 rounded-full bg-navy text-gold hover:bg-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            aria-label="Next page"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-gradient-to-br from-gold/10 to-peach/10 rounded-2xl p-8 text-center shadow-lg border-2 border-gold/20"
        >
          <h3 className="font-serif text-3xl font-bold text-navy mb-4">
            Ready to Create Your Child's Story?
          </h3>
          <p className="text-navy/70 mb-8 text-lg max-w-2xl mx-auto">
            Start with the adventure, tell us about your hero, and add a photo when you&apos;re ready. Print books include a digital preview for approval before printing.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/checkout">
              <Button size="lg" className="bg-gold text-navy hover:bg-gold/90 font-semibold text-lg px-8 py-6">
                Create Your Book
              </Button>
            </Link>
            <Link href="/pricing">
              <Button
                size="lg"
                variant="outline"
                className="border-2 border-navy text-navy hover:bg-navy/10 font-semibold text-lg px-8 py-6"
              >
                View Pricing
              </Button>
            </Link>
          </div>
        </motion.div>
      </div>
    </main>
  );
}
