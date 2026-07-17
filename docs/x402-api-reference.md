# GOAT Flow API Reference

> A practical API overview and implementation reference for developers integrating GOAT Flow.
> This document is intended to explain the core endpoints, authentication model, order lifecycle, and integration boundaries. For field-level details, use it together with the official repository and SDK sources.

---

## 1. What this document is

This document is a developer-facing x402 API overview and implementation reference. It is intended to help integrators quickly understand the core endpoints, authentication model, order lifecycle, and integration boundaries.

It works as a docs-site-friendly API entry point for real integration, but it does not replace low-level field-by-field implementation sources.

### For low-level implementation details and field sources

Also review:

- the `GOATNetwork/x402` repository
- `API.md`
- `DEVELOPER_FAST.md`
- `docs/x402-integration.md`
- `goatx402-sdk-server-ts/src/*`
- `goatx402-demo/server/index.ts`

---

## 2. Prerequisites

Before calling the x402 API, confirm that you already have:

- a Merchant Account
- merchant receiving capability configured
- an `API Key` and `API Secret`
- test and production environment details confirmed
- sufficient fee balance funded

---

## 3. Base configuration

Use the following environment variable naming consistently:

```bash
GOATX402_API_URL=https://flow-api.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
GOATX402_MERCHANT_ID=your_merchant_id
```

Notes:

- **Production base URL**: `https://flow-api.goat.network`
- Common local Core URL: `http://localhost:8180`
- Docker-mapped Core URL: `http://localhost:8286`
- Demo app URL: `http://localhost:3000`
- Older docs may mention `GOATX402_BASE_URL`; prefer `GOATX402_API_URL`

---

## 4. Security and authentication requirements

### 4.1 Backend authentication

Protected endpoints use **HMAC-SHA256** authentication with these required headers:

- `X-API-Key`
- `X-Timestamp`
- `X-Nonce`
- `X-Sign`

### 4.2 Signature algorithm

The signature process is:

1. Take the request body/query fields and add `api_key`, `timestamp`, and `nonce`
2. Remove empty values and the `sign` field if present
3. Sort keys in ASCII order
4. Build a string like `k1=v1&k2=v2`
5. Sign with HMAC-SHA256 using the `API Secret`
6. Hex-encode the result and send it as `X-Sign`

Example signed parameter set:

```text
amount_wei=10000000
api_key=merchant_api_key
chain_id=137
dapp_order_id=order_123
from_address=0x...
nonce=8b9a7c6d-...
timestamp=1760000000
token_symbol=USDC
```

### 4.3 Important security principles

- `GOATX402_API_SECRET` must stay on the backend only
- do not call sensitive merchant APIs directly from the frontend
- do not commit API credentials to public repositories
- wallet signing must happen in a user-controlled wallet context

---

## 5. Core x402 payment flow

The standard integration flow is:

1. Frontend requests order creation from your backend
2. Backend calls `POST /api/v1/orders`
3. Core returns an x402 payment-required response
4. If `calldataSignRequest` exists, the frontend signs first and the backend submits the signature
5. Frontend performs the actual token transfer to `payToAddress`
6. Backend polls the order status
7. After confirmation, backend retrieves the proof
8. Unused orders should be cancelled while they are still cancellable

### Key points

- **`POST /api/v1/orders` returning HTTP 402 does not mean failure**  
  In the x402 protocol, this is the expected success path for order creation.
- For all flow types, the user-side payment action is still a transfer to **`payToAddress`**.

---

## 6. Payment modes and flow types

| Mode | Flow Types | User transfer target | Callback support | Typical use |
| --- | --- | --- | --- | --- |
| `DIRECT` | `ERC20_DIRECT` | Merchant address | No | Simple payment gating |
| `DELEGATE` | `ERC20_3009`, `ERC20_APPROVE_XFER` | TSS / delegated settlement address | Yes | Advanced settlement and callback workflows |

Notes:

