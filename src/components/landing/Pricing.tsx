'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, } },
};

const plans = [
  {
    id: 'digital',
    title: 'Digital PDF',
    price: '$14.99',
    description: 'Digital proof first, then high-resolution PDF',
    features: [
      'Personalized digital storybook PDF',
      'Read on any device',
      'Print at home anytime',
      'Digital proof usually ready within 2 business days',
    ],
    popular: true,
    badge: 'Father’s Day Pick',
    cta: 'Choose Digital',
  },
  {
    id: 'classic',
    title: 'Classic softcover',
    price: '$44.99',
    description: 'Softcover keepsake with digital preview',
    features: [
      'Premium softcover printed book',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Digital PDF included',
    ],
    popular: false,
    cta: 'Choose Classic',
  },
  {
    id: 'premium',
    title: 'Premium hardcover',
    price: '$64.99',
    description: 'Hardcover keepsake edition',
    features: [
      'Beautiful hardcover printed book',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Digital PDF included',
      'Best for special gifts and keepsakes',
    ],
    popular: false,
    cta: 'Choose Premium',
  },
];

export function Pricing() {
  return (
    <section className="w-full bg-white py-20 px-4">
      <div className="container mx-auto">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-6"
        >
          <h2 className="font-serif text-4xl md:text-5xl mb-4" style={{ color: '#1F3A5F' }}>
            Choose Your Story
          </h2>
          <p className="text-gray-600 text-lg max-w-2xl mx-auto">
            Every option includes full personalization — your child as the hero
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-14"
        >
          <div
            className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold"
            style={{ backgroundColor: 'rgba(166,76,76,0.10)', color: '#1f1a16', border: '1px solid rgba(166,76,76,0.25)' }}
          >
            Proof approval included before print · Free shipping included for US orders on physical books
          </div>
        </motion.div>

        {/* Pricing Cards */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8 items-start"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {plans.map((plan) => (
            <motion.div
              key={plan.id}
              variants={fadeUp}
              className={`relative rounded-2xl overflow-hidden flex flex-col transition-all duration-300 ${
                plan.popular
                  ? 'shadow-2xl scale-105'
                  : 'shadow-md hover:shadow-lg'
              }`}
              style={{
                border: plan.popular ? '2px solid #D4AF37' : '1px solid #e5e7eb',
              }}
            >
              {/* Popular Badge */}
              {plan.badge && (
                <div
                  className="text-center py-2.5 text-sm font-bold tracking-wide"
                  style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
                >
                  {plan.badge}
                </div>
              )}

              <div className="p-8 flex flex-col h-full bg-white">
                {/* Plan name */}
                <h3 className="font-serif text-2xl mb-1" style={{ color: '#1F3A5F' }}>
                  {plan.title}
                </h3>
                <p className="text-sm text-gray-500 mb-6">{plan.description}</p>

                {/* Price */}
                <div className="mb-8">
                  <span
                    className="text-4xl font-bold"
                    style={{ color: plan.popular ? '#D4AF37' : '#1F3A5F' }}
                  >
                    {plan.price}
                  </span>
                  <span className="text-gray-500 text-sm ml-1">one-time</span>
                </div>

                {/* Features */}
                <ul className="space-y-3 mb-8 flex-grow">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <svg
                        className="w-5 h-5 flex-shrink-0 mt-0.5"
                        style={{ color: plan.popular ? '#D4AF37' : '#1F3A5F' }}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-gray-600">{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <Link
                  href={`/checkout?tier=${plan.id}`}
                  className="block w-full text-center py-3.5 rounded-xl font-semibold text-base transition-all duration-300 hover:scale-105"
                  style={
                    plan.popular
                      ? { backgroundColor: '#D4AF37', color: '#1F3A5F', boxShadow: '0 4px 14px rgba(212,175,55,0.4)' }
                      : { backgroundColor: '#1F3A5F', color: 'white' }
                  }
                >
                  {plan.cta}
                </Link>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Guarantee note */}
        <motion.p
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center text-sm text-gray-500 mt-10"
        >
          Digital proof before print · Secure Stripe checkout · Support at support@herostorybooks.com
        </motion.p>
      </div>
    </section>
  );
}
