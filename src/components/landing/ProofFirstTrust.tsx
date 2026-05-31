import Link from 'next/link';

const proofSteps = [
  {
    label: '1',
    title: 'Tell us who it is for',
    body: "Start with the child's name, photo, interests, dedication, and optional voice note.",
  },
  {
    label: '2',
    title: 'We craft the proof',
    body: 'We prepare the story and watercolor art, then review the book before sending it to you.',
  },
  {
    label: '3',
    title: 'You approve first',
    body: 'Reply with changes before approval. Nothing prints until you say the full proof is ready.',
  },
] as const;

const proofArtifacts = [
  {
    src: '/assets/lukas-dino-bedtime-proof.jpg',
    alt: 'Bedtime watercolor proof with child reading and dinosaur dream scene',
    label: 'Illustration proof',
  },
  {
    src: '/assets/hsb-lukas-print-story-07.jpg',
    alt: 'Interior proof page from a personalized Lukas dinosaur book',
    label: 'Interior page',
  },
  {
    src: '/assets/hsb-lukas-print-story-16.jpg',
    alt: 'Interior proof page showing the child hero between dinosaurs',
    label: 'Story spread',
  },
  {
    src: '/assets/hsb-lukas-print-story-21.jpg',
    alt: 'Interior proof page with child hero receiving a dinosaur crown',
    label: 'Finished proof',
  },
] as const;

const trustFacts = [
  ['Proof before print', 'You review the whole book before a physical copy is made.'],
  ['Revisions included', 'Story wording, scene details, and art notes can be fixed before approval.'],
  ['Private photos', 'Photos are used to make and support the order, not sold or reused for unrelated projects.'],
  ['Stripe checkout', 'Payment is handled securely through Stripe.'],
] as const;

export function ProofFirstTrust() {
  return (
    <section className="bg-[#f8f0dd] text-[#1f1a16]">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-[0.9fr_1.1fr] md:px-8 md:py-24">
        <div className="self-start md:sticky md:top-24">
          <p className="mb-4 text-xs font-bold uppercase text-[#a64c4c]">
            Proof-first promise
          </p>
          <h2 className="font-serif text-5xl font-medium leading-[1.02] md:text-6xl">
            You see the whole book. Then we print it.
          </h2>
          <p className="mt-6 max-w-xl text-base leading-8 text-[#695f54]">
            HeroStoryBooks is built for gifts that need to feel right. You get the full digital proof first,
            with the story, illustrations, dedication, and format details visible before fulfillment.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/checkout"
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-[#a64c4c] px-6 text-sm font-semibold text-white transition hover:bg-[#8f3f3f]"
            >
              Start your book
            </Link>
            <Link
              href="/samples"
              className="inline-flex min-h-12 items-center justify-center rounded-full border border-[#d8c6a2] bg-[#fff8ec] px-6 text-sm font-semibold text-[#1f1a16] transition hover:bg-white"
            >
              See sample pages
            </Link>
          </div>
        </div>

        <div className="grid gap-8">
          <div className="rounded-lg border border-[#d8c6a2] bg-[#fff8ec] p-5 shadow-[0_24px_70px_-58px_rgba(36,25,20,0.65)]">
            <div className="flex items-center justify-between border-b border-[#e5d7bd] pb-4">
              <div>
                <p className="text-xs font-semibold uppercase text-[#695f54]">Proof email preview</p>
                <h3 className="mt-1 font-serif text-3xl font-semibold">Your proof is ready</h3>
              </div>
              <span className="rounded-full bg-[#f1dfbf] px-3 py-1 text-xs font-semibold text-[#5c4b39]">
                Review first
              </span>
            </div>
            <div className="grid gap-4 pt-5 sm:grid-cols-3">
              {proofSteps.map((step) => (
                <article key={step.label} className="rounded-md border border-[#e5d7bd] bg-[#fbf5e8] p-4">
                  <span className="inline-grid h-8 w-8 place-items-center rounded-full bg-[#a64c4c] font-serif text-lg text-white">
                    {step.label}
                  </span>
                  <h4 className="mt-4 font-serif text-xl font-semibold leading-tight">{step.title}</h4>
                  <p className="mt-2 text-sm leading-6 text-[#695f54]">{step.body}</p>
                </article>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase text-[#a64c4c]">Real proof artifacts</p>
                <h3 className="mt-1 font-serif text-3xl font-semibold">One sample book, shown consistently.</h3>
              </div>
              <p className="max-w-sm text-sm leading-6 text-[#695f54]">
                These are existing Lukas proof assets already approved for internal marketing review.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {proofArtifacts.map((artifact) => (
                <figure key={artifact.src} className="overflow-hidden rounded-lg border border-[#d8c6a2] bg-[#fff8ec]">
                  <img
                    src={artifact.src}
                    alt={artifact.alt}
                    className="aspect-[4/3] w-full object-cover object-[50%_35%]"
                    loading="lazy"
                  />
                  <figcaption className="px-4 py-3 text-sm font-semibold text-[#5c4b39]">
                    {artifact.label}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {trustFacts.map(([title, body]) => (
              <article key={title} className="rounded-lg border border-[#d8c6a2] bg-[#fbf5e8] p-5">
                <h4 className="font-serif text-2xl font-semibold">{title}</h4>
                <p className="mt-2 text-sm leading-6 text-[#695f54]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
