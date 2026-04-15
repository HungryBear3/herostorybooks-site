'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

export function Footer() {
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);

  const handleSubscribe = (e) => {
    e.preventDefault();
    if (email) {
      setSubscribed(true);
      setEmail('');
      setTimeout(() => setSubscribed(false), 3000);
    }
  };

  return (
    <footer className="w-full bg-forest text-white py-16 px-4">
      <div className="container mx-auto">
        <motion.div
          className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {/* Company Info */}
          <motion.div variants={fadeUp}>
            <h3 className="font-serif text-2xl mb-4">HeroStoryBooks</h3>
            <p className="text-gray-300 text-sm leading-relaxed">
              Creating magical, personalized storybooks that celebrate every child as the hero of their own adventure.
            </p>
          </motion.div>

          {/* Quick Links */}
          <motion.div variants={fadeUp}>
            <h4 className="text-lg font-semibold mb-4">Quick Links</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/" className="text-gray-300 hover:text-deep-gold transition">
                  Home
                </Link>
              </li>
              <li>
                <Link href="#how-it-works" className="text-gray-300 hover:text-deep-gold transition">
                  How It Works
                </Link>
              </li>
              <li>
                <Link href="/checkout" className="text-gray-300 hover:text-deep-gold transition">
                  Create Your Book
                </Link>
              </li>
              <li>
                <Link href="#faq" className="text-gray-300 hover:text-deep-gold transition">
                  FAQ
                </Link>
              </li>
            </ul>
          </motion.div>

          {/* Legal */}
          <motion.div variants={fadeUp}>
            <h4 className="text-lg font-semibold mb-4">Legal</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/privacy" className="text-gray-300 hover:text-deep-gold transition">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="text-gray-300 hover:text-deep-gold transition">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link href="/contact" className="text-gray-300 hover:text-deep-gold transition">
                  Contact
                </Link>
              </li>
            </ul>
          </motion.div>

          {/* Newsletter */}
          <motion.div variants={fadeUp}>
            <h4 className="text-lg font-semibold mb-4">Newsletter</h4>
            <p className="text-gray-300 text-sm mb-4">
              Get updates on new books and special offers
            </p>
            <form onSubmit={handleSubscribe} className="space-y-2">
              <input
                type="email"
                placeholder="Your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-deep-gold"
              />
              <button
                type="submit"
                className="w-full px-4 py-2 bg-deep-gold text-white rounded-lg hover:bg-opacity-90 transition font-semibold text-sm"
              >
                {subscribed ? 'Thanks!' : 'Subscribe'}
              </button>
            </form>
          </motion.div>
        </motion.div>

        {/* Copyright */}
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="border-t border-gray-700 pt-8 text-center text-sm text-gray-400"
        >
          <p>© 2026 HeroStoryBooks. All rights reserved.</p>
        </motion.div>
      </div>
    </footer>
  );
}
