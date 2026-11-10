import type { PublicShippingSummary } from '@/lib/initial-shipping-summary';

/** Only the closed server projection crosses into this shared render component. */
export function InitialShippingSummary({ summary }: { summary: PublicShippingSummary }) {
  if (summary.kind === 'standard') return null;
  return <section aria-label="Shipping upgrade" className="bg-white rounded-2xl border border-gray-200 p-6 w-full max-w-md space-y-3">
    <h2 className="font-semibold">Shipping upgrade</h2>
    <p>{summary.message}</p>
    {summary.kind === 'expedited' ? <>
      <h3 className="font-semibold">Accepted quote — not a payment receipt</h3>
      <dl>{summary.rows.map(row => <div key={row.label} className="flex justify-between gap-4 text-sm py-1"><dt>{row.label}</dt><dd>{row.amount}</dd></div>)}</dl>
      <p className="text-sm">{summary.copy}</p>
    </> : null}
    <p className="text-sm">Questions? <a href="mailto:support@herostorybooks.com" className="underline">support@herostorybooks.com</a></p>
  </section>;
}
