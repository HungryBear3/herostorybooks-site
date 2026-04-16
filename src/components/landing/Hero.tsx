'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const slideInRight = {
  hidden: { opacity: 0, x: 50 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.6, delay: 0.2 } },
};

export function Hero() {
  const handleSeeHowItWorks = () => {
    document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="w-full min-h-screen bg-gradient-to-br from-cream via-white to-teal/5 py-20 px-4 md:px-0">
      <div className="container mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          {/* Left: Text Content */}
          <motion.div
            className="space-y-8"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
          >
            <motion.div variants={fadeUp} className="inline-flex items-center gap-2 bg-coral/10 text-coral-dark rounded-full px-4 py-2 text-sm font-semibold">
              🌸 Perfect Mother&apos;s Day Gift
            </motion.div>

            <motion.h1
              variants={fadeUp}
              className="font-serif text-4xl md:text-5xl lg:text-6xl leading-tight text-gray-900"
            >
              Give the gift that becomes a{' '}
              <span className="text-teal">keepsake</span>
            </motion.h1>

            <motion.p
              variants={fadeUp}
              className="text-lg md:text-xl text-gray-600 leading-relaxed max-w-lg"
            >
              Personalized storybooks where your child becomes the hero —
              a treasure they&apos;ll cherish forever.
            </motion.p>

            {/* Trust signals */}
            <motion.div variants={fadeUp} className="flex flex-wrap gap-4">
              <div className="flex items-center gap-1.5 text-sm text-gray-600">
                <span className="text-yellow-500">★★★★★</span>
                <span className="font-semibold text-gray-800">4.9/5</span>
                <span>from 12,000+ reviews</span>
              </div>
              <div className="text-gray-300">|</div>
              <div className="text-sm text-gray-600">
                <span className="font-semibold text-gray-800">150,000+</span> happy families
              </div>
              <div className="text-gray-300">|</div>
              <div className="text-sm text-gray-600">
                <span className="font-semibold text-gray-800">5–7 day</span> delivery
              </div>
            </motion.div>

            {/* CTAs */}
            <motion.div
              variants={fadeUp}
              className="flex flex-col sm:flex-row gap-4 pt-2"
            >
              <Link href="/checkout" className="w-full sm:w-auto">
                <Button
                  className="w-full sm:w-auto bg-coral hover:bg-coral-dark text-white px-8 py-6 text-lg font-semibold rounded-xl transition transform hover:scale-105 shadow-lg shadow-coral/30"
                >
                  Create Your Story Now
                </Button>
              </Link>
              <button
                onClick={handleSeeHowItWorks}
                className="w-full sm:w-auto px-8 py-6 text-lg font-semibold text-teal border-2 border-teal hover:bg-teal hover:text-white rounded-xl transition"
              >
                See How It Works
              </button>
            </motion.div>

            {/* Delivery note */}
            <motion.div variants={fadeUp} className="text-sm text-gray-500">
              📦 Order by April 25 for guaranteed Mother&apos;s Day delivery
            </motion.div>
          </motion.div>

          {/* Right: Book Mockup Image */}
          <motion.div
            variants={slideInRight}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            className="flex justify-center"
          >
            <div className="relative w-full max-w-sm">
              <div className="absolute -inset-4 bg-gradient-to-br from-teal/20 to-coral/20 rounded-3xl blur-2xl" />
              <Image
                src="/sample1.png"
                alt="Personalized children's storybook"
                width={400}
                height={500}
                className="relative w-full h-auto rounded-2xl shadow-2xl"
                priority
              />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
