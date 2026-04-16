'use client';
import React from 'react';
import { MothersDayBanner } from '@/components/landing/MothersDayBanner';
import { Navbar } from '@/components/landing/Navbar';
import { Hero } from '@/components/landing/Hero';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { FeaturedBooks } from '@/components/landing/FeaturedBooks';
import { ValueProposition } from '@/components/landing/ValueProposition';
import { Testimonials } from '@/components/landing/Testimonials';
import { Pricing } from '@/components/landing/Pricing';
import { TrustBadges } from '@/components/landing/TrustBadges';
import { FAQ } from '@/components/landing/FAQ';
import { Footer } from '@/components/landing/Footer';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <main className="w-full">
      <MothersDayBanner />
      <Navbar />
      <Hero />
      <div id="how-it-works">
        <HowItWorks />
      </div>
      <div id="samples">
        <FeaturedBooks />
      </div>
      <ValueProposition />
      <Testimonials />
      <div id="pricing">
        <Pricing />
      </div>
      <TrustBadges />
      <div id="faq">
        <FAQ />
      </div>
      <Footer />
    </main>
  );
}
