# GOAT Flow API Reference

This reference describes the API and wire behavior used by the TypeScript and
Go server SDKs, browser SDK, QuickPay package, and GOAT Flow MPP adapter.

For a tutorial, start with the
[Developer Quick Start](./goat-flow-developer-quickstart.md). For package composition
and production boundaries, see the [Integration Guide](./goat-flow-integration.md).

## 1. Origins and configuration

```bash
GOATX402_API_URL=https://flow-api.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
GOATX402_MERCHANT_ID=your_merchant_id
```

| Surface | Testnet3 origin | Mainnet origin |
| --- | --- | --- |
| GOAT Flow | — | `https://goat.network/flow` |
| Merchant Portal | `https://flow-merchant.testnet3.goat.network` | `https://flow-merchant.goat.network` |
| Admin Portal (authorized operators only) | `https://flow-admin.testnet3.goat.network` | `https://flow-admin.goat.network` |
| Flow API / standalone MPP Core | `https://flow-api.testnet3.goat.network` | `https://flow-api.goat.network` |
| Public QuickPay / Hosted Checkout and same-origin API | `https://flow-quickpay.testnet3.goat.network` | `https://flow-quickpay.goat.network` |

The merchant API URL is configurable in both server SDKs. Test and private
deployments may use different origins. Merchant integrations do not call the
Admin Portal.

The QuickPay client derives its public session and MPP paths from the trusted
QuickPay link origin. It does not switch to `flow-api` from manifest endpoint
fields. Use `flow-api` for authenticated merchant API calls and explicitly
configured standalone MPP.

## 2. HMAC authentication

Protected merchant endpoints require:

- `X-API-Key`
- `X-Timestamp`
- `X-Nonce`
- `X-Sign`

The server SDK algorithm is:

1. Convert top-level body values to strings.
2. Add `api_key`, `timestamp` (Unix seconds), and `nonce`.
3. Remove `sign` and empty-string values.
4. Sort keys lexicographically.
5. Join as `key=value&key=value`.
6. HMAC-SHA256 with the API secret and hex encode.

This legacy delimiter format is not injective for arbitrary values containing
`&` or `=`. Do not treat it as safely binding unrestricted scalar input. A
complete correction requires a versioned canonicalization contract deployed
together in Core and both server SDKs; changing only a client would make its
signatures incompatible with the current verifier. Until that migration is
complete, the active deployment must enforce an identical allowed-value policy
before authentication and request handling.

Current authenticated SDK `GET` methods have no query parameters and therefore
sign only the authentication fields.

The signing format is scalar-only. Hosted Checkout arrays/maps are sent as JSON
strings:

- `acceptable_tokens`
- `line_items_json`
- `public_metadata_json`
- `private_metadata_json`

Do not expose the API secret or HMAC code in the browser.

## 3. Merchant endpoint summary

The current public merchant contract uses DIRECT. Operator callback rows are
compatibility reference for environments explicitly provisioned by the GOAT
operator; their presence in an SDK does not enable them for a merchant.

| Method | Endpoint | Auth | Success |
| --- | --- | --- | --- |
| Create order | `POST /api/v1/orders` | HMAC | `402` |
| Create Hosted Checkout Session | `POST /api/v1/checkout/sessions` | HMAC | `200` |
| Read order | `GET /api/v1/orders/{order_id}` | HMAC | `200` |
| Read proof | `GET /api/v1/orders/{order_id}/proof` | HMAC | `200` |
| Submit operator callback signature | `POST /api/v1/orders/{order_id}/calldata-signature` | HMAC | `200` |
| Cancel order | `POST /api/v1/orders/{order_id}/cancel` | HMAC | `200` |
| Read merchant | `GET /merchants/{merchant_id}` | Public | `200` |

