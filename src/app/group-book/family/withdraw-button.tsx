'use client';

import { useState } from 'react';

export default function WithdrawButton({ alreadyWithdrawn }: { alreadyWithdrawn: boolean }) {
  const [withdrawn, setWithdrawn] = useState(alreadyWithdrawn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    if (withdrawn || busy) return;
    if (!window.confirm('Withdraw your child and mark them for omission from proof and print?')) return;
    setBusy(true);
    setError(null);
    // Must stay under /group-book: the access cookie is scoped to that path.
    let response: Response;
    try {
      response = await fetch('/group-book/family/withdraw', { method: 'POST' });
    } catch {
      // The marker may already be written. Do not claim failure and do not
      // retry the POST: the server-rendered family page is the authoritative status.
      setBusy(false);
      setError('We could not confirm whether your withdrawal was recorded because the connection was interrupted. Reload this page to check its status before trying again.');
      return;
    }
    const body = await response.json().catch(() => ({})) as { omitFromProofAndPrint?: boolean };
    setBusy(false);
    if (response.ok && body.omitFromProofAndPrint) {
      setWithdrawn(true);
      return;
    }
    setError('The withdrawal request was not saved. Please try again.');
  }

  return (
    <div className="stack-12">
      {withdrawn ? (
        <div className="card card-warm" style={{ padding: 16 }}>
          <strong>Withdrawal recorded.</strong>
          <p className="help">This child is marked for omission from proof and print.</p>
        </div>
      ) : (
        <button className="btn btn-ghost btn-block" type="button" onClick={withdraw} disabled={busy}>
          {busy ? 'Recording withdrawal…' : 'Withdraw my child before proof or print'}
        </button>
      )}
      {error && <p className="help" role="alert" style={{ color: 'var(--err)' }}>{error}</p>}
    </div>
  );
}
