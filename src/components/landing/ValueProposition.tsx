'use client';
import React from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, } },
};

const values = [
  {
    icon: '🎨',
    title: 'Personalization That Matters',
    description: "Child's name, photo, and details woven into every page.",
  },
  {
    icon: '✓',
    title: 'Proof First',
    description: 'Review the full book and request changes before anything prints.',
  },
  {
    icon: '🎁',
    title: 'Perfect for Every Occasion',
    description: 'Ideal gifts for birthdays, holidays, and special moments.',
  },
  {
    icon: '💚',
    title: 'Values-Driven',
    description: 'Builds emotional intelligence and inclusivity in every tale.',
  },
];

export function ValueProposition() {
  return (
    <section id="values" className="w-full bg-cream py-20 px-4">
      <div className="container mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="mb-16 overflow-hidden rounded-[32px] bg-[#16324F] text-white shadow-[0_32px_100px_rgba(22,50,79,0.22)]"
        >
          <div className="grid items-center gap-0 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="p-8 md:p-12 lg:p-14">
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.35em] text-[#D6B25E]">
                The HeroStoryBooks promise
              </p>
              <h3 className="max-w-2xl font-serif text-3xl leading-tight md:text-4xl">
                Personalized stories that help children feel brave, seen, and deeply loved.
              </h3>
              <p className="mt-5 max-w-2xl text-base leading-7 text-white/82 md:text-lg">
                We blend keepsake-quality design with confidence-building storytelling, so every book feels
                like a magical gift and a meaningful family ritual.
              </p>
              <div className="mt-8 flex flex-wrap gap-3 text-sm text-white/85">
                <span className="rounded-full border border-white/15 bg-white/8 px-4 py-2">Custom hero journey</span>
                <span className="rounded-full border border-white/15 bg-white/8 px-4 py-2">Made for gifting moments</span>
                <span className="rounded-full border border-white/15 bg-white/8 px-4 py-2">Confidence + kindness themes</span>
              </div>
            </div>
            <div className="flex h-full items-center justify-center bg-[#F6E7CC] p-8 md:p-12">
              <div className="w-full max-w-sm rounded-[28px] bg-white p-6 text-center shadow-2xl shadow-black/10">
                <Image
                  src="/assets/logo-full-fancy.png"
                  alt="HeroStoryBooks full brand mark"
                  width={240}
                  height={240}
                  className="mx-auto h-auto w-40 md:w-48"
                />
                <p className="mt-5 text-xs font-semibold uppercase tracking-[0.3em] text-[#B28B37]">
                  Signature keepsake brand mark
                </p>
                <p className="mt-3 font-serif text-2xl text-[#16324F]">Stories That Build Courage & Kindness</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-14"
        >
          <h2 className="font-serif text-4xl md:text-5xl text-forest mb-4">
            Why Families Love Us
          </h2>
          <p className="text-gray-700 text-lg max-w-2xl mx-auto">
            We believe every child deserves to see themselves as the hero
          </p>
        </motion.div>

        {/* Value Cards */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.12 } } }}
        >
          {values.map((value, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="bg-white p-6 rounded-lg shadow-md text-center transition hover:shadow-lg"
            >
              <div className="text-4xl mb-4">{value.icon}</div>
              <h3 className="font-serif text-xl text-forest mb-2">
                {value.title}
              </h3>
              <p className="text-gray-700 text-sm leading-relaxed">
                {value.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