- `DIRECT`: the user pays directly to the merchant address
- `DELEGATE`: the user first pays the source-chain TSS address, then Core settles
  to the merchant's configured callback chain (which may be the same chain)
- If the order response contains `calldataSignRequest`, the frontend must sign first and the backend must submit that signature

---

## 7. Supported chains and tokens (docs layer)

The supported public network matrix is:

| Chain | Chain ID | DIRECT | DELEGATE | Explorer |
| --- | ---: | :---: | :---: | --- |
| Ethereum | 1 | Yes | Yes | etherscan.io |
| Polygon | 137 | Yes | Yes | polygonscan.com |
| BSC | 56 | Yes | Yes | bscscan.com |
| Arbitrum | 42161 | Yes | Yes | arbiscan.io |
| Optimism | 10 | Yes | Yes | optimistic.etherscan.io |
| Avalanche | 43114 | Yes | Yes | snowtrace.io |
| Base | 8453 | Yes | Yes | basescan.org |
| Berachain | 80094 | Yes | Yes | berascan.com |
| X Layer | 196 | Yes | Yes | web3.okx.com/explorer/x-layer/evm |
| GOAT | 2345 | Yes | Yes | explorer.goat.network |
| Metis | 1088 | Yes | No | andromeda-explorer.metis.io |
| Tempo | 4217 | Yes | No | explore.tempo.xyz |

> Important: the actual supported chains and tokens always depend on each merchant's Core configuration. Do not hardcode support purely from the static table.

---

## 8. Endpoint summary

| Server SDK method | Endpoint | Auth |
| --- | --- | --- |
| `createOrder` | `POST /api/v1/orders` | Yes |
| `createCheckoutSession` | `POST /api/v1/checkout/sessions` | Yes |
| `getOrderStatus` | `GET /api/v1/orders/{order_id}` | Yes |
| `getOrderProof` | `GET /api/v1/orders/{order_id}/proof` | Yes |
| `submitCalldataSignature` | `POST /api/v1/orders/{order_id}/calldata-signature` | Yes |
| `cancelOrder` | `POST /api/v1/orders/{order_id}/cancel` | Yes |
| `getMerchant` | `GET /merchants/{merchant_id}` | No |

QuickPay public endpoints:

| Surface | Endpoint | Auth |
| --- | --- | --- |
| QuickPay discovery | `GET /quickpay/v1/merchants/{merchant_id}` | No |
| Agent instructions | `GET /quickpay/{merchant_id}/agent.md` | No |
| Machine manifest | `GET /quickpay/{merchant_id}/manifest.json` | No |
| Create x402 session | `POST /quickpay/v1/x402/sessions` | No |
| Query x402 session | `GET /quickpay/v1/x402/sessions/{session_id}` | No |
| Read Hosted Checkout | `GET /checkout/v1/sessions/{checkout_id}` | No, opaque handle |
| Poll Hosted Checkout | `GET /checkout/v1/sessions/{checkout_id}/status` | No, opaque handle |
| Bind Hosted Checkout | `POST /checkout/v1/sessions/{checkout_id}/bind` | No, rate-limited |
| Submit Hosted Checkout signature | `POST /checkout/v1/sessions/{checkout_id}/signature` | No, rate-limited |

QuickPay client package:

- npm package / CLI: `goatflow-quickpay`
- CLI commands: `inspect`, `pay-x402`, `pay-product`, `pay-mpp`
- library exports include `QuickPayClient`, `inspect`, `payX402`, `payProduct`,
  `payMpp`, `loadManifest`, and `EthersPaymentBackend`

---

## 9. Core API details

### 9.1 Create Order

**Endpoint**

```text
POST /api/v1/orders
```

**Purpose**

Creates a payment order and returns the x402 Payment Required response.

**Important behavior**

- A successful order creation commonly returns **HTTP 402 Payment Required**
- This is the expected success path in x402 and should not be treated as a normal failure
- The `PAYMENT-REQUIRED` response header is the base64-encoded JSON form of the same x402 challenge returned in the body

