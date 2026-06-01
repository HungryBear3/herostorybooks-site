# HSB QA Gate Deployment-State Audit

Audit time: 2026-05-31 19:52 CDT
Worker: Worker B
Deployment under audit: `dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD`
Production domains: `https://herostorybooks.com`, `https://www.herostorybooks.com`
Source branch: `cc-hsb-awaiting-qa-20260531` at `158b39d`

## Verdict

Partially live.

The customer email / proof-release backend gate is live enough to identify the deployed API route: production returns `401 Unauthorized` for unauthenticated `POST /api/admin/orders/ord_fake_audit_qa_gate/qa-pass`, and Vercel deployment output includes `api/admin/orders/[orderId]/qa-pass`. The deployed checkout copy/promo patch is also live.

The QA Production Room itself is not live on `dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD`: `/admin/qa-room` returns `404` on apex, www, and the direct deployment URL, and Vercel deployment output has zero `admin/qa-room` entries. The QA room exists only in source commit `cfa263f`, which was committed at 2026-05-31 19:37:34 CDT, after this production deployment was created at 2026-05-31 19:15:23 CDT.

Do not rely operationally on the QA Production Room until a new production deploy includes `cfa263f` or later and a repeat unauthenticated smoke shows `/admin/qa-room` is present behind the admin sign-in wall.

No live order mutation, proof release, Stripe Checkout Session, Lulu/RPI action, customer contact, or paid action was performed.

## Source Findings

Relevant commit sequence:

- `ddf88f0` / 2026-05-31 13:09:52 CDT: adds `awaiting_qa` fulfillment hold.
- `0344405` / 2026-05-31 18:16:17 CDT: adds QA release route `src/app/api/admin/orders/[orderId]/qa-pass/route.ts`, `releaseOrderAfterQa`, admin detail action, and tests.
- `8818236` / 2026-05-31 18:27:11 CDT: aligns Father’s Day public copy.
- `cfa263f` / 2026-05-31 19:37:34 CDT: adds QA Production Room page/client and `src/lib/qa-room.ts`.
- `a7ee374` / 2026-05-31 19:38:48 CDT: packages checkout promo/source hygiene.
- `158b39d` / 2026-05-31 19:40:15 CDT: adds postdeploy smoke audit doc.

Source branch `158b39d` includes:

- Admin room page: `src/app/admin/qa-room/page.tsx`
- Admin room client: `src/app/admin/qa-room/qa-room-client.tsx`
- QA analysis helpers: `src/lib/qa-room.ts`
- QA-pass API route: `src/app/api/admin/orders/[orderId]/qa-pass/route.ts`
- QA release server action: `releaseOrderAfterQa` in `src/lib/admin-actions.ts`
- Tests: `tests/qa-room.test.ts`, `tests/admin-shipping-proof.test.ts`, plus fulfillment/order-status/checkout coverage

Admin auth assumptions:

- Admin auth is based on `HSB_ORDER_ADMIN_KEY`.
- Admin cookie name is `hsb-ops-key`.
- API routes also accept `x-hsb-order-admin-key`, but this audit did not send or inspect any secret.
- Live `/admin/orders` renders the unauthenticated `Ops sign-in` page, confirming the admin surface is configured behind an auth wall.

Server-side QA release constraints in source:

- Refuses non-paid orders.
- Refuses orders not in `awaiting_qa`.
- Refuses missing proof/digital artifact URL.
- Refuses `storyMeta.source === "template_after_openai_failure"`.
- Requires all checklist flags: story, images, artifact, customer-safe, no-print-release.
- Digital QA pass sends only digital delivery email and marks `complete`.
- Print QA pass creates/uses proof token, sends proof-ready email, and does not release print.
- Manual proof approval and proof resend now require `qaPassAt`.

## Live Checks

Read-only Vercel checks:

```bash
vercel inspect herostorybooks.com --format=json
vercel inspect dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD --format=json
```

Results:

- `herostorybooks.com` resolves to `dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD`.
- Deployment `dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD` is `READY`, target `production`, created 2026-05-31 19:15:23 CDT.
- Deployment output includes:
  - `api/admin/orders/[orderId]/qa-pass`
  - `admin/orders`
  - `checkout`
- Deployment output does not include:
  - `admin/qa-room`

Read-only HTTP checks:

```bash
GET  https://herostorybooks.com/admin/qa-room
GET  https://www.herostorybooks.com/admin/qa-room
GET  https://herostorybooks-site-eg0cg66gn-alexy-kapluns-projects.vercel.app/admin/qa-room
POST https://herostorybooks.com/api/admin/orders/ord_fake_audit_qa_gate/qa-pass
POST https://www.herostorybooks.com/api/admin/orders/ord_fake_audit_qa_gate/qa-pass
POST https://herostorybooks-site-eg0cg66gn-alexy-kapluns-projects.vercel.app/api/admin/orders/ord_fake_audit_qa_gate/qa-pass
GET  https://herostorybooks.com/admin/orders
GET  https://herostorybooks.com/checkout
```

Results:

- `/admin/qa-room`: `404` on apex, www, and direct deployment URL.
- `/api/admin/orders/ord_fake_audit_qa_gate/qa-pass`: `401` JSON `{"error":"Unauthorized"}` on apex, www, and direct deployment URL.
- `/admin/orders`: `200`, unauthenticated `Ops sign-in` page.
- `/checkout`: `200`, includes proof-approval shipping copy and does not include `Digital PDF included`.

The fake order id probe never passed auth, so it could not read or mutate an order.

## Tests Run

```bash
node --experimental-strip-types --test \
  tests/qa-room.test.ts \
  tests/admin-shipping-proof.test.ts \
  tests/fulfillment.test.ts \
  tests/order-status-view.test.ts \
  tests/stripe-checkout.test.ts
```

Result: 97/97 passed. Node emitted only the existing `MODULE_TYPELESS_PACKAGE_JSON` warning.

## Risks

- The QA-pass API route is live, but this audit did not authenticate or execute it against any real order. Its deployed internal logic is inferred from deployment timing/output plus source, not proven by live order transition.
- The QA Production Room is source-only. Operators cannot use `/admin/qa-room` on the current production deployment.
- If a paid order arrives before the room deploy, the automatic fulfillment hold should keep artifacts in `awaiting_qa`, but the intended operator command center is absent from production.
- Existing admin order detail tooling may have QA-pass controls from `0344405`, but using it would be a live order/customer-email release path and was not exercised.
- A new production deploy from `158b39d` would ship the room, but deployment itself is outside this read-only audit scope and needs explicit approval.

## Next Safe Action

Treat `dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD` as a partial QA gate deployment: backend/email hold and QA-pass route are present; QA Production Room is not.

Next safe operational step is to approve and run a no-order-mutation production deploy from source `158b39d` (or later) solely to bring `/admin/qa-room` live, then repeat these non-mutating checks:

- `vercel inspect herostorybooks.com --format=json` confirms the new deployment id.
- `GET /admin/qa-room` returns the admin sign-in wall, not `404`.
- `POST /api/admin/orders/ord_fake_audit_qa_gate/qa-pass` without auth still returns `401`.
- Focused QA tests remain green.

Until that deploy lands, do not rely on the QA Production Room and do not QA-pass/release any customer proof from this audit.
