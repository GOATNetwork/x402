# MPP Receipt Middleware for the GOAT Flow Integration

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol; it is not owned or defined by GOAT Flow. This package verifies
the repository-specific signed receipt extension emitted by the current GOAT
Flow MPP integration profile. It is not an official MPP SDK and does not parse
the standard MPP HTTP Credential or generic Receipt representation.

The package verifies GOAT Flow profile evidence and does not interact with
buyer or merchant funds.

Package name:

```text
@goatnetwork/mpp-middleware
```

The package exposes a framework-agnostic verifier plus separate Express and
Fastify entry points.

## Install

This package is source-only in this repository and is not included in the npm
release runbook. As of July 21, 2026, the package name is not available from the
public npm registry. Build and install the checked-in directory locally instead
of treating the name as a published dependency. From a sibling application:

```bash
cd ../goatx402-mpp-middleware-ts
npm install
npm run build
cd ../your-application
npm install ../goatx402-mpp-middleware-ts
```

Install `express` or `fastify` in the application that uses the corresponding
adapter.

## Receipt Format

This format is a GOAT Flow integration extension, not the generic MPP Receipt
encoding:

```text
<base64url(JSON(receipt))>.<base64url(raw-signature)>.<algorithm>
```

The base64url segments are unpadded. `algorithm` is the plain string
`ed25519` or `hmac-sha256`; this is not a JWT. The package root exports
`Receipt`, `Envelope`, `decodeHeader`, `decodeEnvelope`, and `signingBytes`.

## Express

```ts
import express from "express";
import { expressMiddleware } from "@goatnetwork/mpp-middleware/express";

const app = express();

app.get(
  "/api/data",
  expressMiddleware({
    merchantId: "merchant_123",
    routeCanonical: "GET:api:data",
    algorithm: "ed25519",
    ed25519Public: receiptVerificationPublicKey,
    store: receiptStore,
  }),
  (req, res) => {
    res.json({
      paid: true,
      receiptId: req.mppReceipt?.receipt_id,
    });
  },
);
```

## Fastify

```ts
import Fastify from "fastify";
import { fastifyPreHandler } from "@goatnetwork/mpp-middleware/fastify";

const app = Fastify();

app.get("/api/data", {
  preHandler: fastifyPreHandler({
    merchantId: "merchant_123",
    routeCanonical: "GET:api:data",
    algorithm: "hmac-sha256",
    hmacSecret,
    store: receiptStore,
  }),
}, async (request) => ({
  paid: true,
  receiptId: request.mppReceipt?.receipt_id,
}));
```

`fastifyPlugin` is also available for an encapsulated group of routes. Prefer
per-route configuration when each route has a different canonical identifier.

## Verification

The middleware checks:

1. `Payment-Receipt` is present and parseable.
2. The Ed25519 or HMAC-SHA256 signature is valid.
3. `merchant_id` matches the configured merchant.
4. `request_canonical` matches the configured route exactly or as a
   colon-delimited suffix.
5. The receipt has not expired.
6. When configured, `receipt_id` has not already been consumed.

Stable rejection reasons:

| HTTP | Reason |
| ---: | --- |
| `401` | `payment_required`, `invalid_payment_receipt`, `invalid_signature`, `audience_mismatch`, `receipt_already_consumed` |
| `402` | `route_mismatch`, `receipt_expired` |
| `503` | `receipt_store_unavailable` |

The wire response contains only `{ "error": "<reason>" }`. Use `onReject` for
operator diagnostics; never reflect its untrusted `detail` value to clients.

## Replay Protection

`InMemoryReceiptIDStore` is suitable only for tests and a single process. A
multi-replica production service needs an atomic shared store such as Redis or a
database unique constraint with TTL.

## Core Verifier

```ts
import {
  decodeHeader,
  verifyReceipt,
} from "@goatnetwork/mpp-middleware";

const result = await verifyReceipt(config, paymentReceiptHeader);
if (!result.ok) {
  console.error(result.status, result.reason);
}

const decoded = decodeHeader(paymentReceiptHeader);
console.log(decoded.receipt.receipt_id, decoded.algorithm);
```

See [GOAT Flow MPP integration profile](../docs/mpp.md) for the implemented
buyer, challenge, transfer, and receipt lifecycle.
