import type { OrderRecord } from './orders.ts';
import { isPrintFormat } from './orders.ts';
import { PROOF_DELAY_SUPPORT_NOTE, PROOF_VOLUME_NOTE } from './proof-turnaround.ts';

export type TimelineStepState = 'done' | 'active' | 'pending' | 'failed';

export interface TimelineStep {
  id: string;
  label: string;
  description: string;
  state: TimelineStepState;
}

export interface OrderStatusView {
  headline: string;
  subhead: string;
  tone: 'neutral' | 'success' | 'action' | 'failure';
  isPrint: boolean;
  isFailed: boolean;
  needsAction: boolean;
  primaryAction?: { label: string; href: string; kind: 'download' | 'view' | 'approve' };
  secondaryAction?: { label: string; href: string };
  tracking?: { number?: string; url?: string; shippedAt?: string };
  timeline: TimelineStep[];
  supportBlurb: string;
  /**
   * Honest queue expectation, set only for a paid order whose proof we have not
   * produced yet — see AWAITING_PROOF_PRODUCTION for the exact states and why
   * every other one is excluded. Carries no queue position or date (we have no
   * customer-facing queue telemetry), and the subheads it can appear under are
   * kept free of short numeric timings so one block never shows two time scales.
   */
  processingNote?: string;
}

/**
 * The only fulfillment states that earn the wait note: the customer is paid up
 * and we have not yet produced their proof, so a busy queue genuinely explains
 * the wait.
 *
 * Everything else is excluded ON PURPOSE, and `tone` alone cannot express why:
 *  - `proof_ready` / `proof_approved` / `submitting_to_print` / `complete` —
 *    the proof exists. Telling that customer proofs can run long is false.
 *  - `delivery_email_failed` — artifacts generated and persisted fine and only
 *    the notification failed (see FulfillmentStatus). Blaming volume misstates
 *    the cause, and "we email you as soon as yours is ready" names the exact
 *    mechanism that just broke.
 *  - `failed_manual_review` — has its own manual-review path; a queue excuse
 *    would bury it.
 *  - anything unrecognized — we cannot substantiate a queue claim about a state
 *    we do not model, so we say nothing rather than guess.
 */
const AWAITING_PROOF_PRODUCTION: ReadonlySet<string> = new Set([
  'not_started',
  'generating_story',
  'generating_images',
  'building_pdf',
]);

function step(
  id: string,
  label: string,
  description: string,
  state: TimelineStepState,
): TimelineStep {
  return { id, label, description, state };
}

export function buildOrderStatusView(order: OrderRecord): OrderStatusView {
  const isPrint = isPrintFormat(order.bookFormat);
  const payment = order.paymentStatus;
  const fulfillment = order.fulfillmentStatus ?? 'not_started';
  const isFailed = fulfillment === 'failed_manual_review';

  const view: OrderStatusView = {
    headline: '',
    subhead: '',
    tone: 'neutral',
    isPrint,
    isFailed,
    needsAction: false,
    timeline: [],
    supportBlurb: `Questions? Reply to any Hero Story Books email or contact support@herostorybooks.com with order ID ${order.id}.`,
  };

  if (isFailed) {
    view.headline = `We hit a snag on ${order.childName}'s book`;
    view.subhead = 'Our team has been alerted and will reach out personally to fix this.';
    view.tone = 'failure';
    view.timeline = buildFailedTimeline(order);
    return view;
  }

  if (payment !== 'paid') {
    view.headline = `Finishing up ${order.childName}'s order`;
    view.subhead = 'Payment has not posted yet. If you just checked out, this usually updates within a minute.';
    view.tone = 'neutral';
    view.timeline = isPrint ? buildPrintTimeline(order) : buildDigitalTimeline(order);
    return view;
  }

  if (order.trackingNumber || order.trackingUrl || order.shippedAt) {
    view.tracking = {
      ...(order.trackingNumber ? { number: order.trackingNumber } : {}),
      ...(order.trackingUrl ? { url: order.trackingUrl } : {}),
      ...(order.shippedAt ? { shippedAt: order.shippedAt } : {}),
    };
  }

  const enriched = isPrint
    ? enrichPrint(view, order, fulfillment)
    : enrichDigital(view, order, fulfillment);

  // Two conditions, both required. `tone` keeps the note away from views where
  // the customer has the book ('success') or the ball is in their court
  // ('action'); the explicit set above keeps it away from states that are
  // 'neutral' but where the proof already exists — which tone alone cannot
  // distinguish.
  if (enriched.tone === 'neutral' && AWAITING_PROOF_PRODUCTION.has(fulfillment)) {
    enriched.processingNote = `${PROOF_VOLUME_NOTE} ${PROOF_DELAY_SUPPORT_NOTE}`;
  }

  return enriched;
}

