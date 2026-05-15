"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { motion } from "framer-motion";

/**
 * Frontend-only "name preview" - a low-risk conversion touch that lets a
 * visitor type their child's first name and see it on three sample surfaces
 * (mock cover title, dedication line, sample-spread snippet).
 *
 * Hard rules carried from the prompt:
 *   - Zero backend calls; no AI, Stripe, Lulu, blob, or external fetch.
 *   - No persistence (no localStorage, no cookies).
 *   - No checkout or pricing changes.
 *   - Hydration-safe: initial server render uses DEFAULT_NAME so the first
 *     client render matches before any user input.
 *   - Microcopy makes clear this is illustrative, not a real generated proof.
 */

const DEFAULT_NAME = "Lukas";
const MAX_NAME_LEN = 24;

// Strip injection-risk punctuation and ASCII control characters. Letters,
// spaces, hyphens, and apostrophes pass through so "Anne-Marie" / "Mary Jane"
// render naturally.
const STRIP_PUNCTUATION_RE = /[<>{}`$&;]/g;
const STRIP_CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

function sanitizeName(input: string): string {
  return input
    .replace(STRIP_PUNCTUATION_RE, "")
    .replace(STRIP_CONTROL_CHARS_RE, "")
    .trimStart()
    .slice(0, MAX_NAME_LEN);
}

export function NamePreview() {
  const [name, setName] = useState(DEFAULT_NAME);
  const inputId = useId();
  const trimmedName = name.trim();
  const displayName = trimmedName || DEFAULT_NAME;
  // Only carry childName into checkout when the visitor actually typed
  // something; otherwise we would falsely prefill the placeholder DEFAULT_NAME
  // and overwrite any saved progress on the checkout side.
  const checkoutHref = trimmedName
    ? `/checkout?childName=${encodeURIComponent(trimmedName)}`
    : "/checkout";

  return (
    <section id="name-preview" className="py-20 bg-cream">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-10"
        >
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-navy mb-4 text-balance">
            See Their Name on the Page
          </h2>
          <p className="text-navy/70 text-lg max-w-2xl mx-auto text-pretty">
            Try your child&apos;s name &mdash; this is a sample preview, not the final book.
          </p>
        </motion.div>

        <div className="max-w-2xl mx-auto">
          <label
            htmlFor={inputId}
            className="block text-sm font-semibold text-navy mb-2"
          >
            Your child&apos;s first name
          </label>
          <input
            id={inputId}
            type="text"
            value={name}
            onChange={(e) => setName(sanitizeName(e.target.value))}
            placeholder="e.g., Emma"
            maxLength={MAX_NAME_LEN}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            aria-describedby={`${inputId}-help`}
            className="w-full px-4 py-3 border-2 border-navy/20 rounded-xl bg-white text-navy text-lg focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/20 transition"
          />
          <p
            id={`${inputId}-help`}
            className="text-xs text-navy/50 mt-2"
          >
            Just for the preview &mdash; nothing is saved or sent anywhere.
          </p>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mt-8 grid gap-4 sm:grid-cols-3"
          >
            <PreviewCard kicker="Cover">
              <span className="font-serif text-2xl text-navy leading-tight">
                {displayName} and the
                <br />
                Dinosaur Door
              </span>
            </PreviewCard>
            <PreviewCard kicker="Dedication">
              <span className="font-serif italic text-xl text-navy">
                Made just for {displayName}.
              </span>
            </PreviewCard>
            <PreviewCard kicker="Sample page">
              <span className="font-serif text-base text-navy/90 leading-relaxed">
                {displayName} tiptoed toward the glowing cave, heart racing with curiosity.
              </span>
            </PreviewCard>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mt-8 text-center"
          >
            <Link
              href={checkoutHref}
              className="inline-block bg-navy text-cream px-8 py-3.5 rounded-xl font-semibold text-base shadow-sm hover:bg-navy/90 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
            >
              Start {displayName}&apos;s book
            </Link>
            <p className="text-xs text-navy/50 mt-3">
              You&apos;ll review a personalized preview before any printing.
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function PreviewCard({
  kicker,
  children,
}: {
  kicker: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border-2 border-gold/30 bg-white p-5 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gold mb-3">
        {kicker}
      </p>
      <div>{children}</div>
    </div>
  );
}
