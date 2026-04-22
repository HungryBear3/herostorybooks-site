'use client';

import Image from 'next/image';
import Link from 'next/link';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const adventures = [
  {
    id: 1,
    title: "Emma's Enchanted Forest Quest",
    description: 'A magical journey through enchanted forests where Emma discovers her inner courage and makes friends with mystical creatures.',
    image: '/assets/featured-adventure-1.png',
    age: '4-10 years',
    highlights: ['Personalized adventure', 'Beautiful illustrations', 'Keepsake quality'],
  },
  {
    id: 2,
    title: "Liam's Ocean Adventure",
    description: 'Dive into an underwater kingdom where Liam becomes a brave explorer, solving mysteries and helping sea creatures in need.',
    image: '/assets/featured-adventure-2.png',
    age: '4-10 years',
    highlights: ['Unique story', 'Premium illustrations', 'Hardcover option'],
  },
  {
    id: 3,
    title: "Sophia's Sky Kingdom Adventure",
    description: 'Soar through magical clouds where Sophia discovers her wings and learns the true meaning of friendship and kindness.',
    image: '/assets/featured-adventure-3.png',
    age: '4-10 years',
    highlights: ['Custom illustrations', 'High-quality printing', 'Gift-ready'],
  },
];

export function FeaturedAdventuresV0() {
  return (
    <section id="adventures" className="w-full bg-gradient-to-b from-cream to-[#F5DDD0] py-24 px-4">
      <div className="container mx-auto">
        {/* Section Header */}
        <motion.div
          className="text-center mb-16"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
        >
          <h2 className="font-serif text-5xl md:text-6xl text-[#16324F] mb-6">
            Featured Adventures
          </h2>
          <p className="text-xl text-gray-700 max-w-2xl mx-auto">
            Explore some of the amazing personalized adventures we've created. Each story is uniquely crafted for its hero.
          </p>
        </motion.div>

        {/* Adventure Cards Grid */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.2 } } }}
        >
          {adventures.map((adventure) => (
            <motion.div
              key={adventure.id}
              variants={fadeUp}
              className="group bg-white rounded-2xl overflow-hidden shadow-lg hover:shadow-2xl transition-all duration-300 hover:scale-105"
            >
              {/* Image Container */}
              <div className="relative h-80 overflow-hidden bg-gradient-to-br from-[#16324F] to-[#2D5A3D]">
                <Image
                  src={adventure.image}
                  alt={adventure.title}
                  fill
                  className="object-cover group-hover:scale-110 transition-transform duration-500"
                />
                {/* Overlay Badge */}
                <div className="absolute top-4 right-4 bg-[#D6B25E] text-[#16324F] px-4 py-2 rounded-full text-sm font-semibold">
                  {adventure.age}
                </div>
              </div>

              {/* Content */}
              <div className="p-6">
                <h3 className="font-serif text-2xl text-[#16324F] mb-3">
                  {adventure.title}
                </h3>
                <p className="text-gray-600 text-base leading-relaxed mb-4">
                  {adventure.description}
                </p>

                {/* Highlights */}
                <div className="flex flex-wrap gap-2 mb-6">
                  {adventure.highlights.map((highlight, idx) => (
                    <span
                      key={idx}
                      className="inline-block bg-[#FDD6C5]/30 text-[#2D5A3D] text-xs font-medium px-3 py-1 rounded-full"
                    >
                      {highlight}
                    </span>
                  ))}
                </div>

                {/* CTA */}
                <Link
                  href="/order"
                  className="inline-block w-full text-center bg-gradient-to-r from-[#16324F] to-[#2D5A3D] text-cream font-semibold py-3 rounded-lg hover:from-[#2D5A3D] hover:to-[#16324F] transition-all duration-300"
                >
                  Create This Adventure
                </Link>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* CTA Section */}
        <motion.div
          className="text-center mt-16"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
        >
          <p className="text-lg text-gray-700 mb-6">
            Can't find the perfect adventure? We'll create a custom story just for your child!
          </p>
          <Link
            href="/order"
            className="inline-block px-10 py-4 bg-[#D6B25E] text-[#16324F] font-serif font-bold text-lg rounded-lg shadow-xl hover:bg-[#C9A960] transition-all duration-300 hover:shadow-2xl"
          >
            Start Creating Now
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
