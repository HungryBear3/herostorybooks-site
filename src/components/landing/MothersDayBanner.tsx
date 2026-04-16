'use client';
import React, { useState, useEffect } from 'react';

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

  useEffect(() => {
    const timer = setInterval(() => setTimeLeft(getTimeLeft()), 1000);
    return () => clearInterval(timer);
  }, []);

  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <div className="w-full bg-gradient-to-r from-teal to-coral py-3 px-4 text-white text-center">
      <div className="container mx-auto flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-6 text-sm sm:text-base font-medium">
        <span className="text-lg">🌸 Mother&apos;s Day Special — Save 20% until April 30</span>
        <div className="flex items-center gap-1 font-mono bg-white/20 rounded-lg px-3 py-1">
          <span className="text-white font-bold">{pad(timeLeft.days)}d</span>
          <span className="opacity-70 mx-0.5">:</span>
          <span className="text-white font-bold">{pad(timeLeft.hours)}h</span>
          <span className="opacity-70 mx-0.5">:</span>
          <span className="text-white font-bold">{pad(timeLeft.minutes)}m</span>
          <span className="opacity-70 mx-0.5">:</span>
          <span className="text-white font-bold">{pad(timeLeft.seconds)}s</span>
        </div>
        <span className="text-white/90 text-sm">Use code <strong>MOM20</strong> at checkout</span>
      </div>
    </div>
  );
}
