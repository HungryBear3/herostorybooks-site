"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { Palette, Upload, Sparkles, Gift } from "lucide-react";

const steps = [
  {
    icon: Palette,
    title: "Choose Your Story",
    description: "Browse our collection of beautifully illustrated adventure themes designed to captivate young minds.",
  },
  {
    icon: Upload,
    title: "Personalize It",
    description: "Add your child's name, photo, and special details to make them the star of their own story.",
  },
  {
    icon: Sparkles,
    title: "We Create Magic",
    description: "Our artisans craft your book with premium materials and attention to every detail.",
  },
  {
    icon: Gift,
    title: "Deliver Joy",
    description: "Receive a keepsake-quality book that will be treasured for generations to come.",
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0 },
};

export function HowItWorks() {
  return (
    <section id="features" className="pt-24 pb-20 bg-gradient-to-b from-cream to-peach/30">
      <div className="container mx-auto px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-navy mb-4">
            How It Works
          </h2>
          <p className="text-navy/70 text-lg max-w-2xl mx-auto">
            Creating a personalized storybook is simple, magical, and unforgettable.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="mb-12 overflow-hidden rounded-3xl border border-gold/20 bg-white shadow-lg"
        >
          <div className="grid gap-0 lg:grid-cols-[1.05fr_auto_1.05fr]">
            <div className="p-6 md:p-8">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.3em] text-navy/50">1. Start with a real photo</p>
              <div className="relative overflow-hidden rounded-2xl bg-peach/20 shadow-sm">
                <Image
                  src="/assets/real-photo-demo.png"
                  alt="Example child photo uploaded for personalization"
                  width={1536}
                  height={1024}
                  className="h-full w-full object-cover"
                />
              </div>
            </div>

            <div className="flex items-center justify-center px-2 py-4 lg:px-0">
              <div className="rounded-full bg-gold px-4 py-2 text-sm font-semibold text-navy shadow-sm">→ Storybook magic</div>
            </div>

            <div className="p-6 md:p-8 lg:border-l lg:border-gold/10">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.3em] text-navy/50">2. We transform it into their adventure</p>
              <div className="relative overflow-hidden rounded-2xl bg-navy/5 shadow-sm">
                <Image
                  src="/assets/storybook-transform-demo.png"
                  alt="Example transformed storybook illustration from the uploaded child photo"
                  width={1536}
                  height={1024}
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
          </div>
        </motion.div>

        {/* Steps grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid md:grid-cols-2 lg:grid-cols-4 gap-8"
        >
          {steps.map((step, index) => (
            <motion.div
              key={step.title}
              variants={itemVariants}
              className="group relative"
            >
              <div className="bg-white rounded-2xl p-8 shadow-sm hover:shadow-xl transition-shadow duration-300 h-full border border-border">
                {/* Step number */}
                <div className="absolute -top-3 -left-3 w-8 h-8 bg-gold rounded-full flex items-center justify-center text-navy font-bold text-sm shadow-lg">
                  {index + 1}
                </div>

                {/* Icon */}
                <div className="w-16 h-16 bg-navy/5 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-gold/20 transition-colors duration-300">
                  <step.icon className="w-8 h-8 text-navy group-hover:text-gold transition-colors duration-300" />
                </div>

                {/* Content */}
                <h3 className="font-serif text-xl font-semibold text-navy mb-3">
                  {step.title}
                </h3>
                <p className="text-navy/70 leading-relaxed">
                  {step.description}
                </p>
              </div>

              {/* Connector line (hidden on last item) */}
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-1/2 -right-4 w-8 h-0.5 bg-gold/30" />
              )}
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
