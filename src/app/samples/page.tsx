'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';

const adventures = [
  {
    name: 'Brave Explorer',
    title: "Marcus's Great Jungle Discovery",
    pages: [
      {
        subtitle: 'Page 1 - The Quest Begins',
        image: '/assets/explorer-sample.png',
        story: "Marcus put on his explorer hat and picked up his trusty backpack. Deep in the jungle, ancient ruins were waiting to be discovered. With courage in his heart, he stepped into the emerald forest, ready for the adventure of a lifetime.",
      },
      {
        subtitle: 'Page 2 - Ancient Ruins',
        image: '/assets/sample-page-2.png',
        story: "As Marcus pushed through the thick vines, stone walls covered in mysterious symbols appeared. His eyes grew wide with wonder. Could this be the legendary Lost City? Each step brought him closer to solving the ancient mystery.",
      },
      {
        subtitle: 'Page 3 - The Discovery',
        image: '/assets/sample-page-3.png',
        story: "Marcus found it! A golden artifact glowed in the sunlight, revealing the secrets of an ancient civilization. He had done it! The world would remember Marcus as the bravest explorer ever to find the Lost City.",
      },
    ],
  },
  {
    name: 'Space Voyager',
    title: "Zara's Cosmic Adventure",
    pages: [
      {
        subtitle: 'Page 1 - Blast Off',
        image: '/assets/space-sample.png',
        story: "Captain Zara climbed into the cockpit of the starship Aurora. The countdown began: 5... 4... 3... 2... 1... BLAST OFF! The rockets roared to life as Zara soared through the clouds toward the infinite cosmos, leaving Earth far below.",
      },
      {
        subtitle: 'Page 2 - Alien Planet',
        image: '/assets/sample-page-2.png',
        story: "The ship descended onto a swirling purple planet filled with bioluminescent plants and twin moons hanging in the sky. Zara explored the exotic landscape, marveling at the wonders of an alien world no human had ever seen before.",
      },
      {
        subtitle: 'Page 3 - New Friends',
        image: '/assets/sample-page-3.png',
        story: "Friendly alien creatures greeted Zara with warm glows and gentle chirps. They welcomed her as a friend among the stars. Zara realized that the greatest discovery wasn't a place—it was the friends she made across the galaxy.",
      },
    ],
  },
  {
    name: 'Ocean Dreams',
    title: "Lily's Underwater Kingdom",
    pages: [
      {
        subtitle: 'Page 1 - Dive Deep',
        image: '/assets/ocean-sample.png',
        story: "Lily took a deep breath and dove beneath the sparkling waves. Suddenly, a magical transformation occurred! Her legs became a shimmering tail, and she could breathe underwater. An entire kingdom of coral and wonders opened before her eyes.",
      },
      {
        subtitle: 'Page 2 - Hidden Treasures',
        image: '/assets/sample-page-2.png',
        story: "Swimming through forests of kelp and gardens of anemones, Lily discovered a secret chamber filled with treasures from sunken ships. Pearl necklaces, golden coins, and jewels beyond counting surrounded her in the underwater vault.",
      },
      {
        subtitle: 'Page 3 - Ocean Friends',
        image: '/assets/sample-page-3.png',
        story: "Dolphins, sea turtles, and rainbow fish danced around Lily in celebration. She had been welcomed as the Guardian of the Seas. With her new ocean friends by her side, Lily knew she'd found her true home under the waves.",
      },
    ],
  },
  {
    name: 'Dinosaur Discovery',
    title: "Sam's Prehistoric Adventure",
    pages: [
      {
        subtitle: 'Page 1 - Time Travel',
        image: '/assets/dino-sample.png',
        story: "Sam found a mysterious crystal that glowed with ancient energy. In a flash of light, Sam was transported back 65 million years to the age of dinosaurs! Towering ferns and prehistoric creatures surrounded him in an impossible world.",
      },
      {
        subtitle: 'Page 2 - Dinosaur Friends',
        image: '/assets/sample-page-2.png',
        story: "A gentle Triceratops approached Sam with curious eyes. Rather than fear, there was friendship between them. Soon, a family of dinosaurs accepted Sam as one of their own, and they explored the primeval landscape together.",
      },
      {
        subtitle: 'Page 3 - Return Home',
        image: '/assets/sample-page-3.png',
        story: "As the crystal glowed again, Sam said goodbye to his dinosaur friends. Back in his own time, Sam kept the crystal as proof of his incredible adventure. He would never forget the day he walked with dinosaurs.",
      },
    ],
  },
];

