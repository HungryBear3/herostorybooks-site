import { EditorialPageShell } from '@/components/editorial-site';

export default function PrivacyPage() {
  // LEGAL REVIEW REQUIRED (Phase A fully-custom checkout): the adult/family
  // media, biometric/BIPA, retention/destruction, and authorized-adult consent
  // language below was drafted by engineering as groundwork and MUST be
  // reviewed and approved by counsel before enabling new media intake
  // (adult/family photos, voice notes, documents, or any face/voice
  // processing) in production. This is NOT a claim of legal compliance.
  return (
    <EditorialPageShell>
      <section className="mx-auto max-w-3xl px-5 py-16 md:px-8 md:py-24">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">Privacy</div>
        <h1 className="font-serif text-5xl font-medium leading-tight tracking-[-0.02em] text-[#1f1a16]">Privacy Policy</h1>
        <p className="mt-4 text-sm text-[#695f54]">Last updated May 16, 2026</p>
        <div className="mt-10 space-y-7 text-base leading-8 text-[#695f54]">
          <p>HeroStoryBooks uses the information you provide only to create, proof, fulfill, and support your personalized book order.</p>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">What we collect</h2><p className="mt-2">We may collect the purchaser&apos;s contact information; the names, ages or life stages, and appearance details of the people the book is about (which may include children and adults such as parents or grandparents); story preferences; dedication text; uploaded reference photos of one or more people; optional voice notes or memory recordings and text/PDF/Word documents; shipping details; and payment status. Payments are processed by Stripe; we do not store full card numbers.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Uploaded photos, voice, and documents</h2><p className="mt-2">Some books feature more than one person — for example a child plus parents, grandparents, or pets. By uploading a photo, voice note, memory recording, or document that includes any person, you confirm you are a parent, guardian, or an authorized adult with permission from every identifiable person in that media (or their parent/guardian) to submit it for this order. We use uploaded media only to create, proof, fulfill, and support the requested book. We do <strong>not</strong> use it to train AI models, and we do <strong>not</strong> clone anyone&apos;s voice. Any face, likeness, or voice processing is limited to producing your book.</p><p className="mt-2 text-sm">Depending on where you live, laws such as the Illinois Biometric Information Privacy Act (BIPA) may apply to certain face or voice data. If we introduce features that create face embeddings, likeness templates, or voiceprints, we will provide the specific notice and consent those laws require before doing so.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Children&apos;s information</h2><p className="mt-2">HeroStoryBooks is purchased by adults; we do not market to children, and we do not knowingly collect information directly from children. Orders must be placed by a parent, guardian, or authorized adult. Child details and uploaded photos are used only to make the requested book and provide customer support. We do not sell children&apos;s data, and we do not use uploaded photos to train AI models. We handle uploaded child photos and optional voice notes with care consistent with COPPA principles.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">How we use AI and vendors</h2><p className="mt-2">We may use trusted service providers for AI-assisted illustration/story drafting, transcription of optional voice notes, hosting, email delivery, payment processing, and print fulfillment. We share only what is needed for those services to complete your order.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Retention and deletion</h2><p className="mt-2">We retain order records as needed for fulfillment, support, fraud prevention, tax/accounting, and legal obligations. Uploaded reference photos, voice notes, and documents are kept only as long as needed to create and support your book. Our target is to remove uploaded photos, voice, and document files from active storage within a limited period after an order is completed or canceled, subject to backups and legal-hold requirements; the specific retention/destruction schedule is being finalized with counsel. You can request deletion of uploaded photos, voice files, or documents at any time by emailing support@herostorybooks.com.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Your data rights</h2><p className="mt-2">You may request access to, correction of, or deletion of the personal information we hold about you or your child&apos;s order by emailing <a className="text-[#a64c4c] underline" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a>. We respond to verified requests within a reasonable timeframe, subject to our legal record-keeping obligations.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Where we serve customers</h2><p className="mt-2">For launch, HeroStoryBooks is intended for US customers. Printed books ship within the US only. International buyers may order the Digital PDF where local payment and import rules allow, but the service, support, and policies on this page are designed around US-customer expectations.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Contact</h2><p className="mt-2">Questions, access requests, or deletion requests: <a className="text-[#a64c4c] underline" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a>.</p></section>
        </div>
      </section>
    </EditorialPageShell>
  );
}
