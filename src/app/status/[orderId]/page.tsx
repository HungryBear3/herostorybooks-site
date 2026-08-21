import { notFound } from 'next/navigation';

import { getOrder } from '@/lib/orders';
import { buildOrderStatusView, type TimelineStep, type TimelineStepState } from '@/lib/order-status-view';

export const dynamic = 'force-dynamic';

type StatusPageProps = {
  params: Promise<{ orderId: string }>;
};

export default async function StatusPage({ params }: StatusPageProps) {
  const { orderId } = await params;
  const order = await getOrder(orderId);
  if (!order) notFound();

  const view = buildOrderStatusView(order);

  return (
    <div className="min-h-screen bg-cream px-4 py-12 sm:py-16">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="text-center space-y-2">
          <p className="text-xs uppercase tracking-widest text-gray-500">Order status</p>
          <h1 className="font-serif text-3xl sm:text-4xl font-bold text-forest">
            {view.headline}
          </h1>
          <p className="text-base text-gray-600 max-w-lg mx-auto">{view.subhead}</p>
          {view.processingNote && (
            <p className="text-sm text-gray-500 max-w-lg mx-auto">{view.processingNote}</p>
          )}
          <p className="text-xs text-gray-400 pt-1">Order ID · {order.id}</p>
        </header>

        <StatusHeroCard view={view} order={order} />

        {view.tracking && (
          <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h2 className="font-semibold text-forest mb-3">Shipment tracking</h2>
            <dl className="text-sm space-y-2">
              {view.tracking.number && (
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500">Tracking number</dt>
                  <dd className="font-mono text-xs break-all text-right">{view.tracking.number}</dd>
                </div>
              )}
              {view.tracking.url && (
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500">Carrier link</dt>
                  <dd><a className="underline text-forest" href={view.tracking.url} target="_blank" rel="noopener">Open tracking</a></dd>
                </div>
              )}
              {view.tracking.shippedAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500">Shipped</dt>
                  <dd>{new Date(view.tracking.shippedAt).toISOString().slice(0, 10)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h2 className="font-semibold text-forest mb-5">Your progress</h2>
          <ol className="space-y-5">
            {view.timeline.map((s, i) => (
              <TimelineRow key={s.id} step={s} isLast={i === view.timeline.length - 1} />
            ))}
          </ol>
        </section>

        {view.isFailed && (
          <section className="bg-white rounded-2xl border border-coral/30 shadow-sm p-6">
            <h2 className="font-semibold text-coral-dark mb-2">What happens now</h2>
            <p className="text-sm text-gray-700 mb-3">
              Your order hit a snag we could not fix automatically. Our team was alerted the moment this
              happened and is already looking into it. You do not need to do anything — we will reach out
              personally within one business day.
            </p>
            <p className="text-sm text-gray-700">
              If you would rather contact us first, reply to any Hero Story Books email or write to{' '}
              <a className="underline text-forest" href={`mailto:support@herostorybooks.com?subject=Order ${order.id}`}>
                support@herostorybooks.com
              </a>
              . Include order ID <strong>{order.id}</strong>.
            </p>
          </section>
        )}

        <footer className="text-center text-xs text-gray-500 pt-2">
          <p>{view.supportBlurb}</p>
          <p className="mt-2">
            <a className="underline hover:text-forest" href="/">Return to Hero Story Books</a>
          </p>
        </footer>
      </div>
    </div>
  );
}

function StatusHeroCard({ view, order }: { view: ReturnType<typeof buildOrderStatusView>; order: { id: string; formatLabel: string; deliveryExpectation: string } }) {
  const toneClasses: Record<string, string> = {
    neutral: 'border-gray-200 bg-white',
    success: 'border-forest/30 bg-lavender',
    action: 'border-[#D4AF37] bg-[#FFF8E6]',
    failure: 'border-coral/40 bg-coral/5',
  };

  return (
    <section className={`rounded-2xl border shadow-sm p-6 ${toneClasses[view.tone]}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">Format</p>
          <p className="font-semibold text-forest">{order.formatLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">Delivery</p>
          <p className="text-sm text-gray-700 max-w-xs">{order.deliveryExpectation}</p>
        </div>
      </div>

      {view.primaryAction && (
        <div className="mt-5 flex flex-col sm:flex-row gap-3">
          <a
            href={view.primaryAction.href}
            className="px-5 py-3 rounded-xl font-semibold text-sm text-center"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
            rel="noopener"
          >
            {view.primaryAction.kind === 'download' ? '📖 ' : '👁️ '}
            {view.primaryAction.label}
          </a>
          {view.secondaryAction && (
            <a
              href={view.secondaryAction.href}
              className="px-5 py-3 rounded-xl border-2 border-gray-200 font-semibold text-sm text-center text-forest hover:bg-gray-50 transition"
            >
              {view.secondaryAction.label}
            </a>
          )}
        </div>
      )}

      {view.needsAction && !view.primaryAction && (
        <p className="mt-4 text-sm text-forest font-medium">
          Check your email for the approval link, or reply to us with any changes you want.
        </p>
      )}
    </section>
  );
}

function TimelineRow({ step, isLast }: { step: TimelineStep; isLast: boolean }) {
  const dot = dotStyle(step.state);
  const labelColor =
    step.state === 'done' ? 'text-forest' :
    step.state === 'active' ? 'text-forest' :
    step.state === 'failed' ? 'text-coral-dark' : 'text-gray-400';

  return (
    <li className="relative pl-8">
      <span
        className={`absolute left-0 top-1 w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-bold ${dot.bg} ${dot.border} ${dot.text}`}
        aria-hidden
      >
        {dot.glyph}
      </span>
      {!isLast && <span className="absolute left-[9px] top-6 bottom-[-20px] w-[2px] bg-gray-200" aria-hidden />}
      <p className={`font-semibold text-sm ${labelColor}`}>{step.label}</p>
      <p className="text-xs text-gray-500 mt-0.5">{step.description}</p>
    </li>
  );
}

function dotStyle(state: TimelineStepState) {
  switch (state) {
    case 'done':
      return { bg: 'bg-forest', border: 'border-forest', text: 'text-white', glyph: '✓' };
    case 'active':
      return { bg: 'bg-white', border: 'border-[#D4AF37]', text: 'text-[#B58D1E]', glyph: '●' };
    case 'failed':
      return { bg: 'bg-coral/10', border: 'border-coral', text: 'text-coral-dark', glyph: '!' };
    default:
      return { bg: 'bg-white', border: 'border-gray-200', text: 'text-gray-300', glyph: '' };
  }
}