export default function SamplesPage() {
  const [currentAdventure, setCurrentAdventure] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const adventure = adventures[currentAdventure];
  const samplePages = adventure.pages;

  const nextPage = () => {
    if (currentPage < samplePages.length - 1) {
      setCurrentPage((prev) => prev + 1);
    } else if (currentAdventure < adventures.length - 1) {
      setCurrentAdventure((prev) => prev + 1);
      setCurrentPage(0);
    }
  };

  const prevPage = () => {
    if (currentPage > 0) {
      setCurrentPage((prev) => prev - 1);
    } else if (currentAdventure > 0) {
      setCurrentAdventure((prev) => prev - 1);
      setCurrentPage(adventures[currentAdventure - 1].pages.length - 1);
    }
  };

  const selectAdventure = (idx: number) => {
    setCurrentAdventure(idx);
    setCurrentPage(0);
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-cream via-peach to-cream py-12 px-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="font-serif text-5xl font-bold text-navy mb-4">
            See How It Works
          </h1>
          <p className="text-lg text-navy/70 mb-8">
            Flip through samples of each adventure type personalized with your child's name.
          </p>
          
          {/* Adventure selector */}
          <div className="flex flex-wrap justify-center gap-3 mb-8">
            {adventures.map((adv, idx) => (
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

        {/* Book Viewer */}
        <motion.div
          key={`${currentAdventure}-${currentPage}`}
          initial={{ opacity: 0, x: 100 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -100 }}
          className="mb-8"
        >
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden border-8 border-navy/10">
            <div className="relative aspect-video">
              <Image
                src={samplePages[currentPage].image}
                alt={samplePages[currentPage].subtitle}
                fill
                className="object-cover"
                priority
              />
            </div>

            {/* Page info & story text */}
            <div className="p-6 bg-white">
              <p className="text-navy/60 text-sm mb-2">
                {adventure.name} • Page {currentPage + 1} of {samplePages.length}
              </p>
              <h2 className="font-serif text-2xl font-bold text-navy mb-4">
                {adventure.title}
              </h2>
              <p className="text-navy/70 font-medium mb-4">
                {samplePages[currentPage].subtitle}
              </p>
              <div className="border-t-2 border-gold/20 pt-4">
                <p className="text-navy text-base leading-relaxed">
                  {samplePages[currentPage].story}
                </p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Navigation Controls */}
        <div className="flex items-center justify-between mb-12">
          <button
            onClick={prevPage}
            disabled={currentPage === 0}
            className="p-3 rounded-full bg-navy text-gold hover:bg-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>

          {/* Page indicators */}
          <div className="flex gap-2">
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
            disabled={currentAdventure === adventures.length - 1 && currentPage === samplePages.length - 1}
            className="p-3 rounded-full bg-navy text-gold hover:bg-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            aria-label="Next page"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>

        {/* CTA Section */}
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
            Every book is personalized with your child's name, interests, and personality. Create a keepsake they'll treasure forever—and want to read again and again.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/checkout">
              <Button size="lg" className="bg-gold text-navy hover:bg-gold/90 font-semibold text-lg px-8 py-6">
                Create Your Book
              </Button>
            </Link>
            <Link href="/">
              <Button
                size="lg"
                variant="outline"
                className="border-2 border-navy text-navy hover:bg-navy/10 font-semibold text-lg px-8 py-6"
              >
                Back to Home
              </Button>
            </Link>
          </div>
        </motion.div>

        {/* Social Proof */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-12 text-center"
        >
          <p className="text-navy/60 mb-4">⭐ Trusted by 50,000+ families</p>
          <p className="text-navy/50 text-sm">
            Join parents who've created lasting memories for their children.
          </p>
        </motion.div>
      </div>
    </main>
  );
}
