# GOAT Flow FAQ

This FAQ covers public SDK and API behavior and identifies settings that depend
on the active GOAT Flow environment.

---

## Product and Payments

### What is GOAT Flow?

GOAT Flow provides commerce and transfer-verification software for merchants,
applications, and agents using the x402 protocol, including:

- browser and server SDKs
- hosted checkout
- QuickPay buyer/agent tooling
- MPP buyer support and merchant middleware

### What is DIRECT?

For `ERC20_DIRECT`, the x402 challenge's `payTo` address is the merchant
receiving address. The browser SDK executes a standard ERC-20 transfer to that
address.

---

## Chains, Tokens, Amounts, and Fees

### Which chains are supported?

There is no authoritative global chain list in the public SDK types.

- For authenticated orders, use the returned x402 `accepts[]` entries.
- For QuickPay, use `rails.x402.tokens` in the merchant manifest.
- For the current GOAT Flow MPP profile, use `rails.mpp.routes`.
- The public `getMerchant(...)` result exposes configured merchant token
  entries.

Do not hardcode a chain table from narrative documentation.

### Which tokens are supported?

Token support is merchant and environment configuration. USDC and USDT appear
as examples in types and tests, but applications must use the token contract,
symbol, decimals, and limits returned at runtime.

### Does QuickPay enforce minimum and maximum amounts?

The QuickPay manifest includes `min_amount_wei` and optional
`max_amount_wei` for each x402 token entry. The QuickPay client validates those
values and preflights a fresh custom-amount payment against them.

Products are priced with a positive decimal `price`; the selected token's
decimals determine the base-unit amount.

### Is there a universal minimum such as USD 0.01?

No universal minimum is defined. Use the runtime token bounds and the active
service policy.

### What service fees are configured for a deployment?

The public packages do not export a stable merchant service-fee schedule or
fee-balance type. The fee balance is separate from buyer-to-merchant transfers;
it must not be described as a balance of customer funds. Fees, top-up
requirements, reservation/refund rules, and insufficient-fee responses must be
confirmed with the deployed portal and API environment.

Do not encode fixed values or environment-specific HTTP responses unless the
active API documents them.

### Who pays gas?

For DIRECT and the current GOAT Flow MPP profile, the buyer wallet broadcasts
the ERC-20 transfer and normally pays the chain's native gas. This is a property
of the GOAT Flow adapter, not MPP generally. A separate AA wallet or Paymaster
may sponsor gas, but that is not implemented by the GOAT Flow client SDK itself.

---

## Orders and HTTP Semantics

### Why does order creation return HTTP 402?

HTTP 402 is the expected success path for `POST /api/v1/orders`. The response is
an x402 payment challenge with `x402Version`, `accepts[]`, order metadata, and
GOAT-specific extensions.

The server SDKs treat HTTP 402 as success only for order creation. An
unexpected 402 from status, proof, checkout, signature, or cancellation fails
closed.

### What payment fields are authoritative?

Use the returned payment option:

- `scheme`
- `network`
- `amount`
- `asset`
- `payTo`
- `maxTimeoutSeconds`

Do not reconstruct these terms from a symbol-only or chain-only configuration.

### What order statuses exist in the SDK?

The public order status union contains:

- `CHECKOUT_VERIFIED`
- `PAYMENT_CONFIRMED`
- `INVOICED`
- `FAILED`
- `EXPIRED`
- `CANCELLED`

The server SDK's `waitForConfirmation(...)` returns on successful
`PAYMENT_CONFIRMED` or `INVOICED`, and on `FAILED`, `EXPIRED`, or `CANCELLED`.
Core can move a DIRECT order from `PAYMENT_CONFIRMED` to `INVOICED` in one
watcher transaction, so a poller may observe only `INVOICED`.

### Can an order be canceled?

The server SDK exposes cancellation for an order in `CHECKOUT_VERIFIED`.
Whether cancellation restores a fee balance or other reservation is a
server-side policy and should not be promised solely from the client method.

An already-broadcast on-chain token transfer cannot be canceled by the SDK.

### How should API errors be handled?

TypeScript API failures are surfaced as the runtime-exported `GoatFlowError`
with:

- `message`
- optional `code`
- optional HTTP `status`

Authenticated-request failures also preserve `responseBody`.
`instanceof GoatFlowError` is supported. Branch on stable status/code fields
when the deployed API documents them; avoid parsing free-form error messages as
a long-term contract.

---

## Proof and Fulfillment

### How is payment confirmed?

The public server SDK polls `GET /api/v1/orders/:orderId` and returns the
configured order status, transaction hash, and confirmation time when present.

The internal listener architecture, RPC failover policy, and exact confirmation
thresholds are not exported by these packages. Treat them as deployment
configuration.

