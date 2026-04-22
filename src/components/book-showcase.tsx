"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

const books = [
  {
    title: "The Brave Explorer",
    description: "An adventurous journey through enchanted forests and magical kingdoms.",
    color: "from-forest/20 to-forest/5",
    accent: "forest",
  },
  {
    title: "Space Voyager",
    description: "Blast off to the stars and discover wonders beyond imagination.",
    color: "from-navy/20 to-navy/5",
    accent: "navy",
  },
  {
    title: "Ocean Dreams",
    description: "Dive deep into underwater adventures with friendly sea creatures.",
    color: "from-lavender to-lavender/30",
    accent: "navy",
  },
  {
    title: "Dinosaur Discovery",
    description: "Travel back in time to meet prehistoric friends and learn their secrets.",
    color: "from-peach to-peach/30",
    accent: "forest",
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
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1 },
};

export function BookShowcase() {
  return (
    <section className="py-24 bg-cream">
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
            Featured Adventures
          </h2>
          <p className="text-navy/70 text-lg max-w-2xl mx-auto">
            Explore our collection of magical stories waiting to feature your child as the hero.
          </p>
        </motion.div>

        {/* Books grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {books.map((book) => (
            <motion.div
              key={book.title}
              variants={itemVariants}
              className="group cursor-pointer"
            >
              <div className="relative overflow-hidden rounded-2xl bg-white border border-border shadow-sm hover:shadow-xl transition-all duration-300">
                {/* Book cover placeholder */}
                <div className={`aspect-[3/4] bg-gradient-to-br ${book.color} relative overflow-hidden`}>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center p-6">
                      <div className="w-16 h-16 mx-auto mb-4 bg-white/50 rounded-full flex items-center justify-center">
                        <span className="font-serif text-2xl text-navy">H</span>
                      </div>
                      <h4 className="font-serif text-lg text-navy font-semibold">
                        {book.title}
                      </h4>
                    </div>
                  </div>
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-navy/0 group-hover:bg-navy/10 transition-colors duration-300" />
                  {/* Zoom effect on image */}
                  <div className="absolute inset-0 scale-100 group-hover:scale-105 transition-transform duration-500" />
                </div>

                {/* Book info */}
                <div className="p-5">
                  <h3 className="font-serif text-lg font-semibold text-navy mb-2 group-hover:text-gold transition-colors">
                    {book.title}
                  </h3>
                  <p className="text-navy/60 text-sm mb-4 line-clamp-2">
                    {book.description}
                  </p>
                  <Link
                    href="#"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-gold hover:text-gold/80 transition-colors"
                  >
                    See Details
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
