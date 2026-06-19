"use client";
import React, { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

export function Footer() {
  const [email, setEmail] = useState('');
  const [sub, setSub] = useState(false);
  const handleSub = (e: React.FormEvent) => { e.preventDefault(); if (email) { setSub(true); setEmail(''); setTimeout(() => setSub(false), 3000); } };
  return (
    <footer className="w-full bg-forest text-white py-16 px-4">
      <div className="container mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Brand & Social */}
        <div>
          <Image
            src="/assets/logo-horizontal-text.png"
            alt="HeroStoryBooks - Stories That Build Courage & Kindness"
            width={220}
            height={80}
            className="h-14 w-auto mb-4"
          />
          <p className="text-sm mb-2 font-medium tracking-[0.2em] uppercase text-white/70">Stories That Build Courage & Kindness</p>
          <p className="text-sm mb-4">Magical storybooks where every child is the hero.</p>
          <div className="flex gap-4">
            <a href="mailto:support@herostorybooks.com" className="hover:text-gray-300">Email us</a>
          </div>
        </div>
        {/* Links */}
        <div className="flex justify-between">
          <ul className="space-y-2 text-sm">
            <li><Link href="/#how">How It Works</Link></li>
            <li><Link href="/samples">Sample Books</Link></li>
            <li><Link href="/pricing">Pricing</Link></li>
            <li><Link href="/checkout">Start Your Book</Link></li>
          </ul>
          <ul className="space-y-2 text-sm">
            <li><Link href="/#faq">FAQ</Link></li>
            <li><Link href="/terms">Shipping & Returns</Link></li>
            <li><Link href="/privacy">Privacy Policy</Link></li>
            <li><Link href="/terms">Terms of Service</Link></li>
          </ul>
        </div>
        {/* Newsletter */}
        <div>
          <h4 className="font-semibold mb-4">Stay Updated</h4>
          <form onSubmit={handleSub} className="flex flex-col space-y-2">
            <input
              type="email"
              className="p-2 rounded text-gray-900"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button type="submit" className="bg-deep-gold text-forest py-2 rounded font-semibold">
              {sub ? 'Subscribed!' : 'Subscribe'}
            </button>
          </form>
        </div>
      </div>
      <div className="text-center text-sm text-gray-400 mt-12">
        &copy; 2026 HeroStoryBooks. All rights reserved.
      </div>
    </footer>
  );
}
