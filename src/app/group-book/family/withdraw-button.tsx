'use client';

import { useState } from 'react';

export default function WithdrawButton({ alreadyWithdrawn }: { alreadyWithdrawn: boolean }) {
  const [withdrawn, setWithdrawn] = useState(alreadyWithdrawn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    if (withdrawn || busy) return;
    if (!window.confirm('Withdraw your child and mark them to be left out of the group book?')) return;
    setBusy(true);
    setError(null);
    // Must stay under /group-book: the access cookie is scoped to that path.
    try {
      const response = await fetch('/group-book/family/withdraw', { method: 'POST' });
      const body = await response.json() as { omitFromProofAndPrint?: boolean; error?: string };
      if (response.ok && body?.omitFromProofAndPrint) {
        setWithdrawn(true);
        return;
      }
      if (response.status === 409 && body?.error === 'edition_already_released') {
        setError('The book has already been released to its recipients, so withdrawal can no longer remove your child from it. Released copies are not recalled.');
        return;
      }
      setError('We could not confirm whether your withdrawal was recorded. Reload this page to check its status before trying again.');
    } catch {
      // The marker may already be written; never automatically retry the POST.
      setError('We could not confirm whether your withdrawal was recorded because the connection or response was interrupted. Reload this page to check its status before trying again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-12">
      {withdrawn ? (
        <div className="card card-warm" style={{ padding: 16 }}>
          <strong>Withdrawal recorded.</strong>
          <p className="help">This child is marked to be left out of the group book. Saved details and photos are kept; photos are kept only until the normal deletion 90 days after the book’s final delivery. Viewing them here requires a valid family invite.</p>
        </div>
      ) : (
        <button className="btn btn-ghost btn-block" type="button" onClick={withdraw} disabled={busy}>
          {busy ? 'Recording withdrawal…' : 'Withdraw my child from the group book'}
        </button>
      )}
      {error && <p className="help" role="alert" style={{ color: 'var(--err)' }}>{error}</p>}
    </div>
  );
}
