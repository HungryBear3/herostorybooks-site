# Rex Review Notes — HSB Owner Print Go Console CD v2

Archived by: Rex 🐺  
Archived at: 2026-06-01 15:53:48 CDT  
Source file: `/Users/abigailclaw/Downloads/Owner Print Go Console - Standalone-2.html`  
Archived prototype: `docs/design/hsb-owner-print-go-console-cd-v2-2026-06-01.html`

## Status

Design handoff/reference only. This is **not** launch evidence and must not be deployed as standalone HTML.

## Rex local review summary

- Browser load was clean in prior Rex review.
- Console was clean.
- Checklist overlap from v1 was fixed.
- Submitted/status pill includes simulated/prototype language.
- Prototype note appears directly under the risky primary action.
- Double-confirm modal gates action behind checkbox + explicit `PRINT GO` confirmation.
- Design PASS for CC implementation reference.

## Non-blocking polish

- Decision tiles remain oversized.
- Modal could repeat simulated/prototype wording more explicitly.

## Implementation guardrails

CC should extract interaction/copy patterns only. Do not paste the standalone HTML into production.

Production implementation must:

- use existing admin auth;
- use real order state from `/admin/orders/[orderId]` / admin order APIs;
- call only the server-side owner print-go endpoint;
- require nonblank operator id;
- show customer approval is not enough;
- show no-auto-print proof before owner-go;
- surface durable lock / race-lost / already-submitted refusals;
- never expose proof token or private customer data beyond the admin-authenticated context;
- add tests for auth, disabled states, confirmation gating, refusal rendering, and no customer-facing imports.

## Launch gate note

This design does not unblock HSB launch by itself. It is queued behind:

1. Rex signed gate audit against `3011b52`.
2. Print path/SLA decision.
3. Named ops owners.
4. KS/bounce monitoring implementation or explicit manual-risk acceptance.
5. Explicitly approved real paid G5 E2E artifact packet.