**Request fields**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `dapp_order_id` | string | Yes | Your app's unique order ID |
| `chain_id` | number | Yes | Payment chain ID |
| `token_symbol` | string | Yes | Payment token, such as `USDC` |
| `token_contract` | string | No | Token contract address |
| `from_address` | string | Yes | Payer address |
| `amount_wei` | string | Yes | Payment amount in atomic units |
| `callback_calldata` | string | No | Used in DELEGATE + callback flows |
| `merchant_id` | string | No | If present, must match the authenticated merchant |

**Fields builders most often consume after backend normalization**

- `orderId`
- `payToAddress`
- `amountWei`
- `flow`
- `expiresAt`
- `calldataSignRequest`

**Key x402 response fields**

- `x402Version`
- `resource`
- `accepts`
- `extensions.goatx402`
- `order_id`
- `flow`
- `token_symbol`
- `calldata_sign_request`

**Literal x402 challenge shape**

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Miwi...
Content-Type: application/json
```

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://flow-api.goat.network/api/v1/orders/{order_id}",
    "description": "Payment: 10000000 USDC",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:137",
      "amount": "10000000",
      "asset": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      "payTo": "0xMerchantOrTssAddress",
      "maxTimeoutSeconds": 600,
      "extra": {
        "flow": "ERC20_DIRECT",
        "tokenSymbol": "USDC"
      }
    }
  ],
  "extensions": {
    "goatx402": {
      "destinationChain": "eip155:137",
      "expiresAt": 1760000600,
      "paymentMethod": "transfer",
      "receiveType": "DIRECT"
    }
  },
  "order_id": "{order_id}",
  "flow": "ERC20_DIRECT",
  "token_symbol": "USDC"
}
```

For `ERC20_3009`, `accepts[0].scheme` is `exact-eip3009` and `extensions.goatx402.signatureEndpoint` points to `POST /api/v1/orders/{order_id}/calldata-signature`.

---

### 9.2 Query Order Status

**Endpoint**

```text
GET /api/v1/orders/{order_id}
```

**Purpose**

Retrieves the current order state so the backend can determine whether payment succeeded, failed, expired, or was cancelled.

**Common response fields**

- `order_id`
- `merchant_id`
- `dapp_order_id`
- `chain_id`
- `token_contract`
- `token_symbol`
- `from_address`
- `amount_wei`
- `status`
- `tx_hash`
- `confirmed_at`

---

### 9.3 Get Proof

**Endpoint**

```text
GET /api/v1/orders/{order_id}/proof
```

**Purpose**

Retrieves the payment proof, useful for:

- reconciliation
- audit trails
- fulfillment evidence
- dispute handling

**Common response shape**

- `payload`
  - `order_id`
  - `tx_hash`
  - `log_index`
  - `from_addr`
  - `to_addr`
  - `amount_wei`
  - `chain_id`
  - `flow`
- `signature`

---

### 9.4 Submit Calldata Signature

**Endpoint**

```text
POST /api/v1/orders/{order_id}/calldata-signature
```

**Purpose**

Submits the user's EIP-712 signature for `calldataSignRequest`. This is typically required in DELEGATE flows with callback execution.

**Request field**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `signature` | string | Yes | User signature, typically `0x...` |

---

### 9.5 Cancel Order

**Endpoint**

```text
POST /api/v1/orders/{order_id}/cancel
```

**Purpose**

Cancels an order that has not completed payment.

**Important limitation**

- In practice, only orders in `CHECKOUT_VERIFIED` can be cancelled
- Cancellation releases reserved resources and refunds the corresponding fee inside Core

**Best practices**

- cancel when the user closes the payment page
- add backend cleanup for timed-out payments
- do not leave long-lived unpaid orders hanging

---

### 9.6 Get Merchant

**Endpoint**

```text
GET /merchants/{merchant_id}
```

