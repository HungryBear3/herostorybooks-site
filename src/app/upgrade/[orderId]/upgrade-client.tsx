'use client';

import { useEffect, useState } from 'react';

type Format = 'classic' | 'premium';

interface OfferView {
  status: 'offered' | 'checkout_open';
  bookTitle: string;
  pageCount: number;
  purchaseKind: 'upgrade' | 'extra_copy';
  approvedProofVersion: string | null;
  expiresAt: string;
  formats: Array<{ targetFormat: Format; label: string; pageCount: number }>;
  openCheckout?: { targetFormat: Format; totalCents: number; url: string | null; expiresAt: string } | null;
}

interface QuoteView {
  quoteId: string;
  targetFormat: Format;
  label: string;
  pageCount: number;
  quantity: number;
  printCents: number;
  shippingCents: number;
  fulfillmentCents: number;
  taxCents: number;
  totalCents: number;
  estimatedDeliveryStart: string | null;
  estimatedDeliveryEnd: string | null;
  expiresAt: string;
}

interface AddressForm {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

const EMPTY_ADDRESS: AddressForm = { name: '', line1: '', line2: '', city: '', state: '', zip: '' };
const NEUTRAL_DENIAL = 'This link is not valid any more. If you still want a printed copy, reply to our email and we will send a fresh link.';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : iso;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let parsed: T;
  try {
    parsed = (await res.json()) as T;
  } catch {
    parsed = {} as T;
  }
  return { status: res.status, body: parsed };
}

