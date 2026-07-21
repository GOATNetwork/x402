# Why GOAT Flow?

GOAT Flow packages the recurring parts of an on-chain commerce integration into
reusable order, checkout, QuickPay, and MPP-adapter interfaces. Its value is not a
promise to remove every wallet or blockchain concern; it is a narrower and more
useful promise to give applications a consistent way to obtain transfer terms,
have a buyer wallet submit a direct transfer, track status, and verify the
result.

---

## 1. The Integration Problem

A production payment flow needs more than an ERC-20 `transfer`:

- the server must define the expected chain, token, recipient, and amount
- the payment must be correlated with an application order
- the frontend must handle wallet interaction and transaction failure
- the backend must distinguish a pending payment from a confirmed one
- fulfillment must use a trusted result, not a browser-only callback
- agent payments need machine-readable discovery and authorization artifacts

Without a shared contract, every application builds these pieces independently.

---

## 2. What GOAT Flow Provides

| Surface | Implemented responsibility |
| --- | --- |
| Server SDK | Authenticated orders/sessions, status, cancellation, proof, and merchant lookup |
| Browser SDK | Buyer-authorized ERC-20 transfer submission, balance checks, and GOAT Flow MPP-adapter support |
| Checkout SDK | Hosted checkout, trusted purchase intents, and validated popup messaging |
| QuickPay | Same-origin discovery, custom-amount transfers, Products, recovery, and MPP |
| MPP-profile middleware | GOAT Flow receipt-extension signature, audience, route, expiry, and optional single use |

This division keeps merchant credentials and price authority on trusted server
surfaces while leaving wallet confirmation with the buyer.

---

## 3. Why DIRECT Is Useful

For `ERC20_DIRECT`, the challenge's `payTo` address is the merchant receiving
address. The buyer sends the ERC-20 transfer there directly.

That gives the merchant:

- an on-chain transfer to its configured address
- an order ID and status lifecycle for application reconciliation
- a signed proof endpoint after confirmation
- a common SDK shape across runtime-configured EVM chains and tokens

DIRECT does not make the transaction gasless. The buyer wallet still broadcasts
and pays gas for the ERC-20 transfer unless a separate wallet-layer mechanism
sponsors it.

---

## 4. Why Hosted Checkout Helps

Hosted Checkout separates the purchase intent from the buyer-controlled browser.

For fulfillable purchases:

- a QuickPay Product carries a merchant-defined decimal price
- a Checkout Session carries a backend-created, server-authoritative price
- the browser URL carries only a `productKey` or opaque `checkoutId`, not an
  authoritative amount
- the buyer chooses only from payment options offered by the server

The Checkout SDK also validates the configured origin and checks the popup
origin, source window, and random nonce before accepting UX messages.

The boundary is deliberate: `onSuccess` can update the interface, but the
merchant must verify payment on a trusted backend before fulfillment.

---

## 5. Why QuickPay Helps Public Buyers and Agents

A QuickPay link exposes a machine-readable manifest without giving the buyer
merchant credentials.

The manifest can describe:

- available x402 tokens and amount bounds
- whether custom amounts are enabled
- fixed-price Products
- paid MPP routes

The QuickPay client derives session and MPP endpoints from the trusted URL
origin, rejects malformed manifests, and checks fresh payment terms before the
payer backend submits tokens directly to the instructed recipient. Products are
independently converted from decimal price into the selected token's base units
before the transfer is allowed.

Explicit idempotency keys support durable session recovery. Reused unpaid
sessions are not rebroadcast by default, which reduces accidental double
payment.

---

## 6. Why MPP Helps Paid APIs

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol, not a GOAT Flow protocol. Its standard HTTP model uses a
Challenge, Credential, and Receipt and supports multiple payment methods. GOAT
Flow's current adapter uses dedicated JSON challenge/verify endpoints, a direct
ERC-20 transfer, and a signed three-segment receipt extension.

That current adapter gives an agent a payment artifact that can be presented to
a protected HTTP route.

The buyer flow is:

`challenge -> ERC-20 transfer -> verify -> Payment-Receipt`

The merchant middleware then validates:

- receipt signature algorithm and signature
- merchant audience
- canonical route binding
- receipt expiry
- optional single-use consumption

This makes authorization explicit at the protected resource boundary. A
transaction hash alone is not enough; success requires the signed receipt
header.

The SDK also preserves a recovery handle when verification fails after the
payment has already been broadcast, allowing the caller to retry verification
without sending a second payment.

---

## 7. Choosing the Right Surface

| Requirement | Use |
| --- | --- |
| Merchant backend creates a payment order | `goatx402-sdk-server` order API |
| Fixed-price public catalog item | QuickPay Product + `goatx402-checkout` |
| Dynamic cart or backend-priced purchase | `createCheckoutSession(...)` + `open({ checkoutId })` |
| Tip or donation with a buyer-entered amount | QuickPay custom amount |
| Agent pays to access an API route | GOAT Flow MPP adapter + profile middleware |

---

## 8. What Must Remain Runtime-Defined

The public SDKs intentionally do not define a universal commercial or
operational policy.

Confirm these with the deployed environment:

- enabled chains and token contracts
- token decimals and amount bounds
- merchant fees and fee-balance behavior
- merchant registration and approval workflow
- password, 2FA, and account-recovery policy
- webhook event names, payloads, signatures, and retry behavior

Applications should read payment terms from the x402 challenge, public merchant
configuration, or QuickPay manifest rather than copying a static matrix from a
document.

---

## 9. Practical Tradeoffs

GOAT Flow still depends on:

- an operated API and checkout service for new orders and status
- chain RPC availability and confirmation time
- a compatible EVM signer and sufficient token/native-gas balances
- merchant-side fulfillment and reconciliation logic
- correct deployment configuration

It is most valuable where standardized on-chain payment, public agent
discovery, or receipt-protected APIs justify those dependencies. It is less
useful for fiat-only products or conventional recurring billing.

---

## Summary

GOAT Flow reduces on-chain commerce integration work by giving developers a
consistent contract for transfer requirements, server-authoritative checkout,
public QuickPay discovery, and its current MPP receipt extension. Its strongest
guarantees come from enforced pricing boundaries, explicit status and proof
handling, same-origin discovery, replay-aware session behavior, and fail-closed
receipt verification.

## Related

- [Documentation hub](./README.md)
- [What is GOAT Flow](./what-is-goat-flow.md)
- [Integration Guide](./goat-flow-integration.md)
