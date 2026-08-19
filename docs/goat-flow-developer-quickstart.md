# GOAT Flow Developer Quick Start

Use this guide to complete a first DIRECT payment with the GOAT Flow SDKs.

For deeper details, see the [Integration Guide](./goat-flow-integration.md) and
[API Reference](./goat-flow-api-reference.md).

## Choose the shortest path

| Goal | Start here |
| --- | --- |
| GOAT Flow-hosted wallet/transfer UI | Hosted Checkout |
| Embedded checkout or payment controls in React | QuickPay React SDK |
| Custom merchant wallet/transfer UI | Server SDK + `PaymentHelper` |
| Agent or CLI payment | QuickPay |
| Paid API route | GOAT Flow MPP profile |

All merchant API credentials stay on your backend.

## Prerequisites

- An approved Merchant Account
- Receiving chain/token configuration
- Sufficient merchant fee balance
- API key and secret for authenticated programmatic flows
- A payer wallet with the selected ERC-20 token and native gas

QuickPay product links and Hosted Checkout do not expose merchant credentials in
the browser. Dynamic Hosted Checkout terms are still created by the merchant
backend.

The runnable examples below use GOAT Testnet3. Move to Mainnet only after the
same merchant, chain, token, receiving address, and service-fee configuration
have been verified there; switch every origin and chain ID together.

## Install

```bash
# Authenticated backend API
npm install goatflow-sdk-server

# Custom browser wallet flow
npm install goatflow-sdk ethers

# Hosted payment window
npm install goatflow-checkout

# Agent / CLI payer
npm install goatflow-quickpay
```

The TypeScript packages declare Node.js >= 18 where Node is used. The Go SDK
module currently declares Go 1.25.

## Path A: Hosted Checkout

### Fixed product

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({
  origin: 'https://flow-quickpay.testnet3.goat.network',
})

payButton.addEventListener('click', () => {
  goat.open({
    merchant: 'merchant_123',
    productKey: 'mug',
    onSuccess(result) {
      // UX signal only. Fulfill after a trusted webhook/status verification.
      console.log(result)
    },
  })
})
```

### Dynamic price

Create the session on your backend:

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: '19.95',
  clientReferenceId: 'cart_123',
  lineItems: [{ name: 'Mug', amount: '19.95', quantity: 1 }],
})
```

Open the opaque session in the browser:

```ts
goat.open({ checkoutId: session.checkoutId })
```

This quick start covers the public DIRECT path. Operator-provisioned session
variants are documented as compatibility reference in the
[Hosted Checkout guide](./goat-flow-checkout.md) and
[API Reference](./goat-flow-api-reference.md); do not select them unless the
target merchant and environment have an explicit deployment contract.

## Path B: Custom order and wallet UI

### 1. Configure the backend

```bash
GOATX402_API_URL=https://flow-api.testnet3.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
```

Never ship these values in a browser bundle.

### 2. Create and map the order

The server and browser SDKs intentionally expose different `Order` shapes.
Map the object explicitly before returning it to the frontend.

```ts
import {
  GoatFlowClient,
  type Order as ServerOrder,
} from 'goatflow-sdk-server'
import type { Order as ClientOrder } from 'goatflow-sdk'

const client = new GoatFlowClient({
  baseUrl: process.env.GOATX402_API_URL!,
  apiKey: process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})

function toClientOrder(order: ServerOrder, fromAddress: string): ClientOrder {
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

export async function createOrder(
  dappOrderId: string,
  fromAddress: string,
): Promise<ClientOrder> {
  const order = await client.createOrder({
    dappOrderId,
    chainId: 48816,
    tokenSymbol: 'USDC',
    fromAddress,
    amountWei: '10000000',
  })

  return toClientOrder(order, fromAddress)
}
```

Generate `dappOrderId` once for the cart or payment intent, persist it before
the request, and reuse the same value for a retry. Do not derive it from the
current timestamp inside `createOrder()`.

Under the hood, successful order creation returns HTTP `402 Payment Required`.
The server SDK treats it as success and normalizes the x402 body.

The server SDK accepts `402` as success only for order creation. An unexpected
`402` from status, proof, checkout, signature, or cancellation fails closed.

### 3. Validate and pay in the browser

