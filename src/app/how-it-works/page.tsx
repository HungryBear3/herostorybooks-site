'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { Upload, Wand2, BookOpen, Package } from 'lucide-react';

const steps = [
  {
    number: 1,
    icon: Upload,
    title: 'Upload Your Photo',
    description: 'Choose a favorite photo of your child. We\'ll use advanced AI to intelligently integrate it into the story artwork.',
    color: 'from-gold to-peach',
  },
  {
    number: 2,
    icon: Wand2,
    title: 'AI Magic',
    description: 'Our proprietary AI technology seamlessly blends your child\'s photo into custom illustrations, making them the hero of their own story.',
    color: 'from-purple to-lavender',
  },
  {
    number: 3,
    icon: BookOpen,
    title: 'Personalized Story',
    description: 'We create a unique, age-appropriate story where your child is the main character. Add their name, interests, and special details.',
    color: 'from-navy to-forest',
  },
  {
    number: 4,
    icon: Package,
    title: 'High-Quality Print',
    description: 'Your finished book is professionally printed on premium paper and hardbound. Perfect for gifting or keeping as a cherished keepsake.',
    color: 'from-cream to-peach',
  },
];

const processHighlights = [
  {
    title: 'Professional Photo Integration',
    description: 'Your child\'s photo is artfully integrated into custom illustrated scenes, not just pasted in. The result looks like a professional storybook illustration.',
  },
  {
    title: 'AI-Powered Customization',
    description: 'Machine learning ensures consistent art style, proper proportions, and age-appropriate content throughout the entire book.',
  },
  {
    title: 'Premium Print Quality',
    description: 'Full-color hardbound books with glossy covers, premium paper, and professional binding that rivals traditional publishing.',
  },
  {
    title: 'Fast Turnaround',
    description: 'From upload to doorstep in just 7-10 business days. Perfect for last-minute gifts or special occasions.',
  },
];

export default function HowItWorksPage() {
  return (
    <main className="min-h-screen bg-cream">
      {/* Hero Section */}
      <section className="relative py-16 px-6 bg-gradient-to-br from-navy via-navy to-forest text-white">
        <div className="max-w-4xl mx-auto text-center">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="font-serif text-5xl md:text-6xl font-bold mb-6"
          >
            How We Create Magic
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-xl text-gold mb-8"
          >
            Transform a photo into a personalized storybook masterpiece
          </motion.p>
        </div>
      </section>

      {/* Process Steps */}
      <section className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 mb-16">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.1 }}
                  className="relative"
                >
                  {/* Connection line */}
                  {idx < steps.length - 1 && (
                    <div className="hidden lg:block absolute top-20 -right-4 w-8 h-1 bg-gradient-to-r from-gold to-transparent" />
                  )}

                  <div className={`bg-gradient-to-br ${step.color} rounded-2xl p-8 text-center h-full shadow-lg`}>
                    <div className="w-16 h-16 mx-auto mb-6 bg-white/20 rounded-full flex items-center justify-center">
                      <Icon className="w-8 h-8 text-white" />
                    </div>
                    <h3 className="font-serif text-2xl font-bold text-navy mb-3">
                      Step {step.number}
                    </h3>
                    <h4 className="text-lg font-bold text-navy mb-4">
                      {step.title}
                    </h4>
                    <p className="text-navy/80 text-sm leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Connection arrows (mobile) */}
          <div className="lg:hidden flex justify-center gap-4 mb-16">
            {[1, 2, 3].map((i) => (
              <div key={i} className="text-gold text-2xl">↓</div>
            ))}
          </div>
        </div>
      </section>

      {/* Detailed Process Explanation */}
      <section className="py-24 px-6 bg-white">
        <div className="max-w-4xl mx-auto">
          <motion.h2
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            className="font-serif text-4xl font-bold text-navy text-center mb-16"
          >
            What Makes Us Different
          </motion.h2>

          <div className="grid md:grid-cols-2 gap-12">
            {processHighlights.map((highlight, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, x: idx % 2 === 0 ? -20 : 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.1 }}
                className="p-8 bg-cream rounded-xl border-2 border-gold/20"
              >
                <h3 className="font-serif text-2xl font-bold text-navy mb-4">
                  {highlight.title}
                </h3>
                <p className="text-navy/70 leading-relaxed">
                  {highlight.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Tech Stack / Quality Assurance */}
      <section className="py-24 px-6 bg-gradient-to-br from-cream via-peach to-cream">
        <div className="max-w-4xl mx-auto text-center">
          <motion.h2
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            className="font-serif text-4xl font-bold text-navy mb-12"
          >
            Quality You Can Trust
          </motion.h2>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              { label: 'AI-Enhanced', value: '99% Accuracy' },
              { label: 'Print Quality', value: 'Premium Grade' },
              { label: 'Turnaround', value: '7-10 Days' },
            ].map((stat, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                transition={{ delay: idx * 0.1 }}
                className="p-6 bg-white rounded-xl shadow-md"
              >
                <p className="text-navy/60 text-sm mb-2">{stat.label}</p>
                <p className="font-serif text-3xl font-bold text-gold">
                  {stat.value}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 px-6 bg-white">
        <div className="max-w-4xl mx-auto text-center">
          <motion.h2
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            className="font-serif text-4xl font-bold text-navy mb-6"
          >
            Ready to Create Magic?
          </motion.h2>
          <p className="text-lg text-navy/70 mb-8 max-w-2xl mx-auto">
            Start with a photo. End with a keepsake your child will treasure forever.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/checkout">
              <Button size="lg" className="bg-gold text-navy hover:bg-gold/90 font-semibold text-lg px-8 py-6">
                Create Your Book
              </Button>
            </Link>
            <Link href="/samples">
              <Button
                size="lg"
                variant="outline"
                className="border-2 border-navy text-navy hover:bg-navy/10 font-semibold text-lg px-8 py-6"
              >
                See Sample Books
              </Button>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