### Is a browser checkout success callback proof of payment?

No. Checkout callbacks are explicitly documented as UX signals. A merchant must
use a trusted backend order/session status or an authenticated webhook before
fulfillment.

### Which webhook event should I use?

The public SDKs do not export one canonical webhook event union. Confirm the
event name, payload, signature verification, and retry policy against the active
webhook contract.

Do not build fulfillment around an event name copied only from a narrative
example.

### Is there an order proof API?

Yes. `getOrderProof(orderId)` returns a server-issued payment record containing
the order ID, transaction hash, log index, payer, recipient, amount, source
chain, and status.

Its historical `signature` field is not a signature or attestation. It is
Keccak256 over `order_id`, `tx_hash`, `log_index`, `from_addr`, `to_addr`,
`amount_wei`, and `from_chain_id`, concatenated in that exact order without
separators; it does not cover `status`. Verify the transaction hash on-chain
when independent proof is required.

---

## QuickPay and Products

### What is the QuickPay discovery surface?

A buyer or agent starts from one of these same-origin paths:

- `/quickpay/<merchant_id>`
- `/quickpay/<merchant_id>/agent.md`
- `/quickpay/<merchant_id>/manifest.json`

The QuickPay client accepts only those canonical URL shapes, requires HTTPS
except for loopback development, and derives all subsequent endpoints from the
trusted origin.

### What does the manifest contain?

Schema `goatx402.quickpay.v1` contains merchant identity plus:

- `rails.x402.enabled`
- custom-amount and memo flags
- x402 token entries and amount bounds
- optional QuickPay Products
- `rails.mpp.enabled`
- MPP route entries

The client validates the trusted origin, merchant identity, and selected token,
Product, or MPP route before payment. It does not reject every malformed
enabled-rail container: non-array token/route lists are currently normalized to
empty lists, and the raw custom-amount client does not require the manifest's
`custom_amount` flag. The session/challenge response and deployed service remain
authoritative.

### How do QuickPay Products work?

A Product contains:

- `product_key`
- `name`
- optional description and HTTPS image URL
- token-agnostic decimal `price`

The buyer chooses a chain/token advertised by the merchant. For a fresh
purchase, the QuickPay client independently converts the price using token
decimals and refuses to broadcast unless the session's x402 terms match the
expected chain, token, amount, and recipient shape.

### Can a fixed-price Product be opened without a merchant backend?

Yes. The Checkout SDK supports:

```ts
goat.open({ merchant, productKey })
```

The browser URL contains the merchant and product key, not the product price.
The product must already exist in the merchant's QuickPay configuration.

### Can I embed QuickPay in my own React page?

Yes. Use the [QuickPay React SDK](./quickpay-react-sdk.md) when you want
Embedded Checkout or a Payment Element instead of only redirecting to a hosted
page.

The React SDK uses the same product, custom-amount, and checkout-session payment
sources. Hosted Page, Embedded Checkout, and Payment Element are UI surfaces.
`checkoutId` is a payment source, not a fourth component type.

### What is a dynamic Hosted Checkout Session?

The merchant backend calls `createCheckoutSession(...)` with
`checkoutType: "DIRECT"` and server-authoritative terms. It receives an opaque
`checkoutId`, which the browser opens with:

```ts
goat.open({ checkoutId })
```

The authenticated API key determines the merchant; the request body does not.

The same `checkoutId` can also be passed to the React SDK:

```tsx
<QuickPayPaymentElement
  source={{ type: 'checkout-session', checkoutId, checkoutType: 'direct' }}
/>
```

Use this when the host owns the surrounding page but wants QuickPay to own the
payment controls and session polling.

### What is custom QuickPay?

Custom QuickPay lets the browser or CLI supply an amount. It is appropriate for
tips, donations, or other cases where the merchant will reconcile the actual
payment.

It is not appropriate as the sole price authority for automatically fulfilled
goods.

### How does QuickPay reduce duplicate payments?

QuickPay supports `idempotency_key`. The client recognizes reused sessions and
does not rebroadcast an unpaid reused session unless the caller explicitly
forces it. For Products, an explicit idempotency key also supports recovery when
the current manifest has changed.

Status polling applies `pollTimeoutMs` as a hard cap and preserves a known
transaction hash across transient failures. A known transaction reported
`EXPIRED` receives five bounded grace polls for a possible late confirmation.
Reconcile by session ID and transaction hash instead of rebroadcasting after an
ambiguous post-broadcast failure.

---

## Machine Payments Protocol

### Is MPP a GOAT Flow protocol?