export default function UpgradeClient({ orderId }: { orderId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferView | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [address, setAddress] = useState<AddressForm>(EMPTY_ADDRESS);
  const [quantity, setQuantity] = useState(1);
  const [quotes, setQuotes] = useState<QuoteView[] | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [openingQuoteId, setOpeningQuoteId] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const presented = fragment.get('token');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    if (!presented) {
      setDenied(NEUTRAL_DENIAL);
      return;
    }
    setToken(presented);
    void postJson<OfferView | { error: string }>(`/api/order/${orderId}/print-upgrade/offer`, { token: presented })
      .then(({ status, body }) => {
        if (status !== 200 || !('formats' in body)) {
          setDenied(NEUTRAL_DENIAL);
          return;
        }
        setOffer(body);
      })
      .catch(() => setDenied('We could not load this page. Please try again in a moment.'));
  }, [orderId]);

  async function requestQuote(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setQuoting(true);
    setQuoteError(null);
    setCheckoutError(null);
    setQuotes(null);
    try {
      const { status, body } = await postJson<{ quotes?: QuoteView[]; error?: string }>(
        `/api/order/${orderId}/print-upgrade/quote`,
        { token, quantity, shippingAddress: { ...address, country: 'US' } },
      );
      if (status === 200 && body.quotes) {
        setQuotes(body.quotes);
      } else if (status === 400) {
        setQuoteError('Please check the address. We can only ship within the United States right now.');
      } else if (status === 503) {
        setQuoteError('Our print provider could not give us a live price just now, so we cannot take a payment yet. Please try again in a few minutes.');
      } else {
        setDenied(NEUTRAL_DENIAL);
      }
    } catch {
      setQuoteError('We could not reach our server. Please try again.');
    } finally {
      setQuoting(false);
    }
  }

  async function openCheckout(quote: QuoteView) {
    if (!token || openingQuoteId) return;
    setOpeningQuoteId(quote.quoteId);
    setCheckoutError(null);
    try {
      const { status, body } = await postJson<{ url?: string; error?: string; open?: { targetFormat: Format; url: string | null } }>(
        `/api/order/${orderId}/print-upgrade/checkout`,
        { token, quoteId: quote.quoteId },
      );
      if (status === 200 && body.url) {
        window.location.assign(body.url);
        return;
      }
      if (status === 409 && body.error === 'checkout_already_open' && body.open?.url) {
        setCheckoutError(`You already have an open payment page for the ${body.open.targetFormat === 'premium' ? 'hardcover' : 'softcover'}. Finish or let it expire (about an hour) before choosing a different format.`);
        window.location.assign(body.open.url);
        return;
      }
      if (status === 409 && (body.error === 'quote_expired' || body.error === 'quote_not_found')) {
        setQuotes(null);
        setQuoteError('That price has expired. Please confirm your address again for a fresh live price.');
        return;
      }
      if (status === 409 && body.error === 'checkout_busy') {
        setCheckoutError('An earlier attempt to open a payment page for the other format is still being confirmed with Stripe. Choose that format again to continue, or wait up to an hour before switching. Nothing has been charged.');
        return;
      }
      if (status === 503) {
        setCheckoutError('We could not open the payment page just now. Nothing was charged. Please try again in a moment.');
        return;
      }
      setDenied(NEUTRAL_DENIAL);
    } catch {
      setCheckoutError('We could not reach our server. Nothing was charged.');
    } finally {
      setOpeningQuoteId(null);
    }
  }

  return (
    <main className="min-h-screen bg-cream px-4 py-12 sm:py-16">
      <div className="max-w-2xl mx-auto space-y-8">
        <header className="text-center space-y-3">
          <p className="text-xs uppercase tracking-widest text-gray-500">{offer?.purchaseKind === 'extra_copy' ? 'Extra copies at our cost' : 'Printed copy at our cost'}</p>
          <h1 className="font-serif text-3xl sm:text-4xl font-bold text-forest">
            {offer ? offer.bookTitle : 'Your printed keepsake'}
          </h1>
          <p className="text-base text-gray-600 max-w-lg mx-auto">
            Choose a softcover or hardcover and pay exactly what our print provider charges us: print, shipping and handling, their fulfillment fee, and any tax they charge. No markup. Prices are quoted live for your address.
          </p>
        </header>

        {denied && (
          <section role="alert" className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-gray-700">
            {denied}
          </section>
        )}

        {!denied && !offer && (
          <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-gray-600">Loading your private page…</section>
        )}

        {offer && (
          <>
            <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-2 text-sm text-gray-700">
              <p>
                <strong>Your approved book:</strong> {offer.pageCount} pages. The softcover is printed as {offer.formats.find((f) => f.targetFormat === 'classic')?.pageCount} interior pages and the hardcover as {offer.formats.find((f) => f.targetFormat === 'premium')?.pageCount}, because of the provider&apos;s minimum page counts; extra pages are blank end pages.
              </p>
              <p>This private link expires on {longDate(offer.expiresAt)}.</p>
              {offer.approvedProofVersion && <p>Approved proof version: {offer.approvedProofVersion}</p>}
              {offer.openCheckout?.url && (
                <p className="text-forest">
                  You already have an open payment page for the {offer.openCheckout.targetFormat === 'premium' ? 'hardcover' : 'softcover'} ({dollars(offer.openCheckout.totalCents)}).{' '}
                  <a className="underline" href={offer.openCheckout.url}>Return to it</a> or wait for it to expire before choosing again.
                </p>
              )}
            </section>

            <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
              <h2 className="font-semibold text-forest mb-1">1. Where should we ship it?</h2>
              <p className="text-sm text-gray-500 mb-4">We need the full address to get an exact shipping and tax price from the provider. It is sent privately and used only for this book.</p>
              <form onSubmit={requestQuote} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="sm:col-span-2 text-sm">
                  <span className="block text-gray-600 mb-1">Number of copies for this destination (1–10)</span>
                  <input required type="number" min={1} max={10} step={1} className="w-full rounded-lg border border-gray-300 px-3 py-2" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
                </label>
                <label className="sm:col-span-2 text-sm">
                  <span className="block text-gray-600 mb-1">Recipient name</span>
                  <input required maxLength={35} className="w-full rounded-lg border border-gray-300 px-3 py-2" value={address.name} onChange={(e) => setAddress({ ...address, name: e.target.value })} autoComplete="name" />
                </label>
                <label className="sm:col-span-2 text-sm">
                  <span className="block text-gray-600 mb-1">Street address</span>
                  <input required maxLength={30} className="w-full rounded-lg border border-gray-300 px-3 py-2" value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} autoComplete="address-line1" />
                </label>
                <label className="sm:col-span-2 text-sm">
                  <span className="block text-gray-600 mb-1">Apartment, unit (optional)</span>
                  <input maxLength={30} className="w-full rounded-lg border border-gray-300 px-3 py-2" value={address.line2} onChange={(e) => setAddress({ ...address, line2: e.target.value })} autoComplete="address-line2" />
                </label>
                <label className="text-sm">
                  <span className="block text-gray-600 mb-1">City</span>
                  <input required maxLength={30} className="w-full rounded-lg border border-gray-300 px-3 py-2" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} autoComplete="address-level2" />
                </label>
                <label className="text-sm">
                  <span className="block text-gray-600 mb-1">State (2 letters)</span>
                  <input required maxLength={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 uppercase" value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value.toUpperCase() })} autoComplete="address-level1" />
                </label>
                <label className="text-sm">
                  <span className="block text-gray-600 mb-1">ZIP code</span>
                  <input required inputMode="numeric" maxLength={10} className="w-full rounded-lg border border-gray-300 px-3 py-2" value={address.zip} onChange={(e) => setAddress({ ...address, zip: e.target.value })} autoComplete="postal-code" />
                </label>
                <div className="text-sm flex items-end">
                  <button type="submit" disabled={quoting} className="w-full px-5 py-2.5 rounded-xl font-semibold" style={{ backgroundColor: '#D4AF37', color: '#1F3A5F', opacity: quoting ? 0.6 : 1 }}>
                    {quoting ? 'Getting live prices…' : 'Get live prices'}
                  </button>
                </div>
              </form>
              {quoteError && <p role="alert" className="mt-3 text-sm text-red-700">{quoteError}</p>}
            </section>

            {quotes && (
              <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                <h2 className="font-semibold text-forest mb-1">2. Choose your format</h2>
                <p className="text-sm text-gray-500 mb-4">Live provider prices for your address, valid until {new Date(quotes[0].expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. The price is locked when you continue to payment.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {quotes.map((quote) => (
                    <div key={quote.quoteId} className="rounded-xl border border-gray-200 p-4 flex flex-col">
                      <h3 className="font-serif text-xl text-forest">{quote.label}</h3>
                      <p className="text-xs text-gray-500 mb-3">{quote.quantity} {quote.quantity === 1 ? 'copy' : 'copies'} · {quote.pageCount} interior pages each</p>
                      <dl className="text-sm space-y-1 flex-1">
                        <div className="flex justify-between"><dt className="text-gray-600">Print (provider cost)</dt><dd>{dollars(quote.printCents)}</dd></div>
                        <div className="flex justify-between"><dt className="text-gray-600">Shipping and handling</dt><dd>{dollars(quote.shippingCents)}</dd></div>
                        {quote.fulfillmentCents > 0 && <div className="flex justify-between"><dt className="text-gray-600">Provider fulfillment fee</dt><dd>{dollars(quote.fulfillmentCents)}</dd></div>}
                        <div className="flex justify-between"><dt className="text-gray-600">Tax (provider)</dt><dd>{dollars(quote.taxCents)}</dd></div>
                        <div className="flex justify-between font-semibold border-t border-gray-200 pt-2 mt-2"><dt>Total — at cost</dt><dd>{dollars(quote.totalCents)}</dd></div>
                      </dl>
                      {quote.estimatedDeliveryStart && quote.estimatedDeliveryEnd ? (
                        <p className="mt-3 text-sm text-gray-600">Estimated delivery: {longDate(quote.estimatedDeliveryStart)}–{longDate(quote.estimatedDeliveryEnd)} if the final print proof is approved promptly. A later approval moves this window.</p>
                      ) : (
                        <p className="mt-3 text-sm text-amber-700">Delivery estimate is unavailable; payment is paused until we verify it.</p>
                      )}
                      <button type="button" disabled={openingQuoteId !== null || !quote.estimatedDeliveryStart || !quote.estimatedDeliveryEnd} onClick={() => openCheckout(quote)} className="mt-4 px-5 py-2.5 rounded-xl font-semibold" style={{ backgroundColor: '#1F3A5F', color: '#fff', opacity: openingQuoteId || !quote.estimatedDeliveryStart ? 0.6 : 1 }}>
                        {openingQuoteId === quote.quoteId ? 'Opening secure payment…' : `Continue to payment · ${dollars(quote.totalCents)}`}
                      </button>
                    </div>
                  ))}
                </div>
                {checkoutError && <p role="alert" className="mt-3 text-sm text-red-700">{checkoutError}</p>}
              </section>
            )}

            <section className="text-sm text-gray-600 space-y-2">
              <p><strong>What happens after you pay:</strong> we prepare the print files for the format you choose and check them by hand. Nothing is printed automatically. We email you a final print proof to confirm, then confirm again before it goes to print and when it ships.</p>
              <p>Your digital book stays yours either way. Payment is handled by Stripe on a secure page.</p>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
