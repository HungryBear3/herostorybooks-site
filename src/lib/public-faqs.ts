import {
  PROOF_REVIEW_ASSURANCE,
  PROOF_TURNAROUND_WINDOW,
  PROOF_VOLUME_NOTE,
} from './proof-turnaround.ts';

/**
 * The homepage FAQ, verbatim — the single source for both the rendered
 * accordion in src/components/editorial-site.tsx and the FAQPage JSON-LD in
 * src/lib/public-structured-data.ts.
 *
 * Google requires a structured FAQ answer to match what a visitor can actually
 * read on the page. Sharing this array makes that identity structural rather
 * than something a test has to police after the two copies drift.
 *
 * Every answer here is public-facing copy. Nothing about a specific order,
 * customer, or child belongs in this file.
 */
export const PUBLIC_HOME_FAQS: Array<[string, string]> = [
  ['How personalized is the book?', 'Fully customizable. Every book can use your child’s name, age, interests, dedication, photo/character notes, and an optional 30-second voice note so the story can reflect their own ideas and phrases. We make the child the hero of the story instead of dropping their name into a generic template.'],
  ['Do I approve it before printing? Can I request changes?', 'Yes — and always. Physical books are not printed until you approve the digital proof. Reply to the proof email with any changes: story wording, photo placement, dedication, character details, scene tone. Revisions before approval are included, not an upsell.'],
  ['How long does it take from order to delivery?', `Digital proofs are usually ready in ${PROOF_TURNAROUND_WINDOW}. ${PROOF_REVIEW_ASSURANCE} ${PROOF_VOLUME_NOTE} Digital orders get the full PDF with that proof email, so there is nothing further to wait for; printed books ship 5–7 business days after you approve, then US delivery is typically 3–5 days. We don’t guarantee specific holiday-delivery dates because carriers can vary.`],
  ['Will it arrive in time for a birthday or gift deadline?', 'Most US printed orders that approve their proof at least 9–12 days before the date arrive in time, but we don’t promise specific dates — shipping carriers vary. If timing is tight, the Digital PDF is a reliable fallback you can print at home or share instantly.'],
  ['Which option is safest for a gift with a deadline?', 'The Digital PDF. The full file arrives with your proof email and there is no printing or shipping step, so there’s no carrier timing risk — you can print it at home or share it instantly. A printed softcover or hardcover is an optional upgrade that ships after approval; arrival depends on the order date, proof approval timing, and your carrier.'],
  ['What if my photo isn’t ready yet — can I still order?', 'Yes. Place the order when you are ready; the proof clock starts when we receive your photo. Digital orders have no shipping step — the PDF arrives with the proof, so you can read and download it as soon as the proof is ready.'],
  ['Can I send it as a gift or surprise someone?', 'Yes. Add a dedication and gift message at checkout. The proof email goes to whoever you list as the buyer, not the recipient, so the surprise stays intact.'],
  ['What if my child doesn’t like the proof?', 'Reply to the proof email with what to change — a different scene, a softer dinosaur, a recolored sweater, whatever. Revisions before approval are free. We don’t print until you say go.'],
  ['What is the refund policy for digital orders?', 'Digital orders are fully refundable up until you approve the proof. Approving accepts the book, and the digital order is final from that point.'],
  ['What is the refund policy for printed books?', 'Printed books are refundable up until you approve the proof for print. After proof approval, we can only replace books with printing defects or fulfillment errors — the book goes to print and generally cannot be canceled.'],
  ['Do you ship internationally?', 'For launch, printed books ship within the US only. International buyers can order the Digital PDF from anywhere with a US-billed payment method.'],
  ['Can I order multiple copies?', 'Yes. Add the book to checkout once for the personalization, then email support after approval and we’ll arrange additional softcover or hardcover prints at a reduced rate.'],
  ['What kind of photo should I upload?', 'One clear, well-lit, front-facing photo where your child’s face is in focus. Phone snapshots are fine — we don’t need a studio portrait. A recent everyday photo usually works best.'],
];
