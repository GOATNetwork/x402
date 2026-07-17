**Overview**
This document summarizes the GOAT Flow Core APIs invoked by `goatflow-sdk-server`, in a Swagger-like format. It focuses on request/response shapes, auth requirements, and how each SDK method maps to Core endpoints.

**Base Url**
Production: `https://flow-api.goat.network`.

SDKs accept `{baseUrl}` in `GoatFlowClient`; paths below are appended to it.

**Auth (HMAC-SHA256)**
Protected endpoints require these headers:
`X-API-Key`, `X-Timestamp`, `X-Nonce`, `X-Sign`

Signature algorithm (from goatx402-core):
1. Take all query/body fields, add `api_key`, `timestamp` (Unix seconds), and `nonce`.
2. Remove `sign` if present, drop empty values.
3. Sort keys by ASCII and build `k1=v1&k2=v2`.
4. HMAC-SHA256 with `apiSecret`, hex-encode.

Notes:
- Timestamp is validated within a short window (default 5 minutes in core).
- `X-Nonce` is required, must be unique per request, and is included in the signed params as `nonce`.
- Use server-side SDK only. Do not expose `apiSecret` in the frontend.

**Fee Mechanism**
- **Fee Deduction:** Fees are deducted from merchant's fee balance when an order is created.
- **Insufficient Balance:** Order creation fails with `insufficient fee balance` error if balance is too low.
- **Fee Refund:** Canceling a `CHECKOUT_VERIFIED` order refunds the fee.
- **Recommendation:** Monitor fee balance regularly and top up to avoid service disruption.

**Error Codes (Core Behavior)**
Core public APIs return HTTP status codes and an error message (field may be `error` or `message`). There is no stable `code` field for these endpoints in core at the moment. Treat HTTP status as the error code.

Common HTTP statuses:
- `400` Bad Request. Validation failures and business rule errors.
- `401` Unauthorized. Missing or invalid auth headers.
- `403` Forbidden. Merchant mismatch or order ownership mismatch.
- `404` Not Found. Merchant or order does not exist.
- `500` Internal Error. Unexpected server errors.

**Common Business Error Messages (HTTP 400)**

*Order Creation Validation Errors:*
- `merchant_id is required`
- `from_address is required`
- `token_symbol is required`
- `dapp_order_id is required`
- `chain_id is required`
- `amount_wei is required`
- `amount_wei must be greater than 0`
- `invalid Ethereum address format`

*Configuration and Resource Errors:*
- `merchant <id> not found`
- `token <symbol> not supported on chain <id>`
- `merchant callback contract not configured for merchant <id> on chain <id>`
- `eip712_name not configured for merchant <id> on chain <id>`
- `eip712_version not configured for merchant <id> on chain <id>`
- `token capability not found for chain <id> token <address>`
- `chain fee config not found for chain_id=<id>, please configure it first`

*Balance Insufficient Errors:*
- `insufficient fee balance: available=$X.XX, required=$Y.YY`
- `insufficient available balance: available=<amount>, required=<amount>`
- `insufficient TSS wallet balance on chain <id>: available=<amount>, required=<amount>`

*Flow-Specific Errors:*
- `callback_calldata is only supported for ERC20_3009 or ERC20_APPROVE_XFER flows`
- `TSS wallet <address> has not approved Permit2 contract for token <token> on chain <id>`
- `no enabled TSS wallet found for chain <id> and token <token>`

*Cancellation Errors:*
- `cannot cancel order in status <status>, only CHECKOUT_VERIFIED orders can be cancelled`

**Endpoint Summary (SDK Mapping)**
| SDK Method (`goatflow-sdk-server`) | Core Endpoint | Auth |
| --- | --- | --- |
| `GoatFlowClient.createOrder` | `POST /api/v1/orders` | Yes |
| `GoatFlowClient.createOrderRaw` | `POST /api/v1/orders` | Yes |
| `GoatFlowClient.createCheckoutSession` | `POST /api/v1/checkout/sessions` | Yes |
| `GoatFlowClient.getOrderStatus` | `GET /api/v1/orders/{order_id}` | Yes |
| `GoatFlowClient.getOrderProof` | `GET /api/v1/orders/{order_id}/proof` | Yes |
| `GoatFlowClient.submitCalldataSignature` | `POST /api/v1/orders/{order_id}/calldata-signature` | Yes |
| `GoatFlowClient.cancelOrder` | `POST /api/v1/orders/{order_id}/cancel` | Yes |
| `GoatFlowClient.getMerchant` | `GET /merchants/{merchant_id}` | No |

