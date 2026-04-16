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
    title: 'Personalization That Matters',
    description: "Child's name, photo, and details woven into every page.",
  },
  {
    icon: '⚡',
    title: 'Fast & Easy',
    description: 'Create a custom storybook in just 10 minutes.',
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
