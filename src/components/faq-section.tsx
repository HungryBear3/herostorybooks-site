"use client";

import { motion } from "framer-motion";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const faqs = [
  {
    question: "How long does it take to create and receive my book?",
    answer: "Once you complete your order, our team prepares a personalized proof for review. Printed books are submitted to production only after approval. You'll receive tracking information as soon as your book ships.",
  },
  {
    question: "Can I personalize multiple copies of the same book?",
    answer: "Absolutely! You can order multiple copies with the same or different personalizations. This is perfect for siblings, grandparents' copies, or gifts. Each book can have its own unique details while telling the same adventure story.",
  },
  {
    question: "What format do I need for photos?",
    answer: "We accept JPEG, PNG, and HEIC formats. For best results, use a clear, well-lit photo with your child's face visible. Our team will optimize your photo to look beautiful in the book. Portrait-oriented photos work best.",
  },
  {
    question: "Is this suitable for different age groups?",
    answer: "Our stories are designed for children ages 0-10. We have age-appropriate themes and reading levels. Younger children (0-4) love the pictures and being read to, while older children (5-10) can read along and engage with the adventure.",
  },
  {
    question: "What if I'm not satisfied with my book?",
    answer: "Your happiness is our priority. If you're not completely satisfied with your book's quality or if there's a printing error, contact us within 30 days and we'll make it right with a replacement or full refund.",
  },
  {
    question: "Do you offer gift options?",
    answer: "Yes. You can add a personalized gift message at checkout, and our Classic and Premium print formats are built for gifting.",
  },
];

export function FAQSection() {
  return (
    <section id="faq" className="py-24 bg-cream">
      <div className="container mx-auto px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-navy mb-4">
            Frequently Asked Questions
          </h2>
          <p className="text-navy/70 text-lg max-w-2xl mx-auto">
            Everything you need to know about creating your personalized storybook.
          </p>
        </motion.div>

        {/* FAQ Accordion */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="max-w-3xl mx-auto"
        >
          <Accordion type="single" collapsible className="space-y-4">
            {faqs.map((faq, index) => (
              <AccordionItem
                key={index}
                value={`item-${index}`}
                className="bg-white rounded-xl border border-border px-6 shadow-sm data-[state=open]:shadow-md transition-shadow"
              >
                <AccordionTrigger className="text-left font-serif text-lg font-semibold text-navy hover:text-gold hover:no-underline py-5">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-navy/70 leading-relaxed pb-5">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </div>
    </section>
  );
}
