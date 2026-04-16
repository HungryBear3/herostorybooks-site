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
    icon: '⭐',
    label: 'Average Rating',
    value: 4.9,
    suffix: '/5',
    color: 'text-teal',
  },
  {
    icon: '👨‍👩‍👧‍👦',
    label: 'Happy Customers',
    value: 150,
    suffix: 'K+',
    color: 'text-coral',
  },
  {
    icon: '📦',
    label: 'Delivery Time',
    value: 5,
    suffix: '–7 Days',
    color: 'text-teal',
  },
  {
    icon: '✅',
    label: 'Satisfaction',
    value: 100,
    suffix: '%',
    color: 'text-coral',
  },
];

function CountUp({ target, suffix, colorClass }: { target: number; suffix: string; colorClass: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });

  useEffect(() => {
    if (!isInView) return;
    const duration = 2000;
    const increment = target / (duration / 16);
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= target) {
        setCount(target);
        clearInterval(timer);
      } else {
        setCount(Math.floor(current * 10) / 10);
      }
    }, 16);
    return () => clearInterval(timer);
  }, [isInView, target]);

  return (
    <div ref={ref} className={`text-3xl md:text-4xl font-bold mb-2 ${colorClass}`}>
      {count.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 })}{suffix}
    </div>
  );
}

export function TrustBadges() {
  return (
    <section className="w-full bg-gradient-to-r from-teal/5 to-coral/5 py-16 px-4">
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
              className="text-center bg-white rounded-2xl p-6 shadow-sm"
            >
              <div className="text-4xl md:text-5xl mb-3">{badge.icon}</div>
              <CountUp target={badge.value} suffix={badge.suffix} colorClass={badge.color} />
              <p className="text-gray-600 font-medium text-sm">{badge.label}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
