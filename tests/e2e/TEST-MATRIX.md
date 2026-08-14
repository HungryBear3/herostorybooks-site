# Customer Text-Placement Editor — Regression Test Matrix

Suite built on `origin/main@b94a97d` in the isolated worktree
`cc-worktrees/hsb-customer-text-editor-regression-20260814`
(branch `test/hsb-customer-text-editor-regression-20260814`).

**Files**

| File | Runner | Scope |
| --- | --- | --- |
| `tests/e2e/customer-text-editor-api.spec.ts` | Playwright (API) | 57 direct-HTTP cases; no UI involved |
| `tests/e2e/customer-text-editor.spec.ts` | Playwright (desktop 1280×900) | 25 browser cases |
| `tests/e2e/customer-text-editor.mobile.spec.ts` | Playwright (Pixel 5, touch) | 7 mobile cases |
| `tests/e2e/seed-cli.ts` / `fixtures.ts` | — | Synthetic fixture seeding + shared helpers |
| `tests/proof-layout-stale-cache-regression.test.ts` | `node:test` | 1 case — **expected to fail**, demonstrates a found defect |

Run: `npm run test:e2e` (or `test:e2e:desktop` / `test:e2e:mobile`). The config
builds and starts the app itself.

---

## Requirement → test case

| # | Required scenario | Covered by |
| --- | --- | --- |
| 1 | Valid token access | api: `a valid token applies the override`; ui: `a valid token opens the editor` |
| 2 | Missing token | api: `a missing token is refused 403…`; ui: `a missing token never renders the editor` |
| 3 | Malformed token | api: `a malformed token is refused 403…` |
| 4 | Expired token | **Not applicable — see "Untested / not applicable" below** |
| 5 | Revoked token | api: `a revoked capability (no token on the order) is refused` |
| 6 | Invalid token | api: `an invalid token is refused 403…`, `an empty token…`; ui: `a wrong token never renders the editor or the story text` |
| 7 | Proof-version binding | api: `a stale proof revision is refused 409 stale_revision…` |
| 8 | Proof-fingerprint binding | api: `a stale fingerprint is refused 409 stale_fingerprint…` |
| 9 | Stale proof rejection | api: `a proof whose fingerprint no longer matches its pages…`; ui: `a stale proof does not offer layout editing` |
| 10 | Stale fingerprint rejection | api: `binding_required` group (4 cases: both missing, version-only, fingerprint-only, empty-string) |
| 11 | Cross-order isolation | api: `customer B token cannot read, alter, or reset customer A order` (covers proof-layout, proof-fit, request-help + reset), `A's own valid token still cannot reach B's order` |
| 12 | Moving a text card | ui: `arrow keys move the card by an exact step without resizing it`, `a pointer drag moves the card`; mobile: `a touch drag moves the card…` |
| 13 | Resizing a text card | ui: `Alt+arrow resizes by an exact step without moving the origin`, `dragging the handle grows the card` |
| 14 | Font-size adjustment | ui: `opacity and text size persist exactly as chosen` (`fontScale`, the shipped control) |
| 15 | Opacity adjustment | ui: `opacity and text size persist exactly as chosen`; mobile: `a placement saved on mobile persists server-side` |
| 16 | Text colour adjustment | ui: `an approved text colour is applied and persisted`; api: `an unapproved text colour is refused`; mobile: `the colour swatches are tappable…` |
| 17 | Background colour | **Not exposed by production — see below** |
| 18 | Reset to approved placement | api: `reset removes an applied override and invalidates the proof`, `reset is itself binding-checked…`, `reset with nothing to reset is an idempotent no-op`; ui: `reset is offered only when an override exists, and clears it` |
| 19 | Overflow rejection | api: `text that cannot fit the card is refused before persistence`; ui: `a tiny card with long text warns and blocks save` |
| 20 | Minimum-size / maximum-size | api: `server-side geometry enforcement` → width/height/fontScale/opacity below-min and above-max cases (**clamped**, see policy note) |
| 21 | Page-boundary rejection | api: `x far negative`, `y far negative`, `card overflowing the right edge`, `card pushed into the folio strip`; ui: `the card can never be dragged outside the page-safe area`; ui: `resizing is bounded by the server maximums` |
| 22 | Server-side validation independent of client | The whole `customer-text-editor-api.spec.ts` file — every case is raw HTTP with no UI in the loop |
| 23 | Reload persistence after a write | ui: `a saved placement is what the server hands back on reload`, `an already-applied placement is rendered back into the editor` |
| 24 | Concurrent writes / stale-write conflict | api: `two concurrent applies on the same binding: exactly one wins`, `replaying a consumed revision fails closed`; ui: `a stale tab reports a reload-and-retry error, not internals` |
| 25 | Mobile viewport + touch | `customer-text-editor.mobile.spec.ts` — all 7 cases (viewport fit, 44px targets, colour wrap, touch drag, save, help, lifecycle) |
| 26 | Request-help behaviour | api: `records a durable audit event and is idempotent, with no side effects`, `a nonexistent page index is refused without persistence`; ui: `keeps the editor open and reports status without leaking`; mobile: `request help by tap keeps the editor open on mobile` |
| 27 | Lifecycle lock after approval | api: `approved refuses apply, reset AND request-help without mutation`; ui: `approved does not offer layout editing` |
| 28 | Lifecycle lock in production/fulfilment/closed states | api + ui parametrised over `finalized`, `shipped`, `in_production`, `print_submitted`, `refunded`, `unpaid` |
| 29 | Rejected writes do not partially mutate | Every refusal case re-reads the order and asserts `proofCardOverride === null` and/or an unchanged audit trail; plus `two concurrent applies…` asserts exactly one geometry landed, never a blend |
| 30 | Error states leak nothing | api: `no refusal echoes the token, story text, or internals` (token, story text, e-mail, `proofApprovalToken`, filesystem paths, stack frames); ui: `a wrong token never renders the editor or the story text`, `a stale tab reports a reload-and-retry error, not internals` |

