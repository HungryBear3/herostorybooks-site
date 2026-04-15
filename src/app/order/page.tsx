"use client";

export default function OrderPage() {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-4xl font-serif text-[var(--forest)] mb-8">Place Your Order</h1>
      {/* Progress Bar */}
      <div className="flex items-center mb-10">
        {['Details', 'Payment', 'Confirm'].map((step, idx) => (
          <div key={idx} className="flex-1 text-center">
            <div
              className={`mx-auto w-8 h-8 rounded-full flex items-center justify-center text-white ${
                idx === 0
                  ? 'bg-[var(--deep-gold)]'
                  : 'bg-gray-300'
              }`}
            >
              {idx + 1}
            </div>
            <p className="mt-2 text-sm text-gray-600">{step}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Form */}
        <form className="flex-1 space-y-6">
          <div>
            <label className="block mb-1 font-semibold">Child's Name</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-md px-4 py-3 text-lg"
              placeholder="e.g., Alice"
            />
          </div>
          <div>
            <label className="block mb-1 font-semibold">Age</label>
            <input
              type="number"
              className="w-full border border-gray-300 rounded-md px-4 py-3 text-lg"
              placeholder="e.g., 5"
            />
          </div>
          <div>
            <label className="block mb-1 font-semibold">Interests</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-md px-4 py-3 text-lg"
              placeholder="e.g., Dragons, space"
            />
          </div>
          <div>
            <label className="block mb-1 font-semibold">Select Plan</label>
            <select className="w-full border border-gray-300 rounded-md px-4 py-3 text-lg">
              <option>Digital - $29</option>
              <option>Printed - $49</option>
              <option>Bundle - $59</option>
            </select>
          </div>
          <div>
            <label className="block mb-1 font-semibold">Email</label>
            <input
              type="email"
              className="w-full border border-gray-300 rounded-md px-4 py-3 text-lg"
              placeholder="you@example.com"
            />
          </div>
          <button
            type="submit"
            className="w-full py-4 bg-[var(--deep-gold)] text-[var(--forest)] font-semibold rounded-md text-lg"
          >
            Continue to Payment
          </button>
        </form>
        {/* Summary Sidebar */}
        <div className="w-full lg:w-1/3 bg-[var(--lavender)] rounded-xl p-6">
          <h2 className="text-2xl font-semibold mb-4">Order Summary</h2>
          <ul className="space-y-2">
            <li className="flex justify-between">
              <span>Digital Plan</span>
              <span>$29</span>
            </li>
            <li className="flex justify-between">
              <span>Printed Plan</span>
              <span>$49</span>
            </li>
          </ul>
          <div className="mt-4 border-t pt-4 flex justify-between font-bold">
            <span>Total</span>
            <span>$78</span>
          </div>
        </div>
      </div>
    </div>
  );
}