**POST /api/v1/orders**
| Item | Value |
| --- | --- |
| Summary | Create a payment order and return x402 Payment Required response |
| Auth | Required |
| SDK | `createOrder` returns normalized `Order`, `createOrderRaw` returns raw x402 |
| Success Status | `402 Payment Required` (expected) |
| Response Header | `PAYMENT-REQUIRED`: base64 of x402 JSON |

Request Body:
| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `dapp_order_id` | string | Yes | Your unique order id |
| `chain_id` | number | Yes | Source chain ID |
| `token_symbol` | string | Yes | Token symbol |
| `token_contract` | string | No | Token contract (optional) |
| `from_address` | string | Yes | Payer address |
| `amount_wei` | string | Yes | Amount in wei |
| `callback_calldata` | string | No | Hex calldata, only for DELEGATE flow |
| `merchant_id` | string | No | If provided, must match auth merchant |

Success Response (x402 PaymentRequired, HTTP 402):
| Field | Type | Description |
| --- | --- | --- |
| `x402Version` | number | x402 protocol version |
| `resource` | object | x402 resource info |
| `accepts` | array | Payment options (scheme, network, amount, asset, payTo, extra) |
| `extensions.goatx402` | object | `destinationChain`, `expiresAt`, `paymentMethod`, `receiveType`; `signatureEndpoint` is included only for `ERC20_3009` |
| `order_id` | string | Core order id |
| `flow` | string | Payment flow (`ERC20_DIRECT`, `ERC20_3009`, `ERC20_APPROVE_XFER`) |
| `token_symbol` | string | Token symbol |
| `calldata_sign_request` | object | EIP-712 signing data when callback is enabled |

**Best Practices for Error Handling:**
1. Always check for `insufficient fee balance` errors and alert operations team
2. Implement retry logic for 5xx errors with exponential backoff
3. Log full error response body for debugging (available in SDK error objects)
4. For token/chain configuration errors, guide users to supported payment methods
5. Handle order cancellation gracefully when payment fails or times out

**GET /api/v1/orders/{order_id}**
| Item | Value |
| --- | --- |
| Summary | Get order status for polling |
| Auth | Required |
| SDK | `getOrderStatus` |
| Success Status | `200 OK` |

Response Body:
| Field | Type | Description |
| --- | --- | --- |
| `order_id` | string | Core order id |
| `merchant_id` | string | Merchant id |
| `dapp_order_id` | string | Your order id |
| `chain_id` | number | Source chain ID |
| `token_contract` | string | Token contract |
| `token_symbol` | string | Token symbol |
| `from_address` | string | Payer address |
| `amount_wei` | string | Amount in wei |
| `status` | string | `CHECKOUT_VERIFIED`, `PAYMENT_CONFIRMED`, `INVOICED`, `FAILED`, `EXPIRED`, `CANCELLED` |
| `tx_hash` | string | Optional, when confirmed |
| `confirmed_at` | string | Optional, timestamp |

**GET /api/v1/orders/{order_id}/proof**
| Item | Value |
| --- | --- |
| Summary | Get order proof for on-chain verification |
| Auth | Required |
| SDK | `getOrderProof` |
| Success Status | `200 OK` |

Response Body:
| Field | Type | Description |
| --- | --- | --- |
| `payload` | object | Proof payload (order_id, tx_hash, log_index, from_addr, to_addr, amount_wei, chain_id, flow) |
| `signature` | string | Proof signature |

**POST /api/v1/orders/{order_id}/calldata-signature**
| Item | Value |
| --- | --- |
| Summary | Submit user EIP-712 signature for callback calldata |
| Auth | Required |
| SDK | `submitCalldataSignature` |
| Success Status | `200 OK` |

Request Body:
| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `signature` | string | Yes | `0x` + 130 hex chars (65 bytes) |

Response Body:
| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `ok` |
| `order_id` | string | Order id |

