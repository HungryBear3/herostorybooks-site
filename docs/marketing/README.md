# HSB marketing measurement

Candidate work, under review. **Nothing in this directory is enabled, connected,
posted, or spent.**

| Document | What it is |
|---|---|
| [`current-state-audit.md`](current-state-audit.md) | What GA4, Stripe, Vercel Analytics, robots, and CSP actually do today, read from source at `d6c5602`, plus nine named conflict/double-counting risks |
| [`attribution-event-contract.md`](attribution-event-contract.md) | v1.0.0 governed UTM rules, the canonical event matrix across GA4 / Meta / Reddit / Stripe, safe parameters, blocked data, dedupe and event-id lifecycle, consent behaviour |
| [`experiments-board.md`](experiments-board.md) | Human view of the 30-day board |
| [`experiments-board.json`](experiments-board.json) | **Authoritative** machine copy, validated on every `npm test` |
| [`meta-measurement-candidate.md`](meta-measurement-candidate.md) | Meta Pixel + Conversions API: privacy and threat model, environment variable names, rollout, rollback, and five open blockers |
| [`reddit-measurement-design.md`](reddit-measurement-design.md) | Reddit mapping, dedupe, CSP, consent, and experiment requirements — design only, no code exists |
| [`ai-discovery-audit.md`](ai-discovery-audit.md) | Catalog and structured-data consistency, robots and OAI-SearchBot source truth, sitemap/canonical/host, llms.txt, AI referral classification, agentic-commerce readiness, and why an MCP surface is not justified |
| [`search-reconciliation-checklist.md`](search-reconciliation-checklist.md) | Read-only checklist, split into source-proven rows and seventeen operator-console questions nobody has opened a console to answer |

## The three things to read first

1. **Stripe is authoritative for purchase.** `src/lib/ga4-purchase.ts` emits GA4
   `purchase` from the signed webhook after the durable payment write. No browser
   surface may compete, and none does.
2. **The Meta pixel cannot fire today.** There is no consent surface in this
   repository, `resolveConsent()` therefore returns `unknown`, and `unknown` fails
   closed — even with the pixel id and the flag set. See
   `meta-measurement-candidate.md` blocker B1, which also covers the resulting
   inconsistency with GA4's unconditional production loading.
3. **No measured contribution per order exists at live prices.** The 2026-05
   unit-economics doc models prices HSB no longer charges. Both paid experiment rows
   carry a `null` target rather than an invented one.

## Code

| Module | Role |
|---|---|
| `src/lib/marketing/utm-contract.ts` | governed UTM validation; pure |
| `src/lib/marketing/event-contract.ts` | canonical event matrix, allowlists, blocked-field guard; pure and isomorphic |
| `src/lib/marketing/route-sanitizer.ts` | strip query/fragment, template dynamic segments, public-route allowlist; pure |
| `src/lib/marketing/consent.ts` | consent resolution, fails closed |
| `src/lib/marketing/meta-pixel.ts` | browser controller + the one adapter that talks to `fbq` |
| `src/lib/marketing/meta-bridge.ts` | the single seam between `src/lib/analytics.ts` and the pixel |
| `src/lib/marketing/meta-capi.ts` | server Conversions API adapter; server-only env names |
| `src/lib/marketing/experiments-board.ts` | board validator |
| `src/components/marketing/meta-pixel-mount.tsx` | root-layout mount |

## Tests

```
npm test                                   # includes all five marketing suites
node --experimental-strip-types --test tests/marketing-*.test.ts
npx playwright test --project=desktop-chromium tests/e2e/marketing-meta-inert.spec.ts
```

| Suite | Covers |
|---|---|
| `tests/marketing-utm-contract.test.ts` | governed UTM rules, PII rejection, tuple validation, collision keys |
| `tests/marketing-meta-pixel.test.ts` | the disabled-by-default gates, init-once, PageView dedupe, route sanitisation and templating, the event and parameter allowlists, the blocked-field guard, and CSP |
| `tests/marketing-meta-capi.test.ts` | server-only config, the trusted paid path, payload contents, dedupe and idempotency, timeout and failure containment |
| `tests/marketing-attribution-preservation.test.ts` | GA4/Stripe attribution unchanged, webhook wiring, no duplicate purchase across a replay, bridge inertness |
| `tests/marketing-experiments-board.test.ts` | the board validator against the real board and against invalid variants, plus Markdown-vs-JSON drift |
| `tests/e2e/marketing-meta-inert.spec.ts` | Chromium: no Meta/Reddit request attempted, no `fbq` installed, HSB analytics still records sanitised page views, family-review CSP intact |

Every test uses an injected adapter or a mocked `fetch`. No test reaches Meta,
Google, Vercel, Reddit, or Stripe.
