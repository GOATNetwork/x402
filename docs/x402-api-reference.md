# GOAT x402 API Reference

> A practical API overview and implementation reference for developers integrating GOAT x402.  
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
- merchant receiving tokens and addresses configured
- an `API Key` and `API Secret` for HMAC-authenticated programmatic x402, including DELEGATE
- test and production environment details confirmed
- sufficient Fee Balance funded

---

## 3. Base configuration

Use the following environment variable naming consistently:

```bash
GOATX402_API_URL=https://x402-api.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
GOATX402_MERCHANT_ID=your_merchant_id
```

Notes:

- **Production base URL**: `https://x402-api.goat.network`
- Common local Core / demo URL: `http://localhost:8286`
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

1. Take query arguments and request body fields, then add `api_key`, `timestamp`, and `nonce`
2. Remove empty values and the `sign` field if present
3. Sort keys in ASCII order
4. Build a string like `k1=v1&k2=v2`
5. Sign with HMAC-SHA256 using the `API Secret`
6. Hex-encode the result and send it as `X-Sign`

`X-Nonce` is required and replay-protected. Requests missing it are rejected.

### 4.3 Authentication models

x402 has three distinct authentication models:

- Programmatic `POST /api/v1/orders` and related order APIs use HMAC API keys.
- Machine Payments Protocol (MPP) route configuration is merchant-portal configuration and uses merchant JWT authentication.
- Machine Payments Protocol (MPP) buyer endpoints, such as `/mpp/v1/challenge` and `/mpp/v1/verify`, do not use merchant API keys.

### 4.4 Important security principles

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
5. Frontend performs the ERC-20 payment to `payToAddress`; in DELEGATE this is a TSS wallet
6. Backend polls the order status
7. After confirmation, backend retrieves the proof
8. Unused orders should be cancelled while they are still cancellable

### Key points

- **`POST /api/v1/orders` returning HTTP 402 does not mean failure**  
  In the x402 protocol, this is the expected success path for order creation.
- For DIRECT, `payToAddress` is usually the merchant receiving address. For DELEGATE, `payToAddress` is a TSS wallet; if callback calldata is present, the buyer also signs the returned callback authorization and the backend submits it.

---

## 6. Payment modes and flow types

| Mode | Flow Types | Payment / execution target | Callback support | Typical use |
| --- | --- | --- | --- | --- |
| `DIRECT` | `ERC20_DIRECT` | Merchant receiving address | No | QuickPay hosted checkout, simple payment gating, Machine Payments Protocol (MPP) buyer flows |
| `DELEGATE` | `ERC20_3009`, `ERC20_APPROVE_XFER` | TSS `payToAddress`; optional MerchantCallback via platform Bob caller | Optional | Programmatic x402 with optional callback execution |

Notes:

- `DIRECT`: QuickPay hosted checkout does not require an API key; optional programmatic x402 requires HMAC API keys; MPP buyer challenge/verify endpoints do not require merchant API keys; the user pays directly to the merchant receiving address
- `DELEGATE`: programmatic x402 only; requires API keys and pays a TSS `payToAddress`; callback execution additionally requires an approved `MerchantCallback` contract
- For DELEGATE callback execution, the merchant must get the platform Bob address from the platform operator/admin, call `setAuthorizedCaller(bob, true)`, and submit the callback contract in the Merchant Portal for admin review
- In DELEGATE, the buyer SDK transfers the ERC-20 payment to the TSS `payToAddress`; if callback calldata is present, the buyer also signs an EIP-712 callback authorization and the platform Bob caller submits it to the merchant's approved callback
- DIRECT and DELEGATE are mutually exclusive and fixed at merchant registration
- If the order response contains `calldataSignRequest`, the frontend must sign first and the backend must submit that signature

---

## 7. Supported chains and tokens (docs layer)

GOAT x402 docs are EVM-only. Supported chains and tokens are DB/config-driven and can vary by merchant configuration.

Examples from checked-in configuration include:

- Mainnet merchant receiving chains: Ethereum `1`, Base `8453`, Arbitrum `42161`, BSC `56`, and Metis `1088`
- MPP Tempo examples: Tempo `4217` and Tempo Moderato `42431`
- Repository testnet seed examples: GOAT Testnet3 `48816`, BSC Testnet `97`, and Sepolia `11155111`

Metis is DIRECT-only at the merchant level. Do not hardcode a static chain matrix; read supported chain and token configuration from merchant/Core configuration.

---

## 8. Endpoint summary

| Server SDK method | Endpoint | Auth |
| --- | --- | --- |
| `createOrder` | `POST /api/v1/orders` | Yes |
| `getOrderStatus` | `GET /api/v1/orders/{order_id}` | Yes |
| `getOrderProof` | `GET /api/v1/orders/{order_id}/proof` | Yes |
| `submitCalldataSignature` | `POST /api/v1/orders/{order_id}/calldata-signature` | Yes |
| `cancelOrder` | `POST /api/v1/orders/{order_id}/cancel` | Yes |
| `getMerchant` | `GET /merchants/{merchant_id}` | No |

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

**Common response fields**

- `merchant_id`
- `name`
- `logo`
- `receive_type`
- `wallets`

`wallets` typically contains:

- `address`
- `chain_id`
- `token_symbol`
- `token_contract`

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

- `insufficient fee balance` (typically HTTP `400` for programmatic order creation; QuickPay may use HTTP `503`)
- `invalid signature`
- `wrong chain / token / amount`
- `callback failed`
- `merchant <id> not found`
- `token <symbol> not supported on chain <id>`
- `cannot cancel order <id>: current status is <status>`

---

## 12. Additional notes for DELEGATE / callback flows

When using DELEGATE mode and post-payment on-chain execution is required, also pay attention to:

- `callback_calldata`
- `calldataSignRequest`
- `MerchantCallback` contract setup
- platform Bob caller allowlist
- EIP-712 domain config such as `eip712_name` and `eip712_version`

The official docs and engineering implementation emphasize:

- do not hardcode EIP-712 domain/type on the frontend
- use the `calldataSignRequest` returned in the order response
- get the Bob caller address from the platform operator/admin
- call `setAuthorizedCaller(bob, true)` on the merchant callback contract before launch
- submit the callback contract in the Merchant Portal for admin review
- only allow the authorized platform Bob caller to invoke the callback entrypoint

---

## 13. Integration recommendations from the official page and engineering implementation

Based on the official x402 page and local engineering files, the recommended sequence is:

1. complete Merchant / receiving / fee setup
2. for DELEGATE callback execution, deploy `MerchantCallback`, authorize Bob with `setAuthorizedCaller(bob, true)`, and complete admin review
3. integrate the server SDK on the backend
4. integrate wallet + payment SDK on the frontend
5. create the order
6. execute the ERC-20 payment to `payToAddress`
7. if callback calldata is used, sign and submit the callback authorization
8. poll order status on the backend
9. retrieve proof
10. cancel stale or abandoned orders in time

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

**create order → return Payment Required → user pays `payToAddress` → optionally submit DELEGATE callback authorization → poll status → retrieve proof → optionally callback / cancel**

---

Contact email: x402support@goat.network
