---
name: goat-flow-dapp-integration
description: Implement or review GOAT Flow commerce integrations in an existing Web DApp using authenticated merchant APIs, Hosted Checkout, QuickPay, or MPP. Use for fixed products, server-priced purchases, custom transfer interfaces, buyer or agent purchases, paid API routes, and audits of pricing, fulfillment, retry, receipt, and environment boundaries.
---

# GOAT Flow DApp Integration

## Goal

Add the smallest GOAT Flow integration that satisfies the application's real
payment and fulfillment requirements. Preserve the application's existing
architecture and business behavior outside the payment gate.

Target the public DIRECT merchant path by default. Do not add callback signing
or other optional receiving modes unless the user supplies a deployment
contract that explicitly requires them.

## Establish the Source of Truth

Before editing, inspect the package source and exports in the version actually
used by the application. Use this evidence order:

1. Package source, types, tests, and exports for client behavior.
2. Deployed API contract for URLs, status semantics, webhooks, and operator
   configuration.
3. Merchant portal observations for environment-specific settings.

Use the repository documentation for context, but resolve conflicts in favor
of the implementation and deployment contract. Do not infer a production
capability from a testnet observation.

## Keep Environments Isolated

Use one environment consistently across API credentials, merchant ID, checkout
origin, QuickPay link, chain, token contract, RPC, and wallet funds.

| Surface | Testnet3 | Mainnet |
| --- | --- | --- |
| Flow API / standalone MPP Core | `https://flow-api.testnet3.goat.network` | `https://flow-api.goat.network` |
| Hosted Checkout / QuickPay and same-origin public API | `https://flow-quickpay.testnet3.goat.network` | `https://flow-quickpay.goat.network` |

Treat these as deployment configuration, not library defaults. Verify them
against the active deployment before shipping.

## Guardrails

- Keep `GOATX402_API_KEY` and `GOATX402_API_SECRET` in a server runtime only.
- Never put a private key in browser code, source control, argv, logs, or an
  agent transcript.
- Treat browser callbacks and wallet receipts as UX signals, not merchant
  fulfillment proof.
- Obtain current amount, token, recipient, chain, and expiry from trusted
  server terms. Do not hardcode a global payment matrix.
- Use a Product or server-created Checkout Session for automatically fulfilled
  purchases. Treat buyer-entered custom amounts as untrusted.
- Do not call a payment method again after a transaction may have broadcast.
  Resume status polling or verification with the existing handle.
- Do not invent fees, webhook events, approval steps, or account policy.
- Do not fund wallets or perform mainnet payments without explicit permission.
- Keep the user's source tree and unrelated changes intact.
- Treat Machine Payments Protocol (MPP) as an independent open protocol, not a
  GOAT Flow protocol. Call the current MPP endpoints, client, middleware, and
  signed receipt a GOAT Flow integration profile or adapter. Do not present its
  JSON challenge/verify endpoints or three-segment receipt as the standard MPP
  HTTP wire format, and do not claim official-SDK interoperability without a
  conformance test.
- In explanatory copy, describe GOAT Flow as commerce and verification software
  that observes an on-chain transfer, verifies it, confirms finality, updates
  protocol state, and issues a receipt.
- Do not describe GOAT Flow as processing, handling, facilitating, accepting,
  collecting, routing, or settling funds, or as a payment processor, gateway,
  platform, layer, rail, solution, or infrastructure.
- For DIRECT, state that the buyer wallet sends tokens directly to the merchant
  receiving address. Keep service-fee credits and Fee Top-up separate from
  buyer-to-merchant funds.

## Gather Context

Collect or infer:

- application path, framework, package manager, and existing backend
- existing cart, order, request, or business reference
- current pricing authority and fulfillment action
- selected GOAT Flow environment and merchant ID
- backend API URL and credentials when merchant APIs are required
- hosted checkout origin when Checkout or QuickPay is required
- wallet provider, supported chain, token contract, RPC, and test funds when a
  live payment is required

If an authenticated path is selected and backend credentials are unavailable,
implement the configuration boundary but stop before a live merchant API call.

## Inspect the Application

1. Locate the current purchase or protected action.
2. Locate the server-side pricing and fulfillment code.
3. Reuse existing order IDs and idempotency references.
4. Confirm whether a trusted server runtime exists.
5. Preserve the current framework, package manager, routing, and state model.
6. Identify every point where duplicate clicks, retries, reloads, or wallet
   replacement transactions can occur.

## Choose One Primary Path

