'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Image from 'next/image';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const testimonials = [
  {
    name: 'Emily Richardson',
    location: 'New York, USA',
    avatar: 'https://i.pravatar.cc/100?img=32',
    quote: 'My daughter was absolutely thrilled to see herself as the brave knight in the story. She\'s read it a hundred times!',
    rating: 5
  },
  {
    name: 'Carlos Miguel',
    location: 'Madrid, Spain',
    avatar: 'https://i.pravatar.cc/100?img=54',
    quote: 'The illustrations are stunning and the personalization is incredible. Delivery was faster than expected!',
    rating: 5
  },
  {
    name: 'Aisha Khan',
    location: 'Dubai, UAE',
    avatar: 'https://i.pravatar.cc/100?img=68',
    quote: 'A truly magical experience. My son felt like the hero of his very own adventure. Worth every penny!',
    rating: 5
  }
];

export function Testimonials() {
  return (
    <section className="w-full bg-lavender py-20 px-4">
      <div className="container mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="mb-16 text-center"
          variants={fadeUp}
        >
          <h2 className="font-serif text-4xl md:text-5xl text-forest mb-4">
            What Our Families Say
          </h2>
          <p className="text-gray-700 text-lg max-w-2xl mx-auto">
            Join thousands of happy families creating magical memories
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {testimonials.map((testimonial, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="bg-white rounded-xl p-8 shadow-md hover:shadow-lg transition-shadow duration-300 border border-gray-100 flex flex-col"
            >
              {/* Star Rating */}
              <div className="flex gap-1 mb-4">
                {Array.from({ length: testimonial.rating }).map((_, i) => (
                  <span key={i} className="text-deep-gold text-lg">★</span>
                ))}
              </div>

              {/* Quote */}
              <p className="text-gray-700 italic mb-6 flex-grow leading-relaxed">
                "{testimonial.quote}"
              </p>

              {/* Author */}
              <div className="flex items-center gap-4 pt-6 border-t border-gray-100">
                <Image
                  src={testimonial.avatar}
                  alt={testimonial.name}
                  width={48}
                  height={48}
                  className="rounded-full"
                />
                <div>
                  <p className="font-serif text-forest font-semibold">
                    {testimonial.name}
                  </p>
                  <p className="text-sm text-gray-600">
                    {testimonial.location}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
