import Image from 'next/image';

export default function HomePage() {
  return (
    <main className="flex flex-col items-center space-y-16 px-4 py-8">
      {/* Hero Section */}
      <section className="w-full bg-purple text-white py-20 text-center">
        <h1 className="text-4xl font-bold mb-4">Bring Your Child's Imagination to Life</h1>
        <p className="text-lg">Create personalized story books where your child becomes the hero.</p>
      </section>

      {/* How It Works */}
      <section className="max-w-3xl text-center space-y-4">
        <h2 className="text-3xl font-semibold">How It Works</h2>
        <div className="space-y-2">
          <p>1. Enter your child's details and preferences.</p>
          <p>2. Customize the adventure story.</p>
          <p>3. Upload a photo to feature as the hero.</p>
          <p>4. Receive a magical story book in the mail.</p>
        </div>
      </section>

      {/* Sample Gallery */}
      <section className="max-w-4xl w-full grid grid-cols-1 sm:grid-cols-2 gap-4">
        <h2 className="col-span-full text-3xl font-semibold text-center">Sample Stories</h2>
        <Image src="/sample1.png" alt="Sample Story 1" width={400} height={300} className="rounded-lg" />
        <Image src="/sample2.png" alt="Sample Story 2" width={400} height={300} className="rounded-lg" />
      </section>

      {/* Pricing Tiers */}
      <section className="max-w-4xl w-full text-center space-y-8">
        <h2 className="text-3xl font-semibold">Pricing</h2>
        <div className="flex flex-col sm:flex-row justify-center gap-4">
          <div className="border p-6 rounded-lg bg-white flex-1">
            <h3 className="text-xl font-bold">Basic</h3>
            <p className="text-4xl font-bold">$19.99</p>
            <p>Standard storybook with personalized cover.</p>
            <button className="mt-4 px-4 py-2 bg-peach text-white rounded-lg">Coming Soon</button>
          </div>
          <div className="border p-6 rounded-lg bg-white flex-1">
            <h3 className="text-xl font-bold">Deluxe</h3>
            <p className="text-4xl font-bold">$29.99</p>
            <p>Includes custom illustrations inside.</p>
            <button className="mt-4 px-4 py-2 bg-peach text-white rounded-lg">Coming Soon</button>
          </div>
        </div>
      </section>

      {/* FAQ Accordion */}
      <section className="max-w-3xl w-full space-y-4">
        <h2 className="text-3xl font-semibold text-center">FAQ</h2>
        <div className="space-y-2">
          {['How long does shipping take?', 'Can I preview the story?', 'What age is suitable?'].map((q, i) => (
            <details key={i} className="border rounded-lg p-4 bg-white">
              <summary className="font-medium cursor-pointer">{q}</summary>
              <p className="mt-2">Answer to "{q}" goes here.</p>
            </details>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full text-center py-4 text-sm text-gray-600">
        © {new Date().getFullYear()} Hero Story Books. All rights reserved.
      </footer>
    </main>
  );
}
