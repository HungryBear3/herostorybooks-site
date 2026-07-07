import { EditorialPageShell } from '@/components/editorial-site';

export default function TermsPage() {
  // LEGAL REVIEW REQUIRED (Phase A fully-custom checkout): the upload
  // authorization and no-voice-cloning language below is engineering
  // groundwork and must be reviewed by counsel before new media intake is
  // enabled in production. This is NOT a claim of legal compliance.
  return (
    <EditorialPageShell>
      <section className="mx-auto max-w-3xl px-5 py-16 md:px-8 md:py-24">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">Terms</div>
        <h1 className="font-serif text-5xl font-medium leading-tight tracking-[-0.02em] text-[#1f1a16]">Terms of Service</h1>
        <p className="mt-4 text-sm text-[#695f54]">Last updated May 16, 2026</p>
        <div className="mt-10 space-y-7 text-base leading-8 text-[#695f54]">
          <p>These terms explain how HeroStoryBooks creates personalized books and how orders, proofs, revisions, printing, and refunds work.</p>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Ordering authorization</h2><p className="mt-2">By placing an order, you confirm that you are the parent, guardian, or an authorized adult with permission to provide the child information, photos, and any optional voice recording used for the book.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Proof approval</h2><p className="mt-2">Physical books include a digital proof before printing. Please review names, photos, story details, and shipping information carefully. We do not print physical books until the proof is approved.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Revisions and refunds</h2><p className="mt-2">If something in the proof feels wrong, contact us before approval and we will revise it. Because each book is personalized, approved printed orders generally cannot be canceled once submitted to print fulfillment. After proof approval, we can only replace books with printing defects or fulfillment errors.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Shipping</h2><p className="mt-2">US shipping is included for softcover and hardcover books. Delivery estimates begin after proof approval and may vary by destination, holidays, weather, carrier delays, or print-provider issues.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Acceptable uploads</h2><p className="mt-2">Do not upload content you do not have rights to use, or content that is abusive, explicit, unlawful, or unsafe. We may refuse or cancel orders that violate these terms.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Contact</h2><p className="mt-2">Support: <a className="text-[#a64c4c] underline" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a>.</p></section>
        </div>
      </section>
    </EditorialPageShell>
  );
}
