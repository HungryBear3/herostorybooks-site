# HSB analytics governance — Phase B

Local candidate on `rex/hsb-analytics-phase-b-20260928`, stacked on Phase A
(`bb3cd5c`, draft PR #196). **Every external activation step below is on
HOLD.** Nothing in this phase sends a new event, reads a credential, or calls
GA4, Meta, Stripe or Vercel.

## Current truth

| Area | Artifact | State |
| --- | --- | --- |
| Event contract | `src/lib/analytics-event-contract.ts` (v1) | Enforced at `track()` / `trackCoverEvent()`; GA paths are approved routes or `/(other)` |
| Purchase | `src/lib/purchase-analytics.ts` (Phase A) | Server-only, settled-webhook winner, unchanged |
| GA4 Admin checklist | `config/analytics/ga4-admin-checklist.v1.json` | 13 dimensions + 1 key event, all `owner_action_pending` |
| Transaction dedup readback | `src/lib/ga4-transaction-readback.ts` | Request builder + evaluator, no network |
| GA4 report reader | `src/lib/ga4-run-report.ts` | Strict `runReport` reader behind every export/readback verdict |
| Decision-packet export | `src/lib/analytics-decision-export.ts`, `src/lib/decision-packet-contract.ts`, `config/analytics/*` | HSB schema + packet compat export pinned to packet `d64d095`; unrepresentable values fail closed (HOLD) |
| Campaign governance | `src/lib/campaign-governance.ts`, `config/analytics/experiment-registry.v1.json` | Registry empty; linter live |
| Funnel diagnostics | `src/lib/ga4-funnel-diagnostics.ts`, `scripts/funnel-diagnostics.ts`, [`funnel.md`](funnel.md) | Read-only request plan + closed `hsb.funnel_diagnostics` v1 report; no new events |
| Meta browser | `src/lib/meta-pixel-candidate.ts` | Candidate, not mounted, cannot activate (no consent surface) |
| Meta server (CAPI) | `src/lib/meta-capi-status.ts` | `DEFERRED`: frozen, null event, no transport |
| Vercel Web Analytics | none (`tests/vercel-analytics-removed.test.ts`) | Intentionally not mounted; no dependency, no custom-event forwarding |

GA4 is the behavioral authority. The signed Stripe webhook and the order
ledger remain the payment authority.

### Why Vercel Web Analytics is not mounted

`@vercel/analytics@1.6.1` and the hosted insights script send the route
(`dp`) and, on cross-origin arrival and with every custom event, the raw
`document.referrer` (`r`). Neither passes through `beforeSend`, and neither
can be redacted by passing a route or path: on a route without dynamic params
the SDK folds query-string keys into `dp`, a typed 404 goes out verbatim, and
a referring page with a permissive referrer policy delivers its full path and
query in `r`. Final-boundary privacy for those fields cannot be guaranteed, so
the channel is removed rather than sanitized: HSB collects less instead of
running an ungoverned second channel.

Code removal alone stops app-originated collection. Owner follow-up after
this is deployed: disable Web Analytics for the project in the Vercel
dashboard, so a future remount or config drift cannot silently resume
collection. Remounting requires a new privacy review of `dp` and `r`.

Check everything offline:

```bash
node --experimental-strip-types scripts/analytics-governance.ts check
```

Exit 0 = accepted, 3 = rejected (value-free `CODE@$.path` lines), 2 = usage
or unreadable file.

## 1. Event contract

One module declares every event a browser may send, with a closed parameter
set per event. `track()` and `trackCoverEvent()` project caller props through
it before anything is buffered or sent: undeclared keys, out-of-vocabulary
values (for example a free-text `theme` restored from storage) and throwing
getters are dropped, and an undeclared event name — including `purchase` in
any casing — emits nothing. The analytics layer then adds only its own
sanitized fields: `timestamp`, a `pathname`/`page_location` path, a referrer
origin, governed `utm_*`, and the complete event-scoped
`campaign_source|medium|name|content` projection with explicit `''` clears.
`gtag('set', …)` is never used.

**GA path boundary.** Every path GA can see — the event `pathname` (from the
browser or a `trackPageView(path)` caller), the event `page_location`, and
the root-layout bootstrap `config` — is `analyticsRoutePath()`
(`src/lib/attribution-contract.ts`): the Phase-A approved landing route, an
identifier-route template such as `/status/[orderId]`, or the one opaque
`/(other)` bucket. A 404 someone typed, a child's name, a phone number, an
address, an order or provider id, a query string or a fragment never
crosses. The bootstrap's inline `hsbSafeRoute` is generated from the same
tables, and `page_referrer` is only ever an origin. `checkGa4BrowserEventCall`
rejects any other path.

| Event | Declared params | Decision-grade |
| --- | --- | --- |
| `page_view` | `pathname` | yes |
| `begin_checkout` | `bookFormat` | yes |
| `checkout_step_view` / `_complete` | `step_id`, `step_number`, `total_steps`, `selected_format` | yes |
| `checkout_step_blocked` | the above + `reason` | yes |
| `order_submit_attempt` | `theme`, `bookFormat`, `hasPhoto`, `hasVoice`, `familyCharacterCount` | yes (funnel stage) |
| `purchase_intent` (alias of the above) | same | no |
| `name_preview_submitted` | `has_name` (no name length: it derives from a child's typed name) | yes (funnel context) |
| `format_selected` / `story_selected` / `proof_approved` | `format` / `theme` / `bookFormat` | no |
| `start_checkout` (no live emitter) | — | no |
| cover events (no live emitter) | `variant` (`A`/`B`) | no |
| `purchase` | server only — Measurement Protocol from the settled webhook winner | key event |

`checkGa4BrowserEventCall()` and `checkGa4PurchasePayload()` are the
contract's executable form; tests run the real emitters and the real webhook
through them. GA4 purchase events are behavioral evidence only — never payment
authority.

## 2. GA4 Admin checklist (owner actions — HOLD)

`config/analytics/ga4-admin-checklist.v1.json` lists only decision-grade,
event-scoped custom dimensions and key events. Nothing is pre-marked done.

- **Custom dimensions (scope: Event)** — `step_id`, `reason`,
  `selected_format` (checkout step events) and `hsb_ft_*` / `hsb_lt_*`
  `source|medium|campaign|content|landing` (purchase). Display names,
  source events and rationale are in the file.
- **Key event** — `purchase` only, counted once per event.
- **Explicitly not key events** — `page_view`, `begin_checkout`, the three
  checkout step events, `name_preview_submitted` and `order_submit_attempt`.
  Do not mark funnel steps.

The linter rejects user/item scope, identifiers or amounts as dimensions
(`transaction_id`, `value`, …), parameters an event does not send, reserved
prefixes, duplicates, any marked funnel step, and any status other than
`owner_action_pending`.

Readback (read-only, after the owner's Admin changes):

```bash
node --experimental-strip-types -e "import('./src/lib/ga4-admin-checklist.ts').then(async (m) => {
  const doc = JSON.parse(require('node:fs').readFileSync('config/analytics/ga4-admin-checklist.v1.json', 'utf8'));
  console.log(JSON.stringify(m.buildGa4AdminReadbackPlan(doc, { propertyId: '<numeric property id>', startDate: '<YYYY-MM-DD>', endDate: '<YYYY-MM-DD>' }), null, 2));
})"
```

Run each request with an `analytics.readonly` token outside this repo, then
feed the JSON responses to `evaluateCustomDimensionsReadback`,
`evaluateKeyEventsReadback` and `evaluateDimensionProbe`. `MATCH` requires the
property's dimensions and key events to be exactly the checklist's (a
duplicated entry is a `MISMATCH`), and every reported dimension value to be
inside the contract vocabulary (values are never echoed). A probe response is
read only through the strict reader (`src/lib/ga4-run-report.ts`): unknown
fields, headers, metadata or cells, a wrong row width, or a `rowCount` below
the rows received is `INVALID_RESPONSE`; a sampled, thresholded,
`(other)`-folded, truncated (`rowCount` above the rows received, e.g. beyond
the 1000-row cap) or empty-for-a-reason report (`metadata.emptyReason`
present with no rows: GA4 explains the emptiness, so it is not evidence of
zero events) is `INCONCLUSIVE`, never `MATCH` or `NO_DATA`; `emptyReason`
beside returned rows is contradictory metadata and `INVALID_RESPONSE`. The
reason text is never read or echoed. An out-of-contract value is a
`MISMATCH` even in an incomplete report. A list response with a page token is
`INCONCLUSIVE`; a malformed token or an unknown field is `INVALID_RESPONSE`.

## 3. Transaction-id dedup readback

`buildGa4TransactionReadbackRequest({ propertyId, transactionId, startDate,
endDate })` returns one Data API `runReport` filtered to `eventName = purchase`
and the exact Checkout Session id (`cs_test_…`/`cs_live_…`, the same rule the
purchase writer uses). Absolute dates only, at most 93 days.
`evaluateGa4TransactionReadback({ transactionId }, response)` returns
`EXACTLY_ONE`, `DUPLICATE`, `MISSING` (GA4 processing can lag a day or two),
`INCONCLUSIVE` (sampled, thresholded, `(other)` row, truncated: `rowCount`
above the rows received, or empty for a stated reason: `metadata.emptyReason`
with no rows, which is not the same as `MISSING`) or `INVALID_RESPONSE`
(anything but the exact shape the request produces — extra or missing
headers, cells or fields, untyped metadata, a missing or low `rowCount`,
`emptyReason` beside returned rows). `EXACTLY_ONE` needs a complete,
exactly-shaped one-row report; `MISSING` needs an empty report GA4 does not
explain.

## 4. Decision-packet export

The offline decision packet is a separate, standalone tool, pinned here at
commit `d64d095f361dc10b939289a8787f25dc6d5d925c`. HSB never runs it at
runtime. It keeps its own export and converts it into the packet's own
document only through a checked mapping:

- `hsb.decision_export.ga4_behavior` v1 — field-for-field the packet's
  `ga4_behavior` v1 (daily `sessions`, `checkout_starts`, `purchase_events` per
  source/medium/campaign/content/landing path), in HSB vocabulary.
- `buildGa4BehaviorExportRequest` (read-only report) and
  `projectGa4BehaviorReport(request, response, header)` (response → export).
  **A projection is bound to the exact built request**: the request is
  rebuilt from the property and dates it names and must match structurally
  (`REQUEST_INVALID` otherwise — a readback request, an edited copy, another
  limit or a second date range is not an export request); the header's
  coverage must lie inside the requested days (`RANGE_UNBOUND`) and every
  attested range inside the coverage, ordered and disjoint
  (`ATTESTED_RANGE_INVALID`), so a header can narrow what is attested but
  never widen, shift or extend it over days GA4 was not asked about. Calendar
  dates are `0001-01-01`–`9999-12-31`, as in the packet; year zero is not a
  date, and the packet export refuses an attestation ending after
  `9999-12-28` (`ATTESTED_RANGE_UNSETTLEABLE`, see §8). Every raw GA4 value is re-governed through the Phase-A allowlists or
  collapsed into `direct` / `none` / `not_set` / `other`; query strings,
  referrer hosts, identifier routes and free text cannot survive. The
  response is read through the strict reader. **A truncated report is
  refused** (`REPORT_TRUNCATED`: `rowCount` above the rows received, including
  anything beyond the 250 000-row request cap), as is a missing, low or
  non-integer `rowCount`, an unknown field or metadata key, a malformed flag,
  or `metadata.emptyReason` beside returned rows (`METADATA_INVALID`). A
  sampled, thresholded or `(other)`-folded report becomes an export with
  those quality flags and **no attested range**, returned as
  `completeness: 'INSUFFICIENT_EVIDENCE'`; an empty-for-a-reason report
  (`emptyReason` with no rows) is likewise `INSUFFICIENT_EVIDENCE` with reason
  `EMPTY_REASON` and no attested range — GA4 explaining an empty result is not
  evidence of zero traffic, and the reason text is never read or echoed. The
  export validator rejects any document that attests completeness while
  carrying a quality flag. Output is revalidated before return.
- `config/analytics/hsb-ga4-behavior-export.schema.v1.json` — generated closed
  JSON Schema. `config/analytics/fixtures/hsb-ga4-behavior-export.synthetic.v1.json`
  — deterministic synthetic fixture (not business data). Regenerate with
  `scripts/analytics-governance.ts schema|fixture`; tests require byte equality.
- `src/lib/decision-packet-contract.ts` — the packet's `ga4_behavior` contract
  (closed keys, vocabularies, naming grammar, limits), copied from the pinned
  commit and bound to the SHA-256 of each source file; its validator is at
  least as strict as the packet's.
- `config/analytics/decision-packet-mapping.v1.json` — the mapping contract.
  It must name the pinned packet schema and full commit, carry each HSB field
  into the packet field of the same meaning, and map every HSB value to
  exactly its packet counterpart (placeholders to themselves, sources/mediums/
  routes by name, content `video-a` → `vid_a` …) — one-to-one, never onto a
  catch-all such as `other` — or declare it `blocked` when the packet has no
  counterpart. There is no fallback.
- `exportDecisionPacketGa4Behavior` / `scripts/analytics-governance.ts
  packet-export FILE` — emits the packet's own `decision_packet.ga4_behavior`
  v1 document, or refuses the whole export with value-free codes when any
  value is blocked or a packet evidence rule would fail (coverage over 400
  days, overlapping attested ranges, checkout starts or purchases above
  sessions, 16 MiB input limit). Nothing is collapsed into `other` and no row
  is dropped, so every packet row maps back to exactly its HSB row.
  `config/analytics/fixtures/decision-packet-ga4-behavior.synthetic.v1.json`
  (`packet-fixture`) is the export of the packet-representable synthetic
  fixture.
- Proof: `tests/decision-packet-compat.test.ts` runs the packet's own
  validator — the pinned files vendored byte for byte under
  `tests/fixtures/decision-packet-d64d095/`, hash-checked — on every success
  output, reads the packet's vocabularies back out of it, and shows why the
  export must refuse on its own: the packet rejects raw HSB labels but would
  silently accept an `other` collapse.

**Packet vocabulary gaps (HOLD, packet-side ruling).** Representable today:
sources except `telegram`; all mediums; content `video|image|carousel|text`
× `a|b` (→ `vid_a` … `txt_b`); landing `/`; all placeholders. Blocked — the
export refuses, it does not collapse — until the packet vocabulary is extended
by a reviewed change there: every governed campaign (packet names need an
objective and one of its reviewed slugs; HSB names carry no objective and the
slug list has none of `gifts|holiday|birthdays|launch`), content variant `c`,
every landing route except `/`, and source `telegram`. So today the packet can
take HSB traffic without governed campaigns (the checked-in governed fixture
is refused) and cannot evaluate an HSB experiment. App-outcome and
payment-ledger exports need operator-keyed `conversion_ref` values and order
data; they are out of scope here.

## 5. Campaign naming and the experiment registry

Governed tags are exactly the Phase-A attribution allowlist, lowercase:

- `utm_source`: `facebook instagram google bing newsletter pinterest youtube tiktok telegram`
- `utm_medium`: `paid_social social email cpc organic referral`
- `utm_campaign`: `launch` or `YYYY-MM-{gifts|holiday|birthdays|launch}[.v1-.v9]`, 2026–2029
- `utm_content`: `{video|image|carousel|text}-{a|b|c}`, optional
- `utm_term`: never
- landing path: one approved public route template — `/`, `/about`,
  `/pricing`, `/samples`, `/gifts`, `/gifts/<occasion>`, `/checkout`,
  `/create/your-memory`

`buildGovernedCampaignUrl(experiment)` produces the one canonical link and
re-reads it through the Phase-A landing capture before returning it.

`config/analytics/experiment-registry.v1.json` (currently empty) holds, per
experiment: `experiment_id` (`hsb_exp_YYYY_NNN`), `business`, `status`,
`start_date`/`end_date`, the governed segment, `budget` (integer minor units in
the registry's single currency, USD), exactly one `primary_outcome`,
`evidence_threshold` (`min_denominator`, `min_events`) and `decision`. No
free-text field exists. Two experiments may not share a segment over
overlapping dates (cancelled ones included, as in the packet). Open statuses
require decision `pending`.

Check a change against the previous version:

```bash
git show HEAD:config/analytics/experiment-registry.v1.json > /tmp/registry.prev.json
node --experimental-strip-types scripts/analytics-governance.ts check --previous /tmp/registry.prev.json
```

Transitions: `planned → running|cancelled`, `running → paused|completed|cancelled`,
`paused → running|completed|cancelled`; `completed`/`cancelled` are final. New
experiments start `planned` or `running`; none is removed. Once started, the
segment, start date, primary outcome, thresholds and currency are frozen; once
terminal, the window and budget are frozen; a made decision is final.

Every primary outcome is measured from GA4 sessions/checkout starts, app
outcomes or the payment ledger — never Meta, never the GA4 purchase event.

## 6. Meta

**Browser candidate** (`src/lib/meta-pixel-candidate.ts`) — not mounted. It
loads no third-party script (`fbevents.js` would collect the full URL,
referrer and page text by itself). An allowed event is one image beacon:
`https://www.facebook.com/tr?id=<pixel>&ev=<PageView|InitiateCheckout>&dl=<canonical origin + route template>&noscript=1`,
sent with `referrerPolicy: 'no-referrer'`. No custom data, no Advanced
Matching. It refuses before building a URL unless all of these hold:
`NEXT_PUBLIC_HSB_META_PIXEL_ENABLED=true` and a 15–16 digit
`NEXT_PUBLIC_HSB_META_PIXEL_ID`; `NEXT_PUBLIC_VERCEL_ENV=production`; the page
is exactly `https://herostorybooks.com`; marketing consent is `granted`; the
event and route are allowed (PageView on approved public routes,
InitiateCheckout on `/checkout`; Purchase never). HSB has no consent surface,
so `readMarketingConsent()` is always `unknown` and the candidate cannot fire.

**Server (CAPI) — DEFERRED.** CAPI needs `user_data` matching evidence. The
current architecture carries no durable marketing consent, no consented
`fbp`/`fbc` in signed checkout metadata, and no Advanced Matching approval, so
`resolveMetaServerPurchase()` always returns a frozen `DEFERRED` status with a
null event and no transport. No environment variable can activate it; the
webhook does not call it. Tests prove the real webhook, under concurrent and
replayed delivery with every plausible Meta variable set, dispatches exactly
one GA4 purchase and contacts no Meta host.

## 7. Activation HOLDs

1. GA4 Admin: create the 13 custom dimensions; confirm `purchase` is the only
   key event (once per event); then run the readback plan to `MATCH`.
2. GA4 data stream: review enhanced-measurement automatic events (page changes
   on history events, site search, form interactions, outbound clicks). They
   are outside this contract and can carry URL or form text.
3. Verify one production purchase with the transaction-id readback
   (`EXACTLY_ONE`) after Phase A is deployed.
4. Decision packet: rule on the vocabulary gaps in §4 (packet-side change,
   then re-pin), or on changing HSB campaign naming. Until then any export
   containing a governed campaign is refused.
5. Meta browser: requires an owner-approved consent surface that records
   durable marketing consent, a pixel id, the two public env vars,
   confirmation that `NEXT_PUBLIC_VERCEL_ENV` is exposed to the build, and a
   reviewed mount point. Until then it stays unmounted.
6. Meta server: requires items in §6 plus a policy review before any send path
   is designed; `DEFERRED` stays until then.
7. Registry: the first real experiment entry needs owner-approved budget,
   thresholds and dates.

## 8. Open rulings

- The packet requires `checkout_starts` and `purchase_events` ≤ `sessions` per
  segment-day. GA4 counts every `begin_checkout`, so a real segment-day can
  exceed its sessions; the export then refuses (`METRIC_INVARIANT`) rather than
  clamp. Needs a ruling before real exports.
- `begin_checkout` accepts an optional `bookFormat` although the live call
  site sends none (a closed enum kept so the Phase-A boundary test holds).
- Packet-side defect, closed on the HSB side: the pinned validator raises an
  uncaught `OverflowError` (not a rejection) when an attested day ends on or
  after `9999-12-29` in any packet timezone — its 48-hour settle arithmetic
  overflows Python's datetime. The TS packet gate therefore refuses any
  attestation ending after `9999-12-28` (`ATTESTED_RANGE_UNSETTLEABLE`),
  derived from the packet's `SETTLE_HOURS`, before a packet document exists;
  `tests/decision-packet-compat.test.ts` sweeps every day through
  `9999-12-31` in every zone against the real validator and proves the gate
  accepts nothing the packet crashes on. Unattested coverage is unaffected.
  The packet's crash itself remains a packet-side ruling.
