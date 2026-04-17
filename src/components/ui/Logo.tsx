"use client";
import Link from 'next/link';
import Image from 'next/image';

export default function Logo() {
  return (
    <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition">
      <Image
        src="/assets/logo-horizontal.png"
        alt="HeroStoryBooks"
        width={180}
        height={50}
        className="h-12 w-auto"
        priority
      />
    </Link>
  );
}
