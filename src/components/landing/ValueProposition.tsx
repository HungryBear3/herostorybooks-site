'use client';
import React from 'react';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0, 0, 0.2, 1] as const } },
};

const values = [
  {
    icon: '🎨',
    title: 'Truly Personalized',
    description: 'Your child\'s name, photo, and unique details are woven into every page. No two books are ever the same.',
  },
  {
    icon: '🏆',
    title: 'Premium Quality',
    description: 'Museum-grade printing on acid-free paper with professional binding that lasts a lifetime.',
  },
  {
    icon: '🌿',
    title: 'Eco-Friendly',
    description: 'Sustainably sourced paper, vegetable-based inks, and carbon-neutral shipping for a greener world.',
  },
];

export function ValueProposition() {
  return (
    <section className="w-full py-20 px-4" style={{ backgroundColor: '#1F3A5F' }}>
      <div className="container mx-auto">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-14"
        >
          <h2 className="font-serif text-4xl md:text-5xl text-white mb-4">
            Why Families Love Us
          </h2>
          <p className="text-white/70 text-lg max-w-2xl mx-auto">
            We believe every child deserves to see themselves as the hero
          </p>
        </motion.div>

        {/* Value Cards */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.12 } } }}
        >
          {values.map((value, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="rounded-2xl p-8 text-center transition-all duration-300 hover:-translate-y-1"
              style={{ backgroundColor: 'rgba(255,255,255,0.08)', border: '1px solid rgba(212,175,55,0.2)' }}
            >
              <div className="text-6xl mb-5">{value.icon}</div>
              <h3 className="font-serif text-xl mb-3" style={{ color: '#D4AF37' }}>
                {value.title}
              </h3>
              <p className="text-white/70 text-sm leading-relaxed">
                {value.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
