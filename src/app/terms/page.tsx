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
        <p className="mt-4 text-sm text-[#695f54]">Last updated July 7, 2026</p>
        <div className="mt-10 space-y-7 text-base leading-8 text-[#695f54]">
          <p>These terms explain how HeroStoryBooks creates personalized books and how orders, proofs, revisions, printing, and refunds work.</p>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Ordering authorization</h2><p className="mt-2">By placing an order, you confirm that you are an adult and that you are the parent, guardian, or an authorized adult with permission to provide the names, relationship details, photos, appearance notes, story notes, and any optional voice recording or document used for the book. If uploaded media includes another identifiable person, you confirm you have that person&apos;s permission or, for a minor, permission from their parent or guardian.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Proof approval</h2><p className="mt-2">Physical books include a digital proof before printing. Please review names, photos, story details, and shipping information carefully. We do not print physical books until the proof is approved.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Revisions and refunds</h2><p className="mt-2">If something in the proof feels wrong, contact us before approval and we will revise it. Because each book is personalized, approved printed orders generally cannot be canceled once submitted to print fulfillment. After proof approval, we can only replace books with printing defects or fulfillment errors.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Shipping</h2><p className="mt-2">US shipping is included for softcover and hardcover books. Delivery estimates begin after proof approval and may vary by destination, holidays, weather, carrier delays, or print-provider issues.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Acceptable uploads and media use</h2><p className="mt-2">Do not upload content you do not have rights or permission to use, or content that is abusive, explicit, unlawful, unsafe, or invasive of another person&apos;s privacy. Uploaded photos, voice notes, memory recordings, and documents are used only to create, proof, fulfill, and support your requested book. Optional voice notes or memory recordings may be transcribed so the transcript can be used as story inspiration for the proof team and AI-assisted drafting. We do <strong>not</strong> use uploaded media for voice cloning, public publishing, or AI model training. We may refuse or cancel orders that violate these terms.</p><p className="mt-2">You may request deletion of uploaded photos, voice files, or documents by emailing support@herostorybooks.com. Deletion may be limited by completed fulfillment, backups, fraud prevention, accounting, dispute, or legal record-keeping requirements.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Primary hero preview features</h2><p className="mt-2">Some preview checkout features may allow a parent, grandparent, pet, sibling, or family group to be the named primary hero. Those preview features are experimental and may require extra reference photos, recipient context, and manual proof review before we accept or fulfill the order. Physical books still do not print until proof approval.</p></section><section><h2 className="font-serif text-2xl text-[#1f1a16]">Contact</h2><p className="mt-2">Support: <a className="text-[#a64c4c] underline" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a>.</p></section>
        </div>
      </section>
    </EditorialPageShell>
  );
}
