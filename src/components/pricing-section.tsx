"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { Check, Sparkles } from "lucide-react";

import { PUBLIC_PRICING_PLANS } from "@/lib/pricing";

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
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-navy mb-4">
            Clear Pricing, Before You Upload Anything
          </h2>
          <p className="text-navy/70 text-lg max-w-2xl mx-auto">
            Choose the format that fits your gift. Print books always include a preview for approval before printing.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto"
        >
          {PUBLIC_PRICING_PLANS.map((plan) => (
            <motion.div
              key={plan.id}
              variants={itemVariants}
              className={`relative rounded-2xl p-8 transition-all duration-300 ${
                plan.featured
                  ? "bg-navy text-cream shadow-2xl shadow-navy/20 scale-105 border-2 border-gold"
                  : "bg-white text-navy shadow-sm border border-border hover:shadow-lg"
              }`}
            >
              {plan.featured && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-gold text-navy px-4 py-1 rounded-full text-sm font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4" />
                  Most Popular
                </div>
              )}

              <h3 className={`font-serif text-2xl font-bold mb-2 ${plan.featured ? "text-cream" : "text-navy"}`}>
                {plan.name}
              </h3>
              <p className={`text-sm mb-6 ${plan.featured ? "text-cream/70" : "text-navy/60"}`}>
                {plan.description}
              </p>

              <div className="mb-5">
                <span className={`text-4xl font-bold ${plan.featured ? "text-gold" : "text-navy"}`}>
                  {plan.price}
                </span>
                <span className={`text-sm ${plan.featured ? "text-cream/60" : "text-navy/50"}`}>
                  {" "}one-time
                </span>
              </div>

              <p className={`text-sm rounded-xl px-4 py-3 mb-6 ${plan.featured ? "bg-white/10 text-cream/90" : "bg-gold/10 text-navy/80"}`}>
                {plan.promise}
              </p>

              <ul className="space-y-3 mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check className={`w-5 h-5 shrink-0 mt-0.5 ${plan.featured ? "text-gold" : "text-forest"}`} />
                    <span className={`text-sm ${plan.featured ? "text-cream/90" : "text-navy/80"}`}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>

              <Link
                href={`/checkout?format=${plan.id}`}
                className={`block w-full text-center py-3.5 rounded-xl font-semibold text-base transition-all duration-300 hover:scale-105 ${
                  plan.featured
                    ? "bg-gold text-navy hover:bg-gold/90"
                    : "bg-navy text-cream hover:bg-navy/90"
                }`}
              >
                {plan.cta}
              </Link>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
