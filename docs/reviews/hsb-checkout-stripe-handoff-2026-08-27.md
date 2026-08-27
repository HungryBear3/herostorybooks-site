# Checkout → Stripe hand-off review

**Date:** 2026-08-27
**Scope:** the browser-side hand-off from the HSB checkout form to Stripe Checkout.
**Base:** `origin/main` @ `edf23f8`
**Related but explicitly out of scope:** draft PR #158 (marketing/measurement),
merged PR #157 (Family Review private storage), the five-step checkout UX audit.
No branch, worktree, or file belonging to those was read for edit or modified.

> No order, Stripe Checkout Session, PaymentIntent, charge, refund, coupon,
> proof, fulfillment job, email, or customer record was created by this review
> or by its tests. No Production/Preview/Vercel/Stripe configuration was read
> or changed. No secret or customer identifier appears in this document.

---

## 1. Incident signature

Verified evidence supplied with the task:

- Production backend processing succeeded at approximately 23:55 CDT on 2026-08-26.
- A pending draft order was created and bound to a Stripe Checkout Session; `/api/order` returned HTTP 200.
- No payment completed, no PaymentIntent was bound, fulfillment never started.
- Production error-level logs showed no matching Stripe/order server failure.

That combination — durable order, bound open session, 200 response, no server
error, no payment — locates the failure strictly *after* the server was done
and *before* the browser reached Stripe.

## 2. The submit path as it stood

`src/app/checkout/checkout-form.tsx` → `handleSubmit`:

1. Guard: `currentStepId !== "review" || !isReadyToPay` → early return.
2. `setIsSubmitting(true)`, clear `submitError`.
3. Synchronous analytics: `track("order_submit_attempt")`, `track("purchase_intent")`.
4. Clear the debounced recovery timer.
5. Build `FormData`; read/create `checkoutAttemptId` in `sessionStorage`.
6. `await fetch("/api/order", …)`.
7. Non-OK → parse the server's specific reason → `throw` → inline error banner.
8. OK → `await response.json()`; `throw` if `redirectTo` is falsy.
9. **`setSuccess(true)`**
10. **`localStorage.removeItem(STORAGE_KEY)`**
11. **`setTimeout(() => { window.location.href = result.redirectTo; sessionStorage.removeItem(attemptStorageKey); }, 1200)`**
12. `finally { setIsSubmitting(false) }`

Steps 9–11 are the whole defect surface.

## 3. Branches that can receive a valid Stripe URL and still fail to navigate

Enumerated against the code above.

| # | Branch | Verdict |
|---|--------|---------|
| B1 | The 1200 ms timer never fires — tab backgrounded, page discarded, phone sleeps, user switches apps. Mobile browsers throttle and may drop pending timers in a hidden document. | **Real.** Primary suspect. The incident was at ~23:55 local. |
| B2 | `localStorage.removeItem` (step 10) throws — Safari private mode, storage disabled, quota. It sits *between* the success state and the timer, and was the only unguarded storage call in the file (`saveProgress`/`loadProgress` both `try/catch`). The throw skips scheduling the navigation entirely, lands in `catch`, and `setSubmitError` renders nothing because `if (success) return <interstitial>` short-circuits the form. | **Real.** Produces exactly the incident signature: order + session created, no payment, no server error, customer parked on "Redirecting to Stripe…" forever. |
| B3 | The user closes/navigates away inside the 1.2 s window while the interstitial says "please don't close this tab". | **Real.** Nothing recoverable was offered. |
| B4 | Double submit — `disabled={isSubmitting \|\| …}` is React state, so two clicks in one batch both read the pre-update value. | **Real but not this incident.** Would create *two* orders, not zero. Fixed anyway; it is the same code path. |
| B5 | `result.redirectTo` present but malformed / non-HTTPS / not Stripe. | **Latent.** Truthiness was the only check; the value was navigated to unvalidated. |
| B6 | Stale closure over `result` in the timer callback. | Not reachable — `result` is a `const` in the same scope and the closure is created after it is assigned. |
| B7 | Effect cleanup / unmount cancelling the hand-off. | Not reachable — the timer id is not stored in a ref and no effect clears it; `recoveryTimerRef` is a different timer, cleared *before* submit. |
| B8 | React StrictMode double-invoking the hand-off. | Not reachable — StrictMode double-invokes effects and renders, not DOM event handlers. Guarded regardless. |
| B9 | Analytics blocking navigation. | Not reachable — `track()` is fully synchronous and internally `try/catch`ed (`src/lib/analytics.ts`), and both calls happen before the fetch. Nothing in the hand-off is awaited. |
| B10 | Popup/new-tab assumptions. | Not applicable — the flow has always been a same-tab assignment. |

