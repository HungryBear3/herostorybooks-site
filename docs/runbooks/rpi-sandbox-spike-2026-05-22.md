# RPI Print sandbox spike — 2026-05-22

Read-only / sandbox-only API discovery of the RPI Print "Open API" to
decide whether RPI Self Service can support HeroStoryBooks (HSB)
8.5×8.5 children's books.

**No production credentials were loaded.** Production `RPI_PRODUCTION_*`
vars in `rpi-sandbox.env` were explicitly `unset` before every API call.
All calls used sandbox `Authorization` header only.

## TL;DR

- ✅ Sandbox auth works against `https://open.api.rpiprint.com` with the
  pre-formed `Authorization` header (no `X-Api-Key` needed for sandbox).
- ✅ The Open API exposes order CRUD (`/orders`, `/orders/create`,
  `/orders/{id}`) and accepts cover-PDF + interior-PDF URLs via
  `coverUrl` + `gutsUrl` fields. That matches HSB's existing
  `printInteriorArtifactUrl` / `printCoverArtifactUrl` blob pattern.
- ❌ **No product/SKU/catalog endpoint exists.** SKUs must be sourced
  from the RPI portal/dashboard, not the API. HSB cannot
  programmatically discover which SKU corresponds to 8.5×8.5 softcover
  or hardcover/imagewrap.
- ❌ **No quote / pricing / shipping-rate endpoint exists.** Shipping
  cost is decided server-side at order-create time and returned on the
  order itself (`selectedShipping.price`). HSB cannot pre-quote a
  customer before charging.
- ⚠️ **Sandbox is permissive**: it accepts unknown SKUs + unreachable
  PDF URLs and returns `201 Order received`, then asynchronously
  marks the order `FAILED` with a `validations` array. Two such
  schema-probe orders ended up FAILED in the sandbox during this spike
  (see "Incident" below). Zero charge, zero physical impact.
- 🟡 **Go/no-go: provisional NO without RPI portal access.** We cannot
  validate HSB's 8.5×8.5 spec or estimate end-to-end shipping cost
  without (1) the RPI dashboard SKU list and (2) at least one
  RPI-supplied sample order template. Recommend asking RPI directly
  before any further integration work.

## Endpoints tried

| Method | Path                       | Status    | Notes                                                                   |
| ------ | -------------------------- | --------- | ----------------------------------------------------------------------- |
| GET    | `/`                        | 404       | AWS API Gateway `{"message":"Not Found"}`                               |
| GET    | `/v1*`, `/health`, `/docs`, `/openapi*`, `/swagger.json` | 404 | No discovery surface             |
| GET    | `/products`, `/catalog`, `/skus`, `/items`, `/printproducts`, `/catalogs`, `/pricelist`, `/productinfo`, etc. | 404 | No catalog endpoint |
| GET    | `/shippingrates`, `/shippingmethods`, `/shippingoptions`, `/carriers` | 404 | No shipping-rate endpoint |
| GET    | `/quote`, `/quotes`, `/order/quote`, `/orders/quote`, `/estimates`, `/orderestimate` | 404 | No quote endpoint |
| GET    | `/uploads`, `/upload`, `/printassets`, `/assets`           | 404 | No public upload endpoint reachable (but error message references `printAssetUploadId`, so one likely exists for partners) |
| GET    | `/me`, `/account`, `/version`, `/webhooks*`                | 404 | No metadata/account endpoints |
| GET    | `/orders`                  | **200**   | Paginated list `{totalCount, offset, nextOffset, prevOffset, orders}`   |
| OPTIONS| `/orders`                  | 204       | No `Allow` header — methods masked                                      |
| POST   | `/orders`                  | 404       | Create is NOT on `/orders` — see `/orders/create`                       |
| POST   | `/orders/create`           | 400 → 201 | Schema validation; creates an order once required fields are present    |
| GET    | `/orders/{id}`             | 200 / 404 | Returns full order with `sandbox` flag, `validations` array, `selectedShipping`, `paymentInfo`, `shipmentTracking` |
| DELETE | `/orders/{id}`             | 400       | Cancellation refused once order is FAILED                               |
| POST   | `/orders/{id}/cancel`      | 404       | Cancellation is on `DELETE`, not POST                                   |