```ts
import { PaymentHelper, type Order } from 'goatflow-sdk'
import { ethers } from 'ethers'

export async function payOrder(order: Order): Promise<string> {
  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  const network = await provider.getNetwork()
  if (Number(network.chainId) !== order.chainId) {
    throw new Error(`Switch wallet to chain ${order.chainId}`)
  }

  const payer = await signer.getAddress()
  if (payer.toLowerCase() !== order.fromAddress.toLowerCase()) {
    throw new Error('Connected wallet does not match the order payer')
  }

  if (Math.floor(Date.now() / 1000) >= order.expiresAt) {
    throw new Error('Order expired')
  }

  const payment = new PaymentHelper(signer)

  if (order.calldataSignRequest) {
    throw new Error(
      'This DIRECT quick start does not handle operator-provisioned callback orders',
    )
  }

  const result = await payment.pay(order)
  if (!result.success || !result.txHash) {
    throw new Error(result.error ?? 'Payment failed')
  }
  return result.txHash
}
```

`PaymentHelper.pay()` does not classify `TRANSACTION_REPLACED`. If a wallet
speed-up is reported as failed, reconcile the original/replacement transaction
and backend order before considering another transfer.

Callback signing is an operator-provisioned compatibility path, not part of
this DIRECT quick start. If the target deployment explicitly requires it, use
the complete field, callback-chain, and signature-submission contract in the
[Integration Guide](./goat-flow-integration.md#51-typescript-client).

`PaymentHelper.pay()` checks token balance, submits the ERC-20 transfer, and
waits for a successful receipt. It returns failures in `PaymentResult`; it does
not check chain, payer, or expiration.

### 4. Confirm on the backend

Do not fulfill only because the wallet transaction returned successfully.

```ts
const orderStatus = await client.getOrderStatus(orderId)

const fulfillable =
  orderStatus.status === 'PAYMENT_CONFIRMED' ||
  orderStatus.status === 'INVOICED'

if (fulfillable) {
  const proof = await client.getOrderProof(orderId)
  await fulfillOnce(orderId, proof)
}
```

Current SDK status values are:

- `CHECKOUT_VERIFIED`
- `PAYMENT_CONFIRMED`
- `INVOICED`
- `FAILED`
- `EXPIRED`
- `CANCELLED`

Server SDK order waiters treat `PAYMENT_CONFIRMED` and `INVOICED` as successful
terminal states. Core can advance a DIRECT order from `PAYMENT_CONFIRMED` to
`INVOICED` in one watcher transaction, so a poller may observe only
`INVOICED`. Before fulfillment, still validate the authenticated order's
merchant context, chain, token, amount, recipient, and transaction identity.

Cancel an abandoned order only while it remains `CHECKOUT_VERIFIED`:

```ts
await client.cancelOrder(orderId)
```

## Path C: QuickPay / agent

QuickPay accepts only canonical same-origin links:

```bash
npx goatflow-quickpay inspect \
  https://flow-quickpay.testnet3.goat.network/quickpay/merchant_123/agent.md

npx goatflow-quickpay pay-product \
  https://flow-quickpay.testnet3.goat.network/quickpay/merchant_123/agent.md \
  --product mug \
  --token USDC \
  --chain 48816
```

The library derives the manifest and session endpoints from the trusted link
origin; it rejects remote `http` URLs and cross-origin endpoint substitution.

QuickPay sessions have their own terminal set: `PAYMENT_CONFIRMED`, `EXPIRED`,
`FAILED`, and `CANCELLED`. Polling is bounded by `pollTimeoutMs`, retains a
known transaction hash across transient failures, and performs five bounded
grace polls when a known transaction is reported `EXPIRED`. Reconcile by
session ID and transaction hash instead of rebroadcasting after an ambiguous
post-broadcast failure.

Library options are camelCase. For example, `payX402()` accepts `amount`,
`chainId`, `tokenSymbol`/`tokenContract`, `memo`, and `idempotencyKey`; it
derives the wire `merchant_id` and `payer_addr`. Do not pass raw API fields such
as `amount_wei`, `merchant_id`, or `payer_addr` to the library methods.

## Path D: QuickPay React SDK

Use the React SDK when the host application wants to embed QuickPay UI instead
of redirecting the buyer to a hosted page.

After your team has access to the React SDK package for the target environment:

```tsx
import {
  QuickPayProvider,
  QuickPayPaymentElement,
} from '@goatx402/quickpay-react'
import '@goatx402/quickpay-react/styles.css'

export function Payment({ checkoutId }: { checkoutId: string }) {
  return (
    <QuickPayProvider apiBase="https://flow-quickpay.testnet3.goat.network">
      <QuickPayPaymentElement
        source={{ type: 'checkout-session', checkoutId, checkoutType: 'direct' }}
        onPaymentSuccess={(event) => {
          // UX only. Fulfill from backend status or authenticated webhook.
          console.log(event.checkoutId, event.status)
        }}
      />
    </QuickPayProvider>
  )
}
```

The SDK exposes Hosted Page links, Embedded Checkout, and Payment Element. A
checkout session is a payment source, not a fourth UI surface. See the
[QuickPay React SDK guide](./quickpay-react-sdk.md).

## Path E: GOAT Flow MPP profile

[MPP](https://mpp.dev/overview) is an independent open protocol. The example
below uses the current GOAT Flow adapter: deployment-specific JSON
challenge/verify endpoints, a direct ERC-20 transfer, and a GOAT-specific signed
receipt. It is not generic MPP client code, and no interoperability result with
the official MPP SDKs is currently published.

```ts
import { MPPClient, MPPError } from 'goatflow-sdk'

const mpp = new MPPClient({
  coreUrl: 'https://flow-api.testnet3.goat.network', // no trailing slash
  signer,
})

async function payForRoute() {
  try {
    return await mpp.pay({
      merchantId: 'merchant_123',
      routeCanonical: 'GET:api:data',
    })
  } catch (error) {
    if (error instanceof MPPError && error.recoverable) {
      // Resume verification of the already-broadcast transfer.
      return mpp.verifyChallenge(error.recoverable)
    }
    throw error
  }
}

const result = await payForRoute()
await fetch('/api/data', {
  headers: { 'Payment-Receipt': result.receiptHeader },
})
```

This is the standalone GOAT Flow MPP adapter, so `coreUrl` is the Core/API
origin configured for that deployment. QuickPay `pay-mpp` instead derives
`coreUrl` from the trusted QuickPay link origin so discovery, challenge, and
verify remain same-origin.

For this profile's challenge endpoint, success is HTTP `402`. Verify success is
HTTP `200` with its signed `Payment-Receipt` extension. A browser integration
works only when the Core origin
allows the DApp origin and exposes that response header, and the protected
resource allows the `Payment-Receipt` request header. Otherwise run the buyer
flow server-side. Once returned, the challenge is authoritative for payment
amount, chain, token, recipient, expiry, MAC, and pricing version.

## Test environment

| Resource | GOAT Testnet3 | GOAT Mainnet |
| --- | --- | --- |
| Chain ID | `48816` | `2345` |
| RPC | `https://rpc.testnet3.goat.network` | `https://rpc.goat.network` |
| Explorer | `https://explorer.testnet3.goat.network` | `https://explorer.goat.network` |
| Merchant Portal | `https://flow-merchant.testnet3.goat.network` | `https://flow-merchant.goat.network` |
| Admin Portal (operators only) | `https://flow-admin.testnet3.goat.network` | `https://flow-admin.goat.network` |
| Flow API / standalone MPP Core | `https://flow-api.testnet3.goat.network` | `https://flow-api.goat.network` |
| QuickPay / Checkout and same-origin public API | `https://flow-quickpay.testnet3.goat.network` | `https://flow-quickpay.goat.network` |

GOAT native gas is BTC. Testnet3 gas is available from the
[faucet](https://bridge.testnet3.goat.network/faucet). Token contracts and
enabled transfer capabilities remain deployment/merchant-specific.

## Troubleshooting

### Order creation

- Confirm key, timestamp, nonce, and signature inputs.
- Confirm merchant fee balance.
- Confirm the chain/token is enabled for this merchant.
- Treat HTTP `402` as success only on documented challenge endpoints.
- If status/proof/checkout/signature/cancel returns `402`, the Server SDK fails
  closed; treat it as an endpoint or deployment mismatch.

### Wallet transfer

- Confirm `chainId`, `fromAddress`, and `expiresAt` before calling `pay()`.
- Confirm the token balance is at least `amountWei`.
- Read `PaymentResult.error`; `pay()` normally does not throw its payment error.

### Status does not advance

- Confirm token contract, recipient, amount, chain, and payer match the order.
- Allow for the deployment's confirmation/finality requirement.
- For Server SDK order polling, `INVOICED` is a successful terminal state.
- For QuickPay session polling, use its separate terminal set; it does not
  include `INVOICED`.

### GOAT Flow MPP transfer broadcast but verify failed

- If `MPPError.recoverable` exists, call `verifyChallenge()` with it.
- Do not call `pay()` again for the same already-broadcast payment.
- Confirm Core CORS allows the DApp origin and exposes `Payment-Receipt`, and
  the protected resource allows that origin and request header.

## Related documents

- [Integration Guide](./goat-flow-integration.md)
- [API Reference](./goat-flow-api-reference.md)
- [Hosted Checkout](./goat-flow-checkout.md)
- [QuickPay React SDK](./quickpay-react-sdk.md)
- [GOAT Flow MPP Integration](./mpp.md)
- [Merchant Guide](./merchant-guide.md)
- [Onboarding Guide](./goat-flow-onboarding-guide.md)