| Requirement | Primary path | Pricing authority | Fulfillment authority |
| --- | --- | --- | --- |
| Fixed catalog item, hosted wallet UI | Hosted Checkout Product | Merchant Product | Trusted session/order status |
| Dynamic cart or invoice, hosted wallet UI | Hosted Checkout Session | Merchant backend | Trusted session/order status |
| Fully custom wallet UI | Authenticated Order API | Merchant backend | Authenticated order status/proof |
| Public buyer/agent automation | QuickPay library or CLI | Manifest preflight plus server session | Terminal server session |
| Paid API route | Current GOAT Flow MPP profile | Core profile challenge | Verified profile `Payment-Receipt` middleware |
| Tip or donation | Hosted custom amount or QuickPay custom amount | Buyer input, reconciled server-side | Observed paid amount |

Do not combine paths unless the application genuinely needs separate payment
experiences.

## Hosted Checkout

Install `goatx402-checkout`. Configure a bare trusted origin: HTTPS in deployed
environments, or HTTP only for loopback development. Reject origins containing
credentials, a path, query, or fragment.

```ts
import { GoatCheckout } from 'goatx402-checkout'

const checkout = GoatCheckout({ origin: checkoutOrigin })
```

Call `open()` synchronously from a user gesture. It accepts exactly one
fulfillable price source:

```ts
checkout.open({
  merchant: merchantId,
  productKey,
  clientReferenceId,
})
```

or:

```ts
checkout.open({
  checkoutId,
  clientReferenceId,
})
```

Do not combine `checkoutId` with `merchant` or `productKey`. Product opens use
`/quickpay/checkout`; server-created session opens use `/checkout?cs=...`. The
fulfillable URL must not contain an authoritative amount.

For a dynamic purchase, create the session on the backend:

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: cartTotal,
  clientReferenceId: cartId,
  lineItems,
  privateMetadata: { cartId },
})
```

Return only the opaque `session.checkoutId` and non-sensitive display data to
the browser. The current return type is `CheckoutSession`, containing
`checkoutId`, `checkoutType`, `url`, and `expiresAt`.

Use `display: 'popup'` by default, `tab` for a new tab, and `redirect` when the
opener channel is unavailable. `redirectToCheckout()` and redirect display do
not provide an opener callback after navigation. Treat `onSuccess` as a UX
event only; query trusted server state before fulfillment.

Use `openCustom({ merchant, amount })` only for tips or donations. Reconcile the
actual paid amount on the server before granting anything of value.

## Authenticated Order API

Install `goatx402-sdk-server` on the backend and `goatflow-sdk` in the browser.
Create `GoatX402Client` only in server code.

```ts
const order = await client.createOrder({
  dappOrderId,
  chainId,
  tokenSymbol,
  tokenContract,
  fromAddress,
  amountWei,
})
```

HTTP 402 is the expected successful response only for order creation. The
current TypeScript server SDK's shared authenticated request helper also
accepts 402 for other methods. Validate every returned shape and fail closed on
an unexpected 402 or malformed result from Checkout, status, proof, signature,
or cancellation calls.

The server and browser `Order` types differ. Map them explicitly; do not pass a
server order to `PaymentHelper` without adding the payer address and converting
`fromChainId` to `chainId`.

```ts
import type { Order as ServerOrder } from 'goatx402-sdk-server'
import type { Order as BrowserOrder } from 'goatflow-sdk'

