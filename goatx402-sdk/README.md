# goatflow-sdk

Frontend TypeScript SDK for GOAT Flow, built on ethers v6. It provides:

- `PaymentHelper` for buyer-authorized browser ERC-20 transfers
- `ERC20Token` approval and transfer helpers
- EIP-712 callback-signing utilities
- `MPPClient` for challenge, buyer transfer, verification, and receipt recovery

This package does not hold merchant API credentials or create authenticated
orders. Use `goatflow-sdk-server` or the Go server SDK on your backend.
Buyer-wallet transfers go directly to the instructed recipient; GOAT Flow and
this SDK do not act as an intermediary for merchant customer funds.

## Install

```bash
npm install goatflow-sdk ethers
```

The package declares Node.js >= 18 for non-browser use.

## Pay a server-created order

The server and browser SDK `Order` types are different. Your backend must map:

- server `fromChainId` -> browser `chainId`
- the create-order payer -> browser `fromAddress`

```ts
import { PaymentHelper, type Order } from 'goatflow-sdk'
import { ethers } from 'ethers'

const order: Order = await fetch('/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ productId: 'mug' }),
}).then((response) => response.json())

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
    'Use the operator-provisioned callback flow before paying this order',
  )
}

const result = await payment.pay(order)
if (!result.success) throw new Error(result.error ?? 'Payment failed')
```

This basic example covers DIRECT. In an explicitly operator-provisioned callback
environment, map `calldataSignRequest`, sign its exact EIP-712 payload on the
returned domain chain, submit it through the merchant backend, and switch back
to the transfer source chain before paying. See the
[full integration guide](../docs/goat-flow-integration.md#51-typescript-client).

`PaymentHelper.pay()` checks the token balance, sends
`transfer(order.payToAddress, order.amountWei)`, waits for a successful receipt,
and returns a `PaymentResult`. The connected buyer signer sends tokens directly
to the instructed recipient; the SDK does not hold, route, or disburse merchant
customer funds. It catches transfer errors and returns
`{ success: false, error }`; it does not perform chain, payer, or expiry checks.
It also does not classify `TRANSACTION_REPLACED`, so reconcile a wallet speed-up
and backend order before retrying a result reported as failed.

All supported order flows still use a user-side ERC-20 transfer to
`payToAddress`:

- `ERC20_DIRECT`: merchant recipient
- `ERC20_3009`: operator-provisioned compatibility recipient
- `ERC20_APPROVE_XFER`: operator-provisioned compatibility recipient

DIRECT is the standard/default public path. The other values are retained for
explicitly provisioned environments and are not part of public onboarding.

## MPP

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol. `MPPClient` implements GOAT Flow's current adapter, not the
standard MPP HTTP Challenge/Credential/Receipt exchange. Its JSON
challenge/verify endpoints and signed three-segment receipt are GOAT-specific,
and this repository has no official-SDK interoperability test.

```ts
import { MPPClient, MPPError } from 'goatflow-sdk'

const mpp = new MPPClient({
  coreUrl: 'https://flow-api.goat.network', // must not end with "/"
  signer,
})

async function payForRoute() {
  try {
    return await mpp.pay({
      merchantId: 'merchant_123',
      routeCanonical: 'GET:api:data',
      onPhase: (phase) => console.log(phase),
    })
  } catch (error) {
    if (error instanceof MPPError && error.recoverable) {
      // The transfer was already broadcast. Resume verification; do not pay again.
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

This is the standalone GOAT Flow MPP adapter, so `coreUrl` is the Core/API origin
configured for the deployment. QuickPay `pay-mpp` derives its adapter origin
from the trusted QuickPay link instead. The returned challenge is authoritative
for amount, chain, token, recipient, expiry, MAC, and pricing version.

Behavior verified by tests:

- `POST /mpp/v1/challenge`: HTTP `402` is success
- chain and challenge expiry are checked before broadcasting
- `payChallenge()` returns `{ txHash, tx }` without waiting locally for mining
- `POST /mpp/v1/verify`: `202`, `429`, network errors, and eligible `5xx`
  responses are retried with bounded backoff
- successful verification requires the GOAT Flow profile's three-segment
  `Payment-Receipt` extension:
  `base64url(JSON(receipt)).base64url(signature).algorithm`
- matching fee-bump replacements are followed
- post-broadcast failures include `MPPError.recoverable`

Keep `onPhase` non-throwing or catch its errors locally; application callback
errors can replace the SDK's expected `MPPError`.

For browser use, Core must allow the DApp origin and expose
`Payment-Receipt`; the protected resource must allow that origin and the
`Payment-Receipt` request header. Otherwise use a server-side buyer client.

## ERC-20 approvals

`PaymentHelper.approveToken`, `ERC20Token.setApproval`, and
`ERC20Token.ensureApproval`:

- approve exact amounts by default; `{ unlimited: true }` is explicit
- avoid a transaction when the existing allowance already satisfies the request
- probe non-zero allowance replacement with `eth_call`
- use confirmed `approve(0)` only for USDT-style/no-simulation fallback
- follow matching wallet fee-bump replacements
- validate bigint range and option types before submitting a transaction

`setApproval()` returns `{ tx?, resetTx? }`.
`PaymentHelper.approveToken()` returns only the final `tx` (or `undefined`).

## Exports

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

See [the package integration guide](./docs/Integration.md),
[the repository integration guide](../docs/goat-flow-integration.md), and the
[Changelog](./CHANGELOG.md).

## License

MIT
