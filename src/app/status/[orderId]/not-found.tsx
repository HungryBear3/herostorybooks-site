export default function OrderStatusNotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-cream px-4 py-16 text-center">
      <span className="text-6xl mb-4">🔍</span>
      <h1 className="font-serif text-3xl font-bold text-forest mb-2">We could not find that order</h1>
      <p className="text-gray-600 max-w-md mb-6">
        Double-check the order ID in your confirmation email. If it still does not work, reach out to{' '}
        <a className="underline" href="mailto:hello@herostorybooks.com">hello@herostorybooks.com</a> and we will track it down.
      </p>
      <a href="/" className="px-6 py-3 rounded-xl font-semibold text-sm" style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}>
        Back to Home
      </a>
    </div>
  );
}
