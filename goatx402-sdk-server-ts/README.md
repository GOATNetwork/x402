# goatflow-sdk-server

Server-side TypeScript SDK for **GOAT Flow** payment integration. It signs
authenticated API requests with your merchant credentials (HMAC with
per-request nonce and replay protection), so the key and secret stay on your
backend — **never expose them to the frontend**. Public endpoints such as
`getMerchant` need no credentials.

Pair it with [`goatflow-sdk`](https://github.com/GOATNetwork/x402/tree/main/goatx402-sdk)
in the browser: this package creates the order, the frontend SDK pays it.

## Install

```bash
npm install goatflow-sdk-server
```

## Quick start

```typescript
import { GoatFlowClient } from 'goatflow-sdk-server'

const client = new GoatFlowClient({
  baseUrl: 'https://flow-api.goat.network',
  apiKey: process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})

// Create an order
const order = await client.createOrder({
  dappOrderId: 'my-order-123',
  chainId: 97,
  tokenSymbol: 'USDC',
  tokenContract: '0x...',
  fromAddress: userWalletAddress,
  amountWei: '1000000',
})

// Return the order to the frontend for payment
res.json(order)
```

## API surface

| Method | Purpose |
|--------|---------|
| `createOrder(params)` | Create a payment order |
| `createOrderRaw(params)` | Create an order and return the raw x402 `402 Payment Required` payload |
| `createCheckoutSession(params)` | Create a hosted checkout session (DIRECT and DELEGATE flows) |
| `createDelegateCheckoutSession(params)` | Deprecated DELEGATE-only wrapper, kept for compatibility |
| `getOrderStatus(orderId)` | Fetch current order status and details |
| `getOrderProof(orderId)` | Fetch the payment record; `signature` is an unsigned content hash, not an attestation |
| `submitCalldataSignature(orderId, signature)` | Submit the buyer's EIP-712 calldata signature |
| `cancelOrder(orderId)` | Cancel an order |
| `getMerchant(merchantId)` | Fetch public merchant info (tokens, receiving config) |
| `waitForConfirmation(orderId, ...)` | Poll until the order reaches a terminal state (confirmed, failed, expired, or cancelled) or polling times out |

Helpers: `calculateSignature` / `signRequest` (request signing),
`toCAIP2` / `fromCAIP2` / `parseX402Header` (x402 header and chain-id utilities).

API failures throw the runtime-exported `GoatFlowError` class. Its `code` and
`status` fields carry structured server details when available; authenticated
request failures also retain the raw `responseBody` for diagnostics.

All requests have a 30-second hard deadline. `waitForConfirmation` additionally
honors its overall timeout, retries transient failures, and immediately surfaces
deterministic 4xx errors other than `408` and `429`.

## Requirements

Node.js >= 18.

## Documentation

Release notes: [`CHANGELOG.md`](./CHANGELOG.md). Backend integration examples
live in the repository's demo server
([`goatx402-demo`](https://github.com/GOATNetwork/x402/tree/main/goatx402-demo)).

## License

MIT
