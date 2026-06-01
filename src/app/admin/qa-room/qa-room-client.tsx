'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import type {
  CommandBoard,
  MarketingGuardrail,
  Posture,
  PostureLevel,
  QaOrderAnalysis,
  QaRiskFlag,
} from '@/lib/qa-room';

type QueueFilter =
  | 'awaiting_qa'
  | 'blocked'
  | 'released'
  | 'print_gate'
  | 'all';

type ViewTab = 'queue' | 'detail' | 'board';

interface Props {
  analyses: QaOrderAnalysis[];
  posture: Posture;
  marketing: MarketingGuardrail;
  board: CommandBoard;
  generatedAtIso: string;
}

const FILTER_LABELS: Record<QueueFilter, string> = {
  awaiting_qa: 'Awaiting QA',
  blocked: 'Blocked / template fallback',
  released: 'Released',
  print_gate: 'Print go/no-go',
  all: 'All',
};

/**
 * Generation Operating Policy §7 — canonical 12-item QA checklist.
 * Server-side `releaseOrderAfterQa` requires all 12 (or the legacy 5-item
 * aliases that expand to them) before a customer email is sent.
 */
const REQUIRED_CHECKS = [
  { key: 'storyPersonalizationQuality', label: 'Story personalization quality' },
  { key: 'familyDetailsCorrectness', label: 'Family / details correctness' },
  { key: 'noTemplateOrGenericProse', label: 'No template / generic prose' },
  { key: 'imageConsistency', label: 'Image consistency across pages' },
  { key: 'childLikenessSafety', label: 'Child likeness + safety' },
  { key: 'noMissingPages', label: 'No missing pages' },
  { key: 'noBrokenImages', label: 'No broken images' },
  { key: 'noFixtureArtifacts', label: 'No fixture / sample / internal artifacts' },
  { key: 'noProviderFallbackMismatch', label: 'No provider / fallback mismatch' },
  { key: 'printOrDigitalSuitability', label: 'Print / digital suitability' },
  { key: 'mobileProofPageCheck', label: 'Mobile proof page check' },
  { key: 'emailReviewLinkCheck', label: 'Email / review link check' },
] as const;

type QaCheckKey = (typeof REQUIRED_CHECKS)[number]['key'];

