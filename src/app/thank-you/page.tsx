export default function ThankYouPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 space-y-6">
      <div className="text-center">
        <span className="text-6xl">✨</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-2">
          Your Storybook Is Being Created!
        </h1>
        <p className="text-lg mt-2">
          Check your email in ~15 minutes for your personalized PDF
        </p>
      </div>
      <div className="bg-[var(--forest)] text-[var(--cream)] p-6 rounded-lg w-full max-w-md text-center">
        Order information will appear here.
      </div>
      <div className="flex space-x-4">
        <a
          href="mailto:?subject=I%20just%20ordered%20a%20HeroStoryBook&body=Check%20out%20HeroStoryBooks!"
          className="px-4 py-2 bg-[var(--gold)] text-[var(--forest)] rounded-lg"
        >
          Share with a Friend
        </a>
        <a href="/" className="underline text-[var(--forest)]">
          Back to Home
        </a>
      </div>
    </div>
  );
}
