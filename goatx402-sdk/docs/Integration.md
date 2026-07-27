# goatflow-sdk Integration Guide

This guide covers the public contract of the browser-oriented
`goatflow-sdk` package. Merchant API authentication and order creation belong in
`goatflow-sdk-server` or the Go server SDK.

For the complete GOAT Flow API guide, see
[GOAT Flow Integration](../../docs/goat-flow-integration.md).

## 1. Install and runtime boundary

```bash
npm install goatflow-sdk ethers
```

The package manifest declares:

- package version `0.2.1`
- Node.js >= 18 for non-browser use
- ethers `^6.9.0`

Browser use requires an ethers-compatible signer, normally from an EIP-1193
wallet provider.

## 2. Exports

```ts
import {
  PaymentHelper,
  MPPClient,
  MPPError,
  PaymentError,
  ERC20Token,
  parseUnits,
  formatUnits,
  signTypedData,
  hashCalldata,
  verifySignature,
} from 'goatflow-sdk'
```

The package also exports order, EIP-712, approval, and MPP types.

## 3. Order boundary

The server and browser SDK `Order` interfaces are not interchangeable.

Server SDK:

```ts
interface ServerOrder {
  orderId: string
  flow: PaymentFlow
  tokenSymbol: string
  tokenContract: string
  payToAddress: string
  fromChainId: number
  payToChainId: number
  amountWei: string
  expiresAt: number
  calldataSignRequest?: CalldataSignRequest
  x402?: X402PaymentRequired
}
```

Browser SDK:

```ts
interface ClientOrder {
  orderId: string
  flow: PaymentFlow
  tokenSymbol: string
  tokenContract: string
  fromAddress: string
  payToAddress: string
  chainId: number
  amountWei: string
  expiresAt: number
  calldataSignRequest?: CalldataSignRequest
}
```

Map it on the backend:

```ts
import type { Order as ServerOrder } from 'goatflow-sdk-server'
import type { Order as ClientOrder } from 'goatflow-sdk'

function toClientOrder(
  order: ServerOrder,
  fromAddress: string,
): ClientOrder {
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

Do not expose merchant API credentials or the raw server object to the browser.

## 4. `PaymentHelper`

### 4.1 Setup

```ts
import { PaymentHelper } from 'goatflow-sdk'
import { ethers } from 'ethers'

const provider = new ethers.BrowserProvider(window.ethereum)
await provider.send('eth_requestAccounts', [])
const signer = await provider.getSigner()
const payment = new PaymentHelper(signer)
```

### 4.2 Application validation

`PaymentHelper.pay()` does not check order chain, payer, or expiry.

```ts
async function validateOrder(order: ClientOrder): Promise<void> {
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
}
```

### 4.3 Pay

```ts
await validateOrder(order)

const result = await payment.pay(order)
if (!result.success || !result.txHash) {
  throw new Error(result.error ?? 'Payment failed')
}
```

Actual implementation:

1. Builds an `ERC20Token` with the signer.
2. Reads the signer's token balance.
3. Converts `amountWei` with `BigInt`.
4. Submits `transfer(payToAddress, amount)`.
5. Waits for the transaction receipt.
6. Requires receipt status `1`.
7. Returns `PaymentResult`.

Errors are caught and returned:

```ts
interface PaymentResult {
  success: boolean
  txHash?: string
  error?: string
}
```

`PaymentError` is exported, but the current `pay()` implementation does not wrap
failures in it.

The helper also treats every `tx.wait()` exception as failure and does not
classify `TRANSACTION_REPLACED`. A successful wallet speed-up can therefore be
reported as failed. Reconcile the original/replacement transaction and backend
order before submitting another transfer.

### 4.4 Supported flow values

```ts
type PaymentFlow =
  | 'ERC20_DIRECT'
  | 'ERC20_3009'
  | 'ERC20_APPROVE_XFER'
```

All three browser paths transfer to the returned `payToAddress`. DIRECT is the
standard/default merchant path. The other values belong to an explicitly
operator-provisioned compatibility integration and are not part of public
onboarding.

## 5. Callback EIP-712 signing

When `calldataSignRequest` is present:

```ts
const signature = await payment.signCalldata(order)

