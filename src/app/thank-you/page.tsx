export default function ThankYouPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-cream px-4 py-16 space-y-8">
      <div className="text-center">
        <span className="text-7xl">✨</span>
        <h1 className="font-serif text-4xl font-bold text-forest mt-4 mb-2">
          Your Storybook Is Being Created!
        </h1>
        <p className="text-lg text-gray-600 max-w-md mx-auto">
          Our AI is weaving your child into their very own adventure right now.
        </p>
      </div>

      {/* Delivery expectations */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-4">
        <p className="font-semibold text-forest text-base">What happens next</p>
        <div className="space-y-3 text-sm text-gray-700">
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">📱</span>
            <div>
              <p className="font-semibold text-forest">Digital PDF — ~15 minutes</p>
              <p className="text-gray-500">Sent to your email as soon as it&apos;s ready. Check your spam if you don&apos;t see it.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">📦</span>
            <div>
              <p className="font-semibold text-forest">Printed book — 5–7 business days</p>
              <p className="text-gray-500">If you ordered a printed copy, your digital PDF arrives first so you can preview it before it ships.</p>
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
          className="px-6 py-3 rounded-xl border-2 border-gray-200 font-semibold text-sm text-center text-forest hover:bg-gray-50 transition"
        >
          Back to Home
        </a>
      </div>
    </div>
  );
}
