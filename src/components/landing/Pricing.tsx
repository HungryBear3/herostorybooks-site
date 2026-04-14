import React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const plans = [
  {
    title: 'Digital',
    price: '$29',
    features: ['PDF delivered in ~15 min', 'Read on any device', 'Print at home'],
    highlight: false,
  },
  {
    title: 'Printed',
    price: '$49',
    features: ['Hardcover book shipped', '7-10 business days', 'Lulu premium printing'],
    highlight: false,
  },
  {
    title: 'Bundle',
    price: '$59',
    features: ['Everything in both tiers', 'Best value', 'One order, two formats'],
    highlight: true,
  },
];

export function Pricing() {
  return (
    <section className="w-full bg-[#F0EDF8] py-20">
      <div className="container mx-auto px-4">
        <h2 className="text-[var(--forest)] text-3xl font-bold text-center mb-10">
          Choose Your Adventure
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((plan, idx) => (
            <div
              key={idx}
              className={
                `relative bg-white rounded-2xl shadow-md p-6 flex flex-col items-center space-y-4 ${
                plan.highlight ? 'border-2 border-[var(--forest)]' : ''
                }`
              }
            >
              {plan.highlight && (
                <span className="absolute top-4 right-4 bg-[var(--gold)] text-[var(--forest)] px-2 py-1 rounded-full text-xs">
                  Most Popular
                </span>
              )}
              <h3 className="text-xl font-semibold">{plan.title}</h3>
              <p className="text-3xl font-bold">{plan.price}</p>
              <ul className="space-y-2 text-center">
                {plan.features.map((feat, i) => (
                  <li key={i}>{feat}</li>
                ))}
              </ul>
              <Link href="/order" passHref>
                <Button className="bg-[var(--gold)] text-[var(--forest)] mt-4">
                  Order Now
                </Button>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
