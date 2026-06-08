import { EditorialPageShell } from '@/components/editorial-site';

export default function PrivacyPage() {
  return (
    <EditorialPageShell>
      <section className="mx-auto max-w-3xl px-5 py-16 md:px-8 md:py-24">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a64c4c]">Privacy</div>
        <h1 className="font-serif text-5xl font-medium leading-tight tracking-[-0.02em] text-[#1f1a16]">Privacy Policy</h1>
        <p className="mt-4 text-sm text-[#695f54]">Last updated June 8, 2026</p>
        <div className="mt-10 space-y-7 text-base leading-8 text-[#695f54]">
          <p>HeroStoryBooks uses the information you provide only to create, proof, fulfill, and support your personalized book order.</p>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">What we collect</h2><p className="mt-2">We may collect parent/guardian contact information, child first name, age, story preferences, dedication text, uploaded photos, optional voice notes, shipping details, and payment status. Payments are processed by Stripe; we do not store full card numbers.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Children&apos;s information</h2><p className="mt-2">HeroStoryBooks is purchased by adults; we do not market to children, and we do not knowingly collect information directly from children. Orders must be placed by a parent, guardian, or authorized adult. Child details, uploaded photos, guided reference photos, and optional voice notes are used only to make the requested book and provide customer support. We do not sell children&apos;s data, and we do not use uploaded photos, guided reference photos, or voice notes to train AI models. We handle uploaded child photos and optional voice notes with care consistent with COPPA principles.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">How we use AI and vendors</h2><p className="mt-2">We may use trusted service providers for AI-assisted illustration/story drafting, hosting, email delivery, payment processing, and print fulfillment. We share only what is needed for those services to complete your order.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Retention and deletion</h2><p className="mt-2">We retain order records as needed for fulfillment, support, fraud prevention, tax/accounting, and legal obligations. Uploaded child photos and guided reference photos are deleted after book delivery plus 30 days unless needed for support or legal record-keeping. Optional child voice notes are deleted after story/proof generation plus 30 days unless needed for support or legal record-keeping. You can request earlier deletion of uploaded child photos, guided reference photos, or optional voice files by emailing support@herostorybooks.com.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Your data rights</h2><p className="mt-2">You may request access to, correction of, or deletion of the personal information we hold about you or your child&apos;s order by emailing <a className="text-[#a64c4c] underline" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a>. We respond to verified requests within a reasonable timeframe, subject to our legal record-keeping obligations.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Where we serve customers</h2><p className="mt-2">For launch, HeroStoryBooks is intended for US customers. Printed books ship within the US only. International buyers may order the Digital PDF where local payment and import rules allow, but the service, support, and policies on this page are designed around US-customer expectations.</p></section>
          <section><h2 className="font-serif text-2xl text-[#1f1a16]">Contact</h2><p className="mt-2">Questions, access requests, or deletion requests: <a className="text-[#a64c4c] underline" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a>.</p></section>
        </div>
      </section>
    </EditorialPageShell>
  );
}
