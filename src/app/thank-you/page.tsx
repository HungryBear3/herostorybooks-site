type ThankYouPageProps = {
  searchParams?: Promise<{
    orderId?: string;
    childName?: string;
    format?: string;
    email?: string;
  }>;
};

export default async function ThankYouPage({ searchParams }: ThankYouPageProps) {
  const params = (await searchParams) || {};
  const childName = params.childName?.trim() || 'Your child';
  const format = params.format?.trim() || 'storybook';
  const email = params.email?.trim();
  const orderId = params.orderId?.trim();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-16 space-y-8">
      <div className="text-center">
        <span className="text-7xl">✨</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
          {childName}&apos;s Storybook Is In Motion!
        </h1>
        <p className="text-lg text-gray-600 max-w-md mx-auto">
          We saved your {format} order and kicked off the first delivery step.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-4">
        <p className="font-semibold text-[var(--forest)] text-base">What happens next</p>
        <div className="space-y-3 text-sm text-gray-700">
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">✅</span>
            <div>
              <p className="font-semibold text-[var(--forest)]">Order received</p>
              <p className="text-gray-500">We saved your order details{orderId ? ` under ${orderId}` : ''} so the team can track it cleanly.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">📱</span>
            <div>
              <p className="font-semibold text-[var(--forest)]">Confirmation + digital-first delivery</p>
              <p className="text-gray-500">
                {email ? `A confirmation was sent to ${email}. ` : ''}
                Digital PDFs arrive in about 15 minutes, and print orders get a digital preview first before they go to print.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">📦</span>
            <div>
              <p className="font-semibold text-[var(--forest)]">Print timeline</p>
              <p className="text-gray-500">If you chose a printed book, production and shipping follow after preview approval. Typical ship window is 5–7 business days.</p>
            </div>
          </div>
        </div>
        <p className="text-xs text-center text-gray-400 pt-2 border-t border-gray-100">
          7-day satisfaction guarantee · Questions? hello@herostorybooks.com
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <a
          href="mailto:?subject=I%20just%20ordered%20a%20HeroStoryBook!&body=Check%20out%20HeroStoryBooks%20—%20personalized%20storybooks%20where%20your%20child%20is%20the%20hero%3A%20https%3A%2F%2Fherostorybooks.com"
          className="px-6 py-3 rounded-xl font-semibold text-sm text-center"
          style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
        >
          Share with a Friend
        </a>
        <a
          href="/"
          className="px-6 py-3 rounded-xl border-2 border-gray-200 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
        >
          Back to Home
        </a>
      </div>
    </div>
  );
}
