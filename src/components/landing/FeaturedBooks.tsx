'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0, 0, 0.2, 1] as const } },
};

const books = [
  {
    id: 1,
    title: 'Keepsake Classic',
    description: 'The timeless storybook where your child is the brave hero of an enchanted adventure.',
    price: '$49.99',
    emoji: '📖',
    color: '#1F3A5F',
  },
  {
    id: 2,
    title: "Mother's Day Special",
    description: 'A heartwarming story celebrating the bond between a child and their amazing mom.',
    price: '$49.99',
    emoji: '🌸',
    color: '#b5477a',
    badge: "Mother's Day",
  },
  {
    id: 3,
    title: 'Grandparent Legacy',
    description: 'An inter-generational tale connecting grandchildren with their grandparents through adventure.',
    price: '$49.99',
    emoji: '🧓',
    color: '#5B7A4F',
  },
  {
    id: 4,
    title: 'Sibling Adventure',
    description: 'Two brothers or sisters embark on an epic quest, learning teamwork and friendship.',
    price: '$59.99',
    emoji: '🤝',
    color: '#2a4f7a',
  },
  {
    id: 5,
    title: "Baby's First Year",
    description: 'A milestone storybook celebrating every precious moment of baby\'s first year of life.',
    price: '$49.99',
    emoji: '👶',
    color: '#7a6e2a',
  },
  {
    id: 6,
    title: 'Custom Theme',
    description: 'You choose the theme — space, ocean, dragons, or anything your child loves!',
    price: '$49.99',
    emoji: '🌟',
    color: '#4a2a7a',
  },
];

export function FeaturedBooks() {
  return (
    <section id="samples" className="w-full bg-white py-20 px-4">
      <div className="container mx-auto">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="text-center mb-16"
        >
          <h2 className="font-serif text-4xl md:text-5xl mb-4" style={{ color: '#1F3A5F' }}>
            Our Storybook Collection
          </h2>
          <p className="text-gray-600 text-lg max-w-2xl mx-auto">
            Six magical themes, every one personalized with your child as the star
          </p>
        </motion.div>

        {/* Grid */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {books.map((book) => (
            <motion.div
              key={book.id}
              variants={fadeUp}
              className="group bg-white rounded-2xl overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border border-gray-100 flex flex-col"
            >
              {/* Book Cover */}
              <div
                className="relative w-full h-52 flex items-center justify-center"
                style={{ backgroundColor: book.color + '15' }}
              >
                {book.badge && (
                  <div
                    className="absolute top-4 left-4 text-white text-xs font-bold px-3 py-1 rounded-full"
                    style={{ backgroundColor: '#D4AF37' }}
                  >
                    {book.badge}
                  </div>
                )}
                <span className="text-8xl group-hover:scale-110 transition-transform duration-300">
                  {book.emoji}
                </span>
              </div>

              {/* Info */}
              <div className="p-6 flex flex-col flex-grow">
                <h3 className="font-serif text-xl mb-2" style={{ color: '#1F3A5F' }}>
                  {book.title}
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed mb-4 flex-grow">
                  {book.description}
                </p>
                <div className="flex items-center justify-between mt-auto pt-4 border-t border-gray-100">
                  <span className="font-bold text-lg" style={{ color: '#1F3A5F' }}>
                    {book.price}
                  </span>
                  <Link
                    href="/order"
                    className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                    style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
                  >
                    Order Now
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
