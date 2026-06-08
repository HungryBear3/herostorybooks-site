"use client";

import React from "react";
import { buildStoryPreview, type StoryPreviewInput } from "@/lib/story-preview";

/**
 * Pre-purchase story-confidence card. Deterministic + local (no provider call).
 * Renders nothing until the required fields (child name + theme) are present.
 */
export function StoryPreviewCard(props: StoryPreviewInput) {
  const preview = buildStoryPreview(props);
  if (!preview) return null;

  return (
    <section className="rounded-2xl border border-[#e4d2ad] bg-[#fffaf1] p-5 space-y-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#a64c4c]">Preview</p>
        <h3 className="font-serif text-xl text-[#1f1a16]">{preview.title}</h3>
      </div>

      <ol className="space-y-1.5 text-sm leading-6 text-[#3b3029]">
        {preview.beats.map((beat, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="text-[#a64c4c]">•</span>
            <span>{beat}</span>
          </li>
        ))}
      </ol>

      <ul className="flex flex-wrap gap-2">
        {preview.stylePromise.map((p, i) => (
          <li key={i} className="rounded-full bg-[#eef4f1] px-3 py-1 text-xs font-semibold text-[#35564d]">
            {p}
          </li>
        ))}
      </ul>

      {preview.customDetailHint && (
        <p className="text-sm text-[#3b3029]">
          We&apos;ll weave in what you told us: <span className="italic">“{preview.customDetailHint}”</span>
        </p>
      )}
      {preview.voiceNote && <p className="text-sm text-[#35564d]">{preview.voiceNote}</p>}
      {preview.guidedNote && <p className="text-sm text-[#35564d]">{preview.guidedNote}</p>}

      <p className="text-xs leading-5 text-[#8a7b6a]">{preview.disclaimer}</p>
    </section>
  );
}
