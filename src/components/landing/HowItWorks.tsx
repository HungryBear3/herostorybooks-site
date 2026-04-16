'use client';
import React from 'react';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0, 0, 0.2, 1] as const } },
};

const steps = [
  {
    number: 1,
    icon: '📸',
    title: 'Upload a Photo',
    description: 'Share a clear photo of your child. Our AI uses it to create illustrations that look just like them.',
  },
  {
    number: 2,
    icon: '✨',
    title: 'AI Creates Your Story',
    description: 'Our AI weaves a personalized tale featuring your child as the hero, with their name on every page.',
  },
  {
    number: 3,
    icon: '🎨',
    title: 'We Print & Bind',
    description: 'Your book is professionally printed on premium paper with museum-quality binding.',
  },
  {
    number: 4,
    icon: '📦',
    title: 'You Receive a Keepsake',
    description: 'Your personalized storybook arrives at your door in a beautiful gift box, ready to treasure forever.',
  },
];

export function HowItWorks() {
  return (
    <section className="w-full py-20 px-4" style={{ backgroundColor: '#F5F1E8' }}>
      <div className="container mx-auto">
        {/* Section Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-16"
        >
          <h2 className="font-serif text-4xl md:text-5xl mb-4" style={{ color: '#1F3A5F' }}>
            How It Works
          </h2>
          <p className="text-gray-600 text-lg max-w-2xl mx-auto">
            Creating your personalized storybook is simple — ready in just a few minutes
          </p>
        </motion.div>

        {/* Steps */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 relative"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.15 } } }}
        >
          {steps.map((step, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="relative flex flex-col items-center text-center"
            >
              {/* Connector line (desktop, between cards) */}
              {idx < steps.length - 1 && (
                <div
                  className="hidden lg:block absolute top-8 left-[calc(50%+2rem)] w-[calc(100%-2rem)] h-0.5"
                  style={{ backgroundColor: 'rgba(212,175,55,0.4)' }}
                />
              )}

              {/* Number circle */}
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-white font-serif text-2xl font-bold mb-4 shadow-lg"
                style={{ backgroundColor: '#1F3A5F' }}
              >
                {step.number}
              </div>

              {/* Icon */}
              <div className="text-5xl mb-4">{step.icon}</div>

              {/* Content */}
              <div className="bg-white rounded-xl p-6 shadow-sm w-full">
                <h3 className="font-serif text-xl mb-2" style={{ color: '#1F3A5F' }}>
                  {step.title}
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* CTA */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mt-14"
        >
          <a
            href="/order"
            className="inline-flex items-center justify-center px-10 py-4 rounded-xl font-semibold text-lg transition-all duration-300 hover:scale-105"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F', boxShadow: '0 4px 16px rgba(212,175,55,0.35)' }}
          >
            Start Your Story
          </a>
        </motion.div>
      </div>
    </section>
  );
}