**Purpose**

Returns public merchant information and supported payment capability, useful for configuration pages and backend initialization.

**Common core response fields**

- `merchant_id`
- `enabled`
- `receive_type`
- `wallets`
- `api_key`

Display fields such as `name` and `logo` are not returned by this core endpoint.

`wallets` typically contains:

- `address`
- `chain_id`
- `token_symbol`
- `token_contract`

---

### 9.7 QuickPay Public API

QuickPay is the public, manifest-driven payer and agent surface. These endpoints are unauthenticated and expose only public merchant payment capability.

**Agent instructions**

```text
GET /quickpay/{merchant_id}/agent.md
```

Returns prompt-injection-hardened Markdown with same-host payment instructions and CLI examples.

**Machine manifest**

```text
GET /quickpay/{merchant_id}/manifest.json
```

Returns a `goatx402.quickpay.v1` manifest with links, x402 tokens, optional MPP routes, and the x402 session endpoint.

**Create x402 session**

```text
POST /quickpay/v1/x402/sessions
```

Request fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `merchant_id` | string | Yes | Merchant ID |
| `payer_addr` | string | Yes | Payer wallet address |
| `chain_id` | number | Yes | EVM chain ID |
| `token_contract` | string | Yes | ERC-20 token contract |
| `amount_wei` | string | Conditional | Atomic token amount for a custom-amount session |
| `product_key` | string | Conditional | Fixed-price product; server derives amount from product price and token decimals |
| `memo` | string | Conditional | Required only when the merchant requires a memo |
| `idempotency_key` | string | No | Reuse-safe session key |
| `client_reference_id` | string | No | Merchant correlation reference |
| `public_metadata` | object | No | Small non-secret metadata object |

Supply either `amount_wei` for a custom payment or `product_key` for a
server-priced product. Product mode pins the authoritative decimal price and
ignores any browser-supplied amount.

Response fields include `session_id`, `merchant_id`, `order_id`, `status`,
`expires_at`, and, when payable, an embedded `x402` challenge with the same
`x402Version: 2` / `accepts[]` shape described above.

**Query x402 session**

```text
GET /quickpay/v1/x402/sessions/{session_id}
```

Returns public session status fields including `status`, `order_status`, `tx_hash`, `amount_wei`, `chain_id`, `token_contract`, `token_symbol`, `pay_to_address`, and `expires_at`.

---

### 9.8 Unified Hosted Checkout

Hosted Checkout lets the platform page own wallet connection and payment UX while
the merchant backend pins authoritative terms.

**Create**

```text
POST /api/v1/checkout/sessions
```

This endpoint uses the same merchant HMAC authentication as order creation.
The API key determines the merchant.

| Field | Required | Purpose |
| --- | --- | --- |
| `checkout_type` | Yes | `DIRECT` or `DELEGATE` |
| `price` | Conditional | DIRECT decimal price or cross-chain DELEGATE decimal price |
| `chain_id` | Conditional | Legacy fixed-wei DELEGATE source chain |
| `fixed_amount_wei` | Conditional | Legacy fixed-wei DELEGATE atomic amount |
| `acceptable_tokens` | Conditional | JSON-stringified token-contract array for legacy DELEGATE |
| `callback_calldata` | No | Optional legacy DELEGATE calldata |
| `client_reference_id` | No | Merchant correlation key, maximum 200 characters |
| `success_url` / `cancel_url` | No | Redirects checked against the merchant allowlist |
| `line_items_json` | No | JSON-stringified display rows |
| `public_metadata_json` | No | JSON-stringified public metadata |
| `private_metadata_json` | No | JSON-stringified metadata excluded from public reads |
| `expires_in` | No | Lifetime in seconds |

DELEGATE accepts one of two amount forms:

- `price`: cross-chain decimal-price mode. Core derives the merchant callback
  chain and eligible source-chain/token candidates.
