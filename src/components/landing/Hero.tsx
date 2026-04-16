"use client";
import React from 'react';
import { motion, Variants } from 'framer-motion';
import Link from 'next/link';
import Image from 'next/image';

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } }
};

export function Hero() {
  return (
    <section id="hero" className="w-full bg-cream min-h-[70vh] flex items-center">
      <div className="container mx-auto px-4 py-20 flex flex-col-reverse lg:flex-row items-center gap-8">
        {/* Text Content */}
        <div className="w-full lg:w-1/2 flex flex-col items-start space-y-6">
          <motion.div variants={fadeUp} initial="hidden" animate="visible">
            <span className="inline-flex items-center px-4 py-2 bg-deep-gold/20 text-deep-gold rounded-full font-medium text-sm">
              ✨ Join 50,000+ families
            </span>
          </motion.div>
          <motion.h1 variants={fadeUp} initial="hidden" animate="visible" className="font-serif text-4xl md:text-5xl lg:text-6xl text-forest leading-tight">
            Every child deserves to be the hero of their own story
          </motion.h1>
          <motion.p variants={fadeUp} initial="hidden" animate="visible" className="text-lg text-gray-700">
            Personalized storybooks that celebrate your child's magic
          </motion.p>
          <motion.div variants={fadeUp} initial="hidden" animate="visible" className="flex space-x-4">
            <Link
              href="/order"
              className="bg-deep-gold text-white px-8 py-3 rounded-lg font-semibold shadow hover:bg-deep-gold/90 transition"
            >
              Create Your Book Now
            </Link>
            <Link
              href="#how-it-works"
              className="border-2 border-forest text-forest px-8 py-3 rounded-lg font-semibold hover:bg-forest hover:text-white transition"
            >
              See How It Works
            </Link>
          </motion.div>
        </div>
        {/* Book Mockup */}
        <motion.div variants={fadeUp} initial="hidden" animate="visible" className="w-full lg:w-1/2 flex justify-center">
          <Image
            src="/sample1.png"
            width={400}
            height={520}
            alt="Book mockup"
            className="rounded-xl shadow-lg"
          />
        </motion.div>
      </div>
    </section>
  );
}
