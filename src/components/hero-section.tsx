"use client";

import { Button } from "@/components/ui/button";
import { Star } from "lucide-react";
import { motion } from "framer-motion";
import Link from "next/link";
import Image from "next/image";

export function HeroSection() {
  return (
    <section className="relative min-h-screen bg-gradient-to-br from-navy via-navy to-forest overflow-hidden">
      {/* Subtle texture overlay using CSS */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
      }} />
      
      {/* Decorative elements */}
      <div className="absolute top-20 left-10 w-64 h-64 bg-gold/10 rounded-full blur-3xl" />
      <div className="absolute bottom-20 right-10 w-96 h-96 bg-forest/30 rounded-full blur-3xl" />

      <div className="container mx-auto px-6 pt-32 pb-20 min-h-screen flex items-center">
        <div className="grid lg:grid-cols-2 gap-12 items-center w-full">
          {/* Left side - Text content */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="text-center lg:text-left"
          >
            {/* Social proof badge */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm border border-white/20 rounded-full px-4 py-2 mb-8"
            >
              <div className="flex">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="w-4 h-4 fill-gold text-gold" />
                ))}
              </div>
              <span className="text-cream/90 text-sm font-medium">
                Trusted by 50,000+ families
              </span>
            </motion.div>

            {/* Headline */}
            <h1 className="font-serif text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold text-cream leading-tight mb-6 text-balance">
              Every Child Is the{" "}
              <span className="text-gold">Hero</span> of Their Story
            </h1>

            {/* Subheading */}
            <p className="text-lg sm:text-xl text-cream/80 mb-10 max-w-xl mx-auto lg:mx-0 text-pretty">
              Create magical, personalized storybooks that spark imagination and 
              become treasured keepsakes for generations.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
              <Link href="/checkout">
                <Button
                  size="lg"
                  className="bg-gold text-navy hover:bg-gold/90 font-semibold text-lg px-8 py-6 shadow-lg shadow-gold/20"
                >
                  Create Your Book
                </Button>
              </Link>
              <a href="#samples" onClick={(e) => { e.preventDefault(); document.querySelector('#samples')?.scrollIntoView({ behavior: 'smooth' }); }}>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-2 border-gold/60 text-gold hover:bg-gold/10 hover:border-gold font-semibold text-lg px-8 py-6 bg-transparent"
                >
                  See a Sample
                </Button>
              </a>
            </div>
          </motion.div>

          {/* Right side - Book mockup */}
          <motion.div
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="relative flex justify-center lg:justify-end"
          >
            <motion.div
              animate={{ y: [0, -15, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              className="relative"
            >
              {/* Book shadow */}
              <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-3/4 h-8 bg-black/30 rounded-full blur-xl" />
              
              {/* Book mockup with image */}
              <div className="relative w-72 h-96 sm:w-80 sm:h-[440px] lg:w-96 lg:h-[520px] rounded-lg shadow-2xl overflow-hidden bg-navy">
                <Image
                  src="/assets/featured-1.png"
                  alt="Sample personalized storybook"
                  fill
                  className="object-cover"
                  priority
                />
                {/* Book spine effect */}
                <div className="absolute left-0 top-0 bottom-0 w-4 bg-gradient-to-r from-navy/40 to-transparent" />
              </div>

              {/* Floating decorative stars */}
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                className="absolute -top-4 -right-4 text-gold"
              >
                <Star className="w-8 h-8 fill-gold" />
              </motion.div>
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute -bottom-2 -left-6 text-gold/60"
              >
                <Star className="w-6 h-6 fill-gold/60" />
              </motion.div>
            </motion.div>
          </motion.div>
        </div>
      </div>

      {/* Scroll indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2"
      >
        <motion.div
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="w-6 h-10 border-2 border-cream/40 rounded-full flex justify-center pt-2"
        >
          <div className="w-1.5 h-3 bg-cream/60 rounded-full" />
        </motion.div>
      </motion.div>
    </section>
  );
}
