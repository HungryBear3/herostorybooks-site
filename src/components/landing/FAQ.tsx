'use client';
import React, { useState } from 'react';
import { motion } from 'framer-motion';

const faqs = [
  {
    question: 'How does the AI personalization work?',
    answer:
      'Our AI analyzes the photo you upload and generates custom illustrations that look like your child. It then weaves their name, interests, and details throughout the story to create a truly unique book.',
  },
  {
    question: 'What photos work best?',
    answer:
      'Clear, well-lit photos work best — ideally a front-facing portrait where the face is clearly visible. Avoid sunglasses, hats, or heavy shadows. A recent photo on a plain background gives the best results.',
  },
  {
    question: 'How long does delivery take?',
    answer:
      'We email a digital proof first, usually within 2 business days. Once you approve the proof, digital orders receive the final high-resolution PDF and printed softcover/hardcover books ship within 5-7 business days via standard US shipping.',
  },
  {
    question: 'Can I customize the story theme?',
    answer:
      'Yes! You can choose from themes like courage, kindness, adventure, friendship, creativity, and more. You can also specify favorite animals, colors, and other details that get incorporated into the story.',
  },
  {
    question: "What's your refund policy?",
    answer:
      "Digital orders are fully refundable up until you approve the proof. Printed books are refundable up until you approve the proof for print. After proof approval, we can only replace books with printing defects or fulfillment errors.",
  },
  {
    question: 'Is this a good gift?',
    answer:
      "Yes — personalized storybooks are a popular birthday and holiday gift. Approve the proof at least 9–12 business days before the date you need it to give the printed book the best chance of arriving in time. Carriers vary, so we don't promise specific delivery dates; for tight timing the Digital PDF is a reliable fallback you can print at home or share instantly.",
  },
];

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-gray-200 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 text-left transition-colors hover:text-[#1F3A5F] gap-4"
        aria-expanded={open}
      >
        <span className="font-semibold text-gray-800 text-base">{question}</span>
        <span
          className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-transform duration-300"
          style={{ backgroundColor: open ? '#1F3A5F' : '#f3f4f6', transform: open ? 'rotate(45deg)' : 'none' }}
        >
          <svg
            className="w-3.5 h-3.5"
            style={{ color: open ? 'white' : '#6b7280' }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
        </span>
      </button>

      {open && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25 }}
          className="pb-5 text-gray-600 text-sm leading-relaxed"
        >
          {answer}
        </motion.div>
      )}
    </div>
  );
}

export function FAQ() {
  return (
    <section className="w-full py-20 px-4" style={{ backgroundColor: '#F5F1E8' }}>
      <div className="container mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-14"
        >
          <h2 className="font-serif text-4xl md:text-5xl mb-4" style={{ color: '#1F3A5F' }}>
            Questions? We&apos;ve Got Answers
          </h2>
          <p className="text-gray-600 text-lg">
            Everything you need to know about your personalized storybook
          </p>
        </motion.div>

        <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm p-8">
          {faqs.map((faq, idx) => (
            <FAQItem key={idx} question={faq.question} answer={faq.answer} />
          ))}
        </div>

        {/* CTA below FAQ */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="text-center mt-12"
        >
          <p className="text-gray-600 mb-4">Still have questions?</p>
          <a
            href="mailto:support@herostorybooks.com"
            className="text-sm font-semibold underline"
            style={{ color: '#1F3A5F' }}
          >
            Contact us at support@herostorybooks.com
          </a>
        </motion.div>
      </div>
    </section>
  );
}
