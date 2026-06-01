# HSB Print Path / SLA Decision — 2026-06-01

Owner: Rex 🐺
Decision time: 2026-06-01 15:43 CDT
Scope: local code/docs/public-reference review only. No vendor outreach, deploy, Stripe charge, production order mutation, Lulu/RPI API call, Resend action, or print action was performed.

## Decision

**Use Lulu API as the currently implemented print path for any controlled internal G5/owner-print-go test, but do not promise date-specific Father’s Day print delivery.**

Customer copy must remain:

- proof-first
- best-chance only for print
- digital safest for on-day gifting
- hardcover framed as a follow-up keepsake unless written partner timing exists
- non-date-specific unless a written SKU/volume SLA is obtained

RPI self-service is **not selected for launch path today** because HSB code is currently wired to Lulu, RPI is not integrated in this candidate, and no written RPI SKU/volume SLA or validated self-service operational workflow is attached to this repo packet.

## Why

### Lulu API path is real in code

Evidence:
- `src/lib/lulu.ts:42-44` defaults selected HSB SKUs:
  - softcover: `0850X0850.FC.STD.PB.080CW444.GXX`
  - hardcover: `0850X0850.FC.STD.CW.080CW444.MXX`
- `src/lib/lulu.ts:126-133` calls Lulu `/cover-dimensions/` with the selected `pod_package_id`.
- `src/lib/lulu.ts:156-210` builds and posts Lulu `/print-jobs/` payload.
- `src/lib/fulfillment.ts:13` imports Lulu `calculateCoverDimensions` / `submitPrintJob`; `src/lib/fulfillment.ts:975-1042` routes print production through the submitPrint dependency/default Lulu path.
- `src/lib/fulfillment.ts:1415-1522` now gates print submission behind explicit owner print-go and durable lock.

### Lulu SKU selection has prior support

From the existing Rex Lulu SKU-selection skill:
- Classic softcover selected SKU: `0850X0850.FC.STD.PB.080CW444.GXX`, 8.5x8.5 full color standard perfect bound 80# coated white gloss, minimum interior pages 32.
- Premium hardcover selected SKU: `0850X0850.FC.STD.CW.080CW444.MXX`, 8.5x8.5 full color standard casewrap 80# coated white matte, minimum interior pages 24.
- Skill source of truth: Lulu API docs/spec sheet (`https://api.lulu.com/docs/`, OpenAPI spec, Lulu print API spec sheet XLSX).

### SLA is not strong enough for public date promises

Evidence from today’s ops memory and current candidate:
- Public partner data previously summarized in today’s Rex log: Lulu softcover production roughly 3–5 business days; hardcover requires extra/unquantified time; shipping estimates are not guaranteed. RPI self-service API says 5-day SLA US-only. Conservative softcover cutoff is 2026-06-01 23:59 CDT; aggressive is 2026-06-03 only with live operator judgment. Jun 5 public print cutoff is not defensible without partner-confirmed SLA.
- `src/lib/fathers-day.ts` was updated so public-facing copy does not expose date-specific print cutoffs or guarantees.
- `tests/fathers-day.test.ts:23-81` now asserts no public `Order by`, `Jun 5`, `June 5`, `June 1`, `Jun 1`, or guarantee wording.
- `tests/fathers-day.test.ts:92-111` asserts digital is safest and hardcover is a follow-up keepsake.

## Operational rule for G5

If Alexy approves a real paid internal G5:

1. Run the order proof-first.
2. Do not call owner print-go until customer proof approval and separate print go/no-go.
3. If print is included in G5, use the existing Lulu API path only.
4. Save artifact packet with:
   - selected SKU / book format
   - Lulu API env/path used
   - printJobId if submitted
   - no-auto-print assertion before owner-go
   - ownerPrintGoAt / ownerPrintGoBy / durable lock evidence
   - partner status/ack readback
5. If print path/SLA is ambiguous at any step, stop at `proof_approved`; do not submit print.

## Copy rule

Until written partner SLA exists for the exact SKU + volume + ship level:

- Do not publish “order by Jun 5” or any replacement exact print cutoff.
- Do not say “guaranteed by Father’s Day.”
- Do not imply hardcover-by-Father’s-Day.
- Use: “Digital is safest for Father’s Day; printed books follow proof approval and are best-chance only.”
- Use: “Hardcover can be a follow-up keepsake.”

## What would change this decision

Select RPI or date-specific print copy only after all of these exist in the artifact packet:

- Written partner SLA for exact product/SKU, volume, ship level, and US-only/region constraints.
- Confirmed operational account/API/self-service path.
- Validated quote/order readback without risking customer order loss.
- Code/runbook integration or a manual workflow with a named owner and cutoff alarm.

## Final status

- Print path for internal test: **Lulu API**.
- Public print promise: **non-date-specific best-chance only**.
- RPI path: **not selected / research-only until written SLA + workflow evidence exists**.
- HSB status impact: supports **YELLOW-CANDIDATE**, not GREEN; real G5 and ops ownership still required.

Signed: Rex 🐺
