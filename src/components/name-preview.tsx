"use client";

import { useId, useState, type ReactNode } from "react";
import { track } from "@/lib/analytics";

/**
 * Frontend-only "name preview" - a low-risk conversion touch that lets a
 * visitor type their child's first name and see it on three sample surfaces
 * (mock cover title, dedication line, sample-spread snippet).
 *
 * Hard rules carried from the prompt:
 *   - Zero backend calls; no AI, Stripe, Lulu, blob, or external fetch.
 *   - No server persistence; typed names are carried to checkout only through
 *     browser sessionStorage after the visitor taps the CTA, never in the URL.
 *   - Microcopy makes clear this is illustrative, not a real generated proof.
 */

const DEFAULT_NAME = "Avery";
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

// The visible NamePreview teases a "Prehistoric Adventure" cover + dinosaur
// story page, so the CTA must hand off to checkout with that story direction
// pre-selected. If we changed the visible tease later, only this constant
// would need to follow.
const NAME_PREVIEW_DIRECTION = "dinosaur";
export const NAME_PREVIEW_HANDOFF_KEY = "hsb_name_preview_handoff";

export function NamePreview() {
  const [name, setName] = useState("");
  const inputId = useId();
  const trimmedName = name.trim();
  const displayName = trimmedName || DEFAULT_NAME;
  const checkoutParams = new URLSearchParams({ direction: NAME_PREVIEW_DIRECTION });
  const checkoutHref = `/checkout?${checkoutParams.toString()}`;

  const handleCtaClick = () => {
    if (typeof window !== "undefined") {
      if (trimmedName) {
        window.sessionStorage.setItem(
          NAME_PREVIEW_HANDOFF_KEY,
          JSON.stringify({ childName: trimmedName, direction: NAME_PREVIEW_DIRECTION }),
        );
      } else {
        window.sessionStorage.removeItem(NAME_PREVIEW_HANDOFF_KEY);
      }
    }
    track("name_preview_submitted", {
      direction: NAME_PREVIEW_DIRECTION,
      hasName: trimmedName.length > 0,
      nameLength: trimmedName.length,
    });
  };

  return (
    <section id="name-preview" className="border-y border-[#dfd2b8] bg-[#f5ead2] pt-6 pb-10 md:pt-10 md:pb-14">
      <div className="container mx-auto px-6">
        <div className="text-center mb-10">
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-navy mb-4 text-balance">
            See their name on the page
          </h2>
          <p className="mx-auto max-w-2xl text-lg leading-8 text-[#695f54] text-pretty">
            Try your child&apos;s name in a real sample scene. This is illustrative only — not a generated proof.
          </p>
          <p className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#d8c6a2] bg-[#fff8ec] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#695f54]">
            <span aria-hidden="true" className="text-[#a64c4c]">✓</span>
            Sample preview · no photo or order is created yet
          </p>
        </div>

        <div className="max-w-2xl mx-auto">
          <label
            htmlFor={inputId}
            className="mb-2 block text-sm font-semibold text-[#1f1a16]"
          >
            Your child&apos;s first name
          </label>
          <input
            id={inputId}
            type="text"
            value={name}
            onChange={(e) => setName(sanitizeName(e.target.value))}
            placeholder="e.g., Avery"
            maxLength={MAX_NAME_LEN}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            aria-describedby={`${inputId}-help`}
            className="w-full rounded-xl border-2 border-[#d8c6a2] bg-[#fff8ec] px-4 py-3 text-lg text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/20"
          />
          <p
            id={`${inputId}-help`}
            className="mt-2 text-xs text-[#695f54]"
          >
            Just for the preview &mdash; we only carry it to checkout if you tap Start.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <PreviewCard kicker="Cover">
              <span className="font-serif text-2xl leading-tight text-[#1f1a16]">
                {displayName}&apos;s
                <br />
                Prehistoric Adventure
              </span>
            </PreviewCard>
            <PreviewCard kicker="Dedication">
              <span className="font-serif text-xl italic text-[#1f1a16]">
                For {displayName} — may curiosity always lead you somewhere wonderful.
              </span>
            </PreviewCard>
            <PreviewCard kicker="Sample page">
              <span className="font-serif text-base leading-relaxed text-[#1f1a16]/90">
                {displayName} followed the giant footprints through the ferns, listening for the friendly rumble just beyond the trees.
              </span>
            </PreviewCard>
          </div>

          <div className="mt-8 text-center">
            <a
              href={checkoutHref}
              onClick={handleCtaClick}
              className="inline-block rounded-full bg-[#1f1a16] px-8 py-3.5 text-base font-semibold text-[#fff8ec] shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#332a22] hover:shadow-md"
            >
              Start {displayName}&apos;s dinosaur book
            </a>
            <p className="mt-3 text-xs text-[#695f54]">
              You&apos;ll review a personalized preview before any printing.
            </p>
          </div>
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
    <div className="rounded-2xl border-2 border-[#d8c6a2] bg-[#fff8ec] p-5 shadow-sm">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#a64c4c]">
        {kicker}
      </p>
      <div>{children}</div>
    </div>
  );
}
