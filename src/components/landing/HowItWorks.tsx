"use client";
import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.4, 0, 0.2, 1] } }
};

const steps = [
  { icon: '📚', title: 'Choose Your Book', description: 'Browse our collection and pick the perfect story.' },
  { icon: '✏️', title: "Add Your Child's Details", description: 'Enter name, photo, and personal touches.' },
  { icon: '🔍', title: 'Preview & Order', description: 'Review your book and place your order with ease.' },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="w-full bg-cream py-20 px-4">
      <div className="container mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-12"
        >
          <h2 className="font-serif text-4xl md:text-5xl text-forest mb-4">How It Works</h2>
          <p className="text-gray-700 text-lg max-w-2xl mx-auto">
            Follow these simple steps to create your magical storybook
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.2 } } }}
        >
          {steps.map((step, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="bg-white p-6 rounded-lg shadow-md text-center flex flex-col items-center"
            >
              <div className="text-5xl mb-4">{step.icon}</div>
              <h3 className="font-serif text-xl text-forest mb-2">{step.title}</h3>
              <p className="text-gray-700 text-sm leading-relaxed">{step.description}</p>
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mt-12"
        >
          <Link
            href="/order"
            className="bg-deep-gold text-white px-8 py-3 rounded-lg font-semibold shadow hover:bg-deep-gold/90 transition"
          >
            Create Your Book Now
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
