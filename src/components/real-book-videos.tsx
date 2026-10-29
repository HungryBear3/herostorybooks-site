const books = [
  { slug: 'pasta-planet', title: 'Pasta Planet' },
  { slug: 'biggest-day-ever', title: 'Biggest Day Ever' },
];

export function RealBookVideos({ compact = false }: { compact?: boolean }) {
  return (
    <section id="real-books" aria-labelledby="real-books-title" className="mx-auto max-w-6xl px-5 py-12 md:px-8">
      <p className="text-sm font-semibold uppercase tracking-widest text-[#765938]">Real books, real page turns</p>
      <h2 id="real-books-title" className="mt-3 font-serif text-3xl text-[#1f1a16] md:text-4xl">See a finished storybook in your hands.</h2>
      <p className="mt-4 max-w-2xl text-[#65594d]">Watch real printed Hero Story Books being opened and explored. Tap play to look inside; sound is off until you choose to turn it on.</p>
      <div className={`mt-8 grid gap-8 ${compact ? '' : 'md:grid-cols-2'}`}>
        {(compact ? books.slice(0, 1) : books).map((book) => (
          <figure key={book.slug} className="overflow-hidden rounded-2xl border border-[#d8c6a2] bg-[#fff8ec]">
            <video controls playsInline muted preload="none" poster={`/videos/real-books/${book.slug}.jpg`} aria-label={`${book.title} printed book page-turn video`} className="aspect-video w-full bg-black">
              <source src={`/videos/real-books/${book.slug}.mp4`} type="video/mp4" />
              <track kind="captions" src={`/videos/real-books/${book.slug}.vtt`} srcLang="en" label="English" />
              Your browser does not support embedded video. <a href={`/videos/real-books/${book.slug}.mp4`}>Watch {book.title}</a>.
            </video>
            <figcaption className="p-5"><h3 className="font-serif text-2xl text-[#1f1a16]">{book.title}</h3><p className="mt-1 text-sm text-[#65594d]">Filmed from a real printed book. Each personalized story is different.</p></figcaption>
          </figure>
        ))}
      </div>
      {compact && <a href="/samples#real-books" className="mt-6 inline-block font-semibold text-[#6e4523] underline underline-offset-4">Watch both real-book videos →</a>}
    </section>
  );
}