export default function QaRoomClient({ analyses, posture, marketing, board, generatedAtIso }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<ViewTab>('queue');
  const [filter, setFilter] = useState<QueueFilter>('awaiting_qa');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => filterAnalyses(analyses, filter, query), [analyses, filter, query]);
  const selected = useMemo(
    () => (selectedId ? analyses.find((a) => a.orderId === selectedId) ?? null : null),
    [analyses, selectedId],
  );

  function openDetail(orderId: string) {
    setSelectedId(orderId);
    setTab('detail');
  }

  return (
    <div className="min-h-screen bg-cream px-3 sm:px-5 lg:px-8 py-5 sm:py-7">
      <div className="mx-auto max-w-6xl flex flex-col gap-5">
        <Header
          posture={posture}
          ordersTotal={analyses.length}
          generatedAtIso={generatedAtIso}
          onRefresh={() => router.refresh()}
        />
        <PostureBanner posture={posture} />
        <MarketingPanel marketing={marketing} posture={posture} />

        <Tabs current={tab} onChange={setTab} />

        {tab === 'queue' && (
          <QueueView
            analyses={filtered}
            filter={filter}
            onFilterChange={setFilter}
            query={query}
            onQueryChange={setQuery}
            posture={posture}
            onOpenDetail={openDetail}
          />
        )}

        {tab === 'detail' && (
          <DetailView
            analyses={analyses}
            selected={selected}
            posture={posture}
            onSelect={setSelectedId}
            onRefresh={() => router.refresh()}
          />
        )}

        {tab === 'board' && <CommandBoardView board={board} />}

        <Footer generatedAtIso={generatedAtIso} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header + posture
// ─────────────────────────────────────────────────────────────────────────────

function Header({
  posture,
  ordersTotal,
  generatedAtIso,
  onRefresh,
}: {
  posture: Posture;
  ordersTotal: number;
  generatedAtIso: string;
  onRefresh: () => void;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-forest">QA Production Room</h1>
        <p className="text-xs sm:text-sm text-gray-500">
          Internal operator surface · {ordersTotal} orders loaded · Generated{' '}
          <time dateTime={generatedAtIso}>{generatedAtIso.slice(0, 19).replace('T', ' ')}Z</time>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <PosturePill level={posture.level} />
        <span className="rounded-full border border-border bg-white px-2 py-1 font-mono uppercase tracking-wider">
          Gate: {posture.gateDown ? 'OFFLINE' : posture.gateState === 'live' ? 'Simulated live gate' : 'Unknown'}
        </span>
        <a
          href="/admin/capacity"
          className="rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-forest hover:bg-cream"
        >
          Capacity
        </a>
        <a
          href="/admin/kill-switches"
          className="rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-forest hover:bg-cream"
        >
          Kill Switches
        </a>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-forest hover:bg-cream"
        >
          Refresh
        </button>
      </div>
    </header>
  );
}

function PosturePill({ level }: { level: PostureLevel }) {
  const map: Record<PostureLevel, { bg: string; text: string; label: string }> = {
    GREEN: { bg: 'bg-forest/10', text: 'text-forest', label: 'GREEN · clean release' },
    YELLOW: { bg: 'bg-[#FFF8E6]', text: 'text-[#8a6d1a]', label: 'YELLOW · proceed with care' },
    RED: { bg: 'bg-coral/20', text: 'text-coral-dark', label: 'RED · releases halted' },
  };
  const m = map[level];
  return (
    <span className={`rounded-full px-3 py-1 font-mono uppercase tracking-wider ${m.bg} ${m.text}`}>
      {m.label}
    </span>
  );
}

function PostureBanner({ posture }: { posture: Posture }) {
  const tone =
    posture.level === 'RED'
      ? 'border-coral/40 bg-coral/10 text-coral-dark'
      : posture.level === 'YELLOW'
        ? 'border-[#E6CD7A] bg-[#FFF8E6] text-[#8a6d1a]'
        : 'border-forest/30 bg-forest/5 text-forest';
  return (
    <section className={`rounded-xl border px-4 py-3 ${tone}`} aria-live="polite">
      <p className="font-semibold text-sm">{posture.banner}</p>
      {posture.rationale.length > 0 && (
        <ul className="mt-1.5 list-disc pl-5 text-xs leading-relaxed">
          {posture.rationale.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10px] uppercase tracking-wider opacity-80">
        Awaiting QA: {posture.ordersAwaitingQa} · Template fallback: {posture.ordersWithTemplateFallback} ·
        Total blockers: {posture.ordersWithBlockers}
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketing guardrail panel — read-only, NOT wired to ads/spend/creator mutation
// ─────────────────────────────────────────────────────────────────────────────

function MarketingPanel({ marketing, posture }: { marketing: MarketingGuardrail; posture: Posture }) {
  const paused = posture.level === 'RED' || posture.gateDown;
  return (
    <section
      aria-label="Marketing guardrails"
      className="rounded-xl border border-border bg-white px-4 py-3 space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-lg font-semibold text-forest">Marketing guardrails</h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gray-500">
          Read-only · not wired to ads/spend
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <GuardrailCell label="Paid budget" value={`$${marketing.paidBudgetUsd}`} sub="Retargeting only" />
        <GuardrailCell label="Creators accepted" value={`${marketing.creatorsAcceptedCap} cap`} sub="Manual approval" />
        <GuardrailCell label="Gifted production" value={`${marketing.giftedProductionDailyCap}/day`} sub="Cap" />
        <GuardrailCell
          label={paused ? 'Traffic posture' : 'Pause conditions'}
          value={paused ? 'PAUSED' : 'Live'}
          sub={paused ? 'RED / gate-down halts ads + creator codes' : 'Resume only after QA gate live'}
          tone={paused ? 'red' : 'neutral'}
        />
      </div>
      <ul className="text-[11px] text-gray-600 leading-relaxed list-disc pl-5">
        {marketing.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}

function GuardrailCell({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'neutral' | 'red';
}) {
  const valueClass = tone === 'red' ? 'text-coral-dark' : 'text-forest';
  return (
    <div className="rounded-lg border border-border/70 bg-cream/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${valueClass}`}>{value}</p>
      <p className="text-[10px] text-gray-500">{sub}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────

function Tabs({ current, onChange }: { current: ViewTab; onChange: (t: ViewTab) => void }) {
  const tabs: Array<{ id: ViewTab; label: string }> = [
    { id: 'queue', label: 'Queue' },
    { id: 'detail', label: 'Order detail' },
    { id: 'board', label: 'Daily command board' },
  ];
  return (
    <nav className="flex flex-wrap gap-1 border-b border-border" role="tablist">
      {tabs.map((t) => {
        const active = current === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={`px-3 py-1.5 text-sm font-semibold rounded-t-md transition ${
              active ? 'bg-white border border-border border-b-white text-forest' : 'text-gray-500 hover:text-forest'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue view — mobile-first cards (NEVER table on mobile)
// ─────────────────────────────────────────────────────────────────────────────

function QueueView({
  analyses,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  posture,
  onOpenDetail,
}: {
  analyses: QaOrderAnalysis[];
  filter: QueueFilter;
  onFilterChange: (f: QueueFilter) => void;
  query: string;
  onQueryChange: (q: string) => void;
  posture: Posture;
  onOpenDetail: (orderId: string) => void;
}) {
  return (
    <section aria-labelledby="qa-queue-heading" className="flex flex-col gap-3">
      <h2 id="qa-queue-heading" className="sr-only">
        QA queue
      </h2>
      <div className="bg-white border border-border rounded-xl p-3 sm:p-4 flex flex-wrap gap-2 items-center">
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search order ID or child name"
          className="flex-1 min-w-[200px] border border-border rounded-lg px-3 py-2 text-sm"
        />
        <select
          value={filter}
          onChange={(e) => onFilterChange(e.target.value as QueueFilter)}
          className="border border-border rounded-lg px-3 py-2 text-sm"
          aria-label="Queue filter"
        >
          {(Object.keys(FILTER_LABELS) as QueueFilter[]).map((k) => (
            <option key={k} value={k}>
              {FILTER_LABELS[k]}
            </option>
          ))}
        </select>
        <span className="text-xs text-gray-500">{analyses.length} shown</span>
      </div>

      {analyses.length === 0 ? (
        <div className="bg-white border border-border rounded-xl p-6 text-center text-sm text-gray-500">
          No orders match this filter.
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3" role="list">
          {analyses.map((a) => (
            <li key={a.orderId} className="contents">
              <QueueCard a={a} posture={posture} onOpenDetail={onOpenDetail} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QueueCard({
  a,
  posture,
  onOpenDetail,
}: {
  a: QaOrderAnalysis;
  posture: Posture;
  onOpenDetail: (id: string) => void;
}) {
  const blocking = a.blockers.filter((b) => b.severity === 'block');
  const tone = a.qaPassed
    ? 'border-forest/30 bg-forest/5'
    : blocking.length > 0
      ? 'border-coral/40 bg-coral/5'
      : a.awaitingQa
        ? 'border-[#E6CD7A] bg-[#FFFCEC]'
        : 'border-border bg-white';
  return (
    <article className={`rounded-xl border p-4 flex flex-col gap-3 ${tone}`} aria-labelledby={`qa-card-${a.orderId}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`qa-card-${a.orderId}`} className="font-serif text-base font-semibold text-forest truncate">
            {a.childName}{' '}
            <span className="text-gray-500 text-sm">· {a.formatLabel}</span>
          </h3>
          <p className="font-mono text-[11px] text-gray-500 truncate">{a.orderId}</p>
        </div>
        <StatusPills a={a} />
      </header>

      {a.slaAgeMinutes !== null && (
        <p className="text-[11px] text-gray-500">
          Awaiting QA for <span className="font-mono text-forest font-semibold">{formatMinutes(a.slaAgeMinutes)}</span>
        </p>
      )}

      {blocking.length > 0 && (
        <ul className="text-xs text-coral-dark space-y-1 list-disc pl-4">
          {blocking.slice(0, 3).map((b) => (
            <li key={b.code}>{b.message}</li>
          ))}
          {blocking.length > 3 && <li className="text-gray-500">… and {blocking.length - 3} more</li>}
        </ul>
      )}

      {a.riskFlags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {a.riskFlags.map((f) => (
            <RiskTag key={f.code} flag={f} />
          ))}
        </div>
      )}

      <p className="text-xs text-forest font-semibold">{a.requiredAction}</p>

      <div className="mt-auto flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onOpenDetail(a.orderId)}
          className="rounded-md border border-forest/30 bg-white px-3 py-1.5 text-xs font-semibold text-forest hover:bg-forest/5"
        >
          Open QA detail
        </button>
        <a
          href={`/admin/orders/${a.orderId}`}
          className="rounded-md border border-border bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-cream"
        >
          Full admin view ↗
        </a>
        {posture.gateDown && (
          <span className="rounded-md bg-coral/10 px-2 py-1 text-[10px] uppercase tracking-wider text-coral-dark">
            Gate down — release halted
          </span>
        )}
      </div>
    </article>
  );
}

function StatusPills({ a }: { a: QaOrderAnalysis }) {
  return (
    <div className="flex flex-wrap items-end justify-end gap-1 text-[10px] font-mono uppercase tracking-wider">
      <Pill tone="neutral">{a.fulfillmentStatus}</Pill>
      {a.qaPassed && <Pill tone="green">QA passed</Pill>}
      {a.awaitingQa && !a.qaPassed && <Pill tone="amber">awaiting QA</Pill>}
      {a.storyOrigin.isFallback && <Pill tone="red">template fallback</Pill>}
      {a.policyReleaseGuard && !a.policyReleaseGuard.ok && !a.qaPassed && (
        <Pill tone="red">policy: {a.policyReleaseGuard.failureCode ?? 'BLOCKED'}</Pill>
      )}
      {a.policyManifest?.emergencyOverrideUsed && <Pill tone="amber">emergency override</Pill>}
      {a.printGoNoGoState === 'awaiting_print_go' && <Pill tone="amber">print go/no-go</Pill>}
      {a.printGoNoGoState === 'shipped' && <Pill tone="green">shipped</Pill>}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'neutral'; children: React.ReactNode }) {
  const cls =
    tone === 'green'
      ? 'bg-forest/10 text-forest'
      : tone === 'amber'
        ? 'bg-[#FFF8E6] text-[#8a6d1a]'
        : tone === 'red'
          ? 'bg-coral/20 text-coral-dark'
          : 'bg-gray-100 text-gray-600';
  return <span className={`rounded-full px-2 py-0.5 ${cls}`}>{children}</span>;
}

function RiskTag({ flag }: { flag: QaRiskFlag }) {
  const tone =
    flag.severity === 'high' ? 'bg-coral/15 text-coral-dark' : flag.severity === 'med' ? 'bg-[#FFF8E6] text-[#8a6d1a]' : 'bg-gray-100 text-gray-600';
  return <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}>{flag.label}</span>;
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail view
// ─────────────────────────────────────────────────────────────────────────────

function DetailView({
  analyses,
  selected,
  posture,
  onSelect,
  onRefresh,
}: {
  analyses: QaOrderAnalysis[];
  selected: QaOrderAnalysis | null;
  posture: Posture;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  if (!selected) {
    return (
      <section className="bg-white border border-border rounded-xl p-5 space-y-3">
        <p className="text-sm text-gray-600">Pick an order from the queue to open its QA detail.</p>
        <select
          onChange={(e) => onSelect(e.target.value)}
          defaultValue=""
          className="border border-border rounded-lg px-3 py-2 text-sm"
        >
          <option value="" disabled>
            Select an order…
          </option>
          {analyses.slice(0, 40).map((a) => (
            <option key={a.orderId} value={a.orderId}>
              {a.childName} · {a.fulfillmentStatus} · {a.orderId}
            </option>
          ))}
        </select>
      </section>
    );
  }

  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 flex flex-col gap-4">
        <OrderSummaryCard a={selected} />
        <BlockerCard a={selected} />
        <ProvenanceCard a={selected} />
        <PolicyGuardCard a={selected} />
        <CustomerPreviewCard a={selected} />
      </div>
      <div className="flex flex-col gap-4">
        <ActionPanel a={selected} posture={posture} onAfterAction={onRefresh} />
        <PrintPanel a={selected} />
        <ContainmentPanel />
      </div>
    </section>
  );
}

function OrderSummaryCard({ a }: { a: QaOrderAnalysis }) {
  return (
    <article className="bg-white border border-border rounded-xl p-4 space-y-2">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif text-xl font-semibold text-forest">{a.childName}</h3>
          <p className="font-mono text-xs text-gray-500">{a.orderId}</p>
        </div>
        <StatusPills a={a} />
      </header>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-3">
        <Field label="Format" value={a.formatLabel} />
        <Field label="Payment" value={a.paymentStatus} />
        <Field label="Fulfillment" value={a.fulfillmentStatus} />
        <Field label="Awaiting QA" value={a.awaitingQa ? 'yes' : 'no'} />
        <Field label="QA passed at" value={a.qaPassAt ?? '—'} />
        <Field label="QA passed by" value={a.qaPassBy ?? '—'} />
        <Field label="Print go/no-go" value={a.printGoNoGoState} />
        <Field
          label="Shipping (print)"
          value={a.isPrint ? (a.shippingPresentIfRequired ? 'present' : 'MISSING') : 'n/a'}
        />
        <Field label="Audit events" value={String(a.auditEventsCount)} />
      </dl>
      <p className="text-[11px] text-gray-500">Required next action: {a.requiredAction}</p>
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className="font-mono text-xs text-forest">{value}</dd>
    </div>
  );
}

function BlockerCard({ a }: { a: QaOrderAnalysis }) {
  if (a.blockers.length === 0 && a.riskFlags.length === 0) {
    return (
      <article className="bg-white border border-forest/20 rounded-xl p-4 text-xs text-forest">
        No blockers or risk flags detected. Operator still runs the QA checklist before release.
      </article>
    );
  }
  return (
    <article className="bg-white border border-border rounded-xl p-4 space-y-3">
      <h3 className="font-serif text-base font-semibold text-forest">Blockers &amp; risk flags</h3>
      {a.blockers.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-coral-dark">Hard blockers</p>
          <ul className="space-y-1.5 text-xs">
            {a.blockers.map((b) => (
              <li
                key={b.code}
                className={`rounded-md px-2 py-1.5 ${
                  b.severity === 'block' ? 'bg-coral/10 text-coral-dark' : 'bg-[#FFF8E6] text-[#8a6d1a]'
                }`}
              >
                <span className="font-mono text-[10px] uppercase tracking-wider">{b.code}</span>
                <span className="ml-2">{b.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {a.riskFlags.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Risk flags</p>
          <div className="flex flex-wrap gap-1">
            {a.riskFlags.map((f) => (
              <RiskTag key={f.code} flag={f} />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function ProvenanceCard({ a }: { a: QaOrderAnalysis }) {
  const ts = a.qaPassAt ?? a.awaitingSince ?? '—';
  return (
    <article className="bg-white border border-border rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-base font-semibold text-forest">Provenance (internal)</h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">As of {ts}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-cream/40 p-3 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Story origin</p>
          <p className="font-mono text-xs">
            <span className="text-forest">{a.storyOrigin.source ?? '—'}</span>
            {a.storyOrigin.model ? <span className="text-gray-500"> · {a.storyOrigin.model}</span> : null}
          </p>
          {a.storyOrigin.isFallback && (
            <p className="text-[11px] text-coral-dark">
              Fallback engaged.{' '}
              {a.storyOrigin.fallbackError ? <code className="font-mono">{a.storyOrigin.fallbackError}</code> : null}
            </p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-cream/40 p-3 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Image lane</p>
          <p className="font-mono text-xs text-forest truncate" title={a.imageLane.representativeRoute ?? undefined}>
            {a.imageLane.representativeRoute ?? '—'}
          </p>
          <p className="text-[11px] text-gray-500">
            {a.imageLane.pagesSharingRoute} page{a.imageLane.pagesSharingRoute === 1 ? '' : 's'} share this route
            {a.imageLane.divergentPageCount > 0
              ? ` · ${a.imageLane.divergentPageCount} divergent`
              : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {a.proofUrl ? (
          <>
            <a
              href={a.proofUrl}
              target="_blank"
              rel="noopener"
              className="rounded-md border border-forest/30 bg-white px-3 py-1.5 text-xs font-semibold text-forest hover:bg-forest/5"
            >
              Open internal proof PDF
            </a>
            <span className="text-[10px] text-gray-500 self-center">
              Internal preview only — not customer-visible until release.
            </span>
          </>
        ) : (
          <span className="text-xs text-gray-500">No proof artifact yet.</span>
        )}
      </div>
    </article>
  );
}

function PolicyGuardCard({ a }: { a: QaOrderAnalysis }) {
  const m = a.policyManifest;
  const g = a.policyReleaseGuard;
  const tone = g.ok
    ? 'border-forest/30 bg-forest/5 text-forest'
    : 'border-coral/40 bg-coral/5 text-coral-dark';
  return (
    <article className={`rounded-xl border p-4 space-y-3 ${tone}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-base font-semibold">Generation Operating Policy guard</h3>
        <span className="text-[10px] uppercase tracking-wider opacity-80">
          §5 release · §6 print
        </span>
      </header>
      <p className="text-xs">
        {g.ok ? (
          <>Release-guard passes. The qa-pass route will accept this order if the 12-item checklist is complete.</>
        ) : (
          <>
            <span className="font-mono">{g.failureCode ?? 'BLOCKED'}</span> · {g.message ?? 'see manifest for details'}
          </>
        )}
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3">
        <Field label="Manifest complete" value={m.complete ? 'yes' : 'NO'} />
        <Field label="QA status" value={m.qaStatus} />
        <Field label="QA reviewer" value={m.qaReviewer ?? '—'} />
        <Field label="Story route allowed" value={m.story.routeAllowed ? 'yes' : 'NO'} />
        <Field label="Story fallback used" value={m.story.storyFallbackUsed ? 'YES' : 'no'} />
        <Field label="Story provider" value={m.story.storyProvider ?? '—'} />
        <Field label="Emergency override" value={m.emergencyOverrideUsed ? `yes (${m.emergencyApprovedBy ?? '—'})` : 'no'} />
        <Field label="Source photo" value={m.sourcePhotoPresent ? 'yes' : 'NO'} />
        <Field label="Personalization" value={m.personalizationInputsPresent ? 'yes' : 'NO'} />
        <Field label="Pages" value={`${m.pages.length} (${m.pages.filter((p) => p.routeAllowed).length} allowed)`} />
        <Field label="Customer released at" value={m.customerProofReleasedAt ?? '—'} />
        <Field label="Manifest hash" value={m.manifestHash ? `${m.manifestHash.slice(0, 10)}…` : 'TODO'} />
      </div>
      {m.pages.some((p) => !p.routeAllowed || p.assetSource !== 'live') && (
        <details className="text-[11px]">
          <summary className="cursor-pointer">Per-page risk detail</summary>
          <ul className="mt-1 space-y-1 list-disc pl-4">
            {m.pages.map((p) => (
              <li key={p.pageId}>
                <span className="font-mono">{p.pageId}</span> · provider={p.imageProvider ?? '—'} ·
                assetSource={p.assetSource}
                {p.routeAllowed ? '' : ` · ${p.routeFailureCode ?? 'BLOCKED'}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

function CustomerPreviewCard({ a }: { a: QaOrderAnalysis }) {
  const safeHeadline = a.customerVisibleHeadline.trim();
  const safeSub = a.customerVisibleStatus.trim();
  const isStillHolding = a.awaitingQa || a.blockers.length > 0;
  const overrideHeadline = isStillHolding ? 'Your book is in review' : safeHeadline;
  const overrideSub = isStillHolding
    ? "Our team is checking your book before sharing the proof. We'll email you when it's ready to review."
    : safeSub;
  return (
    <article className="bg-white border border-border rounded-xl p-4 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-base font-semibold text-forest">Customer-visible preview</h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">
          What the customer sees — never leaks internal providers
        </span>
      </div>
      <div className="rounded-lg border border-dashed border-border bg-cream/60 p-3 space-y-1">
        <p className="font-serif text-base text-forest">{overrideHeadline}</p>
        <p className="text-xs text-gray-700">{overrideSub}</p>
      </div>
      <p className="text-[11px] text-gray-500">
        Source: <code className="font-mono">order-status-view.buildOrderStatusView</code> · holding copy applied while
        blockers/QA pending.
      </p>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Action panel — strict gate separation
// ─────────────────────────────────────────────────────────────────────────────

function ActionPanel({
  a,
  posture,
  onAfterAction,
}: {
  a: QaOrderAnalysis;
  posture: Posture;
  onAfterAction: () => void;
}) {
  const [checks, setChecks] = useState<Record<QaCheckKey, boolean>>({
    storyPersonalizationQuality: false,
    familyDetailsCorrectness: false,
    noTemplateOrGenericProse: false,
    imageConsistency: false,
    childLikenessSafety: false,
    noMissingPages: false,
    noBrokenImages: false,
    noFixtureArtifacts: false,
    noProviderFallbackMismatch: false,
    printOrDigitalSuitability: false,
    mobileProofPageCheck: false,
    emailReviewLinkCheck: false,
  });
  const [qaPassBy, setQaPassBy] = useState('admin');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const allChecked = REQUIRED_CHECKS.every((c) => checks[c.key]);
  // Generation Operating Policy §5 — even with the checklist ticked, the
  // server-side guard re-runs against the manifest. Mirror the same gate
  // client-side so the button can't suggest a release that will be refused.
  const policyGuardOk = a.policyReleaseGuard?.ok ?? false;
  const releaseEnabled =
    a.canQaPass &&
    allChecked &&
    policyGuardOk &&
    !posture.gateDown &&
    posture.gateState === 'live' &&
    !a.qaPassed;

  const reasonsDisabled: string[] = [];
  if (a.qaPassed) reasonsDisabled.push('QA already passed — no further release action.');
  if (!a.awaitingQa) reasonsDisabled.push(`Order is in ${a.fulfillmentStatus}, not awaiting_qa.`);
  if (!a.hasArtifact) reasonsDisabled.push('No proof/digital artifact persisted yet.');
  if (a.paymentStatus !== 'paid') reasonsDisabled.push('Payment not confirmed.');
  if (a.blockers.some((b) => b.severity === 'block')) reasonsDisabled.push('Hard blockers present — resolve first.');
  if (a.isPrint && !a.shippingPresentIfRequired) reasonsDisabled.push('Print order missing shipping address.');
  if (posture.gateDown) reasonsDisabled.push('Gate is down — releases halted.');
  if (!allChecked) reasonsDisabled.push('Complete the 12-item QA checklist before releasing.');
  if (!policyGuardOk) {
    reasonsDisabled.push(
      `Generation Operating Policy guard: ${a.policyReleaseGuard?.failureCode ?? 'BLOCKED'} — ${a.policyReleaseGuard?.message ?? 'see Policy guard card'}`,
    );
  }

  async function runQaPass() {
    if (!releaseEnabled) return;
    setBusy('qa-pass');
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/orders/${a.orderId}/qa-pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qaPassBy: qaPassBy.trim() || 'admin', checklist: checks }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error ?? `Release failed (${res.status})`);
      } else {
        setMsg(data?.detail ?? 'QA passed and customer email sent.');
        onAfterAction();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="bg-white border border-border rounded-xl p-4 space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-base font-semibold text-forest">Internal QA actions</h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">
          QA pass releases proof/digital email · never print
        </span>
      </header>

      {msg && <p className="rounded bg-forest/10 px-3 py-2 text-xs text-forest">{msg}</p>}
      {err && <p className="rounded bg-coral/10 px-3 py-2 text-xs text-coral-dark">{err}</p>}

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-gray-500">QA checklist</p>
        <ul className="space-y-1.5">
          {REQUIRED_CHECKS.map((c) => (
            <li key={c.key}>
              <label className="flex items-start gap-2 rounded border border-border px-2 py-1.5 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={checks[c.key]}
                  onChange={(e) => setChecks((p) => ({ ...p, [c.key]: e.target.checked }))}
                  className="mt-0.5"
                />
                <span>{c.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-gray-500">QA passed by</span>
        <input
          value={qaPassBy}
          onChange={(e) => setQaPassBy(e.target.value)}
          maxLength={120}
          className="mt-1 w-full border border-border rounded-md px-2 py-1.5 text-sm"
        />
      </label>

      <button
        type="button"
        disabled={!releaseEnabled || busy !== null}
        onClick={runQaPass}
        className="w-full rounded-md bg-forest px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="qa-room-release"
      >
        {busy === 'qa-pass'
          ? 'Releasing…'
          : releaseEnabled
            ? 'Approve QA & release customer proof / digital'
            : 'Cannot release — resolve blockers first'}
      </button>
      <p className="text-[11px] text-gray-500">
        Approving QA sends the customer the proof/digital email through the live qa-pass route. It does NOT submit
        print.
      </p>
      {reasonsDisabled.length > 0 && (
        <details className="text-[11px] text-gray-500">
          <summary className="cursor-pointer">Why is release disabled?</summary>
          <ul className="mt-1 list-disc pl-4 space-y-1">
            {reasonsDisabled.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="pt-3 border-t border-border space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-gray-500">Other internal actions</p>
        <ProtoButton label="Queue manual revision note — prototype" />
        <ProtoButton label="Flag for owner review — prototype" />
        <p className="text-[10px] text-gray-500">
          Prototype only — these actions are not wired to a backend endpoint and will not mutate the order. Use the
          full admin view for live mutations.
        </p>
      </div>
    </article>
  );
}

function ProtoButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      className="w-full rounded-md border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-500 cursor-not-allowed"
      aria-disabled="true"
      title="Prototype only — no live mutation"
    >
      {label}
    </button>
  );
}

function PrintPanel({ a }: { a: QaOrderAnalysis }) {
  const canRequest = a.printGoNoGoState === 'awaiting_print_go';
  return (
    <article className="bg-white border border-border rounded-xl p-4 space-y-2">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-base font-semibold text-forest">Print — owner go/no-go required</h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">Separate from QA release</span>
      </header>
      <p className="text-xs text-gray-600">
        Print is a separate post-customer-approval flow. Approving QA never submits print. This panel only enables
        once the customer approves the proof and the order moves to <code className="font-mono">awaiting_print_go</code>.
      </p>
      <button
        type="button"
        disabled
        className="w-full rounded-md border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-500 cursor-not-allowed"
        aria-disabled="true"
        title="Use the full admin view to act on print"
      >
        {canRequest ? 'Open print decision in full admin view ↗' : 'Print decision unavailable — proof not yet customer-approved'}
      </button>
      <p className="text-[10px] text-gray-500">
        Live print actions live in the full admin order page (manual-approve, retry, ship). QA Room does not duplicate
        them.
      </p>
    </article>
  );
}

function ContainmentPanel() {
  return (
    <article className="bg-white border border-border rounded-xl p-4 space-y-2">
      <h3 className="font-serif text-base font-semibold text-forest">Containment</h3>
      <p className="text-xs text-gray-600">
        Local prototype controls. No backend endpoints exist yet — nothing here mutates production.
      </p>
      <div className="space-y-1.5">
        <ProtoButton label="Hold / pull proof — prototype" />
        <ProtoButton label="Pause creator code — prototype" />
        <ProtoButton label="Escalate to owner review — prototype" />
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily command board
// ─────────────────────────────────────────────────────────────────────────────

function CommandBoardView({ board }: { board: CommandBoard }) {
  const sections: Array<{ id: keyof CommandBoard; title: string }> = [
    { id: 'morning', title: 'Morning' },
    { id: 'midday', title: 'Midday' },
    { id: 'afternoon', title: 'Afternoon' },
    { id: 'endOfDay', title: 'End of day' },
  ];
  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {sections.map((s) => (
        <article key={s.id} className="bg-white border border-border rounded-xl p-4 space-y-2">
          <h3 className="font-serif text-base font-semibold text-forest">{s.title}</h3>
          <ul className="space-y-1.5 text-xs text-gray-700 list-disc pl-4">
            {board[s.id].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}

function Footer({ generatedAtIso }: { generatedAtIso: string }) {
  return (
    <footer className="text-[10px] text-gray-500 text-center pt-4 border-t border-border">
      QA Production Room · prototype operator surface · generated{' '}
      <time dateTime={generatedAtIso}>{generatedAtIso}</time> · auth required ·
      ${' '}<code className="font-mono">/api/admin/orders/[orderId]/qa-pass</code> is the only live mutation surface.
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtering
// ─────────────────────────────────────────────────────────────────────────────

function filterAnalyses(analyses: QaOrderAnalysis[], filter: QueueFilter, query: string): QaOrderAnalysis[] {
  const q = query.trim().toLowerCase();
  return analyses.filter((a) => {
    if (q && !(a.orderId.toLowerCase().includes(q) || a.childName.toLowerCase().includes(q))) return false;
    switch (filter) {
      case 'awaiting_qa':
        return a.awaitingQa;
      case 'blocked':
        return a.blockers.some((b) => b.severity === 'block');
      case 'released':
        return a.qaPassed;
      case 'print_gate':
        return a.printGoNoGoState === 'awaiting_print_go' || a.printGoNoGoState === 'submitted';
      case 'all':
      default:
        return true;
    }
  });
}
