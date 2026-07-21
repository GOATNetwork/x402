# GOAT Flow Developer Quick Start

Use this guide to complete a first DIRECT payment with the GOAT Flow SDKs.

For deeper details, see the [Integration Guide](./goat-flow-integration.md) and
[API Reference](./goat-flow-api-reference.md).

## Choose the shortest path

| Goal | Start here |
| --- | --- |
| GOAT Flow-hosted wallet/transfer UI | Hosted Checkout |
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

## Install

```bash
# Authenticated backend API
npm install goatx402-sdk-server

# Custom browser wallet flow
npm install goatflow-sdk

# Hosted payment window
npm install goatx402-checkout

# Agent / CLI payer
npm install goatx402-quickpay
```

The TypeScript packages declare Node.js >= 18 where Node is used. The Go SDK
module currently declares Go 1.25.

## Path A: Hosted Checkout

### Fixed product

```ts
import { GoatCheckout } from 'goatx402-checkout'

const goat = GoatCheckout({ origin: 'https://flow-quickpay.goat.network' })

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
[API Reference](./goat-flow-api-reference.md); do not select them unless the target
merchant and environment have an explicit deployment contract.

## Path B: Custom order and wallet UI

### 1. Configure the backend

```bash
GOATX402_API_URL=https://flow-api.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
```

Never ship these values in a browser bundle.

### 2. Create and map the order

The server and browser SDKs intentionally expose different `Order` shapes.
Map the object explicitly before returning it to the frontend.

```ts
import {
  GoatX402Client,
  type Order as ServerOrder,
} from 'goatx402-sdk-server'
import type { Order as ClientOrder } from 'goatflow-sdk'

const client = new GoatX402Client({
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

export async function createOrder(fromAddress: string): Promise<ClientOrder> {
  const order = await client.createOrder({
    dappOrderId: `order_${Date.now()}`,
    chainId: 2345,
    tokenSymbol: 'USDC',
    tokenContract: '0xToken',
    fromAddress,
    amountWei: '10000000',
  })

  return toClientOrder(order, fromAddress)
}
```

Under the hood, successful order creation returns HTTP `402 Payment Required`.
The server SDK treats it as success and normalizes the x402 body.

Current server-SDK compatibility behavior also accepts `402` from other
authenticated endpoints. That is not protocol success; reject an unexpected
`402` unless the called endpoint explicitly defines a challenge response.

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
  (deploymentTreatsInvoicedAsSuccess && orderStatus.status === 'INVOICED')

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

`INVOICED` is a known SDK value, but its success/terminal meaning is defined by
the target deployment. Current TypeScript and Go polling helpers do not stop on
it. Use explicit `getOrderStatus()` polling when the deployment uses that state.

Cancel an abandoned order only while it remains `CHECKOUT_VERIFIED`:

```ts
await client.cancelOrder(orderId)
```

## Path C: QuickPay / agent

QuickPay accepts only canonical same-origin links:

```bash
npx goatx402-quickpay inspect \
  https://flow-quickpay.goat.network/quickpay/merchant_123/agent.md

npx goatx402-quickpay pay-product \
  https://flow-quickpay.goat.network/quickpay/merchant_123/agent.md \
  --product mug \
  --token USDC \
  --chain 2345
```

The library derives the manifest and session endpoints from the trusted link
origin; it rejects remote `http` URLs and cross-origin endpoint substitution.

Library options are camelCase. For example, `payX402()` accepts `amount`,
`chainId`, `tokenSymbol`/`tokenContract`, `memo`, and `idempotencyKey`; it
derives the wire `merchant_id` and `payer_addr`. Do not pass raw API fields such
as `amount_wei`, `merchant_id`, or `payer_addr` to the library methods.

## Path D: GOAT Flow MPP profile

[MPP](https://mpp.dev/overview) is an independent open protocol. The example
below uses the current GOAT Flow adapter: deployment-specific JSON
challenge/verify endpoints, a direct ERC-20 transfer, and a GOAT-specific signed
receipt. It is not generic MPP client code, and no interoperability result with
the official MPP SDKs is currently published.

```ts
import { MPPClient, MPPError } from 'goatflow-sdk'

const mpp = new MPPClient({
  coreUrl: 'https://flow-api.goat.network', // no trailing slash
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
- If status/proof/checkout/signature/cancel returns `402`, treat it as an
  unexpected compatibility response, not success.

### Wallet transfer

- Confirm `chainId`, `fromAddress`, and `expiresAt` before calling `pay()`.
- Confirm the token balance is at least `amountWei`.
- Read `PaymentResult.error`; `pay()` normally does not throw its payment error.

### Status does not advance

- Confirm token contract, recipient, amount, chain, and payer match the order.
- Allow for the deployment's confirmation/finality requirement.
- Apply the deployment's documented meaning for `INVOICED`; do not assume it is
  globally successful or terminal.

### GOAT Flow MPP transfer broadcast but verify failed

- If `MPPError.recoverable` exists, call `verifyChallenge()` with it.
- Do not call `pay()` again for the same already-broadcast payment.
- Confirm Core CORS allows the DApp origin and exposes `Payment-Receipt`, and
  the protected resource allows that origin and request header.

## Related documents

- [Integration Guide](./goat-flow-integration.md)
- [API Reference](./goat-flow-api-reference.md)
- [Hosted Checkout](./goat-flow-checkout.md)
- [GOAT Flow MPP Integration](./mpp.md)
- [Merchant Guide](./merchant-guide.md)
- [Onboarding Guide](./goat-flow-onboarding-guide.md)
