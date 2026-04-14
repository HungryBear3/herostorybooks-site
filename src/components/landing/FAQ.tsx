import React from 'react';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';

const faqs = [
  {
    question: 'How long does it take?',
    answer:
      'Digital books are delivered by email in ~15 minutes. Printed hardcovers ship via Lulu and arrive in 7-10 business days.',
  },
  {
    question: 'What ages is this for?',
    answer:
      'HeroStoryBooks are designed for children ages 2-10. The stories adapt to be age-appropriate.',
  },
  {
    question: 'Can I customize the story?',
    answer:
      'Yes! You choose the theme (courage, kindness, adventure, friendship, creativity), the art style, and can add special requests.',
  },
  {
    question: 'What if I am not happy?',
    answer: 'We offer a full refund within 7 days, no questions asked.',
  },
  {
    question: 'How do the illustrations work?',
    answer:
      'We use AI to generate custom illustrations that resemble your child based on the photo you upload.',
  },
];

export function FAQ() {
  return (
    <section className="w-full bg-[var(--cream)] py-20">
      <div className="container mx-auto px-4">
        <h2 className="text-[var(--forest)] text-3xl font-bold text-center mb-6">
          Questions?
        </h2>
        {/* Removed unsupported props from Accordion primitive */}
        <Accordion className="max-w-2xl mx-auto">
          {faqs.map((item, idx) => (
            <AccordionItem key={idx} value={`item-${idx}`}> 
              <AccordionTrigger>{item.question}</AccordionTrigger>
              <AccordionContent>
                <p>{item.answer}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
