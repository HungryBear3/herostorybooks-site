'use client';
import React from 'react';
import { Hero } from '@/components/landing/Hero';
import { MothersDayBanner } from '@/components/landing/MothersDayBanner';
import { ValueProposition } from '@/components/landing/ValueProposition';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { FeaturedBooks } from '@/components/landing/FeaturedBooks';
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
      <Hero />
      <ValueProposition />
      <HowItWorks />
      <FeaturedBooks />
      <Testimonials />
      <Pricing />
      <TrustBadges />
      <FAQ />
      <Footer />
    </main>
  );
}