function enrichDigital(
  view: OrderStatusView,
  order: OrderRecord,
  fulfillment: string,
): OrderStatusView {
  view.timeline = buildDigitalTimeline(order);

  if (fulfillment === 'complete' && order.storyArtifactUrl) {
    view.headline = `${order.childName}'s storybook is ready`;
    view.subhead = 'Your personalized PDF is waiting — check your email or download it below.';
    view.tone = 'success';
    view.primaryAction = {
      label: `Download ${order.childName}'s Storybook`,
      href: order.storyArtifactUrl,
      kind: 'download',
    };
  } else if (fulfillment === 'building_pdf') {
    view.headline = `Finalizing ${order.childName}'s book`;
    view.subhead = 'Laying out the pages and binding the PDF.';
    view.tone = 'neutral';
  } else if (fulfillment === 'generating_images') {
    view.headline = `Illustrating ${order.childName}'s adventure`;
    view.subhead = 'Painting each page — this is the longest step.';
    view.tone = 'neutral';
  } else if (fulfillment === 'generating_story') {
    view.headline = `Writing ${order.childName}'s story`;
    view.subhead = 'Crafting the personalized narrative. Illustrations come next.';
    view.tone = 'neutral';
  } else {
    view.headline = `${order.childName}'s order is confirmed`;
    view.subhead = 'Payment received. Your storybook is queued for creation.';
    view.tone = 'neutral';
  }

  return view;
}

function enrichPrint(
  view: OrderStatusView,
  order: OrderRecord,
  fulfillment: string,
): OrderStatusView {
  view.timeline = buildPrintTimeline(order);

  if (order.status === 'shipped') {
    view.headline = `${order.childName}'s book has shipped`;
    view.subhead = order.trackingNumber
      ? 'It is on its way — tracking info is below.'
      : 'It is on its way. Use the tracking link for carrier timing.';
    view.tone = 'success';
    if (order.trackingUrl) {
      view.primaryAction = { label: 'Track your shipment', href: order.trackingUrl, kind: 'view' };
    }
  } else if (fulfillment === 'complete' || order.status === 'print_in_production') {
    view.headline = `${order.childName}'s book is in production`;
    view.subhead = 'The print partner is manufacturing your book now. We will email when it ships.';
    view.tone = 'success';
  } else if (fulfillment === 'submitting_to_print') {
    view.headline = `Sending ${order.childName}'s book to print`;
    view.subhead = 'Handing the approved proof to our print partner right now.';
    view.tone = 'neutral';
  } else if (fulfillment === 'proof_approved') {
    view.headline = 'Proof approved — preparing print submission';
    view.subhead = 'Thanks for approving. We are queuing the job with our print partner.';
    view.tone = 'neutral';
  } else if (fulfillment === 'proof_ready' && order.storyArtifactUrl) {
    view.headline = `${order.childName}'s proof is ready for review`;
    view.subhead = 'Review your proof and approve it so we can send it to print.';
    view.tone = 'action';
    view.needsAction = true;
    view.primaryAction = {
      label: 'View Proof',
      href: order.storyArtifactUrl,
      kind: 'view',
    };
  } else if (fulfillment === 'building_pdf') {
    view.headline = `Finalizing ${order.childName}'s proof`;
    view.subhead = 'Binding the proof PDF. You will get an email to approve it soon.';
    view.tone = 'neutral';
  } else if (fulfillment === 'generating_images' || fulfillment === 'generating_story') {
    view.headline = `Creating ${order.childName}'s adventure`;
    view.subhead = 'Writing and illustrating your personalized book. Proof will follow.';
    view.tone = 'neutral';
  } else {
    view.headline = `${order.childName}'s order is confirmed`;
    view.subhead = 'Payment received. Proof creation is queued.';
    view.tone = 'neutral';
  }

  return view;
}