await fetch(`/api/orders/${order.orderId}/signature`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ signature }),
})
```

The merchant backend forwards it using
`submitCalldataSignature(orderId, signature)`.

That method sends `{ signature }` to the HMAC-authenticated
`POST /api/v1/orders/{order_id}/calldata-signature` endpoint. The returned
`CalldataSignRequest` supplies:

- `domain`: `name`, `version`, `chainId`, `verifyingContract`
- `types`: the full EIP-712 field definitions
- `primaryType`: `Eip3009CallbackData` or `Permit2CallbackData`
- `message`: `token`, `owner`, `payer`, `amount`, `orderId`,
  `calldataNonce`, `deadline`, `calldataHash`, and optional `permit2`

The SDK removes `EIP712Domain` from the types object because ethers v6 handles
the domain separately. Never rebuild the domain/types/message in application
code.

Utilities:

```ts
const calldataHash = hashCalldata('0x...')
const valid = verifySignature(signRequest, signature, expectedSigner)
```

## 6. Token helpers

```ts
const balance = await payment.getTokenBalance(tokenAddress)
const allowance = await payment.getTokenAllowance(tokenAddress, spender)
const tx = await payment.transferToken(tokenAddress, recipient, amount)
```

`transferToken()` returns after broadcast; unlike `pay()`, it does not wait for
the receipt.

### 6.1 Amount conversion

```ts
const amountWei = parseUnits('100.5', 6) // 100500000n
const amount = formatUnits(100500000n, 6) // "100.5"
```

### 6.2 Approval behavior

```ts
const finalTx = await payment.approveToken(
  tokenAddress,
  spender,
  1000000n,
)
```

Exact approval is the default. Unlimited approval is explicit:

```ts
await payment.approveToken(
  tokenAddress,
  spender,
  1000000n,
  { unlimited: true },
)
```

The implementation:

- validates amount is a non-negative `bigint` <= `MaxUint256`
- validates options before any transaction
- skips a write when the allowance already equals the target
- lets `ensureApproval()` keep any allowance already sufficient for the amount
- probes direct non-zero replacement with `eth_call`
- uses a confirmed zero reset only when the direct write cannot be proven
- checks zero allowance after reset/revoke
- follows matching fee-bump replacements
- rejects cancellation or unrelated same-nonce replacement

`PaymentHelper.approveToken()` returns only the final transaction or
`undefined`. Use `ERC20Token.setApproval()` for `{ tx?, resetTx? }`.

## 7. MPP

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol. This section documents GOAT Flow's current adapter, not the
standard MPP HTTP Challenge/Credential/Receipt wire exchange. Its JSON
challenge/verify endpoints and signed three-segment receipt are GOAT-specific;
the repository contains no official-SDK interoperability test.

### 7.1 Setup

```ts
import { MPPClient } from 'goatflow-sdk'

const mpp = new MPPClient({
  coreUrl: 'https://flow-api.goat.network',
  signer,
})
```

`coreUrl` must be non-empty and must not end with `/`.
For the standalone GOAT Flow MPP adapter it is the configured Core/API origin. QuickPay's
`pay-mpp` adapter instead derives `coreUrl` from the trusted QuickPay link
origin so discovery, challenge, and verify stay same-origin.

### 7.2 High-level payment

```ts
const result = await mpp.pay({
  merchantId: 'merchant_123',
  routeCanonical: 'GET:api:data',
  requestCanonical: 'GET:api:data:user-42',
  onPhase(phase, detail) {
    console.log(phase, detail)
  },
})

await fetch('/api/data', {
  headers: { 'Payment-Receipt': result.receiptHeader },
})
```

Phases:

```ts
type MPPPhase =
  | 'requesting_challenge'
  | 'challenge_received'
  | 'sending_transaction'
  | 'transaction_sent'
  | 'transaction_replaced'
  | 'verifying'
  | 'verify_pending'
  | 'verified'
  | 'failed'
