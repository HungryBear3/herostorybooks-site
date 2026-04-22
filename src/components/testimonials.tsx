"use client";

import { motion } from "framer-motion";
import { Star, Quote } from "lucide-react";

const testimonials = [
  {
    name: "Sarah M.",
    childName: "Emma, age 5",
    quote: "My daughter's face lit up when she saw herself in the story. She asks to read it every night before bed. This is truly a magical keepsake!",
    rating: 5,
  },
  {
    name: "Michael T.",
    childName: "Lucas, age 7",
    quote: "The quality exceeded our expectations. The illustrations are gorgeous and the personalization makes it feel so special. Worth every penny.",
    rating: 5,
  },
  {
    name: "Jennifer L.",
    childName: "Sophia, age 4",
    quote: "We ordered for our granddaughter's birthday and it was a huge hit! She loves being the hero and the book quality is exceptional.",
    rating: 5,
  },
  {
    name: "David K.",
    childName: "Oliver, age 6",
    quote: "Third book we've ordered and each one has been perfect. The customer service is wonderful and the turnaround time is impressive.",
    rating: 5,
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

export function Testimonials() {
  return (
    <section id="about" className="py-24 bg-cream border-y border-border">
      <div className="container mx-auto px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-navy mb-4">
            Loved by Families
          </h2>
          <p className="text-navy/70 text-lg max-w-2xl mx-auto">
            Join thousands of happy parents who have created unforgettable memories.
          </p>
        </motion.div>

        {/* Testimonials grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid md:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {testimonials.map((testimonial) => (
            <motion.div
              key={testimonial.name}
              variants={itemVariants}
              className="bg-white rounded-2xl p-6 shadow-sm border border-border hover:shadow-lg transition-shadow duration-300"
            >
              {/* Quote icon */}
              <Quote className="w-8 h-8 text-gold/40 mb-4" />

              {/* Stars */}
              <div className="flex gap-1 mb-4">
                {[...Array(testimonial.rating)].map((_, i) => (
                  <Star key={i} className="w-4 h-4 fill-gold text-gold" />
                ))}
              </div>

              {/* Quote */}
              <p className="text-navy/80 mb-6 leading-relaxed text-sm">
                &quot;{testimonial.quote}&quot;
              </p>

              {/* Author */}
              <div className="flex items-center gap-3">
                {/* Avatar placeholder */}
                <div className="w-10 h-10 bg-gradient-to-br from-gold/30 to-peach rounded-full flex items-center justify-center">
                  <span className="font-semibold text-navy text-sm">
                    {testimonial.name.charAt(0)}
                  </span>
                </div>
                <div>
                  <p className="font-semibold text-navy text-sm">{testimonial.name}</p>
                  <p className="text-navy/60 text-xs">{testimonial.childName}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