function buildDigitalTimeline(order: OrderRecord): TimelineStep[] {
  const payment = order.paymentStatus;
  const f = order.fulfillmentStatus ?? 'not_started';

  const paymentState: TimelineStepState = payment === 'paid' ? 'done' : payment === 'failed' ? 'failed' : 'active';
  const creatingState: TimelineStepState =
    f === 'complete' ? 'done' :
    f === 'generating_story' || f === 'generating_images' || f === 'building_pdf' ? 'active' :
    payment === 'paid' ? 'active' : 'pending';
  const readyState: TimelineStepState = f === 'complete' ? 'done' : 'pending';

  return [
    step('received', 'Order received', 'We saved your order details.', 'done'),
    step('payment', paymentState === 'failed' ? 'Payment failed' : 'Payment confirmed',
      paymentState === 'done' ? 'Stripe confirmed your payment.' :
      paymentState === 'failed' ? 'Payment did not go through.' :
      'Waiting for Stripe to confirm.', paymentState),
    step('creating', 'Creating your book',
      creatingState === 'done' ? 'Story and illustrations complete.' :
      creatingState === 'active' ? 'Writing the story and illustrating the pages.' :
      'Will start once payment is confirmed.', creatingState),
    step('ready', 'Ready to download',
      readyState === 'done' ? 'Your PDF is ready. Check your email.' :
      'We will email your PDF and surface a download button here.', readyState),
  ];
}

function buildPrintTimeline(order: OrderRecord): TimelineStep[] {
  const payment = order.paymentStatus;
  const f = order.fulfillmentStatus ?? 'not_started';
  const s = order.status;

  const paymentState: TimelineStepState = payment === 'paid' ? 'done' : payment === 'failed' ? 'failed' : 'active';

  const creatingDone = f === 'proof_ready' || f === 'proof_approved' || f === 'submitting_to_print' || f === 'complete';
  const creatingActive = f === 'generating_story' || f === 'generating_images' || f === 'building_pdf';
  const creatingState: TimelineStepState = creatingDone ? 'done' : creatingActive ? 'active' : payment === 'paid' ? 'active' : 'pending';

  const proofDone = f === 'proof_approved' || f === 'submitting_to_print' || f === 'complete';
  const proofState: TimelineStepState = proofDone ? 'done' : f === 'proof_ready' ? 'active' : 'pending';

  const productionDone = s === 'shipped';
  const productionActive = f === 'submitting_to_print' || s === 'print_in_production';
  const productionState: TimelineStepState = productionDone ? 'done' : productionActive ? 'active' : 'pending';

  const shippedState: TimelineStepState = s === 'shipped' ? 'done' : 'pending';

  return [
    step('received', 'Order received', 'We saved your order details.', 'done'),
    step('payment', paymentState === 'failed' ? 'Payment failed' : 'Payment confirmed',
      paymentState === 'done' ? 'Stripe confirmed your payment.' :
      paymentState === 'failed' ? 'Payment did not go through.' :
      'Waiting for Stripe to confirm.', paymentState),
    step('creating', 'Creating your book',
      creatingState === 'done' ? 'Story and illustrations complete.' :
      creatingState === 'active' ? 'Writing the story and illustrating the pages.' :
      'Will start once payment is confirmed.', creatingState),
    step('proof', 'Proof approval',
      proofState === 'done' ? 'Proof approved — moving to print.' :
      proofState === 'active' ? 'Your proof is ready to review and approve.' :
      'We will email a digital proof for you to approve before printing.', proofState),
    step('production', 'In production',
      productionState === 'done' ? 'Printed and packed.' :
      productionState === 'active' ? 'Your book is being printed by our partner.' :
      'Starts once you approve the proof.', productionState),
    step('shipped', 'Shipped',
      shippedState === 'done' ? 'On its way to you.' :
      'Print production starts after proof approval; tracking follows when it ships.', shippedState),
  ];
}

function buildFailedTimeline(order: OrderRecord): TimelineStep[] {
  const base = isPrintFormat(order.bookFormat) ? buildPrintTimeline(order) : buildDigitalTimeline(order);
  return base.map(s =>
    s.state === 'active' ? { ...s, state: 'failed', description: s.description } : s,
  );
}
