import React from 'react';
import Link from 'next/link';

export function Footer() {
  return (
    <footer className="w-full bg-[var(--forest)] text-[var(--cream)] py-10">
      <div className="container mx-auto px-4 grid grid-cols-1 md:grid-cols-3 gap-8">
        <div>
          <h3 className="text-xl font-bold">HeroStoryBooks</h3>
          <p className="mt-2">Where every child becomes the hero.</p>
        </div>
        <div>
          <h4 className="text-lg font-semibold mb-2">Links</h4>
          <ul className="space-y-1">
            <li>
              <Link href="/" className="hover:underline">
                Home
              </Link>
            </li>
            <li>
              <Link href="/order" className="hover:underline">
                Order
              </Link>
            </li>
            <li>
              <Link href="/#faq" className="hover:underline">
                FAQ
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <h4 className="text-lg font-semibold mb-2">Contact</h4>
          <p>support@herostorybooks.com</p>
        </div>
      </div>
      <div className="mt-8 text-center text-sm">
        © 2026 HeroStoryBooks. All rights reserved.
      </div>
    </footer>
  );
}
