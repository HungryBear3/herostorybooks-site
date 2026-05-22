'use client';

import { useState } from 'react';

import { Wordmark } from '@/components/family-review/atoms';

/**
 * Minimal reviewer login. POSTs the key to /api/family-review/admin/login
 * which sets the HttpOnly cookie on success and redirects back here.
 *
 * The key is never written to localStorage, sessionStorage, the URL, or
 * any analytics surface. The form uses type="password" so it doesn't
 * land in browser autocomplete history.
 */
export default function AdminLogin() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError('Enter the reviewer key.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/family-review/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
        // Cookie path is "/", so credentials: 'same-origin' (default) is fine.
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setError("That key isn't valid.");
        setBusy(false);
        return;
      }
      // Drop the key out of React state immediately on success so it
      // never sits in memory longer than the request.
      setKey('');
      // Full reload so the server page re-evaluates the cookie gate
      // and renders the board with no stale client state.
      window.location.assign('/family-review/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network_error');
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <Wordmark size={14} />
        <span className="meta">internal review</span>
      </header>
      <main
        className="fr-container"
        style={{ paddingTop: 64, maxWidth: 380 }}
      >
        <div className="stack-16" style={{ textAlign: 'center' }}>
          <div className="eyebrow ochre">Reviewer sign-in</div>
          <h1 className="fr-h1 serif">Internal review</h1>
          <p className="body">
            Enter the reviewer key. The key is set in an HttpOnly cookie
            for this device and never appears in the URL.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="card card-warm"
          style={{ padding: 18, marginTop: 18 }}
          autoComplete="off"
        >
          <div className="field">
            <label className="field-label" htmlFor="fr-admin-key">
              Reviewer key
            </label>
            <input
              id="fr-admin-key"
              type="password"
              className="input"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                if (error) setError(null);
              }}
              disabled={busy}
            />
            {error && (
              <span className="help" style={{ color: 'var(--err)' }}>
                {error}
              </span>
            )}
          </div>
          <button
            type="submit"
            className="btn btn-forest btn-block btn-lg"
            disabled={busy}
            style={{ marginTop: 14 }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </main>
    </>
  );
}