**POST /api/v1/orders/{order_id}/cancel**
| Item | Value |
| --- | --- |
| Summary | Cancel a pending order (only `CHECKOUT_VERIFIED`) |
| Auth | Required |
| SDK | `cancelOrder` |
| Success Status | `200 OK` |

Response Body:
| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `cancelled` |
| `order_id` | string | Order id |

Notes:
- Core cancels only when the order is still `CHECKOUT_VERIFIED`.
- Cancellation restores reserved balance and refunds fee in core.
- **Important:** Always cancel unused orders to avoid wasting fees and resources.
- Best practice: Cancel orders when user closes payment page or payment times out.

**GET /merchants/{merchant_id}**
| Item | Value |
| --- | --- |
| Summary | Get public merchant info |
| Auth | Not required |
| SDK | `getMerchant` |
| Success Status | `200 OK` |

Response Body:
| Field | Type | Description |
| --- | --- | --- |
| `merchant_id` | string | Merchant id |
| `enabled` | boolean | Whether the merchant is enabled |
| `receive_type` | string | `DIRECT` or `DELEGATE` |
| `wallets` | array | `{ address, chain_id, token_symbol, token_contract }` |
| `api_key` | string | Empty on the public Core response; populated only in authenticated/internal merchant lookups |

Note: SDKs may normalize missing display fields, for example using `merchant_id` as `name`. Core's public response does not include `name` or `logo`.

**POST /api/v1/checkout/sessions**

| Item | Value |
| --- | --- |
| Summary | Create a server-authoritative Hosted Checkout Session |
| Auth | Required (merchant HMAC) |
| SDK | `createCheckoutSession` |
| Success Status | `200 OK` |

The authenticated API key determines the merchant. Do not include `merchant_id`
in the body.

Common request fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `checkout_type` | string | Yes | `DIRECT` or `DELEGATE`; must match the merchant |
| `price` | decimal string | Conditional | DIRECT price, or cross-chain DELEGATE price |
| `chain_id` | number | Conditional | Legacy fixed-wei DELEGATE source chain |
| `fixed_amount_wei` | string | Conditional | Legacy fixed-wei DELEGATE amount |
| `acceptable_tokens` | JSON string | Conditional | Legacy DELEGATE token-contract array |
| `callback_calldata` | hex string | No | Legacy fixed-wei DELEGATE callback calldata |
| `client_reference_id` | string | No | Merchant correlation key, maximum 200 characters |
| `success_url` / `cancel_url` | string | No | Allowlist-gated hosted-page redirects |
| `line_items_json` | JSON string | No | Display line items |
| `public_metadata_json` | JSON string | No | Metadata visible in the public session view |
| `private_metadata_json` | JSON string | No | Stored metadata excluded from the public view |
| `expires_in` | number | No | Session lifetime in seconds |

Use exactly one amount form for DELEGATE:

- `price` selects cross-chain decimal-price mode; Core derives callback chain and
  eligible source-chain/token candidates.
- `fixed_amount_wei` + `chain_id` + `acceptable_tokens` selects the compatibility
  single-chain mode.

The server SDK accepts arrays/objects for nested values and performs the required
JSON stringification before HMAC signing.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `checkout_id` | string | Opaque `cs_…` handle passed to the browser SDK |
| `checkout_type` | string | `DIRECT` or `DELEGATE` |
| `url` | string | Platform-built hosted checkout URL |
| `expires_at` | number | Unix expiration time |

**Public Hosted Checkout endpoints**

The platform-hosted page, not the merchant application, normally owns these calls:

| Endpoint | Purpose |
| --- | --- |
| `GET /checkout/v1/sessions/{checkout_id}` | Read safe public terms and current state |
| `GET /checkout/v1/sessions/{checkout_id}/status` | Poll compact status |
| `POST /checkout/v1/sessions/{checkout_id}/bind` | Bind payer/token and create the real order |
| `POST /checkout/v1/sessions/{checkout_id}/signature` | Verify and store a DELEGATE callback signature |

The raw handle is a bearer capability. Keep it out of logs. Completion should be
confirmed from `quickpay.checkout.completed` or trusted backend order status;
the browser `onSuccess` callback is UX-only.
