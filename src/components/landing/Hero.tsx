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
    <section className="w-full min-h-screen bg-white py-20 px-4 md:px-0">
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
            <motion.h1
              variants={fadeUp}
              className="font-serif text-4xl md:text-5xl lg:text-6xl leading-tight text-forest"
            >
              Every child deserves to be the hero of their own story
            </motion.h1>

            <motion.p
              variants={fadeUp}
              className="text-lg md:text-xl text-gray-700 leading-relaxed max-w-lg"
            >
              Personalized storybooks that celebrate your child's magic
            </motion.p>

            {/* CTAs */}
            <motion.div
              variants={fadeUp}
              className="flex flex-col sm:flex-row gap-4 pt-4"
            >
              <Link href="/checkout" className="w-full sm:w-auto">
                <Button
                  className="w-full sm:w-auto bg-deep-gold text-white hover:bg-opacity-90 px-8 py-6 text-lg font-semibold rounded-lg transition transform hover:scale-105"
                >
                  Create Your Story Now
                </Button>
              </Link>
              <button
                onClick={handleSeeHowItWorks}
                className="w-full sm:w-auto px-8 py-6 text-lg font-semibold text-forest border-2 border-forest hover:bg-forest hover:text-white rounded-lg transition"
              >
                See How It Works
              </button>
            </motion.div>

            {/* Trust Badge */}
            <motion.div variants={fadeUp} className="pt-4">
              <p className="text-sm md:text-base text-forest font-medium">
                ✨ Join 50,000+ families who've created magical books
              </p>
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
              <Image
                src="/sample1.png"
                alt="Sample storybook mockup"
                width={400}
                height={500}
                className="w-full h-auto rounded-2xl shadow-2xl"
                priority
              />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
