# GOAT Flow Integration Guide

This is the detailed integration guide for the GOAT Flow API and SDKs.
Use the [Developer Quick Start](./goat-flow-developer-quickstart.md) for a first
payment and the [API Reference](./goat-flow-api-reference.md) for field-level wire
contracts.

## Contents

1. [System boundaries](#1-system-boundaries)
2. [Packages and versions](#2-packages-and-versions)
3. [Integration surfaces](#3-integration-surfaces)
4. [DIRECT order flow](#4-direct-order-flow)
5. [Server SDK integration](#5-server-sdk-integration)
6. [Browser order integration](#6-browser-order-integration)
7. [Hosted Checkout](#7-hosted-checkout)
8. [QuickPay](#8-quickpay)
9. [MPP](#9-mpp)
10. [Authentication](#10-authentication)
11. [Order lifecycle](#11-order-lifecycle)
12. [Errors and retries](#12-errors-and-retries)
13. [Production checklist](#13-production-checklist)
14. [Known compatibility notes](#14-known-compatibility-notes)

## 1. System boundaries

GOAT Flow is the product name. x402 is the payment-challenge protocol used by
the order surfaces. [MPP](https://mpp.dev/overview) is a separate, independent
open protocol. The GOAT Flow MPP components implement the current integration
profile. Public packages use `goatflow-*`; repository directories, protocol
fields, and fixed environment variables may retain `goatx402`.

```text
Merchant backend
  |
  | HMAC-authenticated order / checkout / status / proof API
  v
GOAT Flow merchant API
  |
  | x402 payment terms
  v
Merchant frontend or hosted page
  |
  | User-authorized ERC-20 transfer
  v
EVM chain
  |
  | Watcher / verifier observes and validates the transfer
  v
GOAT Flow order state / Payment-Receipt
```

Security boundaries:

- Merchant API key and secret exist only on the backend.
- The browser receives payment terms, never merchant credentials.
- A wallet transaction hash is not a fulfillment decision.
- Backend status/proof, an authenticated deployment-defined webhook, or the
  GOAT Flow MPP profile's `Payment-Receipt` extension is the authoritative
  completion signal for the corresponding surface.

## 2. Packages and versions

| Package/module | Role | Current manifest/runtime |
| --- | --- | --- |
| `goatflow-sdk-server` | TypeScript merchant backend | `0.3.0`, Node >= 18 |
| `github.com/goatnetwork/goatflow-sdk-server` | Go merchant backend | Go 1.25, source-only |
| `goatflow-sdk` | Browser wallet, ERC-20, MPP | `0.2.1`, ethers `^6.9.0` |
| `goatflow-checkout` | Hosted Checkout opener | `0.1.0` |
| `goatflow-quickpay` | Public payer/agent library and CLI | `0.3.0`, Node >= 18 |
| `@goatnetwork/mpp-middleware` | Merchant MPP middleware | `0.1.0` |

Use package manifests and exported types as the version source of truth. Do not
copy version numbers into application compatibility logic.

## 3. Integration surfaces

### 3.1 Hosted Checkout

Use when the application should rely on GOAT Flow-hosted checkout software for
wallet connection and transfer UX. Your backend creates dynamic sessions;
fixed QuickPay products can open directly.

### 3.2 Custom order flow

Use when the merchant builds its own wallet and transfer UI. The backend creates
the order and maps it to the browser SDK `Order`; the buyer's browser submits
the transfer.

### 3.3 QuickPay

Use for public payer links, products, custom amounts, agents, and CLI payments.
The payer discovers a same-origin manifest and does not need merchant API
credentials.

### 3.4 MPP

Use the current GOAT Flow MPP profile for paid API routes. The buyer obtains the
profile's JSON challenge, submits a direct transfer, asks Core to verify the
transaction, and attaches the returned signed `Payment-Receipt` extension to
the protected request. This is not the standard MPP
Challenge/Credential/Receipt HTTP wire exchange.

## 4. DIRECT order flow

The DIRECT order flow is:

1. Backend creates an order.
2. Core returns an x402 challenge with `payTo`.
3. Browser transfers the token to the merchant receiving address.
4. Core observes the transfer and advances order state.

Flow identifier: `ERC20_DIRECT`.

## 5. Server SDK integration

### 5.1 TypeScript client

```ts
import { GoatFlowClient } from 'goatflow-sdk-server'

const client = new GoatFlowClient({
  baseUrl: process.env.GOATX402_API_URL ?? 'https://flow-api.goat.network',
  apiKey: process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})
```

Create an order:

```ts
const order = await client.createOrder({
  dappOrderId: `order_${Date.now()}`,
  chainId: 2345,
  tokenSymbol: 'USDC',
  tokenContract: '0xToken',
  fromAddress: '0xPayer',
  amountWei: '10000000',
})
```

`createOrder()` accepts the successful HTTP `402` response and normalizes the
first x402 payment option. Use `createOrderRaw()` for the literal x402 object.

Operator-provisioned callback orders are outside public merchant onboarding.
When a deployment contract explicitly enables one, follow the complete fields,
EIP-712 signing, signature-submission endpoint, and chain-switching rules in
the [API Reference appendix](./goat-flow-api-reference.md#appendix-a-operator-provisioned-callback-compatibility).

Read status and proof:

```ts
const orderStatus = await client.getOrderStatus(order.orderId)

const fulfillable =
  orderStatus.status === 'PAYMENT_CONFIRMED' ||
  orderStatus.status === 'INVOICED'

if (fulfillable) {
  const proof = await client.getOrderProof(order.orderId)
}
```

Cancel only while pending:

```ts
const orderStatus = await client.getOrderStatus(order.orderId)

if (orderStatus.status === 'CHECKOUT_VERIFIED') {
  await client.cancelOrder(order.orderId)
}
```

### 5.2 TypeScript errors

```ts
import { GoatFlowError } from 'goatflow-sdk-server'

try {
  await client.createOrder(params)
} catch (error) {
  if (error instanceof GoatFlowError) {
    console.error(error.status, error.code, error.responseBody)
  }
}
```

For authenticated HTTP failures, the client parses `error` or `message`,
attaches `status`, optional `code`, and runtime `responseBody`, and names the
runtime-exported error `GoatFlowError`. `instanceof GoatFlowError` is supported.
Fetch failures may remain native errors.

### 5.3 Go client

```go
client := goatflow.NewClient(goatflow.Config{
    BaseURL:   os.Getenv("GOATX402_API_URL"),
    APIKey:    os.Getenv("GOATX402_API_KEY"),
    APISecret: os.Getenv("GOATX402_API_SECRET"),
})

order, err := client.CreateOrder(ctx, goatflow.CreateOrderParams{
    DappOrderID:  "order_123",
    ChainID:      2345,
    TokenSymbol:  "USDC",
    TokenContract: "0xToken",
    FromAddress:  "0xPayer",
    AmountWei:    "10000000",
})
if err != nil {
    var apiErr *goatflow.APIError
    if errors.As(err, &apiErr) {
        log.Printf(
            "status=%d code=%s body=%s",
            apiErr.Status,
            apiErr.Code,
            apiErr.ResponseBody,
        )
    }
    return err
}
```

The Go client also exposes:

- `CreateOrderRaw`
- `CreateCheckoutSession`
- `GetOrderStatus`
- `GetOrderProof`
- `CancelOrder`
- `GetMerchant`
- `WaitForConfirmation`
- `SetHTTPClient`

Go HTTP failures are returned as `*goatflow.APIError`; use `errors.As`.
Transport and JSON failures are wrapped Go errors.

### 5.4 Polling and HTTP compatibility differences

| Behavior | TypeScript | Go |
| --- | --- | --- |
| First status read | Immediate | After the first interval tick |
| Status-read error while polling | Transient errors retried; deterministic 4xx surfaced | Suppressed and retried |
| Status callback | `onStatusChange` | None |
| Cancellation | Overall timeout plus per-request deadline | Timeout or `context.Context` |
| Built-in terminal states | `PAYMENT_CONFIRMED`, `INVOICED`, `FAILED`, `EXPIRED`, `CANCELLED` | Same |
| First-party request deadline | 30 seconds, bounded by remaining wait timeout | 30-second default HTTP client; replaceable |
| Authenticated HTTP success | Any `2xx`; `402` only for order creation | Exactly `200`; `402` only for order creation |

TypeScript retries request timeouts, network failures, `408`, `429`, and server
errors within the overall wait deadline; other deterministic 4xx errors are
surfaced immediately. Go currently retries all status-read errors.

## 6. Browser order integration

### 6.1 Do not pass the server order unchanged

The server SDK `Order` has:

- `fromChainId`
- `payToChainId`
- no `fromAddress`

The browser SDK `Order` requires:

- `chainId`
- `fromAddress`

Map a minimal object:

```ts
import type { Order as ServerOrder } from 'goatflow-sdk-server'
import type { Order as ClientOrder } from 'goatflow-sdk'

export function toClientOrder(
  order: ServerOrder,
  fromAddress: string,
): ClientOrder {
  return {
    orderId: order.orderId,
    flow: order.flow,
    tokenSymbol: order.tokenSymbol,
    tokenContract: order.tokenContract,
    fromAddress,
    payToAddress: order.payToAddress,
    chainId: order.fromChainId,
    amountWei: order.amountWei,
    expiresAt: order.expiresAt,
    calldataSignRequest: order.calldataSignRequest,
  }
}
```

Avoid `{ ...serverOrder, fromAddress, chainId }`; an explicit allowlist makes the
boundary reviewable and prevents internal/raw fields from leaking.

### 6.2 Validate before payment

`PaymentHelper.pay()` does not validate chain, payer, or expiry.

```ts
async function validateOrder(
  order: ClientOrder,
  provider: ethers.BrowserProvider,
  signer: ethers.Signer,
): Promise<void> {
  const network = await provider.getNetwork()
  if (Number(network.chainId) !== order.chainId) {
    throw new Error(`Wallet is on ${network.chainId}; order requires ${order.chainId}`)
  }

  const payer = await signer.getAddress()
  if (payer.toLowerCase() !== order.fromAddress.toLowerCase()) {
    throw new Error('Connected wallet does not match the order payer')
  }

  if (Math.floor(Date.now() / 1000) >= order.expiresAt) {
    throw new Error('Order expired')
  }
}
```

### 6.3 Pay

```ts
import { PaymentHelper } from 'goatflow-sdk'
import { ethers } from 'ethers'

const provider = new ethers.BrowserProvider(window.ethereum)
const signer = await provider.getSigner()
await validateOrder(order, provider, signer)

const payment = new PaymentHelper(signer)

const result = await payment.pay(order)
if (!result.success) {
  throw new Error(result.error ?? 'Payment failed')
}
```

Actual `pay()` behavior:

1. Read signer address.
2. Read token balance.
3. Return failure if balance is insufficient.
4. Submit `transfer(payToAddress, amountWei)`.
5. Wait for a receipt.
6. Require receipt status `1`.
7. Return `txHash`.

The method catches errors and normally returns `{ success: false, error }`
instead of throwing them.

`PaymentHelper.pay()` treats every `tx.wait()` exception as failure and does not
classify `TRANSACTION_REPLACED`. A successful wallet speed-up can therefore
look failed. Reconcile the original/replacement hash and backend order before
considering another transfer.

### 6.4 ERC-20 approval helpers

Order payment itself uses `transfer()` and does not require an allowance.
Approval helpers are for other integration needs.

```ts
const exactTx = await payment.approveToken(token, spender, amount)
const unlimitedTx = await payment.approveToken(
  token,
  spender,
  amount,
  { unlimited: true },
)
```

The helper:

- validates `bigint` and uint256 bounds before any transaction
- skips writes when the target allowance is already set
- uses a direct-write `eth_call` probe
- falls back to confirmed `approve(0)` only when required
- follows matching fee-bump replacements

Use `ERC20Token.setApproval()` when the reset transaction hash is also needed.

## 7. Hosted Checkout

### 7.1 Fixed product

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://flow-quickpay.goat.network' })

goat.open({
  merchant: 'merchant_123',
  productKey: 'mug',
  clientReferenceId: 'cart_123',
  onSuccess(result) {
    // UX only
    console.log(result)
  },
})
```

### 7.2 Dynamic DIRECT session

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: '19.95',
  clientReferenceId: 'cart_123',
  lineItems: [{ name: 'Mug', amount: '19.95', quantity: 1 }],
  publicMetadata: { campaign: 'summer' },
  privateMetadata: { internalCartId: 'db-42' },
})

// Browser:
goat.open({ checkoutId: session.checkoutId })
```

The SDK serializes nested values into signed JSON strings.

The response exposes `checkoutType` as `string`; handle unknown future values
explicitly. Public integrations create `DIRECT` sessions. Operator-provisioned
compatibility fields, deprecated wrappers, signature submission, and the
`callback_template` trust boundary are documented in the
[API Reference appendix](./goat-flow-api-reference.md#appendix-a-operator-provisioned-callback-compatibility).

### 7.3 Hosted security model

- `origin` must be a bare HTTPS origin; HTTP is allowed only for loopback.
- The opener accepts messages only from the configured origin, exact popup
  source, and matching nonce.
- A server-created checkout ID is an opaque bearer capability.
- Product and checkout-session prices are server-authoritative.
- Browser callbacks are non-sensitive UX events, not proof of payment.

## 8. QuickPay

The canonical public link shape is:

```text
https://flow-quickpay.goat.network/quickpay/{merchant_id}/agent.md
```

The package:

1. Validates the URL scheme and canonical path.
2. Takes the merchant ID from the trusted URL path.
3. Derives the same-origin manifest URL.
4. Validates the manifest merchant ID and rail data.
5. Derives session/MPP endpoints from the same origin.

```ts
import { QuickPayClient, EthersPaymentBackend } from 'goatflow-quickpay'

const quickpay = new QuickPayClient(
  'https://flow-quickpay.goat.network/quickpay/merchant_123/agent.md',
)

const manifest = await quickpay.loadManifest()
const inspected = await quickpay.inspect()
```

The raw session API uses snake_case:

```json
{
  "merchant_id": "merchant_123",
  "payer_addr": "0xPayer",
  "chain_id": 2345,
  "token_contract": "0xToken",
  "amount_wei": "10000000",
  "memo": "invoice-123",
  "idempotency_key": "invoice-123:payer"
}
```

`QuickPayClient` methods do not accept that object. `payX402()` uses
`amount`, `chainId`, `tokenSymbol`/`tokenContract`, `memo`, and
`idempotencyKey`; `payProduct()` uses `productKey`, chain/token selection, and
optional `idempotencyKey`. The client derives `merchant_id` from the trusted URL
and `payer_addr` from the payment backend. There is currently no
`clientReferenceId` library option.

CLI:

```bash
npx goatflow-quickpay inspect <quickpay-url>
npx goatflow-quickpay pay-x402 <quickpay-url> --amount 10 --token USDC --chain 2345
npx goatflow-quickpay pay-product <quickpay-url> --product mug --token USDC --chain 2345
npx goatflow-quickpay pay-mpp <quickpay-url> --route GET:api:data
```

Product mode uses the manifest's decimal `price` and the chosen token decimals.
Custom amount mode is untrusted for automatic fulfillment unless the backend
reconciles the actual paid amount.

QuickPay session terminal states are `PAYMENT_CONFIRMED`, `EXPIRED`, `FAILED`,
and `CANCELLED`; they are separate from Server SDK order states. Status polling
uses `pollTimeoutMs` as a hard cap, retains known transaction hashes across
transient failures, and performs five bounded grace polls when a known
transaction is reported `EXPIRED`. Reconcile by session ID and transaction hash
instead of rebroadcasting after an ambiguous failure.

## 9. MPP

MPP itself is an independent, payment-method-agnostic open protocol. This
section documents the current GOAT Flow adapter, not a generic or official
MPP SDK. Its `/mpp/v1/challenge` and `/mpp/v1/verify` JSON endpoints and signed
three-segment receipt are deployment-specific contracts.

### 9.1 High-level flow

```ts
import { MPPClient } from 'goatflow-sdk'

const mpp = new MPPClient({
  coreUrl: 'https://flow-api.goat.network', // no trailing slash
  signer,
})

const result = await mpp.pay({
  merchantId: 'merchant_123',
  routeCanonical: 'GET:api:data',
  requestCanonical: 'GET:api:data:user-42',
  onPhase: (phase, detail) => console.log(phase, detail),
})
```

`requestCanonical` defaults to `routeCanonical`. When present, it must preserve
the route prefix accepted by Core.

For the standalone GOAT Flow `MPPClient` adapter, `coreUrl` is the configured
Core/API origin for the deployment. The QuickPay `pay-mpp` adapter instead sets
`coreUrl` to the trusted
QuickPay link origin so manifest, challenge, and verify stay same-origin. Do not
assume those two deployment origins are universally the same.

### 9.2 Challenge

The GOAT Flow profile's `POST /mpp/v1/challenge` returns HTTP `402` on success.

The client decodes:

- `challenge_id`
- `expiry` (and legacy `expiry_unix`)
- `amount_wei`
- `chain_id`
- `token_contract`
- `recipient`
- `mac`
- `route_pricing_version`

These challenge fields are authoritative for the payment. Route data in a
manifest is discovery metadata; after challenge issuance, do not override the
amount, chain, token, recipient, expiry, MAC, or pricing version.

### 9.3 Broadcast

Before broadcasting, `payChallenge()` checks:

- signer has a provider
- challenge has not expired
- provider chain matches challenge chain

It submits the buyer-authorized ERC-20 transfer and returns the broadcast hash
immediately. It does not wait for a local receipt because
`/mpp/v1/verify` confirms on-chain finality for this integration profile and
issues its signed receipt. It does not hold or release the transferred tokens.

### 9.4 Verify and retry

`POST /mpp/v1/verify` behavior:

| Response | Behavior |
| --- | --- |
| `200` + `Payment-Receipt` | Decode and return receipt |
| `202` | Retry using `Retry-After` |
| `429` | Retry using `Retry-After` |
| other `4xx` | Terminal `MPPError` |
| `5xx` | Bounded exponential backoff |
| network rejection | Bounded exponential backoff |

Default maximum attempts: 16. Maximum per-wait delay: 30 seconds.

The transfer replacement watcher follows only a replacement with the same
destination and calldata. A user cancellation or unrelated same-nonce
transaction is not treated as the challenged transfer.

### 9.5 Recovery after broadcast

```ts
import { MPPError } from 'goatflow-sdk'

try {
  await mpp.pay(params)
} catch (error) {
  if (error instanceof MPPError && error.recoverable) {
    const recovered = await mpp.verifyChallenge(error.recoverable)
    console.log(recovered.receiptHeader)
    return
  }
  throw error
}
```

Once a transfer has been broadcast, do not call `pay()` again merely because
verification failed. Preserve and resume the challenge/transaction context.

Browser Core CORS must allow the DApp origin and expose the `Payment-Receipt`
response header. The protected resource must allow that origin and the
`Payment-Receipt` request header.

## 10. Authentication

The server SDKs produce:

```text
X-API-Key: <api-key>
X-Timestamp: <unix-seconds>
X-Nonce: <unique-request-id>
X-Sign: <hmac-sha256-hex>
```

The signed parameter set contains:

- every non-null top-level body field converted to string
- `api_key`
- `timestamp`
- `nonce`

Keys are sorted and joined as `key=value&...`; empty strings and `sign` are
excluded.

Hosted Checkout nested fields are JSON-stringified because this signing scheme
does not canonicalize nested JSON.

Operational rules:

- Generate a new nonce for every request.
- Keep system time synchronized.
- Never log the API secret or full credential set.
- Avoid custom signing unless cross-validated against both SDK tests.

## 11. Order lifecycle

Current TypeScript status values include:

```ts
type OrderStatus =
  | 'CHECKOUT_VERIFIED'
  | 'PAYMENT_CONFIRMED'
  | 'INVOICED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
```

Recommended application classification:

| Class | Status |
| --- | --- |
| Pending | `CHECKOUT_VERIFIED` |
| Confirmed success | `PAYMENT_CONFIRMED`, `INVOICED` |
| Failure/closed | `FAILED`, `EXPIRED`, `CANCELLED` |

Server SDK order waiters treat `INVOICED` as a successful terminal state. Core
can advance a DIRECT order from `PAYMENT_CONFIRMED` to `INVOICED` inside one
watcher transaction, so polling code must not require observing both states.
Do not assume every deployment exposes each transition.

`cancelOrder()` is documented for `CHECKOUT_VERIFIED`. Reservation restoration,
fee refunds, and automatic-expiration effects are not part of the public SDK
contract; confirm them with the active API before relying on them.

## 12. Errors and retries

### 12.1 Merchant API

| HTTP | Treatment |
| --- | --- |
| `400` | Validation/business error; inspect body |
| `401` | HMAC/timestamp/nonce failure |
| `402` | Success only for documented challenge endpoints |
| `403` | Ownership/authorization failure |
| `404` | Resource not found |
| `5xx` | Caller-managed bounded retry for idempotent operations |

Do not blindly retry order creation without a stable merchant
`dappOrderId`/idempotency strategy.

Both server SDKs fail closed on unexpected authenticated `402` responses.
Individual merchant API calls do not retry automatically.
`waitForConfirmation()` retries eligible status-read failures within its
overall deadline; Go `WaitForConfirmation` currently retries all status-read
errors. This differs from the MPP verifier, which has its own bounded retry
policy.

### 12.2 Browser order payment

`PaymentHelper.pay()` returns payment failures:

```ts
const result = await payment.pay(order)
if (!result.success) {
  console.error(result.error)
}
```

Wallet user rejection, RPC errors, transfer reverts, and failed receipts are
converted to the `error` string.

### 12.3 MPP

MPP methods throw `MPPError`. Branch on `code`, not message. Important codes
include:

- `network_error`
- `parse_error`
- `bad_request`
- `invalid_request`
- `route_not_found`
- `chain_mismatch`
- `user_rejected`
- `payment_failed`
- `challenge_expired`
- `challenge_already_consumed`
- `challenge_tx_hash_mismatch`
- `payer_mismatch`
- `verify_timeout`
- `service_unavailable`
- `receipt_missing`
- `receipt_malformed`

Application `onPhase` callbacks can throw outside the SDK's error wrapper and
replace the expected `MPPError`, including during the `failed` phase. Keep
phase callbacks non-throwing or catch their errors locally.

## 13. Production checklist

1. Keep merchant credentials in a backend secret store.
2. Use separate credentials and origins per environment.
3. Derive amount/token/chain from server-side product/cart data.
4. Map server orders to browser orders with an explicit allowlist.
5. Validate chain, payer, and expiry before `PaymentHelper.pay()`.
6. Treat authenticated `PAYMENT_CONFIRMED` and `INVOICED` order states as
   successful terminals, while validating all expected order fields.
7. Fulfill idempotently from trusted server evidence.
8. Cancel abandoned `CHECKOUT_VERIFIED` orders.
9. Monitor merchant fee-balance errors.
10. Treat checkout IDs and QuickPay session IDs as capabilities.
11. For the browser MPP adapter, allow the DApp origin on Core and the protected resource,
    expose the response `Payment-Receipt`, allow that request header, and retain
    recoverable verify context after broadcast.

## 14. Known compatibility notes

### 14.1 Polling differences

Both polling helpers stop on `PAYMENT_CONFIRMED`, `INVOICED`, `FAILED`,
`EXPIRED`, or `CANCELLED`. TypeScript performs the first read immediately and
selectively retries transient failures; Go waits one interval and retries every
status-read error until timeout/context cancellation. Use explicit polling when
an application needs one cross-language retry policy.

### 14.2 Merchant token-list field

The TypeScript `getMerchant()` implementation reads `wallets[]` and maps it to
`supportedTokens`. The Go `MerchantInfo` type expects `supported_tokens`.
Verify the target deployment response before using the Go field.

### 14.3 Browser compatibility

No tested minimum-version browser matrix is currently published. The browser path
requires an EIP-1193 wallet/provider and modern features used by ethers and the
SDK (`BigInt`, `fetch`, `URL`, Promises, and Web Crypto/browser primitives).

### 14.4 Runtime capability

Supported chains, tokens, fee configuration, redirect allowlists, and merchant
payment capabilities are deployment-specific. Discover them from trusted
runtime responses or operator configuration rather than a static documentation
table.

### 14.5 Generated declaration examples

Current generated declaration files contain outdated example origins:
`goatx402-sdk-server-ts/dist/index.d.ts` mentions `api.goatx402.io`, and
`goatx402-checkout/dist/types.d.ts` mentions `pay.goat.network`. Those are not
active deployment origins and must not be copied into integrations. The
current origins are listed in the [documentation hub](./README.md#service-origins).

### 14.6 MPP interoperability

The current `MPPClient` and middleware do not implement the standard MPP
HTTP Challenge/Credential/Receipt exchange. They use GOAT Flow JSON
challenge/verify endpoints, a direct ERC-20 transfer, and a signed
three-segment receipt extension. No conformance or interoperability result with
official MPP SDKs is currently published. Treat these components as a
deployment-specific adapter unless standards compatibility is explicitly
documented and tested.
