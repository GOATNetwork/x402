# What is GOAT Flow?

GOAT Flow is the GOAT Network implementation of x402 commerce and payment-
verification flows for merchants, applications, and agents. It turns protocol
requirements, buyer-authorized on-chain transfers, verification, and
fulfillment into a consistent integration flow.

**GOAT Flow** is the product. **x402** is the HTTP payment protocol used by the
order and checkout surfaces.

---

## The Core x402 Flow

The authenticated order API follows this sequence:

1. A merchant backend creates an order.
2. The API returns an HTTP 402 payment challenge.
3. The challenge contains one or more payment options in `accepts[]`, including
   network, token contract, amount, and `payTo`.
4. The buyer wallet sends the required ERC-20 transfer directly to the merchant
   receiving address.
5. The merchant backend polls the order status or receives a deployment-defined
   webhook.
6. After confirmation, the merchant can request the signed order proof.

The server SDK treats HTTP 402 as the expected create-order response and
normalizes the challenge into an `Order` for the browser SDK.

---

## Payment Mode: DIRECT

`ERC20_DIRECT` sends the selected ERC-20 token to the merchant receiving
address. The browser SDK executes a standard token `transfer` to the challenge's
`payTo` address and waits for the transaction receipt.

DIRECT is the clearest fit for:

- checkout and commerce payments
- API and content monetization
- tips and donations
- QuickPay custom amounts and products
- MPP-protected API routes

## Hosted Checkout

The Checkout SDK opens the GOAT Flow-hosted checkout in a top-level popup, tab,
or redirect.

It supports two server-authoritative purchase forms:

- **QuickPay Product:** the browser supplies `merchant` and `productKey`; the
  product manifest supplies the decimal price, while the buyer chooses an
  offered chain/token.
- **Checkout Session:** the merchant backend creates an opaque `checkoutId`
  with `createCheckoutSession(...)`; the browser opens that ID and never sends
  the price.

A separate custom-amount method exists for tips and donations. Because that
amount comes from the browser, it must not be used as the sole authority for
automatic fulfillment.

Browser `onSuccess` is a UX signal only. The merchant must confirm payment from
a trusted backend status source or an authenticated deployment-defined webhook.

---

## QuickPay

QuickPay is the public buyer and agent surface. A trusted QuickPay URL resolves
to a same-origin manifest using schema `goatx402.quickpay.v1`.

The manifest can advertise:

- x402 custom-amount availability
- offered chain/token entries and per-token amount bounds
- fixed-price Products identified by `product_key`
- MPP routes with chain, token, and amount metadata

The `goatx402-quickpay` library and CLI validate the manifest, derive all API
endpoints from the trusted URL origin, and verify fresh session payment terms
before the configured payer backend submits a direct transfer.

Supported commands are:

- `inspect`
- `pay-x402`
- `pay-product`
- `pay-mpp`

---

## Machine Payments Protocol

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent,
open, payment-method-agnostic protocol; it is not defined by GOAT Flow. GOAT
Flow currently provides an MPP-labeled integration profile for paid resources.
That profile works as follows:

1. The buyer requests a challenge for a merchant and canonical route.
2. The challenge binds the amount, chain, token, recipient, expiry, and pricing
   version.
3. The buyer sends an ERC-20 transfer to the challenge recipient.
4. The buyer submits the transaction hash for verification.
5. A successful verification returns a signed `Payment-Receipt` header.
6. The buyer presents that header to the merchant's protected route.

The TypeScript and Go middleware verify the receipt signature, merchant
audience, route binding, expiry, and optionally single-use receipt consumption.

Buyers using this GOAT Flow profile do not use the merchant's API key or secret.
They need a wallet signer and an RPC connection for the route's advertised
chain. The profile's JSON challenge/verify endpoints and three-segment signed
receipt are GOAT-specific extensions, not the generic MPP HTTP wire format.

---

## Chains, Tokens, and Amount Limits

Chain and token availability is runtime configuration, not a universal static
matrix.

- The x402 challenge is authoritative for an authenticated order.
- The QuickPay manifest is authoritative for public QuickPay and GOAT Flow
  MPP-profile discovery.
- `getMerchant(...)` exposes the merchant's configured receive type and token
  entries.

USDC and USDT appear as examples in the SDK types and tests, but those examples
are not a promise that every deployment or merchant supports both tokens.

---

## Security Boundaries

The public implementation establishes several clear boundaries:

- Merchant API keys and secrets stay on the backend.
- The server SDK signs authenticated requests with HMAC-SHA256 and includes a
  timestamp and unique `X-Nonce`.
- Hosted Checkout only accepts messages from the configured origin, the exact
  popup window, and the matching random channel nonce.
- QuickPay derives endpoints from the trusted link origin instead of trusting
  arbitrary manifest URLs.
- Before a fresh QuickPay transfer, the client verifies the session scheme,
  chain, token, and amount, and requires a non-empty `payTo` from the trusted
  origin before broadcasting.
- GOAT Flow MPP-profile middleware validates its signed receipt extension and
  fails closed on invalid, expired, mismatched, replayed, or unverifiable
  receipts.

Registration approval, 2FA, password recovery, fee policy, and webhook signing
are operated-service concerns. Their current procedure must be taken from the
deployed portal and environment documentation, not inferred from SDK types.

---

## Where GOAT Flow Fits

GOAT Flow is a good fit when a product needs:

- pay-per-request APIs
- fixed-price or server-priced checkout
- on-chain payment status and proof
- public agent payment discovery
- receipt-protected machine-to-machine APIs

It is less direct for fiat-only audiences, traditional recurring billing, or
products that do not benefit from on-chain payment.

---

## Getting Started

1. Complete merchant setup in the deployed portal.
2. Configure receiving addresses and runtime payment capabilities.
3. Keep API credentials on the backend.
4. Choose the appropriate integration surface:
   - order API
   - QuickPay Product
   - Hosted Checkout Session
   - custom QuickPay
   - MPP
5. Test the exact environment configuration before production fulfillment.

Continue with:

- [Developer Quick Start](./goat-flow-developer-quickstart.md)
- [Hosted Checkout](./goat-flow-checkout.md)
- [GOAT Flow MPP Integration](./mpp.md)
- [GOAT Flow FAQ](./goat-flow-faq.md)

Support: [Support@goat.network](mailto:Support@goat.network)
