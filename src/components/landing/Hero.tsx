'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0, 0, 0.2, 1] as const } },
};

export function Hero() {
  return (
    <section className="w-full min-h-[90vh] relative flex items-center overflow-hidden">
      {/* Background gradient (fallback when no image asset) */}
      <div
        className="absolute inset-0 z-0"
        style={{
          background: 'linear-gradient(135deg, #1F3A5F 0%, #2a4f7a 40%, #1a3352 100%)',
        }}
      />

      {/* Decorative overlay pattern */}
      <div
        className="absolute inset-0 z-0 opacity-10"
        style={{
          backgroundImage: `radial-gradient(circle at 20% 80%, #D4AF37 0%, transparent 50%),
                            radial-gradient(circle at 80% 20%, #D4AF37 0%, transparent 50%)`,
        }}
      />

      {/* Content */}
      <div className="relative z-10 container mx-auto px-4 py-24 md:py-32">
        <motion.div
          className="max-w-3xl"
          initial="hidden"
          animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.12 } } }}
        >
          {/* Badge */}
          <motion.div variants={fadeUp} className="mb-6">
            <span
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
              style={{ backgroundColor: 'rgba(212,175,55,0.2)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.4)' }}
            >
              Perfect Mother&apos;s Day Gift
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            variants={fadeUp}
            className="font-serif text-4xl md:text-5xl lg:text-6xl text-white leading-tight mb-6"
          >
            Turn Your Child&apos;s Story Into a{' '}
            <span style={{ color: '#D4AF37' }}>Timeless Keepsake</span>
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            variants={fadeUp}
            className="text-lg md:text-xl text-white/80 leading-relaxed mb-6 max-w-2xl"
          >
            AI-powered personalized storybooks, professionally printed and delivered.
            Your child becomes the hero of their very own adventure.
          </motion.p>

          {/* Trust signals */}
          <motion.div variants={fadeUp} className="flex flex-wrap gap-6 mb-10 text-sm text-white/70">
            <div className="flex items-center gap-1.5">
              <span style={{ color: '#D4AF37' }}>★★★★★</span>
              <span className="font-semibold text-white">4.9/5</span>
              <span>from 12,000+ reviews</span>
            </div>
            <div className="hidden sm:block w-px bg-white/20" />
            <div>
              <span className="font-semibold text-white">150,000+</span> happy families
            </div>
            <div className="hidden sm:block w-px bg-white/20" />
            <div>
              <span className="font-semibold text-white">5–7 day</span> delivery
            </div>
          </motion.div>

          {/* CTAs */}
          <motion.div variants={fadeUp} className="flex flex-col sm:flex-row gap-4">
            <Link
              href="/order"
              className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold text-lg transition-all duration-300 hover:scale-105 hover:shadow-lg"
              style={{ backgroundColor: '#D4AF37', color: '#1F3A5F', boxShadow: '0 4px 20px rgba(212,175,55,0.4)' }}
            >
              Create Your Book
            </Link>
            <Link
              href="/#samples"
              className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold text-lg transition-all duration-300 border-2 text-white hover:bg-white/10"
              style={{ borderColor: 'rgba(255,255,255,0.4)' }}
            >
              See Examples
            </Link>
          </motion.div>

          {/* Delivery note */}
          <motion.p variants={fadeUp} className="mt-6 text-sm text-white/60">
            Order by April 25, 2026 for guaranteed Mother&apos;s Day delivery
          </motion.p>
        </motion.div>
      </div>

      {/* Decorative book icon area */}
      <div className="hidden lg:flex absolute right-12 top-1/2 -translate-y-1/2 z-10 items-center justify-center">
        <div
          className="w-72 h-80 rounded-2xl flex flex-col items-center justify-center shadow-2xl"
          style={{ background: 'linear-gradient(145deg, rgba(212,175,55,0.15), rgba(255,255,255,0.05))', border: '1px solid rgba(212,175,55,0.3)' }}
        >
          <div className="text-8xl mb-4">📖</div>
          <p className="text-white/60 text-sm text-center px-6">Your child&apos;s personalized storybook</p>
        </div>
      </div>
    </section>
  );
}
