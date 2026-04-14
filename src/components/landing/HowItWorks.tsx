import React from 'react';
import { motion } from 'framer-motion';

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.15 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

const steps = [
  {
    title: 'Tell Us About Your Child',
    description: 'Name, age, interests',
  },
  {
    title: 'Upload a Photo',
    description: 'We create illustrations resembling them',
  },
  {
    title: 'Get Your Book',
    description: 'Digital PDF in 15 min or printed hardcover shipped',
  },
];

export function HowItWorks() {
  return (
    <section className="w-full bg-[var(--forest)] py-20">
      <div className="container mx-auto px-4">
        <h2 className="text-[var(--cream)] text-3xl font-bold text-center mb-10">
          How It Works
        </h2>
        <motion.div
          className="space-y-8 max-w-2xl mx-auto"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={container}
        >
          {steps.map((step, idx) => (
            <motion.div
              key={idx}
              className="flex items-start space-x-4"
              variants={fadeUp}
            >
              <div className="flex-shrink-0">
                <div className="bg-[var(--gold)] text-[var(--forest)] rounded-full w-8 h-8 flex items-center justify-center">
                  {idx + 1}
                </div>
              </div>
              <div>
                <h3 className="text-[var(--cream)] text-xl font-semibold">
                  {step.title}
                </h3>
                <p className="text-[var(--cream)] text-base">
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