## Authentication

- **Required header:** `Authorization: <RPI_SANDBOX_AUTHORIZATION_HEADER>`
  — pre-formed value, 126 chars in the sandbox env file. Almost
  certainly `Basic <base64>` of `api_key:shared_secret`, but the
  pre-built form is sufficient — no need for HSB to reconstruct.
- `X-Api-Key` header alone (with the `RPI_SANDBOX_API_KEY` value)
  returns 401. The pre-formed `Authorization` header is the only
  required auth header for sandbox.
- Sandbox vs production is selected entirely by which credential pool
  is used; the base URL is identical. **Hard rule for HSB:** keep
  `RPI_PRODUCTION_*` and `RPI_SANDBOX_*` in separate env namespaces and
  `unset` the unused one before every call.

## Product / SKU findings

**No product or SKU endpoint exists in the Open API.** The Open API
treats SKUs as opaque strings handed in by the partner. The
`POST /orders/create` validator does NOT pre-check SKU validity —
unknown SKUs are accepted at `201` and then asynchronously moved to
`FAILED` status with `validations[0].humanReadableString = "Validation
failed: Invalid skus provided for order items"`.

Practical implication for HSB:

1. Someone with portal access must enumerate available print-product
   SKUs from the RPI dashboard.
2. We must explicitly verify each SKU's interior dimensions, paper
   stock, binding type, page count limits, and cover finish.
3. If RPI doesn't list an 8.5×8.5 children's-book SKU, HSB has 3 paths:
   - Switch HSB trim to whatever RPI offers closest (likely 8×8 or
     8.5×11). Largest visual change — affects `pdf-builder.ts` panel
     geometry and Lulu cover dimensions.
   - Ask RPI for a custom SKU (slower, possibly requires minimums).
   - Stay on Lulu for 8.5×8.5 and only use RPI for a different format.

## Cost / shipping findings

**No quote endpoint exists.** `selectedShipping.price` and
`paymentInfo.total` are only populated AFTER an order is created —
sandbox orders that fail validation show `0.00`, so we can't even use
sandbox to estimate.

Practical implication for HSB:

1. We cannot show the customer a live shipping cost at checkout
   without either (a) a published RPI rate card per SKU + region or
   (b) a different shipping-quote provider (Lulu sandbox does support
   this).
2. Recommend either a flat-rate baked into HSB pricing or a "shipping
   computed after proof approval" model — which RPI may already
   require.

## 8.5×8.5 support — UNKNOWN

The API gave no signal one way or the other. The schema accepted
`PROBE_NONEXISTENT` SKU. Confirming HSB's actual spec requires:

1. RPI portal SKU enumeration.
2. RPI rep confirmation of:
   - square format support (8.5×8.5 ideal, 8×8 acceptable)
   - 24-page (classic) + 32-page (premium) interiors, full color
   - softcover AND hardcover (imagewrap or printed jacket)
   - cover + guts PDF submission (we already produce both)
   - PDF spec: bleed, safe zones, color profile (CMYK vs RGB)

## Webhook behavior / signature header notes

- `RPI_SANDBOX_WEBHOOK_SECRET` is present in the env file (32 chars,
  likely HMAC). API does not expose any webhook configuration
  endpoint — webhook URLs are presumably registered via the RPI
  dashboard, not the API.
- Webhook signature header name not observable from this spike — we'd
  need to register a sandbox webhook URL (e.g. a temporary
  `webhook.site`) and trigger an event (e.g. an order status
  transition) to observe the signature header convention.
- Standard RPI / industry pattern is `X-Webhook-Signature` or
  `X-Hub-Signature-256` containing `sha256=<hmac-hex>` over the raw
  body using `WEBHOOK_SECRET`. Confirm before wiring.

## Order create schema (extracted from validation errors)

Top level:

| Field                     | Required | Notes                                                        |
| ------------------------- | -------- | ------------------------------------------------------------ |
| `destination`             | ✅        | shipping address object                                       |
| `shippingClassification`  | ✅        | enum: `priority \| express \| standard \| economy` (lowercase) |
| `currency`                | ✅        | must be `"USD"`                                              |
| `orderItems`              | ✅        | non-empty array                                              |
| `reference`               | optional | partner-side ID, not surfaced in error path                   |

