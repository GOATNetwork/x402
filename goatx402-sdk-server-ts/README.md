# goatflow-sdk-server

Server-side TypeScript SDK for GOAT Flow. It creates orders and Hosted Checkout
Sessions, signs protected API requests with merchant HMAC credentials, polls
order status, and retrieves server-issued payment records.

The SDK coordinates API records and reads reported results. It does not
independently verify payment records or on-chain events, and it does not move
or control buyer funds. On the Crypto rail, DIRECT transfers go from the buyer
wallet to the merchant receiving address. An eligible Card session instead
sends the payer through the hosted provider flow.

Never expose the API secret to browser code.

## Install

```bash
npm install goatflow-sdk-server@0.4.0
```

Requires Node.js >= 18.

Install `goatflow-sdk` separately when the browser also uses the mapped
`Order` with `PaymentHelper`.

## Create an order

```ts
import { GoatFlowClient, type Order as ServerOrder } from 'goatflow-sdk-server'
import type { Order as ClientOrder } from 'goatflow-sdk'

const client = new GoatFlowClient({
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
  fromAddress,
  amountWei: '1000000',
})

res.json(toClientOrder(serverOrder, fromAddress))
```

This is a GOAT Mainnet example. For Testnet3, use
`https://flow-api.testnet3.goat.network`, chain `48816`, and credentials and
token configuration from that same deployment. Package version does not select
an environment.

Core returns HTTP `402 Payment Required` for successful order creation. The SDK
treats it as success. Use `createOrderRaw()` when the literal x402 challenge is
needed.

An ordinary duplicate `dappOrderId` is rejected; it does not return the
previous order. Persist the successful `orderId` and reconcile the original
intent after an ambiguous timeout or duplicate response. The
`recoverExistingOrder` option is restricted to exact service-recognized
`topup:` retries and is not a general merchant idempotency switch.

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

For an eligible Card-only session, omit the Crypto `price` and pin the fiat
terms instead:

```ts
const cardSession = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  paymentRails: ['fiat'],
  fiatCurrency: 'USD',
  fiatAmount: '9.99',
  clientReferenceId: 'card-cart-123',
})

// Persist cardSession.checkoutId and cardSession.url in your application
// database before returning the hosted URL to the browser.
```

A session offering both rails needs Crypto `price` plus `fiatCurrency` and
`fiatAmount`; neither the SDK nor the service converts one amount into the
other. Card availability and supported currencies depend on deployment,
merchant eligibility, and connected-provider status. Creating the session is
not payment confirmation. Confirm provider test/live mode before entering card
details; it cannot be inferred from the chain ID.

`clientReferenceId` is a unique merchant correlation value, not a lookup or
idempotent-replay API. A same-merchant duplicate conflicts instead of returning
the original `checkoutId` or URL, so persist both values from the first
successful response.

The returned `checkoutType` is typed as `string`; the current public merchant
path uses `DIRECT`. The types retain compatibility-only fields and
`createDelegateCheckoutSession()` as a deprecated wrapper for explicitly
operator-provisioned deployments. Do not infer merchant availability from these
exports.

Arrays and objects are JSON-stringified into signed scalar fields by the SDK.

The complete compatibility field mapping and callback trust boundary live in
the [API Reference appendix](../docs/goat-flow-api-reference.md#appendix-a-operator-provisioned-callback-compatibility).

## HMAC

Every protected request includes:

- `X-API-Key`
- `X-Timestamp`
- `X-Nonce`
- `X-Sign`

The signature covers top-level body fields plus `api_key`, `timestamp`, and
`nonce`, sorted and joined as `key=value&...`, then HMAC-SHA256 hex encoded.
This legacy delimiter format is ambiguous when unrestricted values contain
`&` or `=`. See the
[API Reference security note](../docs/goat-flow-api-reference.md#2-hmac-authentication);
Core and both server SDKs must migrate the canonicalization contract together.

## API surface

| Method | Purpose |
| --- | --- |
| `createOrder(params)` | Create and normalize an x402 order |
| `createOrderRaw(params)` | Return the raw x402 response |
| `createCheckoutSession(params)` | Create a Hosted Checkout Session |
| `createDelegateCheckoutSession(params)` | Deprecated compatibility wrapper |
| `getOrderStatus(orderId)` | Read order status/details |
| `getOrderProof(orderId)` | Read the server-issued payment record |
| `submitCalldataSignature(orderId, signature)` | Submit an operator-provisioned EIP-712 callback signature |
| `cancelOrder(orderId)` | Cancel a `CHECKOUT_VERIFIED` order |
| `getMerchant(merchantId)` | Read public merchant information |
| `waitForConfirmation(orderId, options)` | Poll status |

`waitForConfirmation()` returns on successful `PAYMENT_CONFIRMED` or
`INVOICED`, and on `FAILED`, `EXPIRED`, or `CANCELLED`. Core can move a DIRECT
order from `PAYMENT_CONFIRMED` to `INVOICED` in one watcher transaction, so a
poller may observe only `INVOICED`. The helper polls immediately, retries
network failures, request timeouts, `408`, `429`, and server errors within the
overall deadline, and surfaces other deterministic 4xx errors immediately.

Every request has a 30-second hard deadline, further bounded by the remaining
`waitForConfirmation()` timeout. HTTP `402` is accepted as the expected response
only for order creation. Checkout, status, proof, signature, and cancellation
fail closed on an unexpected `402`.

API failures throw the runtime-exported `GoatFlowError`. Its `code`, `status`,
and authenticated-request `responseBody` fields preserve server diagnostics
when available.

`getOrderProof()` returns a server-issued payment record whose historical
`signature` field is not a signature or attestation. It is the Keccak256 digest
of `order_id`, `tx_hash`, `log_index`, `from_addr`, `to_addr`, `amount_wei`, and
`from_chain_id`, concatenated in that exact order without separators. It does
not cover `status`. Verify `payload.tx_hash` on-chain when independent proof is
required.

Helpers:

- `calculateSignature`, `signRequest`
- `toCAIP2`, `fromCAIP2`, `parseX402Header`

See the canonical [API contract](../docs/goat-flow-api-reference.md),
[integration guide](../docs/goat-flow-integration.md), [demo server](../goatx402-demo/server/index.ts),
and [Changelog](./CHANGELOG.md).

## License

MIT
