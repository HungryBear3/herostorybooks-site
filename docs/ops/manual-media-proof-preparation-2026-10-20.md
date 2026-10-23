# Manual media-backed story/proof preparation — local candidate only

## Verified flow and exact gap

Canonical base: `819ee1b2dd73f1845006378dbe34a91f948da3e6`.

1. Checkout/payment produces the paid manual-hold order.
2. Existing authenticated `GET /api/admin/orders/[orderId]/intake-assets/[assetId]` retrieves bound private intake bytes. It validates selection fingerprint, category mirrors, retention, path, MIME and size. Retrieval is **implemented**, not missing. Retrieval does not authorize prose generation or customer release.
3. An operator transcribes/interprets the supplied source and authors an exact 24-page digital/classic or 32-page premium story and locked art set. Precision gates still require character/style locks and visual inspection.
4. New local preparation CLI validates the order snapshot and source, decodes every local PNG/JPEG, uses the existing page-set contract and PDF renderer, and emits a byte-hashed candidate. It leaves the order untouched.
5. **Local implementation now present, not deployed:** the authenticated manual-proof endpoint and operator staging CLI below safely adopt this initial candidate into the durable order. Existing generation/rebuild refuses media-backed sources; retry is not an adoption workflow. Existing customer-specific private-review attachment scripts are not a generic import API. Do not edit Blob/order records directly or reuse another customer's attachment script.
6. After an approved adoption implementation, existing page acceptance, proof-version acknowledgment, whole-book approval, private review and separate release gates must remain in effect. Nothing here approves printing or email.

## Local operator usage

No credentials needed. Do not copy secrets into input. Keep authorized order/source files private.

`node --experimental-strip-types scripts/prepare-manual-media-proof.ts ORDER.json SOURCE.json NEW_OUTPUT_DIR`

`SOURCE.json` contains `orderId`, `expectedOrderHash` (`manualProofSourceHash(order)` from `manual-media-proof-contract.ts`: all order fields except workOutbox, updatedAt, and supplemental stripePaymentIntentId), `story` (existing `StoryContent`, including explicit valid page `textLayout`, ordered `pageNum` 1..N), and `images` (one input-root-relative PNG/JPEG filename per story page). Input root is the source JSON's directory. Remote URLs, absolute paths, escaping symlinks and corrupt images fail. Modern layout and the existing exact page-count contract are mandatory. Proof-card overrides are intentionally refused in this initial workflow. Source art is copied into the private new output directory before rendering; output cannot overwrite an existing candidate.

Output: `candidate.pdf`, copied art, and `manifest.json`. Manifest includes exact PDF/art byte sizes and SHA-256, source story, order snapshot hash and candidate version. `local_candidate_not_adopted` is deliberate. The candidate version identifies source inputs, while PDF SHA identifies actual PDF bytes (renderer metadata can differ between runs). Local image references are not production asset URLs. Do not paste manifest into an order.

Revalidate a fresh order snapshot with `assertSnapshotCurrent` before any later adoption. This is an optimistic-concurrency **preparation precondition**, not an atomic store compare-and-swap. A matching local hash alone cannot authorize production publication or prove the order has not changed remotely.

## Adoption implementation decision packet

Required before claiming full test-book readiness (implementation is now local; Preview/live validation and release capability remain outstanding):

- Authenticated order-scoped initial-import boundary, restricted to paid manual-hold media orders with no prior proof/pages/release/provider submission and no active fulfillment claim.
- Exact versioned fresh read plus conditional order commit; reject changed payment, media selection, hold or proof state. Never overwrite/rebase automatically on conflict.
- Bounded private-store uploads whose paths derive from order ID and immutable version, hash and byte-size verification of every uploaded artifact; cleanup only exact newly created orphan objects after failed CAS.
- Map story pages into current page-review model with **zero accepted pages**, empty customer acknowledgments and no release override; preserve all unrelated fields and use current private asset capabilities.
- Bind production proof fingerprint/version to the actual production renderer inputs, not local filenames. Ensure private route authorizes the new objects without exposing public URLs.
- No generated token sent, no proof email, no `proof_approved`/print advancement. Release remains separately authorized through existing gates.
- Synthetic Preview rehearsal with concurrent refund/edit conflicts, partial uploads, duplicate/replayed import, foreign-order assets, private readback and failure rollback. Independent review, then separately approved merge/deploy.

