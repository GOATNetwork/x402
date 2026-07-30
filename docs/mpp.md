# MPP Integration in GOAT Flow

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent,
open protocol for machine-to-machine payments, designed by Tempo and Stripe and
described by an open specification proposed to the IETF. MPP is not owned or
defined by GOAT Flow.

At the protocol level, MPP is payment-method and currency agnostic. Its standard
HTTP exchange is **Challenge -> Credential -> Receipt**: a protected resource
returns an HTTP `402` challenge, the client retries the resource request with a
payment credential, and the resource returns its response with an optional
receipt. See the official [protocol overview](https://mpp.dev/protocol/),
[HTTP transport](https://mpp.dev/protocol/transports/http), and
[receipt specification](https://mpp.dev/protocol/receipts).

This guide documents the **current GOAT Flow MPP integration profile**
implemented by the GOAT Flow SDK and Core. It follows the challenge, payment
evidence, and receipt lifecycle, but its current wire contract is GOAT-specific:

- JSON `POST /mpp/v1/challenge` and `POST /mpp/v1/verify` endpoints replace the
  standard protected-resource Challenge/Credential retry exchange;
- the buyer wallet submits a direct ERC-20 transfer to the merchant recipient;
- Core returns a signed, three-segment `Payment-Receipt` extension.

These endpoints, fields, and the signed receipt encoding are GOAT Flow
implementation contracts, not the generic MPP HTTP wire format or Receipt
schema. No interoperability result with the official MPP SDKs is currently
published. Do not describe `MPPClient` or the middleware as official MPP SDKs,
or assume an arbitrary standards-based MPP client or server can interoperate
without an adapter and conformance testing.

In the current GOAT Flow profile, the buyer transfers tokens **directly to the
merchant's recipient address**. The transfer does not pass through GOAT Flow or
an intermediary contract, and there is no merchant API key on the buyer side.

> **Note on naming:** MPP means **Machine Payments Protocol**. The Go middleware
> package comment that expands it as "Merchant Payment Protocol" is a stale
> source label, not the protocol name.

> **Terminology:** some API and SDK identifiers use `settled` or `settlement`
> for an observed transfer event or block. In this integration, those terms mean
> verified on-chain finality. Buyer funds still move directly to the merchant
> recipient; GOAT Flow observes finality and issues the signed receipt.

---

## 1. GOAT Flow profile: actors and authentication

| Actor | Role | Credentials |
| --- | --- | --- |
| **Buyer / agent** | Requests a challenge, pays on-chain, verifies, then calls the protected route with the receipt | A wallet signer + chain RPC. **No merchant API key.** |
| **GOAT Flow Core** | Implements this profile's challenge and verification endpoints, observes on-chain finality, and issues the GOAT-specific signed receipt | — |
| **Merchant resource server** | Protects its route and verifies the receipt on each request | A receipt-verification key (ed25519 public key or HMAC secret) |

For this profile, the buyer calls `POST /mpp/v1/challenge` and
`POST /mpp/v1/verify` with only a
`Content-Type: application/json` header — these endpoints are public. The merchant
never shares an API key with buyers; trust is carried by the cryptographically
signed receipt.

Here, **public** means no merchant HMAC credential is required; it does not
guarantee arbitrary browser CORS access. Browser MPP requires an explicitly
allowed Core origin that permits `POST` and `Content-Type` and exposes
`Payment-Receipt`; otherwise use a server-side buyer client. The merchant
resource must separately allow the DApp origin and the `Payment-Receipt`
request header.

---

## 2. GOAT Flow discovery extension

> **Merchant side:** merchants publish paid MPP routes in the portal under
> **Payment Setup → Paid API Routes (MPP)**. Supported chains and tokens are
> deployment- and merchant-specific; read the active portal selector and public
> manifest instead of hardcoding a single network. See the
> [Merchant Guide §12.4](./merchant-guide.md#124-paid-api-routes-mpp).

A buyer using this profile discovers a merchant's paid routes from its trusted
**QuickPay manifest**, loaded from the merchant's public agent surface. This is
a GOAT Flow discovery extension, not the generic MPP discovery document:

```text
GET https://flow-quickpay.goat.network/quickpay/<merchant_id>/agent.md
GET https://flow-quickpay.goat.network/quickpay/<merchant_id>/manifest.json
```

The manifest exposes an MPP rail:

```jsonc
{
  "rails": {
    "mpp": {
      "enabled": true,
      "challenge_endpoint": "…",       // deployment metadata
      "verify_endpoint": "…",          // deployment metadata
      "routes": [
        { "route_canonical": "GET:api:data", "...": "..." }
      ]
    }
  }
}
```

Rules:

- Require `rails.mpp.enabled === true`.
- Select an exact `route_canonical` from `rails.mpp.routes` (e.g. `GET:api:data`).
- In QuickPay-driven MPP, **every endpoint is derived from the QuickPay link
  origin**, even when endpoint fields are present. Absolute URLs embedded in
  the manifest are not trusted, so a
  tampered manifest cannot redirect the buyer's transfer instruction to another
  host. The origin must be `https://` except for loopback development.
- Standalone `MPPClient` does not require a QuickPay manifest. Its `coreUrl` is
  the Core/API origin configured for that deployment. A deployment may serve
  standalone Core and QuickPay from different origins.

---

## 3. GOAT Flow challenge endpoint — `POST /mpp/v1/challenge`

Request body:

```json
{
  "merchant_id": "acme",
  "route_canonical": "GET:api:data",
  "request_canonical": "GET:api:data",
  "payer_addr": "0xBuyerWallet"
}
```

For this endpoint, **success is `HTTP 402 Payment Required`** and the JSON body
is the transfer instruction. This is not the standard MPP
`WWW-Authenticate` challenge representation. Any other status is an error. The
response decodes to:

| Field | Type | Meaning |
| --- | --- | --- |
| `challenge_id` | string | Opaque challenge identifier |
| `expiry` | number (unix seconds) | Do not broadcast after this time |
| `amount_wei` | string | Exact ERC-20 amount to transfer |
| `chain_id` | number | Chain the transfer must happen on |
| `token_contract` | string | ERC-20 token address |
| `recipient` | string | Address to pay (the merchant's recipient) |
| `mac` | string | Challenge MAC, echoed back on verify |
| `route_pricing_version` | number | Pricing version bound into the challenge |

The challenge is authoritative for the transfer: use its exact amount, chain,
token contract, recipient, expiry, MAC, and pricing version. The manifest route
is discovery metadata, not permission to reconstruct or override those fields.

---

## 4. GOAT Flow transfer and verification

### 4.1 Pay — one on-chain transfer

Transfer **exactly `amount_wei`** of `token_contract` to `recipient` on
`chain_id`. Do **not** wait for local confirmation before verifying — a slow RPC
could push the wait past `expiry`, after which Core rejects the verification
request as `challenge_expired` even though you broadcast in time. Broadcast,
capture the `tx_hash`, and go straight to verify.

The SDK pre-checks expiry and chain before opening the wallet, so a mismatch fails
fast without a wallet popup (`challenge_expired`, `chain_mismatch`).

### 4.2 Verify — `POST /mpp/v1/verify`

```json
{
  "challenge_id": "…",
  "tx_hash": "0x…",
  "payer_addr": "0xBuyerWallet",
  "mac": "…"
}
```

Response handling:

| Status | Meaning | Action |
| --- | --- | --- |
| `200` | Transfer verified; receipt issued | Read the `Payment-Receipt` response header (required). Done. |
| `202` | Tx pending finality | Back off for `Retry-After`, then poll again |
| `429` | Verify rate-limited | Back off for `Retry-After`, then poll again |
| `4xx` (400/401/404/413) | Terminal | Do not retry; the challenge/tx is rejected |
| `5xx` | Transient | Exponential backoff, then retry |

`Retry-After` is honored but **capped at 30 seconds** so a misbehaving server
cannot stall the client. The SDK's default is **16 verify attempts**, pinned
under Core's per-`(tx_hash, order_id)` budget (18) so the buyer never out-polls
the server. For chains with slow finality (e.g. Ethereum mainnet), operators must
raise Core's `mpp.rate_limit.tx_order_budget` **and** callers must pass an
explicit higher attempt count.

---

## 5. GOAT Flow signed receipt extension

On `200`, the GOAT Flow verify endpoint returns this `Payment-Receipt` header:

```text
<base64url(JSON(receipt))>.<base64url(raw-signature)>.<algorithm>
```

This three-segment value is specific to the current GOAT Flow profile. It is not
the generic MPP Receipt encoding described by mpp.dev. Both base64url segments
are unpadded. The final segment is plain ASCII:
`ed25519` or `hmac-sha256`. This is visually JWT-like, but it is not a JWT and
does not contain a separate JOSE header.

The decoded receipt JSON contains:

- `receipt_id`, `challenge_id`, `order_id`, `merchant_id`, `payer_addr`
- `chain_id`, `token_contract`, `recipient`, `amount_wei`
- `request_canonical`, `tx_hash`, `log_index`, `block_number`
- `block_timestamp`, `receipt_issued_at`, `receipt_expires_at`

An alternative JSON envelope is
`{ "receipt": {...}, "signature": "<base64url>", "algorithm": "ed25519" }`.
Merchant HTTP middleware consumes the header form. Send it to the protected
route:

```text
GET /api/data
Payment-Receipt: <receiptHeader>
```

The merchant middleware validates the receipt and serves the resource.

---

## 6. GOAT Flow buyer adapter (`goatflow-sdk`)

`MPPClient` wraps the whole `challenge → transfer → verify` sequence.

```ts
import { MPPClient, MPPError } from 'goatflow-sdk'
import { ethers } from 'ethers'

const provider = new ethers.BrowserProvider(window.ethereum)
const signer = await provider.getSigner()

const mpp = new MPPClient({
  coreUrl: 'https://flow-api.goat.network', // no trailing slash
  signer,
})

const result = await mpp.pay({
  merchantId: 'acme',
  routeCanonical: 'GET:api:data',
  onPhase: (phase) => console.log(phase), // requesting_challenge, sending_transaction, verifying, verified, ...
})

// Unlock the resource
const res = await fetch('https://acme.example/api/data', {
  headers: { 'Payment-Receipt': result.receiptHeader },
})
```

This example uses the standalone GOAT Flow MPP adapter: `coreUrl` is the
deployment's Core/API origin.
The QuickPay CLI/library instead derives that value from the trusted QuickPay
link origin. In a browser, run this only from an origin allowed by Core CORS;
the default public deployment is not evidence that any DApp origin is allowed.

Lower-level methods are available when you need to drive the steps yourself:
`requestChallenge(...)`, `payChallenge(challenge)`, and
`verifyChallenge(...)`. `payChallenge()` returns `{ txHash, tx }` immediately;
pass its `txHash` to `verifyChallenge()`. The `tx` value is the ethers
`TransactionResponse` used to observe a matching fee-bump replacement without
blocking verification.

### Error model

Every method throws an `MPPError` with a **stable `code`** — branch on the code,
not the message. Common codes: `challenge_expired`, `chain_mismatch`,
`user_rejected`, `payment_failed`, `bad_request`, `verify_timeout`,
`receipt_missing`, `receipt_malformed`, `network_error`.

An application `onPhase` callback can throw outside parts of the SDK error
wrapper and replace the expected `MPPError`. Keep phase callbacks non-throwing
or catch their errors locally.

---

## 7. Recovery — never pay twice

Once the transfer is broadcast, it exists on-chain even if verification later
fails (network blip, timeout). **Do not start a new payment on a verify failure**
— that would issue a fresh challenge and pay again.

When `pay()` fails after broadcast, the thrown `MPPError` carries a `recoverable`
payload — `{ challenge, txHash, payerAddr, tx }`. Resume by calling
`verifyChallenge` with the preserved challenge and tx hash:

```ts
try {
  await mpp.pay({ merchantId, routeCanonical })
} catch (err) {
  if (err instanceof MPPError && err.recoverable) {
    const { challenge, txHash, payerAddr } = err.recoverable
    const result = await mpp.verifyChallenge({ challenge, txHash, payerAddr })
    // use result.receiptHeader
  } else {
    throw err
  }
}
```

There is currently **no resume-verification CLI command**. Recovery is a
library/manual operation — do not re-run `pay-mpp` to recover, as it pays again.

---

## 8. QuickPay CLI (`goatflow-quickpay`)

For agents and scripts, the QuickPay CLI coordinates this profile's discovery, the
buyer-authorized direct transfer, and receipt verification:

```bash
# 1. Inspect a merchant's payment capabilities (machine-readable JSON)
npx goatflow-quickpay inspect https://flow-quickpay.goat.network/quickpay/acme/agent.md --json

# 2. Pay a fixed MPP route
npx goatflow-quickpay pay-mpp https://flow-quickpay.goat.network/quickpay/acme/agent.md \
  --route GET:api:data
```

Notes:

- Provide the payer wallet key via the environment / config, never inline on the
  command line (shell history leaks). Configure the chain RPC the same way.
- Every endpoint the CLI calls (session create/status, MPP challenge/verify) is
  **derived from the origin**; absolute URLs in the manifest are never trusted.
- Post-broadcast MPP failures preserve recoverable challenge and transaction
  context in structured output. There is no resume-verification CLI command, so
  do not rerun payment; reconcile the transaction and use
  `MPPClient.verifyChallenge()` with the preserved context.
- The on-chain step uses `goatflow-sdk` (ethers v6) as an optional dependency.

---

## 9. GOAT Flow middleware — verify the profile receipt

Protect a route using this integration profile by verifying its
`Payment-Receipt` header on every request. This middleware does not parse a
generic MPP Credential or generic MPP Receipt.

### TypeScript (Express)

The middleware packages are distributed as source modules.
`@goatnetwork/mpp-middleware` is not currently available from npm, and the Go
module path is not currently available from the public Go proxy. Build and
consume the source directories locally; do not present the names as
registry-installable packages.

For a sibling TypeScript application:

```bash
cd ../goatx402-mpp-middleware-ts
npm install
npm run build
cd ../your-application
npm install ../goatx402-mpp-middleware-ts express
```

```ts
import express from 'express'
import {
  expressMiddleware,
} from '@goatnetwork/mpp-middleware/express'

const app = express()

app.get(
  '/api/data',
  expressMiddleware({
    merchantId: 'acme',
    routeCanonical: 'GET:api:data',
    algorithm: 'ed25519',
    ed25519Public: receiptVerificationPublicKey, // 32-byte Uint8Array
    store: receiptStore,
  }),
  (req, res) => {
    res.json({
      data: '…',
      receiptId: req.mppReceipt?.receipt_id,
    })
  },
)
```

Fastify uses the separate subpath:

```ts
import {
  fastifyPlugin,
  fastifyPreHandler,
} from '@goatnetwork/mpp-middleware/fastify'
```

The package root exports `verifyReceipt`, `InMemoryReceiptIDStore`,
`decodeHeader`, `decodeEnvelope`, `signingBytes`, and receipt/config types.

### Go

For a sibling Go application, bind the module path to the local source before
resolving it:

```bash
go mod edit -require=github.com/goatnetwork/goatflow-mpp-middleware-go@v0.0.0
go mod edit -replace=github.com/goatnetwork/goatflow-mpp-middleware-go=../x402/goatx402-mpp-middleware-go
```

```go
import (
    "crypto/ed25519"
    "net/http"

    mppmiddleware "github.com/goatnetwork/goatflow-mpp-middleware-go"
    receiptspec "github.com/goatnetwork/goatflow-mpp-middleware-go/receiptspec"
)

middleware := mppmiddleware.Middleware(mppmiddleware.Config{
    MerchantID:     "acme",
    RouteCanonical: "GET:api:data",
    Algorithm:      receiptspec.AlgEd25519,
    Ed25519Public:  ed25519.PublicKey(receiptVerificationPublicKey),
    ReceiptIDStore: receiptStore,
})

handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    receipt, ok := mppmiddleware.FromContext(r.Context())
    if !ok {
        http.Error(w, "missing verified receipt", http.StatusInternalServerError)
        return
    }
    _, _ = w.Write([]byte(receipt.ReceiptID))
}))
```

After adding the imports, run `go mod tidy`.

Both middlewares run these checks in order and reject on the **first** failure:

1. `Payment-Receipt` header present and well-formed.
2. Signature valid under the configured ed25519 public key or HMAC secret.
3. `merchant_id` matches the configured merchant (audience binding — blocks cross-merchant replay).
4. `request_canonical` bound to the configured route, exactly or as a `<route>:<…>` prefix (route binding — blocks cross-resource replay).
5. Receipt not expired (`now < receipt_expires_at`).
6. If a receipt-ID store is configured, `receipt_id` has not been consumed (double-spend defense).

### Rejection contract

| Condition | HTTP status |
| --- | --- |
| Missing / malformed / invalid-signature / audience / replay failure | `401` |
| Route mismatch or expired receipt | `402` |
| Receipt-store outage (cannot check double-spend) | `503` |

**Production note:** running more than one merchant replica requires a **shared,
atomic receipt-ID store** so a receipt cannot be redeemed twice across replicas.

---

## Related

- [Hosted Checkout](./goat-flow-checkout.md) — browser checkout for DIRECT products and sessions
- [API Reference](./goat-flow-api-reference.md) — HMAC-authenticated merchant API
- [DApp Integration Skill](./goat-flow-dapp-integration/SKILL.md) — coding-agent integration workflow
- [QuickPay payer/agent CLI](../goatx402-quickpay/README.md)
- [TypeScript middleware](../goatx402-mpp-middleware-ts/README.md)
- [Go middleware](../goatx402-mpp-middleware-go/README.md)
