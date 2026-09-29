# HSB analytics governance — Phase B

Local candidate on `rex/hsb-analytics-phase-b-20260928`, stacked on Phase A
(`bb3cd5c`, draft PR #196). **Every external activation step below is on
HOLD.** Nothing in this phase sends a new event, reads a credential, or calls
GA4, Meta, Stripe or Vercel.

## Current truth

| Area | Artifact | State |
| --- | --- | --- |
| Event contract | `src/lib/analytics-event-contract.ts` (v1) | Enforced at `track()` / `trackCoverEvent()` |
| Purchase | `src/lib/purchase-analytics.ts` (Phase A) | Server-only, settled-webhook winner, unchanged |
| GA4 Admin checklist | `config/analytics/ga4-admin-checklist.v1.json` | 13 dimensions + 1 key event, all `owner_action_pending` |
| Transaction dedup readback | `src/lib/ga4-transaction-readback.ts` | Request builder + evaluator, no network |
| Decision-packet export | `src/lib/analytics-decision-export.ts`, `config/analytics/*` | HSB schema, fixture, mapping; packet vocabulary gaps are HOLD |
| Campaign governance | `src/lib/campaign-governance.ts`, `config/analytics/experiment-registry.v1.json` | Registry empty; linter live |
| Meta browser | `src/lib/meta-pixel-candidate.ts` | Candidate, not mounted, cannot activate (no consent surface) |
| Meta server (CAPI) | `src/lib/meta-capi-status.ts` | `DEFERRED`: frozen, null event, no transport |

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
sanitized fields: `timestamp`, a route-template `pathname`/`page_location`, a
referrer origin, governed `utm_*`, and the complete event-scoped
`campaign_source|medium|name|content` projection with explicit `''` clears.
`gtag('set', …)` is never used.

| Event | Declared params | Decision-grade |
| --- | --- | --- |
| `page_view` | `pathname` | yes |
| `begin_checkout` | `bookFormat` | yes |
| `checkout_step_view` / `_complete` | `step_id`, `step_number`, `total_steps`, `selected_format` | yes |
| `checkout_step_blocked` | the above + `reason` | yes |
| `order_submit_attempt` / `purchase_intent` | `theme`, `bookFormat`, `hasPhoto`, `hasVoice`, `familyCharacterCount` | no |
| `name_preview_submitted` | `has_name`, `preview_name_length` | no |
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
- **Explicitly not key events** — `page_view`, `begin_checkout` and the three
  checkout step events. Do not mark funnel steps.

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
property's dimensions and key events to be exactly the checklist's, and every
reported dimension value to be inside the contract vocabulary (values are
never echoed).

## 3. Transaction-id dedup readback

`buildGa4TransactionReadbackRequest({ propertyId, transactionId, startDate,
endDate })` returns one Data API `runReport` filtered to `eventName = purchase`
and the exact Checkout Session id (`cs_test_…`/`cs_live_…`, the same rule the
purchase writer uses). Absolute dates only, at most 93 days.
`evaluateGa4TransactionReadback({ transactionId }, response)` returns
`EXACTLY_ONE`, `DUPLICATE`, `MISSING` (GA4 processing can lag a day or two),
`INCONCLUSIVE` (sampled, thresholded, or `(other)` row) or `INVALID_RESPONSE`.

## 4. Decision-packet export

The offline decision packet is a separate, standalone tool. HSB does not
import it, run it, or emit its documents: that would couple the repositories,
and the packet's campaign/content/landing vocabulary does not contain HSB's
governed labels. Instead:

- `hsb.decision_export.ga4_behavior` v1 — field-for-field the packet's
  `ga4_behavior` v1 (daily `sessions`, `checkout_starts`, `purchase_events` per
  source/medium/campaign/content/landing path), in HSB vocabulary.
- `buildGa4BehaviorExportRequest` (read-only report) and
  `projectGa4BehaviorReport` (response → export). Every raw GA4 value is
  re-governed through the Phase-A allowlists or collapsed into `direct` /
  `none` / `not_set` / `other`; query strings, referrer hosts, identifier
  routes and free text cannot survive. Output is revalidated before return.
- `config/analytics/hsb-ga4-behavior-export.schema.v1.json` — generated closed
  JSON Schema. `config/analytics/fixtures/hsb-ga4-behavior-export.synthetic.v1.json`
  — deterministic synthetic fixture (not business data). Regenerate with
  `scripts/analytics-governance.ts schema|fixture`; tests require byte equality.
- `config/analytics/decision-packet-mapping.v1.json` — the mapping contract,
  validated to cover the HSB export vocabulary exactly.

**Packet vocabulary gaps (HOLD, packet-side ruling).** Mappable today:
sources except `telegram`; all mediums; content `video|image|carousel|text`
× `a|b` (→ `vid_a` … `txt_b`); landing `/`; all sentinels. Blocked and
collapsed to `other` until the packet vocabulary is extended by a reviewed
change there: every governed campaign (HSB names carry no objective and the
packet's slug list has none of `gifts|holiday|birthdays|launch`), content
variant `c`, every landing route except `/`, and source `telegram`. Until then
the packet cannot evaluate an HSB experiment segment. App-outcome and
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
4. Decision packet: rule on the vocabulary gaps in §4 (packet-side change), or
   on changing HSB campaign naming.
5. Meta browser: requires an owner-approved consent surface that records
   durable marketing consent, a pixel id, the two public env vars,
   confirmation that `NEXT_PUBLIC_VERCEL_ENV` is exposed to the build, and a
   reviewed mount point. Until then it stays unmounted.
6. Meta server: requires items in §6 plus a policy review before any send path
   is designed; `DEFERRED` stays until then.
7. Registry: the first real experiment entry needs owner-approved budget,
   thresholds and dates.

## 8. Open rulings

- GA4 `page_location`/`pathname` still carry an unknown path verbatim (only
  identifier routes are templated) — a Phase-A contract with its own test
  ("non-sensitive routes … preserved verbatim"). Closing it to the approved
  route set would change 404 reporting; left for a ruling.
- `begin_checkout` accepts an optional `bookFormat` although the live call
  site sends none (a closed enum kept so the Phase-A boundary test holds).