function toBrowserOrder(
  order: ServerOrder,
  fromAddress: string,
): BrowserOrder {
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

Before payment, verify in application code that the connected wallet matches
`fromAddress`, the wallet network matches `chainId`, and the order has not
expired. `PaymentHelper.pay()` does not perform those checks.

If a supposedly DIRECT order contains `calldataSignRequest`, stop and require
the explicit operator-provisioned callback contract. That path must sign the
exact EIP-712 request on `domain.chainId`, submit it through the merchant
backend, and return the wallet to the transfer source chain before paying.

```ts
import { PaymentHelper } from 'goatflow-sdk'

const result = await new PaymentHelper(signer).pay(order)
if (!result.success || !result.txHash) {
  throw new Error(result.error ?? 'Payment failed')
}
```

`PaymentHelper.pay()` catches transfer failures and returns
`{ success: false, error }`; it does not throw `PaymentError`. It waits for the
local transaction receipt, but that receipt is not trusted fulfillment proof.
Poll the backend with `getOrderStatus()` or `waitForConfirmation()`.
It also treats any `tx.wait()` exception as failure without classifying
`TRANSACTION_REPLACED`; reconcile wallet speed-ups and backend status before
another transfer.

Treat `PAYMENT_CONFIRMED`, `FAILED`, `EXPIRED`, and `CANCELLED` as the terminal
states implemented by the TypeScript and Go waiters. `INVOICED` is a known
state, but its fulfillment meaning is deployment-controlled and it is not a
terminal state in the current waiters. Cancel only a stale
`CHECKOUT_VERIFIED` order.

The TypeScript waiter's timeout is checked between requests and does not abort
an in-flight fetch. Do not treat it as a hard wall-clock deadline.

The TypeScript client currently creates plain `Error` objects and structurally
adds `name`, `status`, and `code`. Preserve those fields, but do not rely on
`instanceof GoatX402Error`.

## QuickPay Library and CLI

Install `goatx402-quickpay` for public payer or agent automation. Prefer Hosted
Checkout for an interactive browser DApp unless the application already owns a
safe wallet backend.

Accept only canonical merchant links:

```text
https://<trusted-origin>/quickpay/<merchant_id>
https://<trusted-origin>/quickpay/<merchant_id>/agent.md
https://<trusted-origin>/quickpay/<merchant_id>/manifest.json
```

Derive the merchant ID from the trusted URL path and keep manifest, session,
challenge, and verification requests on the same origin. Treat the manifest as
discovery and preflight data. Treat the returned x402 session or MPP challenge
as the current payment instruction.

Validate generated `agent.md` commands against the installed package metadata.
The current Testnet3 file may say `npx goatflow-quickpay`, while the supported
package and binary are `goatx402-quickpay`; do not execute the unverified
generated name.

```ts
import { QuickPayClient } from 'goatx402-quickpay'

const quickpay = new QuickPayClient(sharedMerchantLink)
const manifest = await quickpay.loadManifest()
const result = await quickpay.payProduct({
  productKey,
  chainId,
  tokenContract,
  backend,
  idempotencyKey: businessReference,
})
```

Inject a `PaymentBackend`; the library does not choose a wallet implicitly.
`EthersPaymentBackend` accepts a private key and RPC resolver, so use it only in
a controlled CLI/server environment with secrets supplied out of band. Never
bundle it with a payer key in browser code.

For `payProduct()`, use camelCase library fields and let the server price the
product. For `payX402()`, pass a decimal `amount`, `chainId`, a token symbol or
contract, a backend, and an explicit `idempotencyKey` when the payment intent
must survive retries. Raw HTTP bodies use snake_case and atomic `amount_wei`;
do not mix the two interfaces.

Check `result.ok`, `result.status`, `result.session_id`, and `result.tx_hash`.
The terminal session states are `PAYMENT_CONFIRMED`, `EXPIRED`, `FAILED`, and
`CANCELLED`; `INVOICED` is not an assumed success state. A reused session is
polled rather than rebroadcast. Pass literal `force: true` only when it is
proven that no transfer was broadcast.

Use an explicit idempotency key for durable Product recovery when product,
token, or rail configuration may change. If QuickPay MPP reports a transaction
hash without a signed receipt header, do not run the payment again; reconcile
the transaction and resume verification only when the challenge handle is
available.

## Standalone GOAT Flow MPP Adapter

[MPP](https://mpp.dev/overview) is an independent open protocol. The current
`MPPClient` is GOAT Flow's current adapter and is not generic MPP client code.
Install `goatflow-sdk` and construct it with a trusted Core/API origin without a
trailing slash. This trust model differs from QuickPay MPP, which derives Core
from the shared link origin.

```ts
import { MPPClient, MPPError } from 'goatflow-sdk'

const mpp = new MPPClient({
  coreUrl,
  signer,
})

async function payForRoute() {
  try {
    return await mpp.pay({
      merchantId,
      routeCanonical,
      requestCanonical,
      onPhase,
    })
  } catch (error) {
    if (error instanceof MPPError && error.recoverable) {
      return mpp.verifyChallenge(error.recoverable)
    }
    throw error
  }
}
```

Omit `requestCanonical` to use `routeCanonical`. When provided, it must equal
the route or start with `routeCanonical + ':'`.

Treat the challenge as authoritative for amount, chain, token contract,
recipient, expiry, MAC, and pricing version. `pay()` checks expiry and chain,
broadcasts without waiting locally, and uses Core verification as the finality
authority. Verification retries network failures, 5xx, 202, and 429; it treats
other 4xx responses as terminal. The default verification budget is 16
attempts; changing it may also require a matching Core rate-limit change.

Require all successful MPP results to contain `receiptHeader`, `receiptBody`,
`txHash`, and `challengeId`. Attach the exact signed value to the protected
request:

```ts
await fetch(resourceUrl, {
  headers: { 'Payment-Receipt': result.receiptHeader },
})
```

This GOAT Flow receipt extension has three dot-separated segments:
`base64url(receipt JSON).base64url(signature).algorithm`. For browser use, the
Core deployment must allow the DApp origin, `POST`, and `Content-Type`, and must
expose `Payment-Receipt` on verify responses. The protected resource must also
allow the DApp origin and the `Payment-Receipt` request header. Otherwise keep
the buyer flow server-side.

Branch on `MPPError.code`, not message text. Stable current codes include
`network_error`, `parse_error`, `route_not_found`, `invalid_request`,
`chain_mismatch`, `user_rejected`, `payment_failed`, `challenge_expired`,
`challenge_already_consumed`, `challenge_tx_hash_mismatch`, `payer_mismatch`,
`bad_request`, `verify_timeout`, `service_unavailable`, `receipt_missing`, and
`receipt_malformed`.

Keep `onPhase` non-throwing or catch its errors locally. User callbacks can run
outside parts of the SDK error wrapper and replace the expected `MPPError`.

After broadcast, call `verifyChallenge(error.recoverable)` and never call
`pay()` again. Keep the replacement-aware recovery handle; the SDK follows
compatible wallet fee-bump transaction hashes while polling.

## Protect GOAT Flow MPP-Profile Routes

These middlewares verify the GOAT Flow receipt extension; they do not parse a
generic MPP Credential or Receipt. The TypeScript and Go middleware are
source-only in this repository. Do not
claim registry installation unless the active release process has published
them. Build `goatx402-mpp-middleware-ts` locally, install that directory, and
import framework adapters from their subpaths, not the package root.

```ts
import { expressMiddleware } from '@goatnetwork/mpp-middleware/express'

app.get(
  '/paid-resource',
  expressMiddleware({
    merchantId,
    routeCanonical: 'GET:paid-resource',
    algorithm: 'ed25519',
    ed25519Public,
    store: receiptStore,
  }),
  handler,
)
```

For Fastify, import `fastifyPreHandler` or `fastifyPlugin` from
`@goatnetwork/mpp-middleware/fastify`. For Go, bind
`github.com/goatnetwork/goatx402-mpp-middleware-go` to the local source
directory with a `replace` directive before importing it.

Configure `merchantId`, `routeCanonical`, and either `ed25519Public` for
`ed25519` or `hmacSecret` for `hmac-sha256`. Read the verified receipt from
`req.mppReceipt`. Use a shared atomic receipt store in multi-replica production;
the in-memory store is only suitable for local or single-process use.

The middleware verifies a signed receipt, audience, route binding, expiry, and
optional single use. It does not issue a challenge or execute payment. Expect
401 for missing, malformed, invalid, wrong-audience, or consumed receipts; 402
for route mismatch or receipt expiry; and 503 for receipt-store unavailability.
Unexpected verifier exceptions may produce 500 and must fail closed.

## Fulfillment and State

Represent only states the selected integration can prove. Keep protected work
blocked until one of these trusted authorities succeeds:

- authenticated order or session status approved by the deployment contract
- an authenticated webhook event documented by the active deployment
- MPP middleware verification for the current protected request

Do not hardcode webhook event names. The public SDKs do not define one universal
webhook event contract.

Separate wallet rejection, wrong network, insufficient token balance,
insufficient native gas, expiry, backend failure, and post-broadcast recovery.
Persist order IDs, checkout IDs, QuickPay session IDs, idempotency keys,
transaction hashes, MPP challenge recovery data, and the application's business
reference as appropriate. Never persist secrets in client storage.

## Validate

Run the application's existing checks plus focused tests for the selected path.
Verify all of the following that apply:

- backend credentials and private keys are absent from browser bundles and logs
- package imports match the installed version and build successfully
- mainnet and testnet configuration cannot be mixed
- fixed Product and Checkout Session URLs contain no amount
- custom amounts cannot unlock fixed-price fulfillment
- server orders are explicitly mapped to browser orders
- `PaymentHelper.pay()` failure results are handled
- unexpected authenticated HTTP 402 results fail closed
- `INVOICED` is not treated as success without a deployment contract
- browser callbacks cannot fulfill an order by themselves
- repeated clicks, retries, reloads, and reused sessions cannot double-pay
- QuickPay uses same-origin endpoints and explicit recovery identifiers
- MPP success includes both transaction hash and signed receipt header
- post-broadcast MPP failures resume verification rather than payment
- middleware rejects wrong audience, wrong route, expired, malformed, replayed,
  and unverifiable receipts
- a shared receipt store is used when production has multiple replicas
- the original protected action resumes only after trusted confirmation

When live verification is unavailable, report the exact missing environment,
merchant configuration, wallet, chain, token, RPC, balance, or deployment
contract. Do not describe static review as a successful payment test.

## Deliver

Return:

- selected path and why it fits
- modified files and payment entry points
- environment variables and their server/browser ownership
- pricing, trust, retry, recovery, and fulfillment boundaries
- startup, build, test, and live-verification commands actually run
- verified outcomes and remaining deployment confirmations

## Repository References

Consult these files when working in this repository:

- [Developer Quick Start](../goat-flow-developer-quickstart.md)
- [API Reference](../goat-flow-api-reference.md)
- [Hosted Checkout](../goat-flow-checkout.md)
- [Integration Guide](../goat-flow-integration.md)
- [GOAT Flow MPP Integration](../mpp.md)
