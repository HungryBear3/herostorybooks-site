"use client";
import React from 'react';

const metrics = [
  { value: '50,000+', label: 'Books Created' },
  { value: '4.8/5', label: 'Avg Rating' },
  { value: '5–7 days', label: 'Fast Delivery' },
  { value: '100%', label: 'Satisfaction' },
];

export function TrustBadges() {
  return (
    <section className="w-full bg-cream py-16 px-4">
      <div className="container mx-auto flex flex-wrap justify-center gap-8">
        {metrics.map((m, i) => (
          <div key={i} className="flex flex-col items-center">
            <div className="text-4xl font-bold text-deep-gold mb-2">{m.value}</div>
            <div className="text-sm text-gray-700">{m.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
