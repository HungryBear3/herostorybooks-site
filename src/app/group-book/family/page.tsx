import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { Wordmark } from '@/components/family-review/atoms';
import { GROUP_BOOK_ACCESS_COOKIE } from '@/lib/group-book/session';
import { groupBookPhotoAvailability } from '@/lib/group-book/retention';
import { loadOwnFamilySubmission } from '@/lib/group-book/store';
import WithdrawButton from './withdraw-button';

export const dynamic = 'force-dynamic';

export default async function GroupBookFamilyPage() {
  const token = (await cookies()).get(GROUP_BOOK_ACCESS_COOKIE)?.value ?? '';
  // Only an active (unexpired, unrevoked) capability reads, and only its own
  // family. Withdrawn (OMIT) families keep reading their retained submission.
  let own: Awaited<ReturnType<typeof loadOwnFamilySubmission>> | null = null;
  try {
    own = await loadOwnFamilySubmission(token);
  } catch {
    own = null;
  }
  if (own === null) {
    return (
      <main className="fr-container">
        <section className="stack-12" style={{ paddingTop: 32 }}>
          <h1 className="fr-h1 serif">Private storage could not be checked</h1>
          <p className="body">Your submission status could not be read right now. Please reload this page later.</p>
        </section>
      </main>
    );
  }
  if (own.state !== 'found') redirect('/group-book');
  const submission = own.submission;
  const stampedPolicy = submission.consent.version === 'group-book-v2' ? submission.consent.policy.version : null;
  const photos = await groupBookPhotoAvailability(submission.cohort.id, Date.now());
  const photoLine = photos.state === 'expired'
    ? 'No longer available: source photos are deleted 90 days after final delivery'
    : photos.state === 'retained'
      ? `${submission.photos.length} kept until ${photos.dueAt.slice(0, 10)}`
      : photos.state === 'unknown'
        ? 'Status could not be checked'
        : `${submission.photos.length} kept privately`;
  const omitted = submission.effectiveOmitFromProofAndPrint;
  const withdrawn = submission.effectiveStatus === 'withdrawal_requested';
  const unverified = submission.effectiveStatus === 'withdrawal_unverified';

  return (
    <>
      <header className="topbar"><Wordmark size={14} /><span className="meta">private family access</span></header>
      <main className="fr-container">
        <section className="stack-20" style={{ paddingTop: 32, paddingBottom: 48 }}>
          <div className="stack-6">
            <div className="eyebrow forest">Your family&apos;s submission only</div>
            <h1 className="fr-h1 serif">{withdrawn ? 'Withdrawal recorded' : 'Group-book intake received'}</h1>
            <p className="body">No room parent or participating family can open this submission.</p>
          </div>
          <div className="card card-warm stack-8" style={{ padding: 18 }}>
            <div className="fr-row-between"><span className="meta">Cohort</span><strong>{submission.cohort.label}</strong></div>
            <div className="fr-row-between"><span className="meta">Child</span><strong>{submission.child.firstName}</strong></div>
            <div className="fr-row-between"><span className="meta">Age range</span><span>{submission.child.ageRange}</span></div>
            <div className="fr-row-between"><span className="meta">Private source photos</span><span>{photoLine}</span></div>
            <div className="fr-row-between"><span className="meta">Shared-book consent</span><span>{stampedPolicy === null ? 'Recorded' : `Recorded (terms version ${stampedPolicy})`}</span></div>
            <div className="fr-row-between"><span className="meta">Book status</span><strong>{omitted ? 'OMIT' : 'Received; no book has been made'}</strong></div>
          </div>
          {unverified && (
            <p className="help" style={{ color: 'var(--err)' }}>Your withdrawal status could not be verified right now, so this child is treated as omitted. Please check again later.</p>
          )}
          <div className="card card-quiet" style={{ padding: 16 }}>
            <p className="help">Who receives a finished book is set by the group-book terms you agreed to. This page and your source photos are not shared with other families. Withdrawal marks your child to be left out; it does not delete your saved details or photos. Viewing this page requires a valid, unexpired family invite; kept storage is not unconditional access, and an expired or revoked invite must be reissued by the operator.</p>
          </div>
          <WithdrawButton alreadyWithdrawn={withdrawn} />
          <p className="help" style={{ textAlign: 'center' }}>This page does not create a payment, send email, generate art, approve a proof, print, or distribute a book.</p>
        </section>
      </main>
    </>
  );
}
