'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Check } from 'lucide-react';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const plans = [
  {
    title: 'Digital',
    price: '$29',
    priceDesc: 'one-time',
    features: [
      'PDF delivered in ~15 minutes',
      'Read on any device',
      'Print at home',
      'Standard illustrations'
    ],
    highlight: false,
    cta: 'Get Digital Copy'
  },
  {
    title: 'Printed Hardcover',
    price: '$49',
    priceDesc: 'one-time',
    features: [
      'Premium hardcover book',
      'Ships in 7-10 business days',
      'Professional quality printing',
      'Perfect for gifting'
    ],
    highlight: true,
    cta: 'Order Hardcover',
    badge: 'Most Popular'
  },
  {
    title: 'Bundle',
    price: '$59',
    priceDesc: 'one-time',
    features: [
      'Digital + Hardcover copies',
      'Everything from both tiers',
      'Best value',
      'Share in multiple formats'
    ],
    highlight: false,
    cta: 'Get Bundle'
  }
];

export function Pricing() {
  return (
    <section className="w-full bg-white py-20 px-4">
      <div className="container mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="mb-16 text-center"
          variants={fadeUp}
        >
          <h2 className="font-serif text-4xl md:text-5xl text-forest mb-4">
            Choose Your Adventure
          </h2>
          <p className="text-gray-700 text-lg max-w-2xl mx-auto">
            Multiple ways to bring your child's story to life
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {plans.map((plan, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className={`relative rounded-xl overflow-hidden transition-all duration-300 flex flex-col h-full ${
                plan.highlight
                  ? 'bg-gradient-to-b from-deep-gold/10 to-white border-2 border-deep-gold shadow-xl scale-105'
                  : 'bg-white border border-gray-200 shadow-lg'
              }`}
            >
              {/* Badge */}
              {plan.badge && (
                <div className="bg-deep-gold text-white px-4 py-2 text-center text-sm font-semibold">
                  {plan.badge}
                </div>
              )}

              {/* Content */}
              <div className="p-8 flex flex-col h-full">
                {/* Title */}
                <h3 className="font-serif text-2xl text-forest mb-4">
                  {plan.title}
                </h3>

                {/* Price */}
                <div className="mb-8">
                  <span className="text-4xl font-bold text-deep-gold">
                    {plan.price}
                  </span>
                  <span className="text-gray-600 text-sm ml-2">
                    {plan.priceDesc}
                  </span>
                </div>

                {/* Features */}
                <ul className="space-y-4 mb-8 flex-grow">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <Check className="w-5 h-5 text-deep-gold flex-shrink-0 mt-0.5" />
                      <span className="text-gray-700 text-sm">
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <Link href="/checkout" className="block w-full">
                  <Button
                    className={`w-full py-6 text-lg font-semibold rounded-lg transition transform hover:scale-105 ${
                      plan.highlight
                        ? 'bg-deep-gold text-white hover:bg-opacity-90'
                        : 'bg-forest text-white hover:bg-opacity-90'
                    }`}
                  >
                    {plan.cta}
                  </Button>
                </Link>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
