import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { Wordmark } from '@/components/family-review/atoms';
import { resolveGroupBookInvite } from '@/lib/group-book/config';
import { GROUP_BOOK_ACCESS_COOKIE } from '@/lib/group-book/session';
import { loadEffectiveGroupBookSubmission } from '@/lib/group-book/store';
import WithdrawButton from './withdraw-button';

export const dynamic = 'force-dynamic';

export default async function GroupBookFamilyPage() {
  const token = (await cookies()).get(GROUP_BOOK_ACCESS_COOKIE)?.value ?? '';
  const invite = resolveGroupBookInvite(token);
  if (!invite) redirect('/group-book');
  const submission = await loadEffectiveGroupBookSubmission(invite);
  if (!submission) redirect('/group-book');
  const withdrawn = submission.effectiveOmitFromProofAndPrint;

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
            <div className="fr-row-between"><span className="meta">Private photos received</span><span>{submission.photos.length}</span></div>
            <div className="fr-row-between"><span className="meta">Shared-book consent</span><span>Recorded</span></div>
            <div className="fr-row-between"><span className="meta">Proof/print status</span><strong>{withdrawn ? 'OMIT' : 'Eligible pending separate approval'}</strong></div>
          </div>
          <div className="card card-quiet" style={{ padding: 16 }}>
            <p className="help">Participating families may receive the final private group book containing approved children&apos;s first names and illustrated likenesses. They do not receive source photos, parent contact details, or access to this page.</p>
          </div>
          <WithdrawButton alreadyWithdrawn={withdrawn} />
          <p className="help" style={{ textAlign: 'center' }}>This page does not create a payment, send email, generate art, approve a proof, print, or distribute a book.</p>
        </section>
      </main>
    </>
  );
}