---

## Policy notes — where production differs from the brief

These are documented, **not** worked around. Tests assert what production does.

1. **Min/max/boundary are CLAMPED, not rejected.** Out-of-range numeric geometry
   returns `200` with the value clamped into `PROOF_CARD_BOUNDS` and into the
   safe margin / folio reserve. Only *structurally* invalid geometry (missing
   field, `NaN`, string, array) is refused `422 invalid_geometry`. The suite
   therefore asserts the stronger invariant — *nothing outside the bounds can
   ever be persisted, whatever the client sends* — rather than a rejection that
   production does not perform.

2. **No background-colour control exists.** The customer surface exposes text
   colour as a three-value enum (`dark_brown`, `cream`, `charcoal`); the card
   "background" is a scrim whose only control is `opacity`. Requirement 17 is
   covered as far as production allows, via the opacity and contrast cases.

3. **Font size is a bounded `fontScale` multiplier** (0.85–1.15), not a free
   point size. Requirement 14 is tested against the shipped control.

4. **Low opacity can fail on contrast before bounds.** `opacity: 0.01` is
   refused `422 insufficient_contrast` rather than being clamped to the 0.35
   floor, because the readability gate runs on the resolved colour pair.

---

## Untested / intentionally out of scope

- **Token expiry (requirement 4).** The review capability token has no TTL — it
  is a bearer capability revoked by rotation or clearing, not by elapsed time.
  There is no expiry code path to test. Revocation is covered instead
  (`a revoked capability (no token on the order) is refused`). If a TTL is ever
  added, this row needs a real case.
- **Firefox / WebKit / real iOS Safari.** Only Chromium is exercised (desktop +
  Pixel 5 emulation). Pointer-capture and `touch-action` behaviour genuinely
  differ on WebKit; that is a real gap, not a covered one.
- **Real touch-gesture events.** Playwright's touchscreen API supports taps but
  not multi-point drags, so drag cases use pointer events under a touch-enabled
  mobile context. Pinch/zoom and two-finger gestures are untested.
- **The `next dev` server.** The suite runs against `next build && next start`
  because the dev server does not hydrate this app under test (React loads but
  never attaches, so every interaction silently no-ops). Dev-mode behaviour is
  therefore not covered.
- **Visual/pixel regression.** No screenshot comparison; layout assertions are
  geometric and state-based only.
- **The PDF renderer output.** The suite asserts the fit *decision* returned by
  the authoritative fit route, not rendered PDF bytes. Existing
  `tests/proof-layout-renderer.test.ts` covers the renderer.

---

## Safety properties of the harness

- Fixtures are synthetic: `example.invalid` / `synthetic@example.invalid`, no
  real customer data, no real tokens.
- The seeder refuses to run without an explicit `HSB_ORDER_STORE_DIR` and
  deletes every provider / blob / payment / e-mail credential from its own
  environment before touching anything.
- The Playwright web server is launched with those same credentials blanked and
  `HSB_ORDER_STORE_DIR` pointed at the throwaway `.e2e-store/`.
- `HSB_REQUIRE_DURABLE_PERSISTENCE=false` is set for the e2e server. This is the
  opt-out `src/lib/orders.ts` documents for tests; it changes **where** orders
  are stored and nothing about authorization, lifecycle, freshness, isolation,
  or bounds.
- Every test seeds its own uniquely-named order, so no test can observe another
  test's state and files run in parallel safely.
