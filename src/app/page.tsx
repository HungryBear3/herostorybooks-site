import Image from 'next/image';

import React from 'react';
import { Hero } from '@/components/landing/Hero';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { SampleGallery } from '@/components/landing/SampleGallery';
import { Pricing } from '@/components/landing/Pricing';
import { FAQ } from '@/components/landing/FAQ';
import { Footer } from '@/components/landing/Footer';

export default function HomePage() {
  return (
    <main>
      <Hero />
      <HowItWorks />
      <SampleGallery />
      <Pricing />
      <FAQ />
      <Footer />
    </main>
  );
}