The preparation CLI is local-only. The new adoption route requires independent review, full checks and approved deployment, followed by synthetic Preview verification. Do not ask Alexy to spend money or submit another book as evidence of a workflow that has not yet been deployed and verified.

## Verification

New synthetic offline tests render a 24-page candidate, verify PDF SHA, prove no order mutation, and prohibit fetch. Adversarial tests cover wrong order, stale snapshot, unpaid/refunded/auto/active/released/existing-proof/print states, wrong format, remote and escaping image paths, corrupt images, duplicate/incomplete page identities and output overwrite.

Existing intake retrieval/wiring tests remain part of the focused run. Full TypeScript check is currently blocked by the borrowed dependency tree missing `@playwright/test` and `pg` (and dependent fixture typing); it reports no errors in the new script/test. Do not describe this as a clean full build.


## Local adoption candidate (not deployed)

Endpoint: `POST /api/admin/orders/[orderId]/manual-proof`, using existing admin authentication. Body includes `mode: preflight|adopt`, exact preparation manifest, `expectedManifestHash` (canonical source SHA-256 of entire manifest), and `attestation: reviewed_exact_candidate`. The attestation represents the authorized operator's review of the exact local PDF/art; it is not an automatic visual QA certificate. The body is bounded to 512 KiB even without Content-Length. Invalid input/authentication never stages objects.

Operator command (preflight only by default):

`node --experimental-strip-types scripts/adopt-manual-media-proof.ts PACKAGE_DIR REVIEWED_CANONICAL_MANIFEST_SHA256 BASE_URL`

With explicit `--execute`, the command first performs the authenticated remote preflight, then stages exact validated local bytes create-only to the dedicated private store, then requests atomic adoption. Credentials are read from environment, never arguments/output. Base URL is restricted to HTTPS apex/Vercel preview or loopback HTTP and redirects are refused. Target-scoped credentials must match the deployment being rehearsed; do not mix Production credentials into Preview. Required: `HSB_ORDER_ADMIN_KEY`, and only for execute `HSB_PRIVATE_READ_WRITE_TOKEN` distinct from public Blob token. No credential was used during this development.

Server derives paths from order/candidate/artifact hashes, reads and verifies all private bytes/MIME/image decodes, then makes a fresh order read and one conditional commit using the original ETag. Any edit or refund aborts with no rebase. Successful adoption keeps manual hold and order status unchanged, binds the proof/page references and production source fingerprint, sets in-review with zero accepted pages, and records audit. **No review capability is minted, no customer URL returned, and no proof released.** Separate reviewed capability/release workflow is still needed to expose this to the owner/customer. Existing media regeneration/rebuild remains fail-closed; this change does not promise customer edits work automatically.

Staging is a separate operator capability because ordinary Vercel request bodies cannot reliably carry full-resolution books. The API does not accept caller-supplied Blob paths/URLs. Failed uploads/adoption can leave private unreferenced staging objects. They are not readable through customer review routes. The command never deletes them automatically: a concurrent successful adoption could otherwise lose its assets. Record the exact candidate paths and reconcile order references before separately authorized cleanup. Reruns reconcile existing bytes but never overwrite. A replay after successful adoption refuses because initial-order preconditions no longer hold.

Proof identity deliberately separates candidate source hash from exact PDF byte SHA. Story dedication and arbitrary proof-card overrides are refused because current page-review reconstruction does not preserve them. This keeps the prepared source compatible with existing review fingerprinting; no local filepath is used as the production image identity.

Tests after integration: 108 passed (72 existing intake + 36 new preparation/adoption tests). Synthetic adoption validates matching production proof fingerprint, zero accepted pages/no capability or release, preflight zero writes, unauthorized zero reads, stale edits/refund during read, late CAS conflicts, replay, cross-order binding, manifest tampering, invalid/oversize objects and incorrect private MIME/path/hash. Real private storage, real deployment, customer review release and production end-to-end are not tested here.
