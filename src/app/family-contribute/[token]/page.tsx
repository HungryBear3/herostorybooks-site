import { notFound } from 'next/navigation';

import { findOrderByFamilyContributionToken } from '@/lib/orders';

export const dynamic = 'force-dynamic';

type ContributionPageProps = {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ submitted?: string; error?: string }>;
};

const errorCopy: Record<string, string> = {
  empty: 'Add at least one dedication, memory, story idea, voice note, or supporting character photo before submitting.',
  invalid_link: 'That private link is no longer valid. Ask the parent for the latest invite link.',
  voice_type: 'Voice notes must be an audio file.',
  voice_size: 'Voice notes need to be under 15 MB.',
  voice_consent: 'Please confirm you have permission to share the voice note.',
  photo_type: 'Supporting character photos must be image files.',
  photo_size: 'Supporting character photos need to be under 10 MB.',
};

export default async function FamilyContributionPage({ params, searchParams }: ContributionPageProps) {
  const { token } = await params;
  const query = (await searchParams) || {};
  const order = await findOrderByFamilyContributionToken(token);
  if (!order) notFound();

  const childName = order.childName?.trim() || 'this child';
  const submitted = query.submitted === '1';
  const error = query.error ? errorCopy[query.error] : null;

  return (
    <main className="min-h-screen bg-[var(--cream)] px-4 py-10 text-[var(--forest)]">
      <div className="mx-auto max-w-3xl space-y-6">
        <section className="rounded-3xl border border-[#D4AF37]/30 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#B8860B]">
            Private family contribution link
          </p>
          <h1 className="mt-3 text-3xl font-bold sm:text-4xl">
            Help make {childName}&apos;s storybook feel like home
          </h1>
          <p className="mt-3 text-base leading-7 text-gray-600">
            Share a dedication, favorite memory, voice note, story idea, or a supporting character photo.
            We use this only as private inspiration for this book.
          </p>
        </section>

        {submitted ? (
          <section className="rounded-3xl border border-green-200 bg-green-50 p-6 text-green-900 shadow-sm">
            <h2 className="text-2xl font-bold">Thank you — we saved it.</h2>
            <p className="mt-2 text-sm leading-6">
              Your contribution was added to {childName}&apos;s private order notes for the story team.
            </p>
            <a
              href="/checkout"
              className="mt-5 inline-flex rounded-xl px-5 py-3 text-sm font-bold"
              style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
            >
              Want one for another child?
            </a>
          </section>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-900">
            {error}
          </div>
        ) : null}

        <form
          action={`/api/family-contributions/${encodeURIComponent(token)}`}
          method="post"
          encType="multipart/form-data"
          className="space-y-5 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold">
              Your name
              <input
                name="contributorName"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
                placeholder="Grandma Sue"
              />
            </label>
            <label className="space-y-2 text-sm font-semibold">
              Relationship
              <input
                name="relationship"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
                placeholder="grandma, uncle, family friend"
              />
            </label>
          </div>

          <label className="block space-y-2 text-sm font-semibold">
            Dedication
            <textarea
              name="dedication"
              rows={3}
              className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
              placeholder="A short message we can weave into the keepsake."
            />
          </label>

          <label className="block space-y-2 text-sm font-semibold">
            Favorite memory
            <textarea
              name="memory"
              rows={4}
              className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
              placeholder="A tiny real detail: nickname, funny habit, favorite trip, bedtime phrase..."
            />
          </label>

          <label className="block space-y-2 text-sm font-semibold">
            Story idea
            <textarea
              name="storyIdea"
              rows={3}
              className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
              placeholder="Maybe the adventure includes a moon parade, a brave rescue, or a family tradition."
            />
          </label>

          <fieldset className="space-y-4 rounded-2xl border border-gray-200 p-4">
            <legend className="px-2 text-sm font-bold">Optional supporting character</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-semibold">
                Name
                <input
                  name="supportingCharacterName"
                  className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
                  placeholder="Buddy"
                />
              </label>
              <label className="space-y-2 text-sm font-semibold">
                Relationship
                <input
                  name="supportingCharacterRelationship"
                  className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
                  placeholder="family dog, big sister, cousin"
                />
              </label>
            </div>
            <label className="block space-y-2 text-sm font-semibold">
              Notes
              <textarea
                name="supportingCharacterNotes"
                rows={3}
                className="w-full rounded-xl border border-gray-200 px-4 py-3 font-normal text-gray-900"
                placeholder="Looks, personality, favorite thing to do with the child."
              />
            </label>
            <label className="block space-y-2 text-sm font-semibold">
              Supporting character photo
              <input name="supportingCharacterPhoto" type="file" accept="image/*" className="block w-full text-sm" />
            </label>
          </fieldset>

          <fieldset className="space-y-3 rounded-2xl border border-gray-200 p-4">
            <legend className="px-2 text-sm font-bold">Optional voice note</legend>
            <input name="voiceNote" type="file" accept="audio/*" className="block w-full text-sm" />
            <label className="flex items-start gap-3 text-sm text-gray-600">
              <input name="voiceConsent" type="checkbox" className="mt-1" />
              <span>
                I have permission to share this voice note. It is used for story inspiration only — never for voice cloning.
              </span>
            </label>
          </fieldset>

          <button
            type="submit"
            className="w-full rounded-xl px-6 py-4 text-base font-bold shadow-sm sm:w-auto"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
          >
            Add my contribution
          </button>
        </form>
      </div>
    </main>
  );
}
