'use client';

import Image from 'next/image';
import Link from 'next/link';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const slideIn = {
  hidden: { opacity: 0, x: 20 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.8 } },
};

export function HeroV0() {
  return (
    <section id="hero" className="w-full bg-gradient-to-br from-[#16324F] via-[#2D5A3D] to-[#16324F] text-cream min-h-screen flex items-center overflow-hidden relative">
      {/* Decorative elements */}
      <div className="absolute top-10 right-10 w-72 h-72 bg-[#D6B25E]/10 rounded-full blur-3xl"></div>
      <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-[#FDD6C5]/5 rounded-full blur-3xl"></div>

      <div className="container mx-auto px-4 py-20 flex flex-col-reverse lg:flex-row items-center gap-12 relative z-10">
        {/* Text Content */}
        <motion.div
          className="w-full lg:w-1/2 flex flex-col space-y-8"
          initial="hidden"
          animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.15 } } }}
        >
          {/* Logo */}
          <motion.div variants={fadeUp} className="mb-4">
            <Image
              src="/assets/logo-hero-tagline-horizontal.png"
              alt="HeroStoryBooks Logo"
              width={280}
              height={100}
              className="h-auto w-48"
              priority
            />
          </motion.div>

          {/* Social Proof Badge */}
          <motion.div variants={fadeUp}>
            <span className="inline-flex items-center px-4 py-2 bg-[#D6B25E]/20 text-[#D6B25E] rounded-full font-medium text-sm backdrop-blur-sm">
              ⭐ Trusted by 50,000+ families
            </span>
          </motion.div>

          {/* Main Headline */}
          <motion.div variants={fadeUp}>
            <h1 className="font-serif text-5xl md:text-6xl lg:text-7xl leading-tight text-cream">
              Your Child's Name Becomes the Hero of an Amazing Adventure
            </h1>
          </motion.div>

          {/* Subheading */}
          <motion.div variants={fadeUp}>
            <p className="text-lg md:text-xl text-cream/85 leading-relaxed max-w-lg">
              Personalized storybooks that celebrate your child's magic, build their confidence, and become treasured family keepsakes they'll love forever.
            </p>
          </motion.div>

          {/* CTA Buttons */}
          <motion.div variants={fadeUp} className="flex flex-col sm:flex-row gap-4 pt-4">
            <Link
              href="/checkout"
              className="inline-flex items-center justify-center px-8 py-4 bg-[#D6B25E] text-[#16324F] font-serif font-bold text-lg rounded-lg shadow-xl hover:bg-[#C9A960] transition-all duration-300 hover:shadow-2xl hover:scale-105"
            >
              Create Your Book
            </Link>
            <Link
              href="#how-it-works"
              className="inline-flex items-center justify-center px-8 py-4 border-2 border-[#D6B25E] text-[#D6B25E] font-serif font-bold text-lg rounded-lg hover:bg-[#D6B25E]/10 transition-all duration-300"
            >
              See a Sample
            </Link>
          </motion.div>

          {/* Trust Elements */}
          <motion.div variants={fadeUp} className="flex gap-6 pt-4 text-sm text-cream/70">
            <div className="flex items-center gap-2">
              <span className="text-xl">📦</span>
              <span>Ships in 7-10 days</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xl">✨</span>
              <span>Premium quality</span>
            </div>
          </motion.div>
        </motion.div>

        {/* Hero Image - Moving Book Mockup */}
        <motion.div
          className="w-full lg:w-1/2 flex justify-center items-center"
          initial="hidden"
          animate="visible"
          variants={slideIn}
        >
          <motion.div
            animate={{ y: [0, -20, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
            className="relative"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-[#D6B25E]/30 to-[#FDD6C5]/20 rounded-2xl blur-2xl"></div>
            <Image
              src="/assets/hero-book-mockup.png"
              alt="Personalized Storybook Mockup - Your Child as the Hero"
              width={480}
              height={600}
              className="relative z-10 rounded-2xl shadow-2xl"
              priority
            />
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
