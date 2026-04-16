'use client';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';

function getTimeLeft() {
  const target = new Date('2026-04-30T23:59:59');
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

export function MothersDayBanner() {
  const [timeLeft, setTimeLeft] = useState(getTimeLeft());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const wasDismissed = sessionStorage.getItem('hsb-banner-dismissed');
      if (wasDismissed === 'true') setDismissed(true);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTimeLeft(getTimeLeft()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('hsb-banner-dismissed', 'true');
    }
  };

  const pad = (n: number) => String(n).padStart(2, '0');

  if (dismissed) return null;

  return (
    <div
      className="w-full py-3 px-4 text-center relative"
      style={{ background: 'linear-gradient(90deg, #1F3A5F 0%, #2a4f7a 100%)' }}
    >
      <div className="container mx-auto flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-6 text-sm sm:text-base">
        <span className="font-semibold" style={{ color: '#D4AF37' }}>
          Mother&apos;s Day Special: 20% off with code{' '}
          <strong className="bg-white/10 px-2 py-0.5 rounded font-mono">MOM20</strong>
        </span>

        <div
          className="flex items-center gap-1 font-mono rounded-lg px-3 py-1"
          style={{ backgroundColor: 'rgba(212,175,55,0.15)' }}
        >
          <span className="font-bold text-white">{pad(timeLeft.days)}d</span>
          <span className="opacity-50 mx-0.5 text-white">:</span>
          <span className="font-bold text-white">{pad(timeLeft.hours)}h</span>
          <span className="opacity-50 mx-0.5 text-white">:</span>
          <span className="font-bold text-white">{pad(timeLeft.minutes)}m</span>
          <span className="opacity-50 mx-0.5 text-white">:</span>
          <span className="font-bold text-white">{pad(timeLeft.seconds)}s</span>
        </div>

        <Link
          href="/#pricing"
          className="font-semibold px-4 py-1 rounded-lg text-sm transition-colors"
          style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
        >
          Shop Now
        </Link>
      </div>

      {/* Dismiss button */}
      <button
        onClick={handleDismiss}
        aria-label="Dismiss banner"
        className="absolute right-4 top-1/2 -translate-y-1/2 text-white/60 hover:text-white transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
