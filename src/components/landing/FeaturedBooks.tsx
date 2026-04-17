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
  { id: 1, img: '/assets/37e76712-92e0-49fb-a509-a82a4230a8b7.png', title: 'Keepsake Classic', description: 'Your child as the heroic star of an enchanted tale.' },
  { id: 2, img: '/assets/84392084-718e-4e0a-96b6-d4aa7286cb36.png', title: "Mom's Love Story", description: 'A heartwarming adventure celebrating mom and child.' },
  { id: 3, img: '/assets/3d42ac55-0870-409d-b3eb-236200e093dc.png', title: 'Sibling Journey', description: 'Team up siblings for a quest of friendship and courage.' },
  { id: 4, img: '/assets/b22b6d5d-f9cb-42a5-af1a-de96c983f5e5.png', title: 'Magical School', description: 'Dive into a whimsical academy where magic comes alive.' },
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
              className="group bg-white rounded-lg overflow-hidden shadow-lg hover:shadow-2xl transition hover:-translate-y-2"
            >
              <div className="w-full h-80 relative overflow-hidden rounded-t-lg bg-gradient-to-br from-deep-gold/10 to-forest/10">
                <Image src={book.img} alt={book.title} fill className="object-cover group-hover:scale-105 transition duration-500" />
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
