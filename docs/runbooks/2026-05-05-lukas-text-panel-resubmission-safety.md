# Lukas Text-Panel Rebuild Resubmission Safety Runbook

Order: `ord_f5dcffc8a0b84d06`  
Old Lulu job: `2857729`  
Validated local packet: `/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/fix-pass-2026-05-05-text-panel-rebuild`

## Current Decision

Do **not** pay Lulu job `2857729`.

Reason: production order status currently reports `fulfillment=complete`, `status=print_in_production`, `printJobId=2857729`, and its proof URL points at an older `2026-05-04T19-38-20-164Z` artifact — not the validated text-panel rebuild packet.

## Validated Replacement Artifacts

| Artifact | Local file | MD5 |
|---|---|---|
| Proof | `lukas-targeted-fix-proof-local.pdf` | `8bf0f3e4bfd8bcdc3b50523692423880` |
| Print interior | `lukas-targeted-fix-interior-local.pdf` | `a251ff94f09db2d28d7bf181f9a8afdd` |
| Cover | `lukas-targeted-fix-cover-local.pdf` | `07bd65cd9ffa5e2b10e64a7a7bc417d3` |

Validation already passed:

```bash
node --experimental-strip-types --test tests/pdf-builder.test.ts tests/print-interior-renderer.test.ts
node --experimental-strip-types scripts/validate-print-pdf.ts "$OUT/lukas-targeted-fix-proof-local.pdf" "$OUT/lukas-targeted-fix-interior-local.pdf" "$OUT/lukas-targeted-fix-cover-local.pdf"
```

## Safe Resubmission Requirements

Before any new Lulu payment approval:

1. Confirm whether Lulu job `2857729` can be cancelled/ignored without printing the old assets.
2. Upload the three validated PDFs to the production blob namespace under `orders/ord_f5dcffc8a0b84d06/` with stable filenames.
3. Persist order metadata so:
   - `storyArtifactUrl` points to the rebuilt proof URL.
   - `printInteriorArtifactUrl` points to the rebuilt interior URL.
   - `printInteriorMd5 = a251ff94f09db2d28d7bf181f9a8afdd`.
   - `printCoverArtifactUrl` points to the rebuilt cover URL.
   - `printCoverMd5 = 07bd65cd9ffa5e2b10e64a7a7bc417d3`.
4. Clear/supersede old print-job fields only through an explicit recovery path; do not use `rebuild-print-order.ts`, because it correctly refuses already-submitted/in-production orders.
5. Submit a fresh unpaid Lulu job using the rebuilt artifact URLs and MD5s.
6. Confirm the fresh Lulu line item is `ACCEPTED`.
7. Ask Alexy for payment approval for the fresh job only.

## Guardrails

- No whole-book image regeneration.
- Do not mutate production order state in an ad-hoc shell one-liner.
- Do not reuse `2857729` unless Lulu explicitly supports asset replacement for the existing unpaid job and the replacement MD5s can be verified.
- Keep `ord_f5dcffc8a0b84d06` and all MD5s exact in any script/prompt.

## Dedicated Artifact Replacement Script

Implemented one-off script: `scripts/replace-lukas-print-artifacts.ts`.

Dry-run is the default and performs no writes:

```bash
node --experimental-strip-types scripts/replace-lukas-print-artifacts.ts --dry-run
```

Production-order dry-run with live Blob safety checks:

```bash
set -a; source .env.rebuild; set +a
node --experimental-strip-types scripts/replace-lukas-print-artifacts.ts --dry-run
```

Apply command — **do not run unless explicitly approved**:

```bash
set -a; source .env.rebuild; set +a
node --experimental-strip-types scripts/replace-lukas-print-artifacts.ts --apply
```

The script:

- Uploads the three local PDFs to Vercel Blob under `orders/ord_f5dcffc8a0b84d06/` using stable filenames.
- Reads the current order when `BLOB_READ_WRITE_TOKEN` is present.
- Refuses `--apply` unless `id=ord_f5dcffc8a0b84d06`, `paymentStatus=paid`, `refundedAt` is empty, `printJobId=2857729`, and `status=print_in_production`.
- Verifies local MD5s exactly before any mutation.
- Writes the replacement artifact URLs/MD5s and appends a `proof_rebuilt` audit event with `reason=lukas_validated_artifact_replacement`.
- Does **not** submit to Lulu, pay Lulu, clear `printJobId`, modify `paymentStatus`, modify customer/shipping data, regenerate images, regenerate story text, or touch checkout/Stripe/webhooks.
