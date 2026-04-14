import React from 'react';
import { motion } from 'framer-motion';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

export function Hero() {
  return (
    <section className="w-full bg-[var(--cream)] py-20">
      <div className="container mx-auto flex flex-col lg:flex-row items-center px-4">
        <div className="flex-1 space-y-6">
          <motion.h1
            className="font-serif text-[var(--forest)] text-5xl lg:text-7xl"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeUp}
          >
            Your Child Is the Hero
          </motion.h1>
          <motion.p
            className="text-[var(--peach)] text-lg"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeUp}
          >
            Personalized storybooks with AI illustrations that look like your kid
          </motion.p>
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeUp}
          >
            <Link href="/order" passHref>
              <Button className="bg-[var(--gold)] text-[var(--forest)] transform transition hover:scale-105">
                Get Started
              </Button>
            </Link>
          </motion.div>
        </div>
        <div className="flex-1 mt-8 lg:mt-0">
          <Image
            src="/sample1.png"
            alt="Sample illustration"
            width={500}
            height={500}
            className="rounded-2xl shadow-xl"
          />
        </div>
      </div>
    </section>
  );
}
