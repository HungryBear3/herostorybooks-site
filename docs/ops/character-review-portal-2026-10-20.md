# Character review portal — local implementation, not released

## Exact flow and boundaries

Verified paid order → operator creates character sheet → internal QA of exact PNG and description → private customer invitation → customer approves exact version OR requests changes → durable per-order work queue → operator revises and repeats QA → approved character drives book preparation → **separate finished-book review and print approval**.

This adds customer review and a durable event outbox. It does **not** implement Stripe-to-agent wakeup, Telegram notification, automatic image generation, capability email delivery, queue worker dispatch, production deployment, or provider printing. Queue `pending` means persisted, not started or delivered. Existing un-enrolled orders retain existing behavior; enrollment is explicit, not automatic for every new payment.

## Operator rehearsal (synthetic only until reviewed/released)

1. Generate/QA a PNG character sheet locally. Ensure child identity, recurring family/pets, and style consistency. Describe only customer-facing appearance. No public asset URLs.
2. `node --experimental-strip-types scripts/stage-character-sheet.ts ord_SYNTHETIC sheet.png` validates PNG and displays exact content-addressed pathname and SHA256; no network by default.
3. Separate explicit Preview staging: same command with `--execute`, using **distinct Preview private Blob** credential in `HSB_PRIVATE_READ_WRITE_TOKEN`. Create-only/no overwrite. Never use Production credentials for rehearsal. Staging alone sends nothing and changes no order. Preexisting same-path objects are not blindly overwritten/reused; investigate/read back exact bytes.
4. Authenticated `/admin/orders/ORDER` has a character-review panel. Enter staged hash and customer-facing description, attest internal QA. Server decodes PNG, verifies hash/path, requires paid manual-hold initial unreleased order and exact prior character version. Original order ETag CAS binds whole commit; no retry/rebase.
5. Returned seven-day `/character-review/ORDER#token=...` invitation is **not sent**. Secret exists only in response and browser memory; order stores SHA256 hash. Customer writes use Authorization bearer, never query token; fragment removed immediately. Refresh after removal requires reopening original invitation. Revoking/revising produces a fresh secret and invalidates prior link.
6. Customer sees private proxied image and description, chooses approve or bounded2000-character change request. Image fetch also requires exact loaded version, preventing revision races displaying mismatched art. Decision records and workQueue event commit atomically, with deterministic event id. Same exact replay returns success without duplicate; conflicting decision/comment rejected.
7. Pending current-version `revise_character` needs an operator. New publication supersedes previous queue entries and resets approval. `character_approved` allows preparation only for current approved version. Consumers must re-read authoritative order and match event version/status before starting work. Do not run stale/superseded events.
8. Manual-proof preparation/adoption rejects enrolled unapproved characters. Full-snapshot proof manifest binds approved character state. Once proof/page artifacts exist character replacement is refused; use a separate reviewed re-proof process. Auto-fulfillment transaction also refuses enrolled unapproved state. Neither customer character action changes proof approvals, order fulfillment status, print state, or release capability.

## APIs / privacy

Admin GET/POST `/api/admin/orders/[orderId]/character-review`; shared fail-closed admin auth. GET omits capability hash. POST requires expectedVersion (null initially), exact imageHash, description, attestation `reviewed_exact_character_sheet`. CSRF cross-origin requests rejected. All responses no-store/noindex/no-referrer.
Customer GET/POST `/api/order/[orderId]/character-review`; SHA256-only expiring capability, no legacy fallback. No capability gives403. GET `?asset=image&version=...` serves verified PNG only. POST exact version/action/comment; stale/conflicting decisions409, CAS conflict409. Error details never include storage or credentials. Character analytics path is sanitized to `/character-review/[orderId]`, stripping fragment/query.
History records candidate content hash/description and decisions; max100 journal records limits revision growth. Old artifacts intentionally retained for audit, not automatically deleted. Retention/reclamation and abandoned staged-object cleanup require an explicit safe reconciliation process.

## Verification and release gates

94 focused/regression tests passed (character capability/staging/privacy, analytics boundary, manual preparation/adoption, fulfillment and payment-mode coverage). The borrowed node_modules symlink was replaced ONLY in this isolated worktree with an exact-lock `npm ci`; its former shared target was untouched. Full TypeScript check and credential-free production build now PASS.

Browser verification runs the production Next server on loopback with dotenv disabled and inherited credentials blanked. Customer metadata/decision calls use real routes and filesystem CAS; only private PNG storage is intercepted with synthetic bytes. Desktop and mobile approval/change requests, exact persistence/no proof or print advance, fragment removal and expired invitation denial passed5/5; critical repeat5 run passed25/25. Browser test found Next loopback Request.url authority normalization; origin checking now uses actual Host authority, with cross-origin rejection and dedicated regression test. Never trusts x-forwarded-host. Synthetic mobile rendered screenshot inspected.

Evidence logs: `/tmp/hsb-character-final-regression.log`, `/tmp/hsb-character-typecheck-final.log`, `/tmp/hsb-character-build-isolated.log`, `/tmp/hsb-character-browser-repeat.log`. This is NOT full private-Blob Preview E2E: image proxy hash/read behavior is unit-tested, actual private storage and authenticated admin staging need a synthetic Preview rehearsal. Independent review and exact production release authorization remain required. No live customer invitation was minted or sent.
