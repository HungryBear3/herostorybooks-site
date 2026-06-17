// Branded 404 for HSB. Matches the editorial cream/forest/red palette
// used by the homepage shell — no black default Next.js 404. Read-only
// page: pure server component, no client JS, no network calls.

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Page not found · HeroStoryBooks',
  description: 'That page does not exist on HeroStoryBooks. Find your way back to the home page, start a book, or browse the sample.',
};

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col bg-[#f8f0dd] text-[#1f1a16]">
      <header className="border-b border-[#dfd2b8] bg-[#f8f0dd]/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 md:px-8">
          <Link href="/" className="flex items-center gap-3 font-serif text-base font-semibold uppercase tracking-[0.14em] text-[#1f1a16] md:text-lg">
            <span className="h-2 w-2 rounded-full bg-[#a64c4c] shadow-[0_0_0_4px_rgba(166,76,76,0.14)]" />
            HeroStoryBooks
          </Link>
          <nav className="hidden items-center gap-8 md:flex">
            <Link href="/#how" className="text-sm font-medium text-[#695f54] underline-offset-8 transition hover:text-[#a64c4c]">How it works</Link>
            <Link href="/samples" className="text-sm font-medium text-[#695f54] underline-offset-8 transition hover:text-[#a64c4c]">Sample</Link>
            <Link href="/pricing" className="text-sm font-medium text-[#695f54] underline-offset-8 transition hover:text-[#a64c4c]">Pricing</Link>
            <Link href="/#faq" className="text-sm font-medium text-[#695f54] underline-offset-8 transition hover:text-[#a64c4c]">FAQ</Link>
            <Link href="/checkout" className="inline-flex items-center justify-center rounded-full bg-[#1f1a16] px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#fff8ec] shadow-[0_10px_25px_-18px_rgba(31,26,22,0.6)] transition hover:-translate-y-0.5 hover:bg-[#332a22]">Start your book</Link>
          </nav>
          <Link href="/checkout" className="rounded-full bg-[#1f1a16] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#fff8ec] shadow-sm md:hidden">
            Start
          </Link>
        </div>
      </header>

      <section className="flex flex-1 items-center">
        <div className="mx-auto w-full max-w-3xl px-5 py-20 text-center md:px-8 md:py-28">
          <div className="mb-4 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">404 · page not found</div>
          <h1 className="font-serif text-[clamp(2.4rem,6vw,4.5rem)] font-medium leading-[0.9] tracking-[-0.03em] text-[#1f1a16]">
            That page wandered out of the story.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-[#695f54] md:text-lg">
            We can&apos;t find what you were looking for. The link may have moved, or the URL might be off by a letter.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-full bg-[#1f1a16] px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#fff8ec] shadow-[0_10px_25px_-18px_rgba(31,26,22,0.6)] transition hover:-translate-y-0.5 hover:bg-[#332a22]"
            >
              Back to home
            </Link>
            <Link
              href="/checkout"
              className="inline-flex items-center justify-center rounded-full border border-[#1f1a16] px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#1f1a16] transition hover:bg-[#1f1a16] hover:text-[#fff8ec]"
            >
              Start your book
            </Link>
            <Link
              href="/samples"
              className="text-sm font-medium text-[#695f54] underline underline-offset-8 transition hover:text-[#a64c4c]"
            >
              See a sample
            </Link>
          </div>
          <div className="mt-12 text-sm text-[#695f54]">
            Still stuck?{' '}
            <a href="mailto:support@herostorybooks.com" className="text-[#1f1a16] underline underline-offset-4 hover:text-[#a64c4c]">
              support@herostorybooks.com
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#dfd2b8] bg-[#f5ead2]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-5 text-xs text-[#695f54] md:px-8">
          <span>© 2026 HeroStoryBooks · Made by a small team in Chicago · <a href="mailto:support@herostorybooks.com" className="hover:text-[#a64c4c]">support@herostorybooks.com</a></span>
          <span>SSL-encrypted · Stripe-secured · proof-first printed keepsakes</span>
        </div>
      </footer>
    </main>
  );
}
