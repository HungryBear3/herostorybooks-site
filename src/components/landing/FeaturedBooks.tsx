'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const books = [
  {
    id: 1,
    title: 'The Adventures of Emma',
    description: 'A thrilling journey through enchanted forests',
    image: '/sample1.png'
  },
  {
    id: 2,
    title: 'Liam\'s Magical Quest',
    description: 'An epic tale of courage and friendship',
    image: '/sample1.png'
  },
  {
    id: 3,
    title: 'Sofia\'s Dream Adventure',
    description: 'Where imagination becomes reality',
    image: '/sample1.png'
  }
];

export function FeaturedBooks() {
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
            Featured Storybooks
          </h2>
          <p className="text-gray-700 text-lg max-w-2xl mx-auto">
            Explore our collection of beautifully illustrated books
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {books.map((book) => (
            <motion.div
              key={book.id}
              variants={fadeUp}
              className="bg-white rounded-xl overflow-hidden shadow-lg hover:shadow-2xl transition-all duration-300 hover:scale-102 group cursor-pointer"
            >
              {/* Book Cover Image */}
              <div className="relative w-full h-72 overflow-hidden bg-lavender">
                <Image
                  src={book.image}
                  alt={book.title}
                  fill
                  className="object-cover group-hover:scale-110 transition-transform duration-300"
                />
              </div>

              {/* Book Info */}
              <div className="p-6">
                <h3 className="font-serif text-2xl text-forest mb-2">
                  {book.title}
                </h3>
                <p className="text-gray-600 text-sm mb-6 leading-relaxed">
                  {book.description}
                </p>

                <Link href="/checkout" className="block w-full">
                  <Button className="w-full bg-deep-gold text-white hover:bg-opacity-90 transition">
                    Personalize This Book
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