**Conclusion: the 1.2 s delay was not the only unsafe boundary.** B2 is an
independent, silent, unguarded failure between success and navigation, and B3
had no recovery affordance. All three are closed by the same change.

## 4. Server-side behaviour relied on (unchanged)

Confirmed in `src/app/api/order/route.ts` and `src/lib/orders.ts`:

- The order id is derived deterministically from `checkoutAttemptId`
  (`sha256(checkoutAttemptId)` → `ord_<16 hex>`), and `persistOrResumeCheckoutOrder`
  resumes rather than duplicates.
- A repeated `checkoutAttemptId` whose order already holds a session retrieves
  it and returns the **same** URL when the session is still `open`; otherwise it
  returns 409 rather than creating a second one.
- Session creation passes `idempotencyKey: hsb_checkout_${order.id}`.
- The redirect URL is released only *after* `bindOrderCheckoutSession` succeeds.

So: retrying with the same attempt id is safe, and following an
already-issued URL cannot create a second order, session, or charge. The fix
depends on this and does not modify it.

## 5. Redirect allowlist model

`checkout.stripe.com` is the only Stripe host this application already
recognises, in both places it matters — `src/app/layout.tsx` (referrer
handling) and `src/lib/analytics.ts` (`unwantedReferralHosts`). There is no
Stripe custom-checkout-domain configuration anywhere in the repository.

`isAllowedStripeCheckoutUrl` therefore accepts a value only when **all** hold:

- it is a non-empty string;
- `new URL(value)` parses it **without a base**, so relative and
  protocol-relative values are rejected rather than resolved against the
  current origin;
- `protocol === 'https:'`;
- no embedded credentials (`username`/`password`);
- `hostname.toLowerCase()` is **exactly** `checkout.stripe.com`.

Exact host equality, deliberately not a suffix test: `endsWith('stripe.com')`
would also accept `checkout.stripe.com.attacker.example`. Rejected shapes are
covered by test: `http:`, `javascript:`, `data:`, `blob:`, `ftp:`, relative,
protocol-relative, lookalike hosts, `stripe.com` itself, URLs merely
*containing* the host in a path or query, and credential-embedding URLs.

**Assumption recorded:** HSB uses no Stripe custom checkout domain. If one is
ever configured, `ALLOWED_STRIPE_CHECKOUT_HOSTS` must be extended in the same
change, or checkout will fail closed for every buyer.

## 6. Telemetry decision — no new events

No handoff telemetry was added. Reasons:

- The consent/analytics surface is being actively reworked in draft PR #158;
  adding an event name and a consent decision here would collide with it.
- The failure is already detectable server-side without new client signal:
  `src/app/api/internal/stranded-scan/route.ts` finds orders holding a bound
  session with no payment — which is precisely this incident's shape.
- The customer-visible fallback below converts the silent failure into a
  recoverable, self-evident one, which is the higher-value fix.

If handoff telemetry is wanted later it must be bounded enums plus route
templates only — never the Stripe URL, session id, order id, query string, or
form payload — and must be fired only after `navigate()` has been called.

## 7. Residual risk

- If the browser accepts the `replace()` call but then silently drops the
  navigation, the attempt id has already been cleared, so a page reload plus a
  fresh submit would create a *new* order. The manual fallback link is the
  mitigation, and it is on screen at that moment. This is not a regression —
  the previous code cleared the attempt id at the same point.
- The exact-host allowlist is a deliberate availability trade: an unannounced
  Stripe host change fails checkout closed rather than redirecting anywhere
  unexpected.
- B2's trigger (throwing `localStorage`) was inferred from the code, not
  observed in a log. It is fixed regardless, and B1/B3 are fixed by the same
  change, so the remediation does not depend on which one fired that night.
