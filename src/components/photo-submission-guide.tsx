import Link from "next/link";

type PhotoSubmissionGuideProps = {
  compact?: boolean;
  showCta?: boolean;
  showGuideLink?: boolean;
};

const photoTips = [
  {
    label: "Best",
    title: "One clear face photo",
    body: "Use a recent, well-lit head-and-shoulders photo with the face in focus and unobstructed.",
    tone: "border-[#b9d5c7] bg-[#eef7f2]",
  },
  {
    label: "Usable",
    title: "Full-body or group photos",
    body: "These can help when every face is visible and large enough. Tell us who to use and where they are.",
    tone: "border-[#e2c889] bg-[#fff8e8]",
  },
  {
    label: "Avoid",
    title: "Tiny, blurry, or hidden faces",
    body: "Skip heavy filters, sunglasses, harsh shadows, cropped heads, and people blocking one another.",
    tone: "border-[#dfb8ae] bg-[#fff1ed]",
  },
] as const;

export function PhotoSubmissionGuide({
  compact = false,
  showCta = true,
  showGuideLink = true,
}: PhotoSubmissionGuideProps) {
  return (
    <section
      aria-labelledby={compact ? "checkout-photo-guide-title" : "photo-guide-title"}
      className={compact ? "space-y-4" : "bg-[#f5ead2]/55 py-16 md:py-24"}
    >
      <div className={compact ? "" : "mx-auto max-w-6xl px-5 md:px-8"}>
        <div className={compact ? "space-y-4" : "grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr]"}>
          <div>
            <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">
              Photo guide
            </div>
            <h2
              id={compact ? "checkout-photo-guide-title" : "photo-guide-title"}
              className={compact
                ? "font-serif text-2xl leading-tight text-[#1f1a16]"
                : "font-serif text-4xl font-medium leading-tight tracking-[-0.02em] text-[#1f1a16] md:text-5xl"}
            >
              Clear photos help us create a more recognizable, consistent character.
            </h2>
            <p className="mt-4 text-sm leading-6 text-[#695f54] md:text-base md:leading-7">
              A phone photo is fine. Group and full-body photos may be usable, but a separate clear face photo for each important character gives the best reference.
            </p>
            {!compact && (
              <p className="mt-3 text-sm leading-6 text-[#695f54]">
                Add parents, siblings, grandparents, and pets you want in the story. We use the references to create storybook-style characters, then send a private digital proof for your review before anything prints.
              </p>
            )}
            {showCta && (
              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="/checkout"
                  className="inline-flex items-center justify-center rounded-full bg-[#1f1a16] px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#fff8ec] transition hover:bg-[#332a22]"
                >
                  Start your story
                </a>
                {!compact && showGuideLink && (
                  <Link
                    href="/photo-guide"
                    className="inline-flex items-center justify-center rounded-full border border-[#c9b891] px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#1f1a16] transition hover:border-[#a64c4c] hover:text-[#a64c4c]"
                  >
                    Open the full photo guide
                  </Link>
                )}
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-[1.75rem] border border-[#d8c6a2] bg-[#1f1a16] shadow-[0_28px_65px_-40px_rgba(31,26,22,0.6)]">
            <video
              controls
              playsInline
              preload="metadata"
              poster="/assets/photo-guide/walkthrough-poster.png"
              className="aspect-[9/16] max-h-[640px] w-full bg-[#1f1a16] object-contain"
              aria-label="Walkthrough showing which photos to upload and how a personalized storybook is created"
            >
              <source src="/assets/photo-guide/photo-submission-walkthrough.mp4" type="video/mp4" />
              Your browser does not support this video. Use the photo checklist below instead.
            </video>
          </div>
        </div>

        <div className={compact ? "grid gap-3 sm:grid-cols-3" : "mt-10 grid gap-4 md:grid-cols-3"}>
          {photoTips.map((tip) => (
            <article key={tip.label} className={`rounded-2xl border p-4 ${tip.tone}`}>
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a64c4c]">{tip.label}</div>
              <h3 className="mt-2 font-serif text-xl font-semibold text-[#1f1a16]">{tip.title}</h3>
              <p className="mt-2 text-xs leading-5 text-[#695f54]">{tip.body}</p>
            </article>
          ))}
        </div>

        <p className={compact ? "text-xs leading-5 text-[#695f54]" : "mt-6 text-sm leading-6 text-[#695f54]"}>
          Helpful extra: 2–3 photos from different angles can improve consistency for a main character. Clear pet photos work best near eye level. Every result is a storybook interpretation—not a guarantee of an exact photographic likeness.
        </p>
      </div>
    </section>
  );
}
