'use client';

import { useMemo, useState } from 'react';

import type { KillSwitchSnapshot, KillSwitchSnapshotItem } from '@/lib/ops-kill-switches';

export default function KillSwitchesClient({
  initialSnapshot,
  envCheckoutPaused,
}: {
  initialSnapshot: KillSwitchSnapshot;
  envCheckoutPaused: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [operator, setOperator] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeCount = useMemo(
    () => snapshot.switches.filter((item) => item.active).length + (envCheckoutPaused ? 1 : 0),
    [snapshot.switches, envCheckoutPaused],
  );

  async function submit(item: KillSwitchSnapshotItem, active: boolean) {
    setError(null);
    setBusyId(item.id);
    try {
      const response = await fetch('/api/admin/kill-switches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          active,
          reason: reasons[item.id] ?? item.reason ?? '',
          updatedBy: operator,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; snapshot?: KillSwitchSnapshot };
      if (!response.ok || !body.snapshot) {
        throw new Error(body.error ?? `Update failed with ${response.status}`);
      }
      setSnapshot(body.snapshot);
      setReasons((prev) => ({ ...prev, [item.id]: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="min-h-screen bg-cream px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-bold text-forest">Kill Switches</h1>
            <p className="text-sm text-gray-500">
              YELLOW-CANDIDATE / internal prep only - External launch RED/HOLD - Generated{' '}
              <time dateTime={snapshot.generatedAt}>{snapshot.generatedAt.slice(0, 19).replace('T', ' ')}Z</time>
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-xs">
            <a className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-forest" href="/admin/orders">
              Orders
            </a>
            <a className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-forest" href="/admin/qa-room">
              QA Room
            </a>
            <a className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-forest" href="/admin/capacity">
              Capacity
            </a>
          </nav>
        </header>

        <section className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <div className="grid gap-3 md:grid-cols-[1fr_220px] md:items-end">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Operator identity</p>
              <input
                value={operator}
                onChange={(event) => setOperator(event.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                placeholder="name or email required for any change"
              />
            </div>
            <div className="rounded-md border border-gray-200 bg-cream px-3 py-2 text-sm">
              <p className="font-mono text-lg font-bold text-forest">{activeCount}</p>
              <p className="text-xs text-gray-600">active hold signal{activeCount === 1 ? '' : 's'}</p>
            </div>
          </div>
          {error && <p className="mt-3 rounded-md bg-coral/15 px-3 py-2 text-sm text-coral-dark">{error}</p>}
          {envCheckoutPaused && (
            <p className="mt-3 rounded-md bg-[#FFF8E6] px-3 py-2 text-sm text-[#8a6d1a]">
              Environment checkout pause is active through HSB_CHECKOUT_PAUSED=true. Clear that env flag separately.
            </p>
          )}
        </section>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {snapshot.switches.map((item) => (
            <article key={item.id} className="rounded-lg border border-gray-200 bg-white px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-serif text-lg font-bold text-forest">{item.label}</h2>
                  <p className="mt-1 text-sm text-gray-600">{item.summary}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider ${
                  item.mode === 'enforced' ? 'bg-forest/10 text-forest' : 'bg-gray-100 text-gray-600'
                }`}>
                  {item.mode === 'enforced' ? 'Enforced' : 'Manual'}
                </span>
              </div>

              <div className={`mt-3 rounded-md border px-3 py-2 text-sm ${
                item.active ? 'border-coral/40 bg-coral/10 text-coral-dark' : 'border-gray-200 bg-cream text-gray-700'
              }`}>
                <p className="font-semibold">{item.active ? 'ACTIVE HOLD' : 'Inactive'}</p>
                <p className="mt-1">{item.enforcement}</p>
                {item.reason && <p className="mt-1">Reason: {item.reason}</p>}
                {item.updatedBy && <p className="mt-1 text-xs">Last changed by {item.updatedBy} at {item.updatedAt}</p>}
              </div>

              <textarea
                value={reasons[item.id] ?? ''}
                onChange={(event) => setReasons((prev) => ({ ...prev, [item.id]: event.target.value }))}
                className="mt-3 h-20 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                placeholder={item.active ? 'Optional reason for clearing' : 'Required reason to activate'}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyId === item.id || item.active}
                  onClick={() => submit(item, true)}
                  className="rounded-md border border-coral/40 bg-coral/10 px-3 py-1.5 text-xs font-semibold text-coral-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Activate hold
                </button>
                <button
                  type="button"
                  disabled={busyId === item.id || !item.active}
                  onClick={() => submit(item, false)}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-forest disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear hold
                </button>
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <h2 className="font-serif text-lg font-bold text-forest">Recent Changes</h2>
          {snapshot.history.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600">No switch changes recorded in this state file.</p>
          ) : (
            <ol className="mt-2 space-y-2 text-sm text-gray-600">
              {snapshot.history.slice(0, 10).map((event, index) => (
                <li key={`${event.id}-${event.updatedAt}-${index}`} className="rounded-md bg-cream px-3 py-2">
                  <span className="font-mono text-xs uppercase">{event.active ? 'activated' : 'cleared'}</span>{' '}
                  {event.id} by {event.updatedBy} at {event.updatedAt}
                  {event.reason ? ` - ${event.reason}` : ''}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
