'use client';
import React, { useState, useEffect } from 'react';
import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const badges = [
  {
    icon: '📚',
    label: 'Books Created',
    value: 50000,
    suffix: '+'
  },
  {
    icon: '⭐',
    label: 'Average Rating',
    value: 4.8,
    suffix: '/5'
  },
  {
    icon: '📦',
    label: 'Ships Within',
    value: 7,
    suffix: ' Days'
  },
  {
    icon: '✅',
    label: 'Satisfaction',
    value: 100,
    suffix: '%'
  }
];

function CountUp({ target, suffix }) {
  const [count, setCount] = useState(0);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });

  useEffect(() => {
    if (!isInView) return;

    let start = 0;
    const end = target;
    const duration = 2000; // 2 seconds
    const increment = end / (duration / 16); // 60fps

    let current = start;
    const timer = setInterval(() => {
      current += increment;
      if (current >= end) {
        setCount(end);
        clearInterval(timer);
      } else {
        setCount(Math.floor(current * 10) / 10); // One decimal place
      }
    }, 16);

    return () => clearInterval(timer);
  }, [isInView, target]);

  return (
    <div ref={ref}>
      {count.toLocaleString('en-US', {
        maximumFractionDigits: 1,
        minimumFractionDigits: 0
      })}{suffix}
    </div>
  );
}

export function TrustBadges() {
  return (
    <section className="w-full bg-gray-50 py-16 px-4">
      <div className="container mx-auto">
        <motion.div
          className="grid grid-cols-2 md:grid-cols-4 gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {badges.map((badge, idx) => (
            <motion.div
              key={idx}
              variants={fadeUp}
              className="text-center"
            >
              <div className="text-4xl md:text-5xl mb-3">
                {badge.icon}
              </div>
              <div className="text-3xl md:text-4xl font-bold text-deep-gold mb-2">
                <CountUp target={badge.value} suffix={badge.suffix} />
              </div>
              <p className="text-gray-700 font-medium text-sm">
                {badge.label}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
