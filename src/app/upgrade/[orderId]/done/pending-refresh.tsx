'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Re-read the durable receipt while Stripe's signed webhook is in flight. */
export function PendingPrintPaymentRefresh() {
  const router = useRouter();
  const [takingLonger, setTakingLonger] = useState(false);

  useEffect(() => {
    let checks = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      checks += 1;
      router.refresh();
      if (checks >= 10) {
        window.clearInterval(timer);
        setTakingLonger(true);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [router]);

  return (
    <div className="space-y-3 text-gray-700">
      <p>We&apos;re recording your order. Your payment may already have gone through; please don&apos;t start another checkout. This page checks automatically.</p>
      {takingLonger && (
        <>
          <p>This is taking longer than expected. If your card shows a charge, contact <a className="underline" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a> with the order ID below.</p>
          <button className="underline font-semibold" type="button" onClick={() => router.refresh()}>Check again</button>
        </>
      )}
    </div>
  );
}
