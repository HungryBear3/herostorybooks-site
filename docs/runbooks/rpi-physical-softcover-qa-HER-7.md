# RPI Physical Softcover QA Tracking — HER-7

> **HOLD — TRACKING ONLY, NOT PRINT APPROVAL.**
> This document records evidence for one approved RPI softcover production test
> as it moves through shipping, delivery, and physical QA. It does **not**
> approve any print run, does **not** clear launch / G5 / public traffic, and
> does **not** authorize any new RPI/Lulu/print/payment/order action. Updating
> this file changes nothing in production — it is a read-only operator
> checklist. Every "action" below is a human reading a dashboard or inspecting
> a physical book; none of it is performed by automation.

Linear: [HER-7](https://linear.app/herostorybooks/issue/HER-7/rpi-physical-softcover-qa-tracking)
Status: **Todo** (open — see "What remains before HER-7 can be marked done")
Last updated: 2026-06-02 (initial tracker created; awaiting physical book)

---

## Hard constraints (do NOT violate)

- **Do not** submit, pay, cancel, modify, or create any RPI/Lulu/print order.
- **Do not** use RPI **bundled Pay All**. The tracked order is already paid as a
  single production test; never trigger a batch/bundled payment.
- **Do not** touch Stripe, payments, customer orders, fulfillment, production
  env, or deploys as part of this gate.
- **Do not** mark launch / G5 / public traffic as clear based on this gate.
- Status/shipping/delivery facts are captured **read-only** from the RPI portal
  by a human. No new RPI/Lulu/print/payment/order action without explicit
  approval recorded in HER-7.

---

## Tracked order (evidence under test)

| Field | Value |
| --- | --- |
| RPI production order id | `ce868c70-61dc-4e36-ad0e-33174930c702` |
| Product | Physical softcover (production test) |
| Status after payment | `VALID_HOLDING_BIN` |
| Payment charged | $23.23 (already paid — do not re-pay, do not Pay All) |
| Estimated ship | 2026-06-09 |
| Estimated delivery | 2026-06-14 |

This is an **RPI print-provider order id** (UUID), not an HSB internal
`ord_...` record, so it does not appear in the HSB order/blob store or in
`/admin/orders`. Track it from the RPI portal, read-only.

---

## QA gate checklist

Mark a box only when the evidence is captured and recorded in the log below.
An unchecked box is an open blocker. Do not infer a checked box from an
estimate — only from observed evidence.

### 1. Status checks (read-only)

- [ ] Order status re-read from RPI portal after `VALID_HOLDING_BIN`
- [ ] Status transition into production/print captured (date + screenshot)
- [ ] No unexpected status (held / error / cancelled) — if seen, stop and note

### 2. Shipping / tracking evidence

- [ ] Shipped status observed (actual, not the 2026-06-09 estimate)
- [ ] Carrier + tracking number captured
- [ ] Ship date recorded vs. estimate (2026-06-09)

### 3. Delivery evidence

- [ ] Delivered status / tracking shows delivered
- [ ] Delivery date recorded vs. estimate (2026-06-14)
- [ ] Package received in hand by a human reviewer

### 4. Physical inspection / print QA (book in hand)

- [ ] **Print quality** — sharpness, no banding, no smudging, ink solid
- [ ] **Color** — matches approved proof; skin tones acceptable; no heavy cast
- [ ] **Binding** — softcover glue/spine sound; pages do not pull loose
- [ ] **Page order** — sequence correct; no duplicated/missing/rotated pages
- [ ] **Trim / registration** — content not cut off; margins consistent
- [ ] **Cover** — front/back/spine correct, title legible, finish acceptable

### 5. Photo / evidence packet

- [ ] Photos: cover (front + back + spine)
- [ ] Photos: representative interior spreads (incl. any page flagged above)
- [ ] Photos: any defects, with notes
- [ ] Packet stored and linked in HER-7 (attachment or linked location)

### 6. Human verdict

- [ ] A named human records a **PASS / CONDITIONAL / FAIL** verdict with reasons
- [ ] Fulfillment implications recorded (see below)
- [ ] Verdict posted to HER-7

---

## Evidence log (fill as captured)

| Date | Source (read-only) | Observation | Captured by | Evidence link |
| --- | --- | --- | --- | --- |
| 2026-06-02 | RPI portal | Status `VALID_HOLDING_BIN`, paid $23.23, est ship 06-09 / delivery 06-14 | — | HER-7 description |
| _pending_ | RPI portal | Shipped + tracking | — | — |
| _pending_ | Carrier | Delivered | — | — |
| _pending_ | Physical book | Print/color/binding/page-order QA | — | — |
| _pending_ | Reviewer | Final verdict | — | — |

---

## Fulfillment implications (document, do not act)

Record what a PASS/CONDITIONAL/FAIL would mean for fulfillment — for the record
only. This document does not authorize any of it.

- **PASS** — softcover print path is evidenced as viable for the tested config.
  A separate, explicitly-approved decision (not this gate) would be required to
  move physical fulfillment forward. Does not clear launch / G5 / public traffic.
- **CONDITIONAL** — note the specific defect(s) and what must change (provider
  setting, file, color profile) before another tracked test.
- **FAIL** — note root cause; physical fulfillment stays blocked; no public
  physical orders.

---

## What remains before HER-7 can be marked done

HER-7 cannot be closed by code or by this document. It stays open until **all**
of the following are captured as real evidence on the physical book:

1. **Shipped** status observed (not estimated) with carrier + tracking.
2. **Delivered** status observed and the book received in hand.
3. **Physical inspection** complete across print, color, binding, page order,
   trim/registration, and cover.
4. **Evidence packet** (photos + notes) stored and linked in HER-7.
5. **Human verdict** (PASS / CONDITIONAL / FAIL) recorded with reasons and
   fulfillment implications, posted to HER-7.

Until then this is **tracking only**. It is not a print approval and clears
nothing for launch, G5, or public traffic.
