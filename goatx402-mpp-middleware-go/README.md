# MPP Receipt Middleware for the GOAT Flow Integration (Go)

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol; it is not owned or defined by GOAT Flow. This module verifies
the repository-specific signed receipt extension emitted by the current GOAT
Flow MPP integration profile. It is not an official MPP SDK and does not parse
the standard MPP HTTP Credential or generic Receipt representation.

The module verifies GOAT Flow profile evidence and does not interact with buyer
or merchant funds.

Module:

```text
github.com/goatnetwork/goatflow-mpp-middleware-go
```

## Install

This module is source-only in this repository and is not published from a
standalone source repository. Clone `GOATNetwork/x402`, then bind the logical
module path to the checked-in directory:

```bash
go mod edit -require=github.com/goatnetwork/goatflow-mpp-middleware-go@v0.0.0
go mod edit -replace=github.com/goatnetwork/goatflow-mpp-middleware-go=../x402/goatx402-mpp-middleware-go
```

Add the imports shown below, then run `go mod tidy`. The checked-in module
declares Go 1.22.

## Receipt Format

This format is a GOAT Flow integration extension, not the generic MPP Receipt
encoding:

```text
<base64url(JSON(receipt))>.<base64url(raw-signature)>.<algorithm>
```

The base64url segments are unpadded. `algorithm` is `ed25519` or
`hmac-sha256`; the value is not a JWT. The root package exports HTTP
middleware, `FromContext`, rejection constants, and the replay-store contract.
The `receiptspec` subpackage exports the receipt/envelope types plus strict
header/envelope encode/decode and signature helpers.

## Protect a Handler

```go
package main

import (
    "crypto/ed25519"
    "net/http"

    mppmiddleware "github.com/goatnetwork/goatflow-mpp-middleware-go"
    receiptspec "github.com/goatnetwork/goatflow-mpp-middleware-go/receiptspec"
)

func paidHandler(receiptVerificationKey ed25519.PublicKey, store mppmiddleware.ReceiptIDStore) http.Handler {
    middleware := mppmiddleware.Middleware(mppmiddleware.Config{
        MerchantID:     "merchant_123",
        RouteCanonical: "GET:api:data",
        Algorithm:      receiptspec.AlgEd25519,
        Ed25519Public:  receiptVerificationKey,
        ReceiptIDStore: store,
    })

    return middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        receipt, ok := mppmiddleware.FromContext(r.Context())
        if !ok {
            http.Error(w, "missing verified receipt", http.StatusInternalServerError)
            return
        }

        w.Write([]byte(receipt.ReceiptID))
    }))
}
```

For HMAC verification, use `receiptspec.AlgHMACSHA256` and set
`Config.HMACSecret`.

## Verification

The middleware checks:

1. One well-formed `Payment-Receipt` header is present.
2. The configured Ed25519 or HMAC-SHA256 signature is valid.
3. `merchant_id` matches `Config.MerchantID`.
4. `request_canonical` matches `Config.RouteCanonical` exactly or as a
   colon-delimited suffix.
5. The receipt has not expired.
6. When configured, the receipt ID has not already been consumed.

Rejected requests use `application/problem+json` and expose a stable `error`
reason. Signature, audience, malformed receipt, and replay failures use `401`;
route mismatch and expiry use `402`; receipt-store failure uses `503`.

## Replay Protection

`ReceiptIDStore.MarkConsumed` must be concurrency-safe and should be atomic
across replicas. Use Redis `SET NX` with expiry or a database uniqueness
constraint. A process-local map cannot prevent replay between service replicas.

## Operational Hook

`Config.OnReject` receives the request and stable rejection reason before the
response is written. Use it for metrics and server-side logs. It must not write
the response.

`Middleware` panics at construction time for invalid configuration so deployment
errors fail during startup instead of on the first paid request.

See:

- [GOAT Flow MPP integration profile](../docs/mpp.md)
- [Runnable example](./example_test.go)
