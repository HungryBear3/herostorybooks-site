'use client';

import { useEffect, useState } from 'react';

export default function ReviewSessionBootstrap({ orderId }: { orderId: string }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = fragment.get('token');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    if (!token) {
      setError('This review link is missing its access token.');
      return;
    }
    void fetch(`/api/order/${orderId}/review-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Review session setup failed');
        window.location.reload();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Review session setup failed');
      });
  }, [orderId]);

  return (
    <main style={{ padding: '2rem', maxWidth: 560, margin: '0 auto' }}>
      <h1>Preparing your review</h1>
      <p>Establishing a secure review session for this order.</p>
      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
