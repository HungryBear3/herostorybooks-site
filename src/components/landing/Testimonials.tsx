"use client";
import React from 'react';
import { motion } from 'framer-motion';
import Image from 'next/image';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5,  } }
};

const testimonials = [
  { name: 'Sarah M.', location: 'TX, USA', text: 'My daughter cried tears of joy when she saw herself as the princess! We read it nightly.', avatar: '/assets/hero-1.jpg' },
  { name: 'Jennifer K.', location: 'CA, USA', text: 'The quality blew me away. Illustrations look exactly like my son. Stunning keepsake!', avatar: '/assets/hero-2.jpg' },
  { name: 'Michelle R.', location: 'NY, USA', text: 'Absolutely magical! My twins each got their own heroic tale together. Worth every penny.', avatar: '/assets/hero-3.jpg' },
];

export function Testimonials() {
  return (
    <section className="w-full bg-cream py-20 px-4">
      <div className="container mx-auto text-center">
        <motion.h2
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="font-serif text-4xl md:text-5xl text-forest mb-4"
        >
          What Families Are Saying
        </motion.h2>
        <p className="text-gray-700 mb-8 text-lg">
          <span className="text-deep-gold text-xl">★★★★★</span> <span className="font-semibold">50,000+ families</span> love their storybooks
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {testimonials.map((t, idx) => (
            <motion.div
              key={idx}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeUp}
              className="bg-white p-6 rounded-lg shadow-lg hover:shadow-xl transition border-t-4 border-deep-gold/30"
            >
              <div className="w-20 h-20 mx-auto mb-4 relative ring-4 ring-deep-gold/30">
                <Image src={t.avatar} alt={t.name} fill className="rounded-full object-cover" />
              </div>
              <p className="text-gray-700 italic mb-4 leading-relaxed">"{t.text}"</p>
              <div className="font-semibold text-forest text-lg">{t.name}</div>
              <div className="text-sm text-gray-500 font-medium">{t.location}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
