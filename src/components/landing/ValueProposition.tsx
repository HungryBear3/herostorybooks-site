'use client';
import React from 'react';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const values = [
  {
    icon: '🎨',
    title: 'Personalization That Matters',
    description: 'Child\'s name, photo, and details are woven into every page'
  },
  {
    icon: '⚡',
    title: 'Fast & Easy',
    description: 'Create your personalized book in just 10 minutes'
  },
  {
    icon: '🎁',
    title: 'Perfect for Every Occasion',
    description: 'Birthdays, holidays, gifts, or just because'
  },
  {
    icon: '💚',
    title: 'Values-Driven',
    description: 'Celebrating emotional intelligence and inclusivity'
  }
];

export function ValueProposition() {
  return (
    <section className="w-full bg-lavender py-20 px-4">
      <div className="container mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
          className="grid grid-cols-1 md:grid-cols-2 gap-8"
        >
          {values.map((value, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="bg-white rounded-xl p-8 shadow-sm hover:shadow-lg transition-shadow duration-300 group hover:scale-105 transform cursor-pointer"
            >
              <div className="flex items-start gap-4">
                <span className="text-5xl leading-none">{value.icon}</span>
                <div className="flex-1">
                  <h3 className="text-xl font-serif text-forest mb-2 group-hover:text-deep-gold transition">
                    {value.title}
                  </h3>
                  <p className="text-gray-700 text-sm leading-relaxed">
                    {value.description}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
