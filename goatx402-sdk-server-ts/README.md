# goatx402-sdk-server

Server-side TypeScript SDK for GOAT Flow. It creates orders and Hosted Checkout
Sessions, signs protected API requests with merchant HMAC credentials, polls
order status, and retrieves payment proofs.

The SDK coordinates API records and reads reported results. It does not
independently verify proofs, response signatures, or on-chain events, and it
does not move or control buyer funds. DIRECT transfers go from the buyer wallet
to the merchant receiving address.

Never expose the API secret to browser code.

## Install

```bash
npm install goatx402-sdk-server goatflow-sdk
```

Requires Node.js >= 18.

## Create an order

```ts
import { GoatX402Client, type Order as ServerOrder } from 'goatx402-sdk-server'
import type { Order as ClientOrder } from 'goatflow-sdk'

const client = new GoatX402Client({
  baseUrl: process.env.GOATX402_API_URL ?? 'https://flow-api.goat.network',
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

const fromAddress = '0xUser'
const serverOrder = await client.createOrder({
  dappOrderId: 'my-order-123',
  chainId: 2345,
  tokenSymbol: 'USDC',
  tokenContract: '0xToken',
  fromAddress,
  amountWei: '1000000',
})

res.json(toClientOrder(serverOrder, fromAddress))
```

Core returns HTTP `402 Payment Required` for successful order creation. The SDK
treats it as success. Use `createOrderRaw()` when the literal x402 challenge is
needed.

For an explicitly operator-provisioned compatibility flow, `callbackCalldata`
may produce `calldata_sign_request` and a signature endpoint. Submit the returned
EIP-712 signature with `submitCalldataSignature(orderId, signature)`. This is not
part of the current public DIRECT onboarding path; see the API Reference for the
complete field contract.

The server and browser `Order` types differ. The server type has
`fromChainId` / `payToChainId` and no `fromAddress`; map it explicitly as shown.

## Hosted Checkout

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: '9.99',
  lineItems: [{ name: 'Mug', amount: '9.99', quantity: 1 }],
  clientReferenceId: 'cart-123',
})
```

The returned `checkoutType` is typed as `string`; the current public merchant
path uses `DIRECT`. The types retain DELEGATE and legacy fixed-wei fields for
operator-provisioned compatibility deployments. `createDelegateCheckoutSession()`
is a deprecated wrapper. Do not infer merchant availability from these exports.

Arrays and objects are JSON-stringified into signed scalar fields by the SDK.

## HMAC

Every protected request includes:

- `X-API-Key`
- `X-Timestamp`
- `X-Nonce`
- `X-Sign`

The signature covers top-level body fields plus `api_key`, `timestamp`, and
`nonce`, sorted and joined as `key=value&...`, then HMAC-SHA256 hex encoded.

## API surface

| Method | Purpose |
| --- | --- |
| `createOrder(params)` | Create and normalize an x402 order |
| `createOrderRaw(params)` | Return the raw x402 response |
| `createCheckoutSession(params)` | Create a Hosted Checkout Session |
| `createDelegateCheckoutSession(params)` | Deprecated compatibility wrapper |
| `getOrderStatus(orderId)` | Read order status/details |
| `getOrderProof(orderId)` | Read signed proof |
| `submitCalldataSignature(orderId, signature)` | Submit an operator-provisioned EIP-712 callback signature |
| `cancelOrder(orderId)` | Cancel a `CHECKOUT_VERIFIED` order |
| `getMerchant(merchantId)` | Read public merchant information |
| `waitForConfirmation(orderId, options)` | Poll status |

The status union includes `INVOICED`, but its success/terminal meaning is
deployment-defined and `waitForConfirmation()` does not stop on it. The helper
polls immediately and propagates `getOrderStatus()` errors instead of retrying
them. Its timeout is checked between requests and does not abort an in-flight
`fetch`, so it is not a hard wall-clock deadline. Use explicit polling when you
need another policy.

Compatibility caveat: the shared authenticated request helper accepts HTTP
`402` for every method, although only order creation defines `402` as success.
Treat `402` from checkout, status, proof, signature, or cancellation as an
unexpected deployment/version response and validate the returned shape.

Helpers:

- `calculateSignature`, `signRequest`
- `toCAIP2`, `fromCAIP2`, `parseX402Header`

See the canonical [API contract](../docs/goat-flow-api-reference.md),
[integration guide](../docs/goat-flow-integration.md), [demo server](../goatx402-demo/server/index.ts),
and [Changelog](./CHANGELOG.md).

## License

MIT