```

### 7.3 Low-level methods

- `requestChallenge()`
- `payChallenge()`
- `verifyChallenge()`
- `pay()`

`requestChallenge()` posts:

```json
{
  "merchant_id": "merchant_123",
  "route_canonical": "GET:api:data",
  "request_canonical": "GET:api:data:user-42",
  "payer_addr": "0xPayer"
}
```

HTTP `402` is success.

The returned challenge is authoritative for amount, chain, token contract,
recipient, expiry, MAC, and pricing version. Do not reconstruct those fields
from manifest discovery data.

`payChallenge()`:

- rejects an expired challenge
- rejects a signer on the wrong chain
- broadcasts the ERC-20 transfer
- returns `{ txHash, tx }` without waiting for mining

`verifyChallenge()` posts:

```json
{
  "challenge_id": "ch_...",
  "tx_hash": "0x...",
  "payer_addr": "0xPayer",
  "mac": "..."
}
```

Verify response handling:

| Status | Behavior |
| --- | --- |
| `200` | Requires the GOAT Flow profile's `Payment-Receipt` extension; decodes its first base64url segment as receipt JSON |
| `202` | Retry with `Retry-After` |
| `429` | Retry with `Retry-After` |
| other `4xx` | Throw terminal `MPPError` |
| `5xx` | Retry with bounded backoff |
| fetch rejection | Retry with bounded backoff |

Defaults:

- 16 verify attempts
- 2-second fallback delay when `Retry-After` is missing
- 30-second maximum delay per attempt

The header format is:
`base64url(JSON(receipt)).base64url(raw-signature).algorithm`, where
`algorithm` is `ed25519` or `hmac-sha256`. It is not a JWT.

### 7.4 Recovery

After `payChallenge()` broadcasts, `pay()` attaches recovery context to failures:

```ts
import { MPPError } from 'goatflow-sdk'

try {
  await mpp.pay(params)
} catch (error) {
  if (error instanceof MPPError && error.recoverable) {
    const result = await mpp.verifyChallenge(error.recoverable)
    console.log(result.receiptHeader)
    return
  }
  throw error
}
```

Do not call `pay()` again when `recoverable` exists; that could prompt a second
transfer.

The replacement watcher follows only a transaction with matching destination
and calldata. It ignores user cancellation and unrelated same-nonce
transactions.

### 7.5 Error codes

Stable codes include:

- `network_error`
- `parse_error`
- `invalid_request`
- `route_not_found`
- `chain_mismatch`
- `user_rejected`
- `payment_failed`
- `challenge_expired`
- `challenge_already_consumed`
- `challenge_tx_hash_mismatch`
- `payer_mismatch`
- `bad_request`
- `verify_timeout`
- `service_unavailable`
- `receipt_missing`
- `receipt_malformed`

Branch on `MPPError.code`, not its message.

For this browser adapter, Core must allow the DApp origin, `POST`, and `Content-Type` and
expose `Payment-Receipt` through CORS. The protected resource must separately
allow the DApp origin and the `Payment-Receipt` request header. Otherwise use a
server-side buyer client.

## 8. Order status

The package exports:

```ts
type OrderStatus =
  | 'CHECKOUT_VERIFIED'
  | 'PAYMENT_CONFIRMED'
  | 'INVOICED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
```

The browser SDK does not poll or classify order status itself. Use the backend
Server SDK, whose current waiters treat `PAYMENT_CONFIRMED` and `INVOICED` as
successful terminal states. This order model is separate from QuickPay session
status, whose terminal set does not include `INVOICED`.

## 9. Security checklist

1. Create orders on the backend.
2. Map only required server-order fields to the browser.
3. Validate wallet chain, payer, and expiry before payment.
4. Use returned `payToAddress`, token, and amount; do not construct terms in the
   frontend.
5. Sign only the returned EIP-712 request.
6. Treat a wallet receipt as payment submission evidence, not final fulfillment.
7. Use exact approvals by default.
8. Preserve MPP recovery context after a broadcast.
9. Allow the DApp origin on Core and the protected resource, expose the
   `Payment-Receipt` response header, and allow that request header.

## 10. Verification sources

Behavior in this guide was checked against:

- `src/index.ts`
- `src/types.ts`
- `src/payment.ts`
- `src/contracts/erc20.ts`
- `src/eip712/index.ts`
- `src/mpp.ts`
- `src/__tests__/*`
- `package.json`

Last verified: July 23, 2026.