No. [Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an
independent open protocol with a standard Challenge/Credential/Receipt HTTP
exchange and extensible payment methods. GOAT Flow currently implements a
deployment-specific adapter with JSON challenge/verify endpoints, a direct
ERC-20 transfer, and a signed three-segment receipt extension.

No interoperability result with official MPP SDKs is currently published. Do
not treat `MPPClient` or the middleware as a generic or official MPP
implementation without an adapter and conformance testing.

### What does a buyer using the GOAT Flow MPP profile need?

A buyer using the current GOAT Flow profile needs:

- a trusted QuickPay URL
- an EVM wallet signer
- an RPC connection for the route's chain
- the exact `route_canonical` advertised in the manifest

The buyer does not use the merchant API key or secret.

### What is the current GOAT Flow MPP integration flow?

1. `POST /mpp/v1/challenge`
2. transfer the challenged ERC-20 amount to the challenged recipient
3. `POST /mpp/v1/verify`
4. receive the signed `Payment-Receipt` header
5. call the protected merchant route with that header

### What does the GOAT Flow receipt extension protect?

The middleware verifies:

- signature and configured algorithm
- merchant audience
- canonical route binding
- expiry
- optional receipt-ID single-use consumption

A successful receipt is attached to the Express or Fastify request, or to the
Go request context.

### What are the merchant middleware error semantics?

The TypeScript middleware returns stable JSON reason codes:

| Condition | HTTP status | `error` |
| --- | ---: | --- |
| Missing receipt | 401 | `payment_required` |
| Malformed receipt | 401 | `invalid_payment_receipt` |
| Invalid signature | 401 | `invalid_signature` |
| Wrong merchant | 401 | `audience_mismatch` |
| Wrong route | 402 | `route_mismatch` |
| Expired receipt | 402 | `receipt_expired` |
| Already consumed | 401 | `receipt_already_consumed` |
| Receipt store unavailable | 503 | `receipt_store_unavailable` |

Unexpected verifier throws fail closed with HTTP 500 `internal_error` in the
Express adapter.

### How does GOAT Flow profile verification polling behave?

The browser SDK:

- retries HTTP 202 and 429 using `Retry-After`
- retries network failures and 5xx responses with bounded backoff
- treats other 4xx responses as terminal
- requires a `Payment-Receipt` header on HTTP 200
- returns stable `MPPError.code` values

### What if verification fails after the transfer was broadcast?

Do not call `pay()` again blindly. The SDK attaches a `recoverable` payload to
post-broadcast `MPPError` instances so the caller can run
`verifyChallenge(...)` for the existing transaction.

The QuickPay CLI also avoids reporting success unless it has both a transaction
hash and the signed receipt header.

---

## Credentials and Account Security

### Where should merchant API credentials live?

Only on the merchant backend. The browser SDK must receive normalized order
data, not the API key or secret.

### How are authenticated SDK requests signed?

The TypeScript server SDK signs parameters with HMAC-SHA256 and sends:

- `X-API-Key`
- `X-Timestamp`
- unique `X-Nonce`
- `X-Sign`

The server's exact timestamp window, nonce retention, and rejection codes are
not exported by the public client package; confirm them with the deployed API
contract.

### What is the registration and approval workflow?

Merchant registration, approval, API-key issuance, and rejection policy are
managed through the Merchant Portal. Follow the portal and
[Merchant Guide](./merchant-guide.md) for the target environment.

### How do password recovery and 2FA work?

Password changes, account recovery, 2FA enrollment and reset, session lifetime,
and administrator permissions are managed through the active portal. See the
[Merchant Guide](./merchant-guide.md#4-approval-login-and-account-security), and
contact [Support@goat.network](mailto:Support@goat.network) when self-service
recovery is unavailable.

### Which wallets are supported?

The browser SDK accepts an `ethers.Signer` and executes standard ERC-20
operations. No tested vendor-by-vendor wallet compatibility matrix is currently
published.

WalletConnect, embedded wallets, account-abstraction wallets, and Paymasters may
work when they provide compatible signer/provider behavior, but they are not a
GOAT Flow SDK guarantee.

---

## Operations, Compliance, and Support

### Where are KYC, AML, tax, and privacy requirements defined?

These technical documents do not provide a merchant compliance determination.
Merchants must confirm jurisdiction-specific requirements, data handling,
reporting, and sanctions controls separately.

### What should be confirmed before production?

- merchant approval and enabled receive type
- receiving addresses
- live chain/token entries and limits
- fee and top-up policy
- API base URL and checkout origin
- webhook contract and signature validation
- MPP receipt algorithm/key and shared replay store for multi-replica services
- fulfillment behavior for every terminal status

### Where can I get support?

Contact [Support@goat.network](mailto:Support@goat.network).

## Related

- [Documentation hub](./README.md)
- [Developer Quick Start](./goat-flow-developer-quickstart.md)
- [Merchant Guide](./merchant-guide.md)
