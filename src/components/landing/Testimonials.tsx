'use client';
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const testimonials = [
  {
    name: 'Sarah M.',
    initials: 'SM',
    avatarColor: '#2a4f7a',
    rating: 5,
    text: 'My daughter burst into tears of joy when she saw herself as the princess in the story! We read it every single night. This is the most thoughtful gift I\'ve ever given.',
  },
  {
    name: 'Jennifer K.',
    initials: 'JK',
    avatarColor: '#5B7A4F',
    rating: 5,
    text: 'I ordered this for Mother\'s Day and the quality blew me away. The illustrations look exactly like my son. The hardcover is beautiful and the story made me cry happy tears.',
  },
  {
    name: 'Michelle R.',
    initials: 'MR',
    avatarColor: '#b5477a',
    rating: 5,
    text: 'Absolutely magical! My twins each got their own book where they were the heroes together. They carry those books everywhere. Worth every single penny.',
  },
  {
    name: 'Amanda T.',
    initials: 'AT',
    avatarColor: '#7a6e2a',
    rating: 5,
    text: 'The ordering process was so easy and the book arrived faster than expected. My son now believes he\'s a real superhero and I\'m not going to correct him. Best gift ever!',
  },
];

export function Testimonials() {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrent((prev) => (prev + 1) % testimonials.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const prev = () => setCurrent((c) => (c - 1 + testimonials.length) % testimonials.length);
  const next = () => setCurrent((c) => (c + 1) % testimonials.length);

  const t = testimonials[current];

  return (
    <section className="w-full py-20 px-4" style={{ backgroundColor: '#F5F1E8' }}>
      <div className="container mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-14"
        >
          <h2 className="font-serif text-4xl md:text-5xl mb-4" style={{ color: '#1F3A5F' }}>
            What Families Are Saying
          </h2>
          <div className="flex items-center justify-center gap-1 text-sm text-gray-500">
            <span style={{ color: '#D4AF37' }}>★★★★★</span>
            <span className="ml-1 font-semibold" style={{ color: '#1F3A5F' }}>4.9/5</span>
            <span>from 12,000+ reviews</span>
          </div>
        </motion.div>

        {/* Carousel */}
        <div className="relative max-w-2xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={current}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.3 }}
              className="bg-white rounded-2xl p-8 shadow-md border border-gray-100 text-center"
            >
              {/* Stars */}
              <div className="flex justify-center gap-1 mb-6">
                {Array.from({ length: t.rating }).map((_, i) => (
                  <span key={i} style={{ color: '#D4AF37' }} className="text-xl">★</span>
                ))}
              </div>

              {/* Quote */}
              <p className="text-gray-700 text-lg leading-relaxed italic mb-8">
                &ldquo;{t.text}&rdquo;
              </p>

              {/* Author */}
              <div className="flex items-center justify-center gap-4">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-sm"
                  style={{ backgroundColor: t.avatarColor }}
                >
                  {t.initials}
                </div>
                <span className="font-serif font-semibold" style={{ color: '#1F3A5F' }}>
                  {t.name}
                </span>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Navigation Controls */}
          <div className="flex items-center justify-center gap-4 mt-8">
            <button
              onClick={prev}
              className="w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all hover:scale-110"
              style={{ borderColor: '#1F3A5F', color: '#1F3A5F' }}
              aria-label="Previous testimonial"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {/* Dots */}
            <div className="flex gap-2">
              {testimonials.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrent(i)}
                  className="w-2.5 h-2.5 rounded-full transition-all"
                  style={{ backgroundColor: i === current ? '#1F3A5F' : '#c8c4bc' }}
                  aria-label={`Go to testimonial ${i + 1}`}
                />
              ))}
            </div>

            <button
              onClick={next}
              className="w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all hover:scale-110"
              style={{ borderColor: '#1F3A5F', color: '#1F3A5F' }}
              aria-label="Next testimonial"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
