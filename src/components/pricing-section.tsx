"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Check, Sparkles } from "lucide-react";

const tiers = [
  {
    name: "Classic",
    price: "$19.99",
    description: "Perfect for a special gift",
    features: [
      "20-page personalized story",
      "Child's name throughout",
      "Softcover binding",
      "Standard shipping",
    ],
    featured: false,
  },
  {
    name: "Premium",
    price: "$29.99",
    description: "Our most popular choice",
    features: [
      "28-page personalized story",
      "Child's name & photo",
      "Hardcover binding",
      "Gift wrapping included",
      "Priority shipping",
    ],
    featured: true,
  },
  {
    name: "Deluxe",
    price: "$44.99",
    description: "The ultimate keepsake",
    features: [
      "36-page personalized story",
      "Multiple photos & dedication",
      "Premium hardcover",
      "Collector's gift box",
      "Express shipping",
      "Digital copy included",
    ],
    featured: false,
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0 },
};

export function PricingSection() {
  return (
    <section id="pricing" className="py-24 bg-gradient-to-b from-cream to-peach/20">
      <div className="container mx-auto px-6">
        {/* Promo banner */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mx-auto mb-12"
        >
          <div className="bg-gold/20 border border-gold/40 rounded-full px-6 py-3 text-center">
            <span className="text-navy font-medium">
              🎁 20% off with code <span className="font-bold">MOM20</span> through Apr 30
            </span>
          </div>
        </motion.div>

        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-navy mb-4">
            Choose Your Story
          </h2>
          <p className="text-navy/70 text-lg max-w-2xl mx-auto">
            Every tier creates a magical experience. Pick the perfect fit for your little hero.
          </p>
        </motion.div>

        {/* Pricing cards */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto"
        >
          {tiers.map((tier) => (
            <motion.div
              key={tier.name}
              variants={itemVariants}
              className={`relative rounded-2xl p-8 transition-all duration-300 ${
                tier.featured
                  ? "bg-navy text-cream shadow-2xl shadow-navy/20 scale-105 border-2 border-gold"
                  : "bg-white text-navy shadow-sm border border-border hover:shadow-lg"
              }`}
            >
              {/* Featured badge */}
              {tier.featured && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-gold text-navy px-4 py-1 rounded-full text-sm font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4" />
                  Most Popular
                </div>
              )}

              {/* Tier name */}
              <h3 className={`font-serif text-2xl font-bold mb-2 ${tier.featured ? "text-cream" : "text-navy"}`}>
                {tier.name}
              </h3>

              {/* Description */}
              <p className={`text-sm mb-6 ${tier.featured ? "text-cream/70" : "text-navy/60"}`}>
                {tier.description}
              </p>

              {/* Price */}
              <div className="mb-8">
                <span className={`text-4xl font-bold ${tier.featured ? "text-gold" : "text-navy"}`}>
                  {tier.price}
                </span>
                <span className={`text-sm ${tier.featured ? "text-cream/60" : "text-navy/50"}`}>
                  {" "}per book
                </span>
              </div>

              {/* Features */}
              <ul className="space-y-3 mb-8">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check className={`w-5 h-5 shrink-0 mt-0.5 ${tier.featured ? "text-gold" : "text-forest"}`} />
                    <span className={`text-sm ${tier.featured ? "text-cream/90" : "text-navy/80"}`}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <Button
                className={`w-full font-semibold ${
                  tier.featured
                    ? "bg-gold text-navy hover:bg-gold/90"
                    : "bg-navy text-cream hover:bg-navy/90"
                }`}
              >
                Choose {tier.name}
              </Button>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