HTTP `402` is a success only where the endpoint defines a payment challenge
(create order and the GOAT Flow MPP profile's challenge endpoint).

Both current server SDKs accept `402` as success only for order creation.
Status, proof, checkout, signature, and cancellation calls fail closed on an
unexpected `402`.

## 4. Create order

```http
POST /api/v1/orders
```

### Request

| JSON field | Type | Required | TypeScript | Go |
| --- | --- | --- | --- | --- |
| `dapp_order_id` | string | Yes | `dappOrderId` | `DappOrderID` |
| `chain_id` | integer | Yes | `chainId` | `ChainID` |
| `token_symbol` | string | Yes | `tokenSymbol` | `TokenSymbol` |
| `token_contract` | string | No | `tokenContract` | `TokenContract` |
| `from_address` | string | Yes | `fromAddress` | `FromAddress` |
| `amount_wei` | integer string | Yes | `amountWei` | `AmountWei` |
| `callback_calldata` | hex string | No | `callbackCalldata` | `CallbackCalldata` |

### Raw response

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-REQUIRED: <base64-x402-json>
```

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://flow-api.goat.network/api/v1/orders/{order_id}",
    "description": "Payment",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:2345",
      "amount": "10000000",
      "asset": "0xToken",
      "payTo": "0xMerchant",
      "maxTimeoutSeconds": 600,
      "extra": {
        "flow": "ERC20_DIRECT",
        "tokenSymbol": "USDC"
      }
    }
  ],
  "extensions": {
    "goatx402": {
      "destinationChain": "eip155:2345",
      "expiresAt": 1780000000,
      "paymentMethod": "transfer",
      "receiveType": "DIRECT"
    }
  },
  "order_id": "order-id",
  "flow": "ERC20_DIRECT",
  "token_symbol": "USDC"
}
```

The documented flow is `ERC20_DIRECT`. The browser transfers the ERC-20 token
to the merchant receiving address returned as `payTo`.

Operator-provisioned callback fields and signature submission are retained as
compatibility reference in [Appendix A](#appendix-a-operator-provisioned-callback-compatibility).

### Normalized server `Order`

`createOrder()` normalizes the first `accepts[]` entry:

| Server field | Source |
| --- | --- |
| `orderId` | `order_id` |
| `flow` | top-level `flow`, then `accepts[0].extra.flow`, default `ERC20_DIRECT` in TS |
| `tokenSymbol` | top-level `token_symbol`, then `accepts[0].extra.tokenSymbol` |
| `tokenContract` | `accepts[0].asset` |
| `payToAddress` | `accepts[0].payTo` |
| `fromChainId` | parsed from `accepts[0].network` |
| `payToChainId` | parsed from `extensions.goatx402.destinationChain` |
| `amountWei` | `accepts[0].amount` |
| `expiresAt` | `extensions.goatx402.expiresAt` |
| `calldataSignRequest` | top-level `calldata_sign_request` |

These are normalization outputs, not response-validation guarantees. The
TypeScript client can fall back to request values for token, source chain, and
amount and defaults a missing flow to `ERC20_DIRECT`; the Go client only falls
back to the requested source chain. Either client can therefore expose empty or
zero values when a deployment returns an incomplete challenge. Validate every
field needed by the browser before presenting a transfer.

The browser `Order` instead requires `chainId` and `fromAddress`. Map explicitly:

```ts
function toClientOrder(serverOrder: ServerOrder, fromAddress: string): ClientOrder {
  return {
    orderId: serverOrder.orderId,
    flow: serverOrder.flow,
    tokenSymbol: serverOrder.tokenSymbol,
    tokenContract: serverOrder.tokenContract,
    fromAddress,
    payToAddress: serverOrder.payToAddress,
    chainId: serverOrder.fromChainId,
    amountWei: serverOrder.amountWei,
    expiresAt: serverOrder.expiresAt,
    calldataSignRequest: serverOrder.calldataSignRequest,
  }
}
```

## 5. Read order status

```http
GET /api/v1/orders/{order_id}
```

Response fields mapped by the SDKs:

| Wire field | TypeScript field | Go field |
| --- | --- | --- |
| `order_id` | `orderId` | `OrderID` |
| `merchant_id` | `merchantId` | `MerchantID` |
| `dapp_order_id` | `dappOrderId` | `DappOrderID` |
| `chain_id` | `chainId` | `ChainID` |
| `token_contract` | `tokenContract` | `TokenContract` |
| `token_symbol` | `tokenSymbol` | `TokenSymbol` |
| `from_address` | `fromAddress` | `FromAddress` |
| `amount_wei` | `amountWei` | `AmountWei` |
| `status` | `status` | `Status` |
| `tx_hash` | `txHash` | `TxHash` |
| `confirmed_at` | `confirmedAt` | `ConfirmedAt` |

Current SDK status values:

- `CHECKOUT_VERIFIED`
- `PAYMENT_CONFIRMED`
- `INVOICED`
- `FAILED`
- `EXPIRED`
- `CANCELLED`

`PAYMENT_CONFIRMED` and `INVOICED` are successful terminal states for the
Server SDK order waiters. Core can advance a DIRECT order from
`PAYMENT_CONFIRMED` to `INVOICED` inside one watcher transaction, so a poller
may observe only `INVOICED`.

The polling helpers differ in timing and retry policy. TypeScript reads
immediately, retries network failures, request timeouts, `408`, `429`, and
server errors, and surfaces other deterministic 4xx errors. Each request has a
30-second deadline bounded by the remaining overall timeout. Go waits one
interval before its first read and retries status-read errors until a later
poll, timeout, or context cancellation; its default HTTP client also has a
30-second timeout.

## 6. Read proof

```http
GET /api/v1/orders/{order_id}/proof
```

```json
{
  "payload": {
    "order_id": "order-id",
    "tx_hash": "0x...",
    "log_index": 0,
    "from_addr": "0x...",
    "to_addr": "0x...",
    "amount_wei": "10000000",
    "from_chain_id": 2345,
    "status": "INVOICED"
  },
  "signature": "0x..."
}
```

Retrieve proof after a trusted successful order status.

The historical field name `signature` is misleading: this value is not a
signature or attestation. It is Keccak256 over these seven payload fields,
concatenated without separators in this exact order:

```text
order_id || tx_hash || log_index || from_addr || to_addr || amount_wei || from_chain_id
```

The digest does not cover `status` or any other field. Anyone can recompute it.
Verify `payload.tx_hash` on-chain when independent proof is required.

## 7. Cancel order

```http
POST /api/v1/orders/{order_id}/cancel
Content-Type: application/json

{}
```

The SDK contract permits cancellation while the order is
`CHECKOUT_VERIFIED`. Do not assume another state is cancellable.

## 8. Read merchant

```http
GET /merchants/{merchant_id}
```

This endpoint is public.

The TypeScript client currently expects a wire response with `merchant_id`,
optional `name`/`logo`, `receive_type` (`DIRECT`), and `wallets[]`, then maps
wallets to `supportedTokens`.

The Go `MerchantInfo` type currently declares `supported_tokens` directly.
Because these two clients expect different token-list field names,
verify the response shape of your target deployment before relying on the Go
`SupportedTokens` field.

## 9. Hosted Checkout Sessions

```http
POST /api/v1/checkout/sessions
```

Authenticated with merchant HMAC. The API key determines the merchant.

### Request

Create a DIRECT session:

```json
{
  "checkout_type": "DIRECT",
  "price": "9.99",
  "client_reference_id": "cart-123",
  "line_items_json": "[{\"name\":\"Mug\",\"amount\":\"9.99\"}]"
}
```

The public DIRECT field mapping is:

| Wire field | TypeScript | Go | Use |
| --- | --- | --- | --- |
| `checkout_type` | `checkoutType` | `CheckoutType` | Use `DIRECT` for public merchant checkout |
| `price` | `price` | `Price` | Decimal product or cart price |
| `success_url` | `successUrl` | `SuccessURL` | Optional allowlisted success redirect |
| `cancel_url` | `cancelUrl` | `CancelURL` | Optional allowlisted cancel redirect |
| `client_reference_id` | `clientReferenceId` | `ClientReferenceID` | Optional correlation/idempotency reference |
| `expires_in` | `expiresIn` | `ExpiresIn` | Optional lifetime in seconds |
| `line_items_json` | `lineItems` | `LineItems` | JSON-stringified display items |
| `public_metadata_json` | `publicMetadata` | `PublicMetadata` | JSON-stringified public metadata |
| `private_metadata_json` | `privateMetadata` | `PrivateMetadata` | JSON-stringified merchant-only metadata |

Use the server SDK so nested values are serialized consistently with HMAC.

Operator-provisioned fields, deprecated wrappers, and callback trust boundaries
are isolated in
[Appendix A](#appendix-a-operator-provisioned-callback-compatibility). They are
not part of public merchant onboarding.

### Response

```json
{
  "checkout_id": "cs_...",
  "checkout_type": "DIRECT",
  "url": "https://flow-quickpay.goat.network/checkout?cs=cs_...",
  "expires_at": 1780000000
}
```

The exported `CheckoutSession.checkoutType` / Go `CheckoutType` response field
is typed as `string`. Known current values are `DIRECT` and `DELEGATE`; handle an
unknown future value explicitly.

The browser receives only the opaque checkout ID:

```ts
const goat = GoatCheckout({ origin: 'https://flow-quickpay.goat.network' })
goat.open({ checkoutId: session.checkoutId })
```

The public page normally owns:

- `GET /checkout/v1/sessions/{checkout_id}`
- `GET /checkout/v1/sessions/{checkout_id}/status`
- `POST /checkout/v1/sessions/{checkout_id}/bind`
- `POST /checkout/v1/sessions/{checkout_id}/signature` for an
  operator-provisioned callback signature when required

Treat the checkout ID as a bearer capability. Browser `onSuccess` is not proof
for fulfillment.

## 10. QuickPay

QuickPay links are public and same-origin:

| Surface | Endpoint |
| --- | --- |
| Web/agent entry | `GET /quickpay/{merchant_id}` |
| Agent instructions | `GET /quickpay/{merchant_id}/agent.md` |
| Manifest | `GET /quickpay/{merchant_id}/manifest.json` |
| Discovery | `GET /quickpay/v1/merchants/{merchant_id}` |
| Create x402 session | `POST /quickpay/v1/x402/sessions` |
| Read x402 session | `GET /quickpay/v1/x402/sessions/{session_id}` |

The `goatflow-quickpay` package accepts only canonical
`/quickpay/{merchant_id}` links over HTTPS (or HTTP loopback for local
development) and derives all called endpoints from that trusted origin.

### Create public x402 session

```json
{
  "merchant_id": "merchant_123",
  "payer_addr": "0xUser",
  "chain_id": 2345,
  "token_contract": "0xToken",
  "amount_wei": "10000000",
  "memo": "invoice-123",
  "idempotency_key": "invoice-123:user-456"
}
```

Use either:

- `amount_wei` for custom amount
- `product_key` for a server-priced product

That JSON is the raw public API shape. The library uses camelCase options:
`amount`, `tokenSymbol`/`tokenContract`, `chainId`, `memo`, and
`idempotencyKey`; it derives `merchant_id` from the trusted QuickPay URL and
`payer_addr` from the payment backend. Product mode uses `productKey`. The
current library does not expose a `clientReferenceId` option, so do not pass raw
snake_case fields to `QuickPayClient.payX402()` or `payProduct()`.

The package validates the trusted origin, merchant identity, and the individual
token, Product, or route entry selected for a payment. Current boundaries:

- non-array `tokens` or `routes` values are normalized to empty lists rather
  than rejected as a malformed manifest;
- `payX402()` does not require the manifest's `custom_amount` flag before
  requesting a raw custom-amount session; and
- Product min/max enforcement remains server-authoritative even when the client
  performs local price and token checks.

Treat manifest validation as client-side discovery and preflight, not a
replacement for server validation.

CLI commands:

```bash
npx goatflow-quickpay inspect <quickpay-url>
npx goatflow-quickpay pay-x402 <quickpay-url> --amount 10 --token USDC --chain 2345
npx goatflow-quickpay pay-product <quickpay-url> --product mug --token USDC --chain 2345
npx goatflow-quickpay pay-mpp <quickpay-url> --route GET:api:data
```

QuickPay session terminal states are `PAYMENT_CONFIRMED`, `EXPIRED`, `FAILED`,
and `CANCELLED`; this is distinct from the Server SDK order model. Session
polling applies `pollTimeoutMs` as a hard cap, retains known transaction hashes
across transient status errors, can adopt a server-confirmed replacement hash
for a fresh payment, and performs five bounded grace polls when a known
transaction is reported `EXPIRED`. A forced reused session does not replace its
local hash with an unrelated prior server hash. Reconcile by session ID and
transaction hash rather than rebroadcasting after an ambiguous failure.

## 11. GOAT Flow MPP integration endpoints

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol. This section documents the current GOAT Flow integration profile,
not the standard MPP HTTP wire format. The current client uses dedicated JSON
challenge and verification endpoints instead of retrying the protected resource
with a standard MPP Credential, and its three-segment signed receipt is a GOAT
Flow extension. No official-SDK interoperability result is currently published.

### GOAT Flow profile challenge

```http
POST /mpp/v1/challenge
Content-Type: application/json
```

```json
{
  "merchant_id": "merchant_123",
  "route_canonical": "GET:api:data",
  "request_canonical": "GET:api:data",
  "payer_addr": "0xUser"
}
```

For this GOAT Flow endpoint, HTTP `402` is success. The SDK accepts `expiry` and
legacy `expiry_unix`:

```json
{
  "challenge_id": "ch_...",
  "expiry": 1780000000,
  "amount_wei": "1000000",
  "chain_id": 4217,
  "token_contract": "0xToken",
  "recipient": "0xRecipient",
  "mac": "...",
  "route_pricing_version": 1
}
```

The returned challenge is authoritative for amount, chain, token contract,
recipient, expiry, MAC, and pricing version. The manifest route is discovery
metadata; never construct or override payment terms from it after the challenge
arrives.

`request_canonical` defaults to `route_canonical` in `MPPClient.pay()`. The
server contract requires it to equal the route or use the route plus a strict
suffix.

For standalone `MPPClient`, `coreUrl` is the configured Core/API origin for the
target deployment. In QuickPay `pay-mpp`, the adapter intentionally uses the
trusted QuickPay link origin as `coreUrl`, keeping manifest, challenge, and
verify requests same-origin. These origins are deployment choices and need not
be globally identical.

### GOAT Flow profile transfer

`payChallenge()`:

- checks challenge expiry
- checks signer provider chain
- broadcasts `ERC20.transfer(recipient, amountWei)`
- returns `{ txHash, tx }` immediately without local confirmation waiting;
  pass `txHash` to verification and use the ethers `TransactionResponse` in
  `tx` for matching transaction-replacement recovery

### GOAT Flow profile verification

```http
POST /mpp/v1/verify
Content-Type: application/json
```

```json
{
  "challenge_id": "ch_...",
  "tx_hash": "0x...",
  "payer_addr": "0xUser",
  "mac": "..."
}
```

| Status | SDK behavior |
| --- | --- |
| `200` | Requires and decodes the GOAT Flow profile's `Payment-Receipt` extension |
| `202` | Retry using `Retry-After` |
| `429` | Retry using `Retry-After` |
| other `4xx` | Terminal `MPPError` |
| `5xx` | Bounded exponential backoff |
| fetch rejection | Bounded retry |

The default verify budget is 16 attempts; individual waits are capped at 30
seconds. A post-broadcast failure from `pay()` carries `MPPError.recoverable` so
the caller can resume `verifyChallenge()` without paying again.

Browser Core responses must allow the DApp origin and expose
`Payment-Receipt`; the protected resource must allow that origin and the
`Payment-Receipt` request header. Otherwise use a server-side buyer client.

## 12. Browser `PaymentHelper`

`PaymentHelper.pay(order)`:

1. Creates an `ERC20Token` for `order.tokenContract`.
2. Reads the connected signer's balance.
3. Returns failure if balance is below `order.amountWei`.
4. Sends `transfer(order.payToAddress, amount)`.
5. Waits for a receipt with status `1`.
6. Returns `{ success: true, txHash }` or `{ success: false, error }`.

It does not validate:

- wallet chain
- payer address
- order expiry
- backend order status

Applications must perform those checks.

The helper converts every `tx.wait()` exception into a failed `PaymentResult`.
Unlike the lower-level `ERC20Token` helpers, it does not classify
`TRANSACTION_REPLACED`; a successful wallet speed-up can therefore be reported
as a failure. Do not submit another transfer solely from that result. Reconcile
the original/replacement transaction and the backend order first.

## 13. Error model

TypeScript API failures throw the runtime-exported `GoatFlowError`, so
`instanceof GoatFlowError` is supported. The error preserves optional `code`
and `status`; authenticated-request failures also preserve the raw
`responseBody`. Fetch/network failures may remain native errors.

Go returns `*APIError` for non-success HTTP responses, preserving status,
optional code, and raw body; transport and JSON errors use wrapped Go errors.
The TypeScript authenticated helper accepts any `2xx` response, while Go
accepts exactly `200`. Both accept `402` only for order creation.

Browser order payment errors are returned in `PaymentResult`. MPP methods throw
`MPPError` with stable `code`, optional `httpStatus`, original `cause`, and
optional recovery context.

`onPhase` is application code and executes outside parts of the MPP error
wrapper. If that callback throws, its arbitrary error can replace the expected
`MPPError`, including during the `failed` phase. Keep it non-throwing or wrap it
locally. `bad_request` is a stable terminal MPP code for rejected HTTP `400`
verification parameters.

Do not retry a payment broadcast solely because an API call timed out. First
determine whether a transaction was already submitted.

## 14. Runtime capability and version sources

Do not hardcode a global chain/token matrix. Availability is
deployment- and merchant-specific. Use the merchant/QuickPay response or
operator configuration.

Current package manifests:

| Package | Version | Runtime |
| --- | --- | --- |
| `goatflow-sdk` | `0.2.1` | Node >= 18 outside browser |
| `goatflow-sdk-server` | `0.3.0` | Node >= 18 |
| `goatflow-quickpay` | `0.3.0` | Node >= 18 |
| `goatflow-checkout` | `0.1.0` | Node >= 18 for tooling |
| Go server SDK | module source | Go 1.25 |

Package manifests, exported types, and release notes are the version source of
truth.

## Appendix A: Operator-provisioned callback compatibility

This appendix is not part of public DIRECT onboarding. Use it only when the
target merchant and environment have an explicit operator deployment contract.

Checkout Session compatibility supports either a decimal `price`, or the
legacy fixed-wei combination of `chain_id`, `fixed_amount_wei`, and
`acceptable_tokens`. For these explicitly provisioned sessions,
`checkout_type` is `DELEGATE`. The additional server-SDK field mapping is:

| Wire field | TypeScript | Go | Use |
| --- | --- | --- | --- |
| `chain_id` | `chainId` | `ChainID` | Legacy fixed-wei source chain |
| `fixed_amount_wei` | `fixedAmountWei` | `FixedAmountWei` | Legacy fixed-wei amount |
| `acceptable_tokens` | `acceptableTokens` | `AcceptableTokens` | JSON-stringified token addresses |
| `callback_calldata` | `callbackCalldata` | `CallbackCalldata` | Optional create-time callback calldata |

Only create-time `callback_calldata` in the legacy fixed-wei form is
server-authoritative and guarantees exact callback bytes. The decimal-price
form rejects create-time calldata. A
`public_metadata_json.callback_template` value is only a hosted-UI encoding
hint: bind-time calldata is buyer-controlled, may be omitted or replaced, and
is not revalidated against the template. The callback contract must enforce its
own selector, parameter, and permission policy.

The TypeScript `createDelegateCheckoutSession()` and Go
`CreateDelegateCheckoutSession()` helpers remain deprecated compatibility
wrappers around `createCheckoutSession()` / `CreateCheckoutSession()`.

An order-create request may include `callback_calldata`. The authoritative
challenge can then use `ERC20_3009` or `ERC20_APPROVE_XFER`, return an
operator-provisioned recipient, and include
`extensions.goatx402.signatureEndpoint` and `calldata_sign_request`.

The signature request supplies the complete EIP-712 `domain`, `types`,
`primaryType`, and `message`. `primaryType` is `Eip3009CallbackData` or
`Permit2CallbackData`; sign the returned structure without rebuilding or
selectively copying it. Its `domain.chainId` can differ from the transfer
source chain, and the SDK does not switch either chain for the application.

After the buyer signs, send the signature to the merchant backend. The backend
submits it with `submitCalldataSignature(orderId, signature)` or
`SubmitCalldataSignature(...)`:

```http
POST /api/v1/orders/{order_id}/calldata-signature
Content-Type: application/json

{ "signature": "0x..." }
```

Keep merchant HMAC credentials on the backend.
