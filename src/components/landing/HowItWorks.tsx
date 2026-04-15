'use client';
import React from 'react';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const steps = [
  {
    icon: '📖',
    number: 1,
    title: 'Choose Your Book',
    description: 'Browse our collection of beautifully illustrated storybooks'
  },
  {
    icon: '✏️',
    number: 2,
    title: 'Add Your Child\'s Details',
    description: 'Personalize with your child\'s name, photo, and favorite details'
  },
  {
    icon: '📦',
    number: 3,
    title: 'Preview & Order',
    description: 'Review your magical book and order your hardcover or digital copy'
  }
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="w-full bg-white py-20 px-4">
      <div className="container mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="mb-16 text-center"
          variants={fadeUp}
        >
          <h2 className="font-serif text-4xl md:text-5xl text-forest mb-4">
            How It Works
          </h2>
          <p className="text-gray-700 text-lg max-w-2xl mx-auto">
            Create your child's personalized story in three simple steps
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8 relative"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.15 } } }}
        >
          {/* Connecting line (desktop only) */}
          <div className="hidden md:block absolute top-16 left-0 right-0 h-1 bg-gradient-to-r from-deep-gold via-deep-gold to-transparent -z-10" />

          {steps.map((step, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="relative"
            >
              {/* Step card */}
              <div className="bg-white border-2 border-lavender rounded-xl p-8 text-center hover:border-deep-gold transition-colors duration-300 h-full flex flex-col justify-between">
                {/* Step number badge */}
                <div className="flex justify-center mb-6">
                  <div className="w-16 h-16 rounded-full bg-deep-gold text-white flex items-center justify-center text-3xl font-serif font-bold">
                    {step.number}
                  </div>
                </div>

                {/* Icon */}
                <div className="text-5xl mb-4">{step.icon}</div>

                {/* Content */}
                <div>
                  <h3 className="font-serif text-2xl text-forest mb-3">
                    {step.title}
                  </h3>
                  <p className="text-gray-600 text-sm leading-relaxed">
                    {step.description}
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