- `fixed_amount_wei` + `chain_id` + `acceptable_tokens`: compatibility
  single-chain mode.

Use `createCheckoutSession` from the TypeScript or Go server SDK so nested values
are encoded consistently with HMAC signing.

Response:

```json
{
  "checkout_id": "cs_...",
  "checkout_type": "DIRECT",
  "url": "https://pay.goat.network/checkout?cs=cs_...",
  "expires_at": 1780000000
}
```

Pass only `checkout_id` to
`GoatCheckout({ origin }).open({ checkoutId })`, or redirect to the returned
platform URL.

**Hosted-page endpoints**

```text
GET  /checkout/v1/sessions/{checkout_id}
GET  /checkout/v1/sessions/{checkout_id}/status
POST /checkout/v1/sessions/{checkout_id}/bind
POST /checkout/v1/sessions/{checkout_id}/signature
```

Merchant applications normally do not orchestrate these public calls; the hosted
checkout page does. The public read excludes private metadata. Bind creates the
real order, while the signature endpoint verifies/stores a DELEGATE EIP-712
callback signature when required.

Fulfill only from `quickpay.checkout.completed` or trusted backend status. Browser
`onSuccess` is not proof of payment.

See [Hosted Checkout](x402-checkout.md).

---

## 10. Order states

Common order states are:

- `CHECKOUT_VERIFIED` — order created, waiting for payment
- `PAYMENT_CONFIRMED` — payment observed and confirmed
- `INVOICED` — completed in the current flow
- `FAILED` — failed
- `EXPIRED` — expired before completion
- `CANCELLED` — cancelled while still cancellable

---

## 11. Common errors and HTTP statuses

| HTTP Status | Meaning |
| --- | --- |
| `200` | Success |
| `400` | Validation failure or business rule error |
| `401` | Authentication failure |
| `402` | **Payment Required: normally the success path for order creation** |
| `403` | Authorization error |
| `404` | Resource not found |
| `500` | Internal server error |

### Common business errors

- `insufficient fee balance`
- `invalid signature`
- `wrong chain / token / amount`
- `callback failed`
- `merchant <id> not found`
- `token <symbol> not supported on chain <id>`
- `cannot cancel order in status <status>, only CHECKOUT_VERIFIED orders can be cancelled`

---

## 12. Additional notes for DELEGATE / callback flows

When using DELEGATE mode and post-payment on-chain execution is required, also pay attention to:

- `callback_calldata`
- `calldataSignRequest`
- MerchantCallback contract setup
- callback caller allowlist
- EIP-712 domain config such as `eip712_name` and `eip712_version`

The official docs and engineering implementation emphasize:

- do not hardcode EIP-712 domain/type on the frontend
- use the `calldataSignRequest` returned in the order response
- only allow the authorized x402 Core caller to invoke the callback entrypoint

---

## 13. Integration recommendations from the official page and engineering implementation

Based on the official x402 page and local engineering files, the recommended sequence is:

1. complete Merchant / receiving / fee setup
2. integrate the server SDK on the backend
3. integrate wallet + payment SDK on the frontend
4. create the order
5. if callback is used, sign and submit the signature first
6. execute the frontend payment
7. poll order status on the backend
8. retrieve proof
9. cancel stale or abandoned orders in time

---

## 14. Related engineering docs and repositories

Recommended references:

- `GOATNetwork/x402` repository
- `README.md`
- `DEVELOPER_FAST.md`
- `API.md`
- `goatx402-demo/README.md`
- `goatx402-demo/server/index.ts`
- `docs/x402-integration.md`
- `goatx402-contract/README.md`
- `goatx402-contract/QUICK_START.md`
- `goatx402-contract/MERCHANT_CALLBACK.md`

---

## 15. One-line summary

The x402 API is not just “an order creation endpoint.” The real integration path is:

**create order → return Payment Required → user pays `payToAddress` → poll status → retrieve proof → optionally callback / cancel**

---

Contact email: x402support@goat.network
