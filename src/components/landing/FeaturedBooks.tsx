"use client";
import React from 'react';
import { motion, Variants } from 'framer-motion';
import Image from 'next/image';
import Link from 'next/link';

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } }
};

const samples = [
  { id: 1, img: '/sample1.png', title: 'Keepsake Classic', description: 'Your child as the heroic star of an enchanted tale.' },
  { id: 2, img: '/sample2.png', title: "Mom's Love Story", description: 'A heartwarming adventure celebrating mom and child.' },
  { id: 3, img: '/sample3.png', title: 'Sibling Journey', description: 'Team up siblings for a quest of friendship and courage.' },
  { id: 4, img: '/sample4.png', title: 'Magical School', description: 'Dive into a whimsical academy where magic comes alive.' },
];

export function FeaturedBooks() {
  return (
    <section id="samples" className="w-full bg-cream py-20 px-4">
      <div className="container mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-12"
        >
          <h2 className="font-serif text-4xl md:text-5xl text-forest mb-4">Featured Books</h2>
          <p className="text-gray-700 text-lg max-w-2xl mx-auto">
            Discover enchanting tales personalized for your child
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.15 } } }}
        >
          {samples.map((book) => (
            <motion.div
              key={book.id}
              variants={fadeUp}
              className="group bg-white rounded-lg overflow-hidden shadow-md hover:shadow-lg transition hover:-translate-y-1"
            >
              <div className="w-full h-64 relative">
                <Image src={book.img} alt={book.title} fill className="object-cover" />
              </div>
              <div className="p-4 flex flex-col">
                <h3 className="font-serif text-lg text-forest mb-2">{book.title}</h3>
                <p className="text-gray-600 text-sm flex-grow">{book.description}</p>
                <Link
                  href="/order"
                  className="mt-4 inline-block bg-deep-gold text-white px-4 py-2 rounded-lg text-center font-semibold hover:bg-deep-gold/90 transition"
                >
                  Personalize
                </Link>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