`destination`:

| Field         | Required | Notes                                                                 |
| ------------- | -------- | --------------------------------------------------------------------- |
| `name`        | ✅        |                                                                       |
| `country`     | ✅        | **ISO Alpha-2** only (`US`, `CA`, `GB`); `USA` is rejected            |
| `regionCode`  | ✅ (US/CA) | 2-letter (`IL`), OR `state` full name (`Illinois`)                    |
| `city`        | ✅        |                                                                       |
| `postal`      | ✅        | not `zip`                                                             |
| `address1`    | ✅        | not `street1` / not `addressLine1`                                    |

`orderItems[*]`:

| Field           | Required | Notes                                                                                       |
| --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `sku`           | ✅        | partner-provided opaque string; validated asynchronously after create                       |
| `quantity`      | ✅        | integer                                                                                     |
| `orderItemId`   | ✅        | partner-side line-item ID                                                                   |
| `product`       | ✅        | must have ONE OF: (`coverUrl` + `gutsUrl`), `printAssetUploadId`, or `imageUrl`            |
| `printableNumber` | optional | not yet probed                                                                              |

`product` modes:

1. **Cover + guts URLs** — `coverUrl` and `gutsUrl` are public URLs
   that RPI fetches at print time. HSB pattern.
2. **printAssetUploadId** — pre-uploaded asset (upload endpoint not
   discoverable from the public Open API surface).
3. **imageUrl** — single image (not relevant to books).

## Incident — inadvertent sandbox orders

During schema enumeration I assumed the sandbox would reject the fake
SKU `PROBE_NONEXISTENT` before creating an order. It did not. Two
sandbox orders were created during the spike:

| customerOrderId                          | reference                          | status | total |
| ---------------------------------------- | ---------------------------------- | ------ | ----- |
| `b8f9275c-0aa0-4acc-a780-0d81b86827aa`   | _(none)_                           | FAILED | $0.00 |
| `185b44a9-75fb-4761-af34-d72c89f20d42`   | `hsb-sandbox-spike-probe-noop`     | FAILED | $0.00 |

Both:
- Are flagged `sandbox: true` in the order JSON.
- Auto-failed RPI's async post-create validation
  (`"Invalid skus provided for order items"`).
- Have `orderItems: []` server-side (the array was apparently dropped
  during validation rollback).
- Have `paymentInfo.total: 0.00` and `paymentStatus: PENDING`.
- Cannot be cancelled (`DELETE` returns 400 "Order has been marked as
  FAILED and cannot be cancelled"). They will live as failed records
  in the sandbox history forever.

**Zero downstream impact**: no charge, no print job, no shipping
labels. The records exist only as audit history in the RPI sandbox
tenant.

**Process lesson for any future probing**: do not include a non-empty
`product` object (with URLs OR uploadId) until you have confirmed
behavior with a known-failing pre-flight test. RPI does not pre-check
SKUs, so any payload that passes the synchronous schema validator
becomes a sandbox order record.

## Suggested next steps (not done in this spike)

1. **Get RPI dashboard access**: enumerate available children's-book
   SKUs, particularly square formats. Get a sample order template
   from RPI (their own sample PDFs) so a future sandbox dry-run uses
   real geometry.
2. **Confirm webhook signature scheme** by registering a `webhook.site`
   URL in the RPI dashboard and triggering a sandbox status event.
3. **Ask RPI directly**: 8.5×8.5 children's book full-color, 24/32pp,
   softcover + hardcover/imagewrap — do you stock this, with what SKU,
   and what is your PDF spec?
4. **Lulu comparison**: HSB currently uses Lulu for the same spec. Lulu
   provides a quote endpoint and exposes a public product catalog with
   8.5×8.5 SKUs. Keep Lulu as the baseline until RPI can match feature
   parity at the same or lower per-unit cost.

## Go / no-go for HSB

**Provisional NO until RPI portal access + SKU + sample template are
in hand.** RPI's Open API is technically usable from HSB
(`coverUrl + gutsUrl` matches our blob-URL pattern, sandbox auth is
clean, the response shape is friendly), but we cannot pre-quote
shipping, cannot list SKUs, and cannot verify 8.5×8.5 support from the
API alone. Re-evaluate after the RPI dashboard conversation.
